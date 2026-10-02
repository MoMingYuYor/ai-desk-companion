// 评测页(E-07 + EVAL-05 重写):数据集选择、Fake/real 明确标签、冻结配置选择、
// 启动与取消、进度轮询、指标与案例详情、人工审阅与报告导出。
//
// 最小页内切换(不新建复杂平台):
// - 重开页面按 evalRunId 拉状态(输入 run id 即可恢复视图);
// - 观测缺失(toolObservations 空)显式标「未测」,不显示为 0 绕过;
// - 未审对象与 coverage/holdoutComplete 来自审阅总览,unreviewed 显式可见;
// - Fake/real 分列:执行类型单选 + 配置行按 executionKind 打标签,
//   fake 结果不代表模型能力(报告侧同样显著标示)。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderInfo } from '../../../shared/types'
import type {
  EvalCaseArtifactsView,
  EvalCaseOutcomeView,
  EvalConfigView,
  EvalDatasetView,
  EvalReviewOverviewView,
  EvalRunStateView
} from '../../../shared/api'

const DECISION_OPTIONS: Array<{ value: 'supported' | 'contradicted' | 'insufficient'; label: string }> = [
  { value: 'supported', label: '支持' },
  { value: 'contradicted', label: '矛盾' },
  { value: 'insufficient', label: '证据不足' }
]

interface ReviewDraft {
  decision: 'supported' | 'contradicted' | 'insufficient'
  reason: string
}

/** 当前绑定的运行(id + nonce:取消/重开同 id 时强制重新轮询) */
interface ActiveRun {
  id: string
  nonce: number
}

export function EvalsPage({ refreshKey }: { refreshKey: number }): JSX.Element {
  const [datasets, setDatasets] = useState<EvalDatasetView[]>([])
  const [configs, setConfigs] = useState<EvalConfigView[]>([])
  const [datasetVersion, setDatasetVersion] = useState<string>('')
  const [split, setSplit] = useState<'dev' | 'holdout'>('dev')
  const [executionKind, setExecutionKind] = useState<'fake' | 'real'>('fake')
  const [selectedConfigs, setSelectedConfigs] = useState<string[]>([])
  const [repeats, setRepeats] = useState(1)
  const [maxCases, setMaxCases] = useState(5)
  const [runIdInput, setRunIdInput] = useState('')
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null)
  const [state, setState] = useState<EvalRunStateView | null>(null)
  const [report, setReport] = useState<string | null>(null)
  const [reportUrl, setReportUrl] = useState<string | null>(null)
  const [overview, setOverview] = useState<EvalReviewOverviewView | null>(null)
  const [detail, setDetail] = useState<EvalCaseArtifactsView | null>(null)
  const [detailKey, setDetailKey] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({})
  const [reviewer, setReviewer] = useState('人工')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [experimentId, setExperimentId] = useState('adc-rc1')
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const nonceRef = useRef(0)

  const loadMeta = useCallback(async (): Promise<void> => {
    try {
      const [ds, cs] = await Promise.all([window.api.listEvalDatasets(), window.api.listEvalConfigs()])
      setDatasets(ds)
      setConfigs(cs)
      // 缺省选中第一个数据集与全部 fake 配置,减少空表单误操作
      setDatasetVersion((prev) => prev || ds[0]?.version || '')
      setSelectedConfigs((prev) => (prev.length > 0 ? prev : cs.filter((c) => c.executionKind === 'fake').map((c) => c.configId)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => { void loadMeta() }, [loadMeta, refreshKey])

  useEffect(() => {
    if (executionKind !== 'real') return
    let stopped = false
    void (async () => {
      try {
        const items = await window.api.listProviders()
        if (stopped) return
        setProviders(items)
        if (!providerId && items[0]) { setProviderId(items[0].id); setModel(items[0].defaultModel) }
      } catch (err) { if (!stopped) setError(err instanceof Error ? err.message : String(err)) }
    })()
    return () => { stopped = true }
  }, [executionKind, providerId])

  const freezeConfigs = async (): Promise<void> => {
    if (!datasetVersion) { setError('请选择数据集'); return }
    const provider = providers.find(p => p.id === providerId)
    if (executionKind === 'real' && (!provider || !model)) { setError('请选择已配置服务商和模型'); return }
    setBusy(true); setError(null)
    try {
      const result = await window.api.freezeEvalExperiment({ experimentId, datasetVersion,
        stage: datasetVersion.startsWith('personal_ops_') ? 'ops-planning' : 'research-extraction', executionKind,
        target: executionKind === 'real' && provider ? { providerId: provider.id, protocol: provider.protocol, baseUrl: provider.baseUrl, model } : null })
      await loadMeta()
      setSelectedConfigs(result.configIds)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  // 进度轮询:activeRun 变化(启动/取消/重开)即重新绑定;终态后拉报告与审阅总览
  useEffect(() => {
    if (!activeRun) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = async (): Promise<void> => {
      try {
        const [md, ov] = await Promise.all([
          window.api.getEvalReport(activeRun.id),
          window.api.getEvalReviewOverview(activeRun.id)
        ])
        if (stopped) return
        setReport(md)
        setOverview(ov)
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : String(err))
      }
    }
    const tick = async (): Promise<void> => {
      try {
        const s = await window.api.getEvalRun(activeRun.id)
        if (stopped) return
        if (s) {
          setState(s)
          if (s.status !== 'running') { void finish(); return }
        } else if (!state) {
          setError(`未找到评测运行:${activeRun.id}(检查 artifactRoot 是否一致)`)
          return
        }
        timer = setTimeout(() => { void tick() }, 200)
      } catch (err) {
        if (!stopped) { setError(err instanceof Error ? err.message : String(err)) }
      }
    }
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun])

  const startBatch = useCallback(async (): Promise<void> => {
    setError(null)
    if (!datasetVersion) { setError('请选择数据集'); return }
    if (selectedConfigs.length === 0) { setError('请至少选择一个冻结配置'); return }
    setBusy(true)
    try {
      const { evalRunId } = await window.api.startEvalBatch({
        datasetVersion,
        split,
        executionKind,
        configIds: selectedConfigs,
        repeats,
        maxCases
      })
      setState(null)
      setReport(null)
      setReportUrl(null)
      setOverview(null)
      setDetail(null)
      setDetailKey(null)
      nonceRef.current += 1
      setActiveRun({ id: evalRunId, nonce: nonceRef.current })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [datasetVersion, split, executionKind, selectedConfigs, repeats, maxCases])

  const cancelRun = useCallback(async (): Promise<void> => {
    if (!activeRun) return
    setBusy(true)
    try {
      await window.api.cancelEvalRun(activeRun.id)
      // 取消后立即重拉:终态(cancelled)与已完成结果原样展示
      nonceRef.current += 1
      setActiveRun({ id: activeRun.id, nonce: nonceRef.current })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [activeRun])

  const openRun = useCallback(async (): Promise<void> => {
    const id = runIdInput.trim()
    if (!id) { setError('请输入 evalRunId'); return }
    setError(null)
    try {
      const s = await window.api.getEvalRun(id)
      if (!s) { setError(`未找到评测运行:${id}`); return }
      setState(s)
      setReport(null)
      setReportUrl(null)
      setOverview(null)
      setDetail(null)
      setDetailKey(null)
      nonceRef.current += 1
      setActiveRun({ id, nonce: nonceRef.current })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [runIdInput])

  const openDetail = useCallback(async (r: EvalCaseOutcomeView): Promise<void> => {
    if (!state) return
    try {
      const artifacts = await window.api.getEvalCaseArtifacts(state.evalRunId, r.configId, r.caseId, r.repeatIndex)
      setDetail(artifacts)
      setDetailKey(`${r.configId}/${r.caseId}/${r.repeatIndex}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [state])

  const submitReview = useCallback(async (subjectKey: string): Promise<void> => {
    if (!overview) return
    const subject = overview.subjects.find((s) => s.subjectKey === subjectKey)
    if (!subject) return
    const draft = drafts[subjectKey] ?? { decision: 'supported' as const, reason: '' }
    setBusy(true)
    try {
      await window.api.saveEvalReview({
        evalRunId: overview.evalRunId,
        configId: subject.configId,
        caseId: subject.caseId,
        repeatIndex: subject.repeatIndex,
        claimId: subject.claimId,
        evidenceId: subject.evidenceId,
        decision: draft.decision,
        reason: draft.reason,
        reviewer: reviewer.trim() || '人工'
      })
      const ov = await window.api.getEvalReviewOverview(overview.evalRunId)
      setOverview(ov)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [overview, drafts, reviewer])

  const exportReport = useCallback(async (): Promise<void> => {
    if (!state) return
    try {
      const md = await window.api.getEvalReport(state.evalRunId)
      setReport(md)
      // 环境支持 Blob URL 时提供下载链接(真实应用点击保存;jsdom 无该能力则仅展示)
      if (md && typeof URL.createObjectURL === 'function') {
        setReportUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev)
          return URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [state])

  const running = state?.status === 'running'
  const results = state?.results ?? []
  const missingObservation = results.filter(
    (r) => r.status !== 'not_run' && (!r.toolObservations || r.toolObservations.length === 0)
  ).length

  return (
    <div className="page" style={{ flexDirection: 'column', gap: 12 }}>
      <div className="row"><span className="muted">用固定数据集检验 Agent 的质量与安全(fake 只验证工程流程,不代表模型能力)</span></div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 6 }}>评测数据集</div>
        {datasets.length === 0 && <div className="muted">暂无已注册的数据集</div>}
        {datasets.map((d) => (
          <label key={d.version} className="row" style={{ justifyContent: 'flex-start', gap: 8, padding: '2px 0' }}>
            <input
              type="radio"
              name="eval-dataset"
              data-testid={`evals-dataset-${d.version}`}
              checked={datasetVersion === d.version}
              onChange={() => setDatasetVersion(d.version)}
            />
            <span>{d.version}(共 {d.total} 条,dev {d.dev} / holdout {d.holdout})</span>
          </label>
        ))}
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 6 }}>执行设置</div>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <label className="row" style={{ gap: 4 }}>
            <input type="radio" name="eval-kind" data-testid="evals-kind-fake" checked={executionKind === 'fake'} onChange={() => setExecutionKind('fake')} />
            <span>fake(离线流程验证)</span>
          </label>
          <label className="row" style={{ gap: 4 }}>
            <input type="radio" name="eval-kind" data-testid="evals-kind-real" checked={executionKind === 'real'} onChange={() => setExecutionKind('real')} />
            <span>real(真实模型)</span>
          </label>
          <label className="row" style={{ gap: 4 }}>
            <span className="muted">split</span>
            <select data-testid="evals-split" value={split} onChange={(e) => setSplit(e.target.value as 'dev' | 'holdout')}>
              <option value="dev">dev</option>
              <option value="holdout">holdout</option>
            </select>
          </label>
          <label className="row" style={{ gap: 4 }}>
            <span className="muted">repeats</span>
            <input type="number" min={1} max={10} data-testid="evals-repeats" value={repeats} onChange={(e) => setRepeats(Math.max(1, Number(e.target.value) || 1))} style={{ width: 64 }} />
          </label>
          <label className="row" style={{ gap: 4 }}>
            <span className="muted">max-cases</span>
            <input type="number" min={1} data-testid="evals-max-cases" value={maxCases} onChange={(e) => setMaxCases(Math.max(1, Number(e.target.value) || 1))} style={{ width: 72 }} />
          </label>
        </div>
        <div style={{ marginTop: 8, fontWeight: 600 }}>冻结配置</div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          <label>实验名称 <input data-testid="evals-experiment" value={experimentId} onChange={e => setExperimentId(e.target.value)} /></label>
          {executionKind === 'real' && <>
            <select aria-label="评测服务商" value={providerId} onChange={e => { setProviderId(e.target.value); setModel(providers.find(p => p.id === e.target.value)?.defaultModel ?? '') }}>
              {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select aria-label="评测模型" value={model} onChange={e => setModel(e.target.value)}>
              {(providers.find(p => p.id === providerId)?.models ?? []).map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </>}
          <button data-testid="evals-freeze" disabled={busy || !datasetVersion} onClick={() => void freezeConfigs()}>创建对照配置</button>
        </div>
        {configs.length === 0 && <div className="muted">暂无冻结配置(fake-flow-v1 会在启动时自动注册)</div>}
        {configs.map((c) => (
          <label key={c.configId} className="row" style={{ justifyContent: 'flex-start', gap: 8, padding: '2px 0' }}>
            <input
              type="checkbox"
              data-testid={`evals-config-${c.configId}`}
              checked={selectedConfigs.includes(c.configId)}
              onChange={(e) =>
                setSelectedConfigs((prev) =>
                  e.target.checked ? [...prev, c.configId] : prev.filter((id) => id !== c.configId)
                )
              }
            />
            <span>
              {c.configId}
              <span
                style={{
                  marginLeft: 6,
                  padding: '0 6px',
                  borderRadius: 8,
                  fontSize: 12,
                  background: c.executionKind === 'fake' ? 'var(--muted-bg, #eee)' : 'var(--accent-bg, #d6e4ff)'
                }}
              >
                {c.executionKind === 'fake' ? 'Fake' : 'Real'}
              </span>
              <span className="muted" style={{ marginLeft: 6 }}>{c.model} / {c.pipelineVariant}</span>
            </span>
          </label>
        ))}
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <button data-testid="evals-start" disabled={busy || running} onClick={() => void startBatch()}>
            {busy || running ? '运行中…' : `启动 ${executionKind === 'fake' ? 'fake' : 'real'} 评测`}
          </button>
          <button data-testid="evals-cancel" disabled={!running || busy} onClick={() => void cancelRun()}>取消</button>
        </div>
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 6 }}>按 evalRunId 重开</div>
        <div className="row" style={{ gap: 8 }}>
          <input
            data-testid="evals-runid-input"
            placeholder="eval-…"
            value={runIdInput}
            onChange={(e) => setRunIdInput(e.target.value)}
            style={{ flex: 1 }}
          />
          <button data-testid="evals-runid-open" onClick={() => void openRun()}>打开</button>
        </div>
      </div>

      {error && <div className="card" style={{ color: 'var(--danger, #c62828)' }} data-testid="evals-error">{error}</div>}

      {state && (
        <div className="card" data-testid="evals-run">
          <div style={{ fontWeight: 600 }}>批次 {state.evalRunId}</div>
          <div className="muted" data-testid="evals-run-status">
            状态:{state.status}{state.stopReason ? `(终止原因:${state.stopReason})` : ''}
            ;数据集:{state.datasetVersion};split:{state.splits.join('/')};配置:{state.configIds.join(', ')}
            ;执行:<span data-testid="evals-run-kind">{state.executionKind === 'fake' ? 'Fake(不代表模型能力)' : 'Real'}</span>
          </div>
          <div className="muted" data-testid="evals-metrics">
            通过:{results.filter((r) => r.status === 'passed').length} /
            失败:{results.filter((r) => r.status === 'failed').length} /
            未启动:{results.filter((r) => r.status === 'not_run').length} /
            观测缺失:{missingObservation}(未测不计入安全结论)
          </div>
        </div>
      )}

      {results.length > 0 && (
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>案例结果</div>
          {results.map((r, i) => (
            <div key={`${r.configId}/${r.caseId}/${r.repeatIndex}`} className="row" style={{ justifyContent: 'space-between', padding: '3px 0' }} data-testid={`evals-case-${i}`}>
              <span>
                <span data-testid={`evals-case-status-${i}`}>{r.status}</span>
                {' '}· {r.caseId}({r.configId} × {r.repeatIndex})
                {r.status !== 'not_run' && (!r.toolObservations || r.toolObservations.length === 0) && (
                  <span className="muted" data-testid={`evals-case-unobserved-${i}`}> · 观测未测(缺观测)</span>
                )}
                {r.failureReasons.length > 0 && <span style={{ color: 'var(--danger, #c62828)' }}> · {r.failureReasons.join(';')}</span>}
              </span>
              <button data-testid={`evals-case-detail-${i}`} onClick={() => { void openDetail(r) }}>详情</button>
            </div>
          ))}
        </div>
      )}

      {detail && (
        <div className="card" data-testid="evals-detail">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>案例产物详情({detailKey})</div>
          {!detail.ok && (
            <div style={{ color: 'var(--danger, #c62828)' }} data-testid="evals-detail-integrity">
              产物完整性校验失败:{detail.manifestError ?? ''}{detail.missing.length > 0 ? ` 缺失:${detail.missing.join(', ')}` : ''}{detail.mismatched.length > 0 ? ` hash 不符:${detail.mismatched.join(', ')}` : ''}
            </div>
          )}
          {detail.ok && (
            <>
              <div className="muted" data-testid="evals-detail-manifest">
                manifest complete={String((detail.manifest as { complete?: boolean } | null)?.complete ?? false)}
                ;文件数:{Array.isArray((detail.manifest as { files?: unknown[] } | null)?.files) ? (detail.manifest as { files: unknown[] }).files.length : 0}
              </div>
              <div className="muted" data-testid="evals-detail-observations">
                观测:{(detail.observations?.length ?? 0) === 0 ? '未测(缺观测)' : `${detail.observations!.length} 条`}
                ;规则判分:{detail.ruleChecks?.length ?? 0} 条
              </div>
            </>
          )}
        </div>
      )}

      {overview && (
        <div className="card" data-testid="evals-review">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>人工审阅</div>
          <div className="muted" data-testid="evals-review-coverage">
            复核覆盖率:{overview.coverage.value === null ? 'N/A' : `${Math.round(overview.coverage.value * 100)}%`}({overview.coverage.reviewed}/{overview.coverage.expected})
            ;holdout {overview.holdoutComplete ? '已完成' : '未完成(coverage 不足 100% 不得判通过)'}
          </div>
          <div className="muted" data-testid="evals-review-unreviewed">
            未审:{overview.unreviewed.length} 条{overview.unreviewed.length > 0 ? '(未审不计入支持精度分母,不能以少量已审高分判通过)' : ''}
          </div>
          {overview.subjects.length === 0 && <div className="muted">本批次没有待审的 claim-evidence 对(ops 案例无研究证据,属正常)</div>}
          {overview.subjects.map((s, i) => {
            const draft = drafts[s.subjectKey] ?? { decision: 'supported' as const, reason: '' }
            return (
              <div key={s.subjectKey} className="row" style={{ flexWrap: 'wrap', gap: 6, padding: '4px 0' }} data-testid={`evals-review-subject-${i}`}>
                <span className="muted">{s.caseId} · {s.claimId} · {s.evidenceId}{s.latest ? ` · 已审:${s.latest.decision}` : ' · 未审'}</span>
                <select
                  data-testid={`evals-review-decision-${i}`}
                  value={draft.decision}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [s.subjectKey]: { ...draft, decision: e.target.value as ReviewDraft['decision'] } }))}
                >
                  {DECISION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <input
                  data-testid={`evals-review-reason-${i}`}
                  placeholder="审阅理由(必填)"
                  value={draft.reason}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [s.subjectKey]: { ...draft, reason: e.target.value } }))}
                  style={{ flex: 1, minWidth: 160 }}
                />
                <input
                  data-testid="evals-review-reviewer"
                  value={reviewer}
                  onChange={(e) => setReviewer(e.target.value)}
                  style={{ width: 90 }}
                />
                <button data-testid={`evals-review-submit-${i}`} disabled={busy} onClick={() => { void submitReview(s.subjectKey) }}>提交审阅</button>
              </div>
            )
          })}
        </div>
      )}

      {report && (
        <div className="card" data-testid="evals-report">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>评测报告</div>
            <div className="row" style={{ gap: 8 }}>
              {reportUrl && (
                <a data-testid="evals-report-download" href={reportUrl} download={`eval-${state?.evalRunId ?? 'run'}-report.md`}>
                  下载报告
                </a>
              )}
              <button data-testid="evals-report-export" onClick={() => { void exportReport() }}>导出报告</button>
            </div>
          </div>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{report}</pre>
        </div>
      )}
    </div>
  )
}
