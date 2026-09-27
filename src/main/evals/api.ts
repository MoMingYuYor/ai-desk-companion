// 评测 IPC 服务函数(E-07):数据集发现、批次启动、状态与报告。
// 由 ipc.ts 在 Agent 通道旁注册;与 runner 解耦(本层只做 IO 适配)。

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { loadDatasetFromText, type LoadedDataset } from './dataset'
import { EvalRunner, type EvalRunState } from './runner'
import { calculateMetrics } from './metrics'
import { renderEvalReport } from './report'
import { appError } from '../../shared/operations'
import { OperationError } from '../db/operations'

export interface EvalsDeps {
  /** 评测数据集与产物的根目录(生产为 userData/evals) */
  evalsRoot: string
  sqlJsDistDir: string
}

const datasetCache = new Map<string, LoadedDataset>()

export function loadEvalsDataset(evalsRoot: string, version: string): LoadedDataset {
  const cached = datasetCache.get(version)
  if (cached) return cached
  const dir = join(evalsRoot, 'datasets', version)
  if (!existsSync(join(dir, 'cases.jsonl'))) {
    throw new OperationError(appError('VALIDATION', `评测数据集不存在:${version}`, { retryable: false }))
  }
  const jsonl = readFileSync(join(dir, 'cases.jsonl'), 'utf-8')
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'))
  const dataset = loadDatasetFromText(jsonl, manifest)
  datasetCache.set(version, dataset)
  return dataset
}

export function startEvalBatch(deps: EvalsDeps, params: {
  datasetVersion: string
  splits: Array<'dev' | 'holdout'>
}): { evalRunId: string; status: string } {
  const dataset = loadEvalsDataset(deps.evalsRoot, params.datasetVersion)
  const evalRunId = `eval-${Date.now().toString(36)}`
  const artifactRoot = join(deps.evalsRoot, 'artifacts')
  mkdirSync(join(artifactRoot, 'cases'), { recursive: true })

  const runner = new EvalRunner(
    { artifactRoot, sqlJsDistDir: deps.sqlJsDistDir, dataset },
    {
      evalRunId,
      datasetVersion: dataset.manifest.dataset_version,
      casesSha256: dataset.casesSha256,
      splits: params.splits,
      configIds: ['fake_flow'],
      executionKind: 'fake',
      repeats: 1,
      maxCases: 50,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      results: []
    }
  )
  void runner.run().catch((err: unknown) => {
    console.error('[evals] 批次异常:', err instanceof Error ? err.message : String(err))
  })
  return { evalRunId, status: 'running' }
}

export function getEvalRunState(evalsRoot: string, evalRunId: string): EvalRunState | null {
  const stateFile = join(evalsRoot, 'artifacts', evalRunId, 'state.json')
  if (!existsSync(stateFile)) return null
  return JSON.parse(readFileSync(stateFile, 'utf-8')) as EvalRunState
}

export function getEvalReport(evalsRoot: string, evalRunId: string): string | null {
  const state = getEvalRunState(evalsRoot, evalRunId)
  if (!state) return null
  const dataset = loadEvalsDataset(evalsRoot, state.datasetVersion)
  const metrics = calculateMetrics(state, dataset.cases)
  return renderEvalReport({
    state, metrics, dataset,
    reproduceCommand: `npx vitest run tests/evals/ops50.test.ts`
  })
}

export function listEvalDatasets(evalsRoot: string): Array<{ version: string; total: number }> {
  const datasetsDir = join(evalsRoot, 'datasets')
  if (!existsSync(datasetsDir)) return []
  try {
    return readdirSync(datasetsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(datasetsDir, d.name, 'manifest.json')))
      .map((d) => {
        const manifest = JSON.parse(readFileSync(join(datasetsDir, d.name, 'manifest.json'), 'utf-8'))
        return { version: manifest.dataset_version as string, total: manifest.total as number }
      })
  } catch {
    return []
  }
}
