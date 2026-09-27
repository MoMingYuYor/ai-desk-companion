// 评测页(E-07):数据集概览 + 批次启动 + 指标与报告展示。
// 最小可用版本:覆盖数据集发现、fake 批次执行、报告 Markdown 渲染。

import { useCallback, useEffect, useState } from 'react'
import { Channels } from '../../../shared/api'
import { useSubscribe } from '../../shared/util'

interface DatasetInfo { version: string; total: number }
interface EvalRunState {
  evalRunId: string
  status: string
  datasetVersion: string
  results: Array<{ caseId: string; status: string; failureReasons: string[] }>
}

export function EvalsPage({ refreshKey }: { refreshKey: number }): JSX.Element {
  const [datasets, setDatasets] = useState<DatasetInfo[]>([])
  const [evalRunId, setEvalRunId] = useState<string | null>(null)
  const [state, setState] = useState<EvalRunState | null>(null)
  const [report, setReport] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const loadDatasets = useCallback(async () => {
    try {
      setDatasets(await window.api.listEvalDatasets())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => { void loadDatasets() }, [loadDatasets, refreshKey])

  const startBatch = useCallback(async (version: string) => {
    setRunning(true)
    setError(null)
    try {
      const { evalRunId } = await window.api.startEvalBatch({
        datasetVersion: version, splits: ['dev', 'holdout']
      })
      setEvalRunId(evalRunId)
      // 轮询直到终态(fake 模式应很快)
      const poll = async (): Promise<void> => {
        const s = await window.api.getEvalRun(evalRunId) as EvalRunState | null
        if (s && s.status !== 'running') {
          setState(s)
          const md = await window.api.getEvalReport(evalRunId)
          setReport(md)
          setRunning(false)
          return
        }
        setTimeout(() => void poll(), 500)
      }
      void poll()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setRunning(false)
    }
  }, [])

  return (
    <div className="page" style={{ flexDirection: 'column', gap: 12 }}>
      <div className="row"><span className="muted">用固定数据集检验 Agent 的质量与安全</span></div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 6 }}>评测数据集</div>
        {datasets.length === 0 && <div className="muted">暂无已注册的数据集</div>}
        {datasets.map((d) => (
          <div key={d.version} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
            <span>{d.version}({d.total} 条)</span>
            <button disabled={running} onClick={() => void startBatch(d.version)}>
              {running ? '运行中…' : '启动 fake 评测'}
            </button>
          </div>
        ))}
        {error && <div style={{ color: 'var(--danger, #c62828)', marginTop: 6 }} data-testid="evals-error">{error}</div>}
      </div>

      {state && (
        <div className="card" data-testid="evals-result">
          <div style={{ fontWeight: 600 }}>批次 {state.evalRunId}</div>
          <div className="muted">状态:{state.status}</div>
          <div className="muted">
            通过:{state.results.filter((r) => r.status === 'passed').length} /
            失败:{state.results.filter((r) => r.status === 'failed').length} /
            未启动:{state.results.filter((r) => r.status === 'not_run').length}
          </div>
        </div>
      )}

      {report && (
        <div className="card" data-testid="evals-report">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>评测报告</div>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{report}</pre>
        </div>
      )}
    </div>
  )
}
