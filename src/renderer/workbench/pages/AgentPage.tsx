// 个人事务 Agent 界面(A-06):输入 → 运行时间线 → 确认卡 → 结果。
//
// 数据流:提交即创建运行(agent:run-create,202 语义,规划异步),
// 订阅 evt:agent-run-updated / finished 按 runId 过滤、按 seq 去重合并;
// 进入 awaiting_confirmation 时经 agent:run-approvals 拉取待批提案渲染确认卡;
// 断线或切页回来时经 agent:run-events 按最后 seq 补发(不重复渲染)。
//
// 边界(模块规格第 16 节):空输入禁止提交;partial 不可伪装成完整成功;
// 过期提案禁止批准;渲染层不保存模型 Key。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Channels, type AgentApprovalView, type AgentRunListItem, type AgentRunView, type AgentRunEventsResult } from '../../../shared/api'
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

/** 按 seq 去重合并(允许重发,不重复渲染) */
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

interface ConfirmCardProps {
  approval: AgentApprovalView
  onDecide: (approvalId: string, decision: 'approved' | 'rejected') => void
  busy: boolean
}

/** 确认卡:工具名、已校验参数、目标、有效期;过期禁止批准 */
function ConfirmCard({ approval, onDecide, busy }: ConfirmCardProps) {
  const expired = new Date(approval.expiresAt).getTime() <= Date.now()
  return (
    <div className="card" data-testid="agent-confirm-card" style={{ borderColor: expired ? 'var(--danger, #c62828)' : undefined }}>
      <div style={{ fontWeight: 600 }}>
        待确认:{approval.toolName}
        {expired && <span style={{ color: 'var(--danger, #c62828)', marginLeft: 8 }}>(已过期,需重新发起)</span>}
      </div>
      <div className="muted" style={{ margin: '6px 0' }}>
        有效期至 {approval.expiresAt}
        {approval.targetVersion != null && ` · 目标版本 v${approval.targetVersion}`}
      </div>
      <pre style={{ whiteSpace: 'pre-wrap', background: 'rgba(0,0,0,0.04)', padding: 8, borderRadius: 6 }}>
        {JSON.stringify(approval.arguments ?? {}, null, 2)}
      </pre>
      <div className="row" style={{ gap: 8 }}>
        <button disabled={busy || expired} onClick={() => onDecide(approval.approvalId, 'approved')}>
          批准执行
        </button>
        <button className="ghost danger" disabled={busy} onClick={() => onDecide(approval.approvalId, 'rejected')}>
          拒绝
        </button>
      </div>
    </div>
  )
}

export function AgentPage({ refreshKey }: { refreshKey: number }): JSX.Element {
  const [input, setInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [run, setRun] = useState<AgentRunView | null>(null)
  const [events, setEvents] = useState<TraceEvent[]>([])
  const [approvals, setApprovals] = useState<AgentApprovalView[]>([])
  const [history, setHistory] = useState<Array<{ runId: string; status: string; input: string; startedAt: string }>>([])
  const [error, setError] = useState<string | null>(null)
  const [decideBusy, setDecideBusy] = useState(false)
  // 只关注当前查看的运行;ref 用于事件回调内拿到最新 runId
  const runIdRef = useRef<string | null>(null)
  const lastSeqRef = useRef(0)

  const refreshRun = useCallback(
    async (id: string) => {
      try {
        const [view, approvals] = await Promise.all([
          window.api.getAgentRun(id),
          window.api.getAgentRunApprovals(id)
        ])
        if (runIdRef.current !== id) return
        setRun(view)
        setApprovals(approvals)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    []
  )

  const backfillEvents = useCallback(async (id: string) => {
    const result: AgentRunEventsResult = await window.api.getAgentRunEvents(id, lastSeqRef.current)
    if (runIdRef.current !== id) return
    if (result.events.length > 0) {
      lastSeqRef.current = result.events[result.events.length - 1]!.seq
      setEvents((prev) => mergeEvents(prev, result.events))
    }
  }, [])

  const openRun = useCallback(
    async (id: string) => {
      runIdRef.current = id
      lastSeqRef.current = 0
      setEvents([])
      setApprovals([])
      setError(null)
      await Promise.all([refreshRun(id), backfillEvents(id)])
    },
    [refreshRun, backfillEvents]
  )

  const loadHistory = useCallback(async (): Promise<AgentRunListItem[]> => {
    try {
      const runs = await window.api.listAgentRuns()
      setHistory(runs)
      return runs
    } catch {
      /* 历史加载失败不阻塞主流程 */
      return []
    }
  }, [openRun])

  // 首次与 refreshKey 变化:加载历史;无当前运行时自动恢复最近一条
  useEffect(() => {
    void loadHistory().then((runs) => {
      if (!runIdRef.current && runs.length > 0) void openRun(runs[0]!.runId)
    })
  }, [loadHistory, openRun, refreshKey])

  // 事件订阅:updated 合并事件并刷新运行状态;finished 刷新 + 历史
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
    void refreshRun(payload.run.runId)
    void loadHistory()
  })

  const submit = useCallback(async () => {
    if (input.trim() === '' || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const created = await window.api.createAgentRun({ input: input.trim() })
      setInput('')
      await openRun(created.runId)
      void loadHistory()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }, [input, submitting, openRun, loadHistory])

  const decide = useCallback(
    async (approvalId: string, decision: 'approved' | 'rejected') => {
      if (!run) return
      setDecideBusy(true)
      setError(null)
      try {
        await window.api.decideAgentApproval(approvalId, decision)
        await refreshRun(run.runId)
        const id = run.runId
        await backfillEvents(id)
        void loadHistory()
      } catch (err) {
        // 冲突(过期/版本变化)如实展示,不允许带病批准
        setError(err instanceof Error ? err.message : String(err))
        await refreshRun(run.runId)
      } finally {
        setDecideBusy(false)
      }
    },
    [run, refreshRun, backfillEvents, loadHistory]
  )

  const answer = useCallback(
    async (questionId: string, answer: string) => {
      if (!run) return
      try {
        await window.api.submitAgentAnswers(run.runId, [{ questionId, answer }])
        await refreshRun(run.runId)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [run, refreshRun]
  )

  const pendingConfirmations = useMemo(
    () => approvals.filter((a) => a.decision === 'pending'),
    [approvals]
  )
  const questions = useMemo(() => {
    const inputEvents = events.filter((e) => e.eventType === 'input')
    const last = inputEvents[inputEvents.length - 1]
    const qs = (last?.payload as { questions?: Array<{ questionId: string; question: string }> } | undefined)?.questions
    // 已回答过的澄清不再展示
    const answered = new Set(
      inputEvents.flatMap((e) => (e.payload as { answers?: Array<{ questionId: string }> }).answers ?? []).map(
        (a) => a.questionId
      )
    )
    return (qs ?? []).filter((q) => !answered.has(q.questionId))
  }, [events])

  return (
    <div className="page" style={{ flexDirection: 'column', gap: 12 }}>
      <div className="row" style={{ marginBottom: 0 }}>
        <span className="muted">用自然语言安排任务;涉及写入的操作会先征求你的确认</span>
      </div>

      {/* 输入区:空输入禁止提交;提交中防重 */}
      <div className="card">
        <textarea
          data-testid="agent-input"
          value={input}
          placeholder="例如:把本周未完成的高优先级任务整理出来"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
          style={{ width: '100%', minHeight: 56, resize: 'vertical' }}
        />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <button data-testid="agent-submit" disabled={input.trim() === '' || submitting} onClick={() => void submit()}>
            {submitting ? '提交中…' : '开始执行'}
          </button>
        </div>
        {error && (
          <div data-testid="agent-error" style={{ color: 'var(--danger, #c62828)', marginTop: 6 }}>
            {error}
          </div>
        )}
      </div>

      {/* 当前运行视图 */}
      {run && (
        <div className="card" data-testid="agent-run">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 600 }}>{run.input}</div>
            <span style={{ color: statusTone(run.status) }} data-testid="agent-run-status">
              {STATUS_LABEL[run.status]}
            </span>
          </div>

          {/* 澄清问题 */}
          {run.status === 'awaiting_input' && questions.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {questions.map((q) => (
                <div key={q.questionId} style={{ marginBottom: 8 }}>
                  <div>{q.question}</div>
                  <button onClick={() => void answer(q.questionId, '好的,按建议执行')}>按建议继续</button>
                </div>
              ))}
            </div>
          )}

          {/* 确认卡(可能多张) */}
          {pendingConfirmations.map((a) => (
            <div key={a.approvalId} style={{ marginTop: 10 }}>
              <ConfirmCard approval={a} onDecide={(id, d) => void decide(id, d)} busy={decideBusy} />
            </div>
          ))}

          {/* 时间线 */}
          <div data-testid="agent-timeline" style={{ marginTop: 12 }}>
            {events.map((e) => (
              <div key={e.seq} style={{ display: 'flex', gap: 8, padding: '4px 0', alignItems: 'baseline' }}>
                <span className="muted" style={{ minWidth: 44 }}>{fmtTime(e.createdAt)}</span>
                <span className="muted" style={{ minWidth: 56 }}>#{e.seq}</span>
                <span style={{ minWidth: 60 }}>{EVENT_LABEL[e.eventType]}</span>
                <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}>
                  {e.eventType === 'tool_call' &&
                    `${String((e.payload as { tool?: string }).tool ?? '')} ${
                      (e.payload as { ok?: boolean }).ok === false
                        ? `失败(${String((e.payload as { error?: string }).error ?? '')})`
                        : '完成'
                    }`}
                  {e.eventType === 'plan' && String((e.payload as { goal?: string }).goal ?? '')}
                  {e.eventType === 'error' && String((e.payload as { message?: string }).message ?? '')}
                  {e.eventType === 'confirmation' && `提案 ${(e.payload as { approvalId?: string }).approvalId?.slice(0, 8)}`}
                </span>
              </div>
            ))}
            {events.length === 0 && <div className="muted">暂无轨迹事件</div>}
          </div>

          {/* 结果区:partial 不伪装成功 */}
          {(run.status === 'partial' || run.status === 'failed') && (
            <div data-testid="agent-result-failure" style={{ color: 'var(--danger, #c62828)', marginTop: 10 }}>
              {run.status === 'partial'
                ? '部分步骤失败:已完成的影响保留,失败原因见上方轨迹。'
                : `运行失败${run.errorCode ? `(${run.errorCode})` : ''}:既有影响保留,详见轨迹。`}
            </div>
          )}
        </div>
      )}

      {/* 历史列表 */}
      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 6 }}>最近运行</div>
        {history.length === 0 && <div className="muted">还没有运行记录</div>}
        {history.map((r) => (
          <div
            key={r.runId}
            data-testid="agent-history-item"
            className="row"
            style={{ justifyContent: 'space-between', padding: '4px 0', cursor: 'pointer' }}
            onClick={() => void openRun(r.runId)}
          >
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.input}</span>
            <span style={{ color: statusTone(r.status as RunStatus) }}>{STATUS_LABEL[r.status as RunStatus]}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
