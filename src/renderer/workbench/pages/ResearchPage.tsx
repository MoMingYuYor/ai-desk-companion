// 研究工作台(R-06):资料导入/选择 → 研究问题 → 运行时间线 → 报告(结论—证据—限制)。
//
// 数据流与复用(与 AgentPage 同一模式):
// - 创建走 research:run-create(幂等键 operationId 由页面生成并持有,重复点击复用同键);
// - 详情与事件复用 Agent 通道:getAgentRun / getAgentRunEvents 补发 + useSubscribe(evt:agent-run-updated)
//   按 seq 游标合并(mergeEvents / lastSeqRef);
// - 澄清:从 input 事件 payload.questions 提取,提交走 submitAgentAnswers 既有通道;
// - 报告:research:report-get,按 report_state 如实展示(partial 不伪装成功);
// - 证据抽屉:research:snapshot-get 读规范全文,按码点 offset 高亮(Array.from 视角切分,
//   与 chunker.ts 约定一致——offset 是 Unicode 码点索引,不是 UTF-16 下标);
// - 「转为待办」:只新建 mode=personal_ops 运行(需审批后才写入),不直接产生业务写。
//
// 页面状态(规格 §3):空资料禁用提交;排队/加载显示阶段;澄清卡片;部分完成展示
// 未完成子问题与终止原因;失败展示错误码;取消不伪装成功;断线按最后 seq 补发。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Channels,
  type AgentRunListItem,
  type AgentRunView,
  type AgentRunEventsResult,
  type ResearchReportResponse,
  type ResearchSnapshotView,
  type ResearchSourceOutcomeView
} from '../../../shared/api'
import type { TraceEvent } from '../../../shared/agent'
import { useSubscribe } from '../../shared/util'

type RunStatus = AgentRunView['status']

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: '排队中',
  planning: '规划中',
  awaiting_input: '等待补充信息',
  awaiting_confirmation: '等待确认',
  executing: '执行中',
  succeeded: '已完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消'
}

const EVENT_LABEL: Record<TraceEvent['eventType'], string> = {
  input: '输入',
  retrieval: '检索',
  plan: '计划',
  tool_call: '工具调用',
  confirmation: '待确认',
  model: '模型',
  output: '结果',
  error: '错误'
}

/** 按 seq 去重合并(允许重发,不重复渲染);与 AgentPage 同一实现 */
function mergeEvents(existing: TraceEvent[], incoming: TraceEvent[]): TraceEvent[] {
  const bySeq = new Map<number, TraceEvent>()
  for (const e of existing) bySeq.set(e.seq, e)
  for (const e of incoming) bySeq.set(e.seq, e)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

function fmtTime(iso: string): string {
  return iso.length >= 16 ? iso.slice(11, 16) : iso
}

function statusTone(status: RunStatus): string {
  if (status === 'succeeded') return 'var(--ok, #2e7d32)'
  if (status === 'failed') return 'var(--danger, #c62828)'
  if (status === 'partial') return 'var(--warn, #b26a00)'
  if (status === 'cancelled') return 'var(--muted, #777)'
  return 'var(--accent, #1565c0)'
}

// ---------- 码点高亮(证据抽屉) ----------

export interface HighlightRange {
  start: number
  end: number
}

/**
 * 规范全文 → 按 offset 高亮的渲染段。
 * offset 是 Array.from(text) 的码点索引(零起点、左闭右开):先用 Array.from 切出
 * 码点数组,再按码点下标切片后拼回字符串,保证 emoji(代理对)/组合字符/中文/
 * CRLF 换行(规范化后为 LF)在 UTF-16 视角下不错位。
 * 无有效区间时返回整段文本(抽屉退化为只读全文)。
 */
export function splitByCodePointOffsets(text: string, range: HighlightRange | null): Array<{ text: string; highlight: boolean }> {
  const points = Array.from(text)
  if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end)) {
    return [{ text, highlight: false }]
  }
  const start = Math.max(0, Math.min(range.start, points.length))
  const end = Math.max(start, Math.min(range.end, points.length))
  const parts: Array<{ text: string; highlight: boolean }> = []
  if (start > 0) parts.push({ text: points.slice(0, start).join(''), highlight: false })
  if (end > start) parts.push({ text: points.slice(start, end).join(''), highlight: true })
  if (end < points.length) parts.push({ text: points.slice(end).join(''), highlight: false })
  return parts
}

/** markdown 极简渲染:标题/列表行/普通行,不在渲染层引入重型依赖与 HTML 注入面 */
function MarkdownBlock({ markdown }: { markdown: string }): JSX.Element {
  const lines = markdown.split('\n')
  return (
    <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
      {lines.map((line, i) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('### ')) {
          return <div key={i} style={{ fontWeight: 600, marginTop: 8 }}>{trimmed.slice(4)}</div>
        }
        if (trimmed.startsWith('## ')) {
          return <div key={i} style={{ fontWeight: 700, marginTop: 10 }}>{trimmed.slice(3)}</div>
        }
        return <div key={i}>{line}</div>
      })}
    </div>
  )
}

// ---------- 证据抽屉 ----------

interface DrawerState {
  citationId: string
  snapshotId: string
  quote: string
  startOffset: number
  endOffset: number
}

function EvidenceDrawer({
  state,
  onClose
}: {
  state: DrawerState
  onClose: () => void
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<ResearchSnapshotView | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setSnapshot(null)
    setError(null)
    window.api
      .getResearchSnapshot(state.snapshotId)
      .then((view) => {
        if (alive) setSnapshot(view)
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [state.snapshotId])

  const parts = useMemo(
    () => (snapshot ? splitByCodePointOffsets(snapshot.normalizedText, { start: state.startOffset, end: state.endOffset }) : []),
    [snapshot, state.startOffset, state.endOffset]
  )

  return (
    <div
      data-testid="research-drawer"
      style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 460, overflow: 'auto', background: 'var(--bg, #fff)', boxShadow: '-4px 0 16px rgba(0,0,0,0.18)', padding: 16, zIndex: 40 }}
    >
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div style={{ fontWeight: 600 }}>证据抽屉</div>
        <button className="ghost" data-testid="research-drawer-close" onClick={onClose}>
          关闭
        </button>
      </div>
      {error && <div style={{ color: 'var(--danger, #c62828)', marginTop: 8 }}>{error}</div>}
      {!snapshot && !error && <div className="muted" style={{ marginTop: 8 }}>正在读取快照…</div>}
      {snapshot && (
        <>
          <div className="muted" style={{ margin: '8px 0' }}>
            {snapshot.sourceName}({snapshot.sourceType}) · text_sha256={snapshot.textSha256.slice(0, 12)}… ·{' '}
            {snapshot.codePointLength} 码点
          </div>
          <div data-testid="research-drawer-text" style={{ whiteSpace: 'pre-wrap', border: '1px solid rgba(0,0,0,0.08)', borderRadius: 6, padding: 8 }}>
            {parts.map((p, i) =>
              p.highlight ? (
                <mark key={i} data-testid="research-drawer-highlight" style={{ background: '#fff3a3' }}>
                  {p.text}
                </mark>
              ) : (
                <span key={i}>{p.text}</span>
              )
            )}
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            高亮区间 [{state.startOffset}, {state.endOffset}) 码点
          </div>
        </>
      )}
    </div>
  )
}

// ---------- 报告区(结论—证据—限制) ----------

function ReportView({
  report,
  onOpenCitation
}: {
  report: ResearchReportResponse
  onOpenCitation: (citation: ResearchReportResponse['citations'][number]) => void
}): JSX.Element {
  const sectionOrder = ['core_findings', 'evidence_by_subquestion', 'conflicts_and_gaps']
  const ordered = [...report.sections].sort((a, b) => {
    const ia = sectionOrder.indexOf(a.section)
    const ib = sectionOrder.indexOf(b.section)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })

  return (
    <div data-testid="research-report" style={{ marginTop: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ fontWeight: 700 }}>
          报告 v{report.version}
          <span style={{ marginLeft: 8, color: report.report_state === 'final' ? 'var(--ok, #2e7d32)' : 'var(--warn, #b26a00)' }}>
            {report.report_state === 'final' ? '完整' : report.report_state === 'partial' ? '部分完成' : '草稿'}
          </span>
        </div>
        <div className="muted">清单 hash {report.manifest_sha256.slice(0, 12)}…</div>
      </div>

      {/* 阅读顺序:结论 → 证据 → 限制 */}
      {ordered.map((s) => (
        <div key={s.section} data-testid={`research-report-section-${s.section}`} style={{ marginBottom: 12 }}>
          <MarkdownBlock markdown={s.markdown} />
        </div>
      ))}

      {/* 引用列表:展示编号按当前报告版本顺序;结构化字段保留稳定 Citation ID */}
      <div style={{ marginTop: 8 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>引用</div>
        {report.citations.map((c, i) => (
          <div key={c.citation_id} className="row" style={{ gap: 8, padding: '2px 0' }}>
            <span className="muted">[{i + 1}]</span>
            <span className="muted" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.relation} · {c.quote ?? c.evidence_id.slice(0, 8)}
            </span>
            {c.snapshot_id && (
              <button className="ghost" data-testid={`research-cite-${c.evidence_id}`} onClick={() => onOpenCitation(c)}>
                查看原文
              </button>
            )}
          </div>
        ))}
      </div>

      {/* 未完成子问题(partial 的诚实展示) */}
      {report.unanswered_subquestions.length > 0 && (
        <div data-testid="research-unanswered" style={{ color: 'var(--warn, #b26a00)', marginTop: 10 }}>
          未完成子问题:
          {report.unanswered_subquestions.map((s) => (
            <div key={s.subquestion_id}>
              - {s.question}
              {s.insufficiency_reason ? `(${s.insufficiency_reason})` : ''}
            </div>
          ))}
        </div>
      )}

      {/* 导出与转为待办:导出仅本地文件;转待办只新建 personal_ops 运行,需审批后才写入 */}
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <button data-testid="research-export" onClick={() => downloadMarkdown(report)}>
          导出 Markdown
        </button>
        <button data-testid="research-convert-todo" onClick={() => void onConvertTodo(report)}>
          转为待办(新建个人事务运行,需审批后才写入)
        </button>
      </div>
      <div id="research-convert-result" />
    </div>
  )
}

/** 导出 Markdown:本地 Blob 下载,不自动上传(「导出成功」只表示本地生成文件) */
function downloadMarkdown(report: ResearchReportResponse): void {
  const header = `# 研究报告 v${report.version}(run ${report.run_id})\n\nreport_state: ${report.report_state}\nmanifest_sha256: ${report.manifest_sha256}\n\n`
  const blob = new Blob([header, report.markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `research-report-${report.run_id.slice(0, 8)}-v${report.version}.md`
  a.click()
  URL.revokeObjectURL(url)
}

/** 「转为待办」:从报告建议创建 mode=personal_ops 运行;未审批不产生任何业务写 */
async function onConvertTodo(report: ResearchReportResponse): Promise<void> {
  const suggestion =
    report.claims.find((c) => c.claim_type === 'recommendation')?.text ??
    report.unanswered_subquestions.map((s) => `补充资料以回答:${s.question}`).join(';') ??
    report.run_id
  await window.api.createAgentRun({
    input: `依据研究报告 v${report.version}(run ${report.run_id})执行建议:${suggestion}`,
    mode: 'personal_ops'
  })
  const node = document.getElementById('research-convert-result')
  if (node) node.textContent = '已创建个人事务运行,等待审批后才写入业务数据'
}

// ---------- 页面 ----------

interface ImportedSource {
  documentId: string
  sourceName: string
  sourceType: string
  sourceLocator: string | null
  deduped: boolean
}

export function ResearchPage({ refreshKey }: { refreshKey: number }): JSX.Element {
  // 左:已导入资料
  const [sources, setSources] = useState<ImportedSource[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<ResearchSourceOutcomeView[] | null>(null)
  // 中:研究问题
  const [question, setQuestion] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // 右:运行与事件
  const [run, setRun] = useState<AgentRunView | null>(null)
  const [events, setEvents] = useState<TraceEvent[]>([])
  const [history, setHistory] = useState<AgentRunListItem[]>([])
  const [report, setReport] = useState<ResearchReportResponse | null>(null)
  const [reportError, setReportError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<DrawerState | null>(null)

  // 幂等键:每次"新发起"生成一次,提交进行中重复点击复用同键
  const operationIdRef = useRef<string>('')
  // 事件游标:按 seq 补发(断线重连/切页回来不重复渲染)
  const runIdRef = useRef<string | null>(null)
  const lastSeqRef = useRef(0)

  const backfillEvents = useCallback(async (id: string) => {
    const result: AgentRunEventsResult = await window.api.getAgentRunEvents(id, lastSeqRef.current)
    if (runIdRef.current !== id) return
    if (result.run) setRun(result.run)
    if (result.events.length > 0) {
      lastSeqRef.current = result.events[result.events.length - 1]!.seq
      setEvents((prev) => mergeEvents(prev, result.events))
    }
  }, [])

  const loadReport = useCallback(async (id: string) => {
    setReportError(null)
    try {
      const r = await window.api.getResearchReport(id)
      setReport(r)
    } catch (err: unknown) {
      setReport(null)
      setReportError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const openRun = useCallback(
    async (id: string) => {
      runIdRef.current = id
      lastSeqRef.current = 0
      setEvents([])
      setReport(null)
      setReportError(null)
      setError(null)
      await backfillEvents(id)
      // 终态或已有报告版本时拉报告;REPORT_NOT_READY 只提示不阻塞
      const view = runIdRef.current === id ? await window.api.getAgentRun(id).catch(() => null) : null
      if (view && (view.status === 'succeeded' || view.status === 'partial' || view.status === 'failed')) {
        void loadReport(id)
      }
    },
    [backfillEvents, loadReport]
  )

  const loadHistory = useCallback(async (): Promise<AgentRunListItem[]> => {
    try {
      const runs = await window.api.listAgentRuns()
      // 只展示研究运行(共享运行列表按 mode 过滤)
      const research = runs.filter((r) => r.mode === 'research')
      setHistory(research)
      return research
    } catch {
      return []
    }
  }, [])

  useEffect(() => {
    void loadHistory().then((runs) => {
      if (!runIdRef.current && runs.length > 0) void openRun(runs[0]!.runId)
    })
  }, [loadHistory, openRun, refreshKey])

  // 事件订阅:复用 Agent 运行事件(研究运行就是 AgentRun)
  useSubscribe(Channels.EventAgentRunUpdated, (...args: unknown[]) => {
    const payload = args[0] as { run: AgentRunView; event: TraceEvent } | undefined
    if (!payload || payload.run.runId !== runIdRef.current) return
    if (payload.event.seq > lastSeqRef.current) {
      lastSeqRef.current = payload.event.seq
      setEvents((prev) => mergeEvents(prev, [payload.event]))
    }
    setRun(payload.run)
  })
  useSubscribe(Channels.EventAgentRunFinished, (...args: unknown[]) => {
    const payload = args[0] as { run: AgentRunView } | undefined
    if (!payload || payload.run.runId !== runIdRef.current) return
    setRun(payload.run)
    void loadHistory()
    if (payload.run.status !== 'cancelled' && payload.run.status !== 'failed') {
      void loadReport(payload.run.runId)
    } else {
      // 失败/取消也可能已有阶段草稿:尝试读取,REPORT_NOT_READY 如实提示
      void loadReport(payload.run.runId)
    }
  })

  /** File → Uint8Array:优先 arrayBuffer(),兜底 FileReader(jsdom 环境无 arrayBuffer) */
async function fileBytes(f: File): Promise<Uint8Array> {
  if (typeof f.arrayBuffer === 'function') return new Uint8Array(await f.arrayBuffer())
  return await new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error(`读取文件失败:${f.name}`))
    reader.readAsArrayBuffer(f)
  })
}

// ---------- 导入 ----------
  const importFiles = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = '.md,.txt,.json,.csv'
    input.onchange = () => {
      if (!input.files || input.files.length === 0) return
      void (async () => {
        setImporting(true)
        setError(null)
        try {
          const files = await Promise.all(
            Array.from(input.files!).map(async (f) => ({
              name: f.name,
              bytes: await fileBytes(f)
            }))
          )
          const outcomes = await window.api.importResearchDocuments(files)
          setImportResult(outcomes)
          const okItems: ImportedSource[] = outcomes
            .filter((o) => o.ok && o.documentId)
            .map((o) => ({
              documentId: o.documentId!,
              sourceName: o.sourceName,
              sourceType: o.sourceType ?? '',
              sourceLocator: o.sourceLocator,
              deduped: o.deduped ?? false
            }))
          if (okItems.length > 0) {
            setSources((prev) => {
              const seen = new Set(prev.map((p) => p.documentId))
              return [...prev, ...okItems.filter((o) => !seen.has(o.documentId))]
            })
            setSelected((prev) => {
              const next = new Set(prev)
              for (const item of okItems) next.add(item.documentId)
              return next
            })
          }
        } catch (err: unknown) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setImporting(false)
        }
      })()
    }
    input.click()
    // 挂到 DOM 供测试(jsdom 无文件对话框,测试直接对 input 注入 File 后触发 change)
    input.style.display = 'none'
    input.setAttribute('data-testid', 'research-import-input')
    document.body.appendChild(input)
    input.addEventListener('change', () => input.remove(), { once: true })
  }, [])

  // ---------- 创建研究运行 ----------
  const submit = useCallback(async () => {
    if (question.trim() === '' || selected.size === 0 || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      if (operationIdRef.current === '') {
        operationIdRef.current = `research-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      }
      const created = await window.api.createResearchRun({
        question: question.trim(),
        snapshotIds: [...selected],
        operationId: operationIdRef.current
      })
      // 新运行成功后清空幂等键:下一次提交是新请求
      operationIdRef.current = ''
      setQuestion('')
      await openRun(created.runId)
      void loadHistory()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }, [question, selected, submitting, openRun, loadHistory])

  // ---------- 澄清(与 AgentPage 同一提取逻辑;研究事件载荷为 snake_case) ----------
  const questions = useMemo(() => {
    const inputEvents = events.filter((e) => e.eventType === 'input')
    const last = inputEvents[inputEvents.length - 1]
    const qs = (last?.payload as { questions?: Array<{ question_id: string; question: string }> } | undefined)?.questions
    const answered = new Set(
      inputEvents.flatMap((e) => (e.payload as { answers?: Array<{ question_id: string }> }).answers ?? []).map(
        (a) => a.question_id
      )
    )
    return (qs ?? []).filter((q) => !answered.has(q.question_id))
  }, [events])

  const answer = useCallback(
    async (questionId: string, value: string) => {
      if (!run) return
      try {
        await window.api.submitAgentAnswers(run.runId, [{ questionId, answer: value }])
        await backfillEvents(run.runId)
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [run, backfillEvents]
  )

  // ---------- 取消 ----------
  const cancelRun = useCallback(async () => {
    if (!run) return
    try {
      await window.api.cancelAgentRun(run.runId)
      await backfillEvents(run.runId)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [run, backfillEvents])

  const openCitation = useCallback(
    (c: ResearchReportResponse['citations'][number]) => {
      if (!c.snapshot_id) return
      setDrawer({
        citationId: c.citation_id,
        snapshotId: c.snapshot_id,
        quote: c.quote ?? '',
        startOffset: c.start_offset ?? 0,
        endOffset: c.end_offset ?? 0
      })
    },
    []
  )

  const running = run !== null && (run.status === 'queued' || run.status === 'planning' || run.status === 'executing')

  return (
    <div className="page" style={{ flexDirection: 'column', gap: 12 }}>
      <div className="row" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {/* 左:已导入资料 */}
        <div className="card" style={{ width: 260, flexShrink: 0 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 600 }}>已导入资料</div>
            <button className="ghost" data-testid="research-import" disabled={importing} onClick={importFiles}>
              {importing ? '导入中…' : '导入资料'}
            </button>
          </div>
          {sources.length === 0 && (
            <div className="muted" data-testid="research-empty" style={{ marginTop: 8 }}>
              暂无资料;支持 .md / .txt / .json / .csv(单文件 5 MB,单批 100 个)
            </div>
          )}
          {sources.map((s) => (
            <label key={s.documentId} className="row" style={{ gap: 6, padding: '4px 0', alignItems: 'center' }}>
              <input
                type="checkbox"
                data-testid={`research-source-${s.documentId}`}
                checked={selected.has(s.documentId)}
                onChange={() =>
                  setSelected((prev) => {
                    const next = new Set(prev)
                    if (next.has(s.documentId)) next.delete(s.documentId)
                    else next.add(s.documentId)
                    return next
                  })
                }
              />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.sourceName}
                {s.sourceLocator ? ` ${s.sourceLocator}` : ''}
              </span>
              <span className="muted">{s.sourceType}</span>
            </label>
          ))}
          {importResult && (
            <div data-testid="research-import-result" style={{ marginTop: 8, fontSize: 12 }}>
              {importResult.map((o, i) => (
                <div key={i} style={{ color: o.ok ? 'var(--ok, #2e7d32)' : 'var(--danger, #c62828)' }}>
                  {o.ok ? `✓ ${o.sourceName}${o.deduped ? '(重复,已复用)' : ''}` : `✗ ${o.sourceName}:${o.error?.message ?? '导入失败'}`}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 中:研究问题 + 资料选择 */}
        <div className="card" style={{ flex: 1 }}>
          <textarea
            data-testid="research-question"
            value={question}
            placeholder="例如:比较这些岗位的 Python 要求,并给出有依据的学习建议"
            onChange={(e) => setQuestion(e.target.value)}
            style={{ width: '100%', minHeight: 56, resize: 'vertical' }}
          />
          <div className="muted" style={{ marginTop: 4 }}>
            已选 {selected.size} 份资料;至少选择 1 份才能发起研究
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
            {running && (
              <button className="ghost" data-testid="research-cancel" onClick={() => void cancelRun()}>
                取消运行
              </button>
            )}
            <button
              data-testid="research-submit"
              disabled={question.trim() === '' || selected.size === 0 || submitting}
              onClick={() => void submit()}
            >
              {submitting ? '提交中…' : '开始研究'}
            </button>
          </div>
          {error && (
            <div data-testid="research-error" style={{ color: 'var(--danger, #c62828)', marginTop: 6 }}>
              {error}
            </div>
          )}
        </div>
      </div>

      {/* 当前运行:阶段时间线 + 澄清 + 报告 */}
      {run && (
        <div className="card" data-testid="research-run">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 600 }}>{run.input}</div>
            <span style={{ color: statusTone(run.status) }} data-testid="research-run-status">
              {STATUS_LABEL[run.status]}
            </span>
          </div>

          {/* 澄清问题卡片 */}
          {run.status === 'awaiting_input' && questions.length > 0 && (
            <div data-testid="research-questions" style={{ marginTop: 10 }}>
              {questions.map((q) => (
                <div key={q.question_id} style={{ marginBottom: 8 }}>
                  <div>{q.question}</div>
                  <div className="row" style={{ gap: 8, marginTop: 4 }}>
                    <input
                      data-testid={`research-question-input-${q.question_id}`}
                      placeholder="补充说明(留空按默认假设)"
                      onBlur={(e) => {
                        const value = e.target.value.trim()
                        if (value !== '') void answer(q.question_id, value)
                      }}
                      style={{ flex: 1 }}
                    />
                    <button onClick={() => void answer(q.question_id, '按默认假设继续')}>按默认假设继续</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 时间线 */}
          <div data-testid="research-timeline" style={{ marginTop: 12 }}>
            {events.map((e) => (
              <div key={e.seq} style={{ display: 'flex', gap: 8, padding: '4px 0', alignItems: 'baseline' }}>
                <span className="muted" style={{ minWidth: 44 }}>{fmtTime(e.createdAt)}</span>
                <span className="muted" style={{ minWidth: 56 }}>#{e.seq}</span>
                <span style={{ minWidth: 60 }}>{EVENT_LABEL[e.eventType]}</span>
                <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}>
                  {e.eventType === 'retrieval' &&
                    `检索 ${(e.payload as { chunkCount?: number }).chunkCount ?? ''}`.trim()}
                  {e.eventType === 'plan' && String((e.payload as { goal?: string }).goal ?? '')}
                  {e.eventType === 'tool_call' && String((e.payload as { tool?: string }).tool ?? '')}
                  {e.eventType === 'error' && String((e.payload as { message?: string }).message ?? '')}
                </span>
              </div>
            ))}
            {events.length === 0 && <div className="muted">暂无轨迹事件</div>}
          </div>

          {/* partial/failed/cancelled:不伪装成功 */}
          {(run.status === 'partial' || run.status === 'failed' || run.status === 'cancelled') && (
            <div data-testid="research-run-failure" style={{ color: run.status === 'partial' ? 'var(--warn, #b26a00)' : 'var(--danger, #c62828)', marginTop: 10 }}>
              {run.status === 'partial' && '部分完成:已验证结论保留,未完成子问题与终止原因见下方报告区。'}
              {run.status === 'failed' && `运行失败${run.errorCode ? `(${run.errorCode})` : ''}:已保存内容保留;重试研究须新建运行。`}
              {run.status === 'cancelled' && '已取消:已完成阶段与用量保留,不伪装为成功。'}
            </div>
          )}

          {/* 报告区 */}
          {report && <ReportView report={report} onOpenCitation={(c) => openCitation(c)} />}
          {reportError && (
            <div className="muted" data-testid="research-report-error" style={{ marginTop: 8 }}>
              {reportError}
            </div>
          )}
        </div>
      )}

      {/* 历史:按运行时间与状态;打开历史运行读取固定快照与报告版本 */}
      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 6 }}>研究历史</div>
        {history.length === 0 && <div className="muted">还没有研究运行</div>}
        {history.map((r) => (
          <div
            key={r.runId}
            data-testid="research-history-item"
            className="row"
            style={{ justifyContent: 'space-between', padding: '4px 0', cursor: 'pointer' }}
            onClick={() => void openRun(r.runId)}
          >
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.input}</span>
            <span className="muted" style={{ minWidth: 88 }}>{fmtTime(r.startedAt)}</span>
            <span style={{ color: statusTone(r.status as RunStatus) }}>{STATUS_LABEL[r.status as RunStatus]}</span>
          </div>
        ))}
      </div>

      {/* 证据抽屉 */}
      {drawer && <EvidenceDrawer state={drawer} onClose={() => setDrawer(null)} />}
    </div>
  )
}
