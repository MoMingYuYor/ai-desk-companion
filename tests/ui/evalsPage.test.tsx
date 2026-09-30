// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { EvalsPage } from '../../src/renderer/workbench/pages/EvalsPage'
import type {
  EvalCaseArtifactsView,
  EvalCaseOutcomeView,
  EvalReviewOverviewView,
  EvalRunStateView
} from '../../src/shared/api'

// EVAL-05:评测页组件测试(jsdom + window.api mock,参照 researchPage 惯例)。
// 页面自动化通过只代表 mock IPC 交互通过;Electron 真运行由 E2E-01 单独验收。

afterEach(cleanup)

function outcomeView(over: Partial<EvalCaseOutcomeView> = {}): EvalCaseOutcomeView {
  return {
    configId: 'fake-flow-v1',
    caseId: 'case-1',
    repeatIndex: 0,
    status: 'passed',
    runId: 'run-1',
    terminalStatus: 'succeeded',
    failureReasons: [],
    executedTools: ['todo.list'],
    toolObservations: [{ tool: 'todo.list', ok: true }],
    ruleChecks: [],
    durationMs: 12,
    artifactStatus: 'ok',
    artifactDir: 'eval-t1/fake-flow-v1/case-1/0',
    researchScoring: null,
    actualProvider: null,
    modelAttempts: [],
    ...over
  }
}

function stateView(over: Partial<EvalRunStateView> = {}): EvalRunStateView {
  return {
    evalRunId: 'eval-t1',
    datasetVersion: 'personal_ops_v1',
    casesSha256: 'a'.repeat(64),
    splits: ['dev'],
    configIds: ['fake-flow-v1'],
    executionKind: 'fake',
    repeats: 1,
    maxCases: 5,
    status: 'completed',
    startedAt: '2026-09-30T00:00:00.000Z',
    finishedAt: '2026-09-30T00:01:00.000Z',
    stopReason: null,
    results: [outcomeView()],
    lastInterruption: null,
    ...over
  }
}

function artifactsView(over: Partial<EvalCaseArtifactsView> = {}): EvalCaseArtifactsView {
  return {
    ok: true,
    manifest: { complete: true, files: [{ name: 'run.json', sha256: 'x' }] },
    manifestError: null,
    mismatched: [],
    missing: [],
    run: { caseId: 'case-1' },
    traceEvents: [],
    observations: [{ tool: 'todo.list', ok: true }],
    ruleChecks: [{ key: 'args:todo.list' }],
    evidence: { applicable: false, reason: 'not_applicable' },
    report: { report_applicable: false },
    snapshots: { applicable: false },
    ...over
  }
}

const SUBJECT_KEY = 'eval-t1::fake-flow-v1::case-1::0::claim-1::ev-1'

function overviewView(over: Partial<EvalReviewOverviewView> = {}): EvalReviewOverviewView {
  return {
    evalRunId: 'eval-t1',
    subjects: [
      { subjectKey: SUBJECT_KEY, configId: 'fake-flow-v1', caseId: 'case-1', repeatIndex: 0, claimId: 'claim-1', evidenceId: 'ev-1', latest: null }
    ],
    coverage: { value: 0, reviewed: 0, expected: 1 },
    supportPrecision: { value: null, reviewed: 0, supported: 0 },
    holdoutComplete: false,
    unreviewed: [SUBJECT_KEY],
    ...over
  }
}

type Listener = (...args: unknown[]) => void

interface Harness {
  startEval: ReturnType<typeof vi.fn>
  cancelEval: ReturnType<typeof vi.fn>
  saveReview: ReturnType<typeof vi.fn>
  getRun: ReturnType<typeof vi.fn>
  listeners: Map<string, Listener[]>
}

function installApi(over: {
  datasets?: Array<{ version: string; total: number; dev: number; holdout: number }>
  configs?: Array<{ configId: string; executionKind: 'fake' | 'real'; pipelineVariant: string; model: string; providerId: string; rubricVersion: string }>
  runStates?: Array<EvalRunStateView | null>
  state?: EvalRunStateView | null
  report?: string | null
  artifacts?: EvalCaseArtifactsView | null
  overview?: EvalReviewOverviewView | null
  /** 取消后的状态(未提供 runStates 时:取消前一直 running,取消后返回该状态) */
  afterCancel?: EvalRunStateView
} = {}): Harness {
  const listeners = new Map<string, Listener[]>()
  let runCall = 0
  let cancelCalled = false
  const getRun = vi.fn(async () => {
    if (over.runStates && over.runStates.length > 0) {
      const s = over.runStates[Math.min(runCall, over.runStates.length - 1)]!
      runCall += 1
      return s
    }
    // 取消后的状态优先;显式区分「未提供」与「明确 null(未知 run)」
    if (over.afterCancel && cancelCalled) return over.afterCancel
    if (over.state !== undefined) return over.state
    return stateView()
  })
  const startEval = vi.fn(async () => ({ evalRunId: 'eval-t1', status: 'running' }))
  const cancelEval = vi.fn(async () => {
    cancelCalled = true
    return { cancelled: true }
  })
  const saveReview = vi.fn(async (input: Record<string, unknown>) => ({
    reviewId: 'rv-1',
    subjectKey: `${input.evalRunId}::${input.configId}::${input.caseId}::${String(input.repeatIndex)}::${input.claimId}::${input.evidenceId}`,
    decision: input.decision,
    reason: input.reason,
    reviewer: input.reviewer,
    rubricVersion: 'rubric-v1',
    reviewedAt: '2026-09-30T00:02:00.000Z'
  }))
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    listEvalDatasets: vi.fn(async () => over.datasets ?? [{ version: 'personal_ops_v1', total: 50, dev: 30, holdout: 20 }]),
    listEvalConfigs: vi.fn(
      async () =>
        over.configs ?? [
          { configId: 'fake-flow-v1', executionKind: 'fake', pipelineVariant: 'baseline', model: 'fake-model', providerId: 'eval-fake', rubricVersion: 'rubric-v1' },
          { configId: 'real-x', executionKind: 'real', pipelineVariant: 'baseline', model: 'gpt-x', providerId: 'prov-1', rubricVersion: 'rubric-v1' }
        ]
    ),
    startEvalBatch: startEval,
    getEvalRun: getRun,
    cancelEvalRun: cancelEval,
    getEvalReport: vi.fn(async () => over.report ?? '# 评测报告:eval-t1\n\n| 指标 | 值 |'),
    getEvalCaseArtifacts: vi.fn(async () => over.artifacts ?? artifactsView()),
    saveEvalReview: saveReview,
    getEvalReviewOverview: vi.fn(async () => over.overview ?? overviewView()),
    on: vi.fn((channel: string, listener: Listener) => {
      const list = listeners.get(channel) ?? []
      list.push(listener)
      listeners.set(channel, list)
      return () => {
        listeners.set(channel, (listeners.get(channel) ?? []).filter((l) => l !== listener))
      }
    })
  }
  return { startEval, cancelEval, saveReview, getRun, listeners }
}

async function startBatch(): Promise<void> {
  fireEvent.click(screen.getByTestId('evals-start'))
  await waitFor(() => expect(screen.getByTestId('evals-run')).toBeTruthy())
}

// ---------- 发现与标签 ----------

describe('EvalsPage 数据集与配置发现', () => {
  it('渲染数据集与冻结配置,配置带 Fake/Real 标签;fake 配置默认勾选', async () => {
    installApi()
    render(<EvalsPage refreshKey={0} />)
    await waitFor(() => expect(screen.getByTestId('evals-dataset-personal_ops_v1')).toBeTruthy())
    // 第一个数据集默认选中
    expect((screen.getByTestId('evals-dataset-personal_ops_v1') as HTMLInputElement).checked).toBe(true)
    // 配置标签:fake 与 real 明确分列(执行类型单选同样可见)
    await waitFor(() => expect(screen.getByTestId('evals-config-fake-flow-v1')).toBeTruthy())
    expect(screen.getByTestId('evals-config-real-x')).toBeTruthy()
    expect((screen.getByTestId('evals-config-fake-flow-v1') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('evals-config-real-x') as HTMLInputElement).checked).toBe(false)
    expect(screen.getByTestId('evals-kind-fake')).toBeTruthy()
    expect(screen.getByTestId('evals-kind-real')).toBeTruthy()
    expect(screen.getByTestId('evals-config-real-x').parentElement?.textContent).toContain('Real')
    expect(screen.getByTestId('evals-config-fake-flow-v1').parentElement?.textContent).toContain('Fake')
  })

  it('数据集发现失败:显示具体错误,不显示空数据集假象', async () => {
    installApi()
    ;(window.api as unknown as Record<string, ReturnType<typeof vi.fn>>).listEvalDatasets = vi.fn(async () => {
      throw new Error('评测数据集根目录不存在:/resources/evals/datasets')
    })
    render(<EvalsPage refreshKey={0} />)
    await waitFor(() => expect(screen.getByTestId('evals-error').textContent).toContain('评测数据集根目录不存在'))
  })
})

// ---------- 启动 / 取消 / 进度 / 指标 ----------

describe('EvalsPage 启动与取消', () => {
  it('启动调用携带完整参数(数据集/split/执行类型/配置/repeats/max-cases)并轮询到终态', async () => {
    const h = installApi({
      runStates: [stateView({ status: 'running', results: [] }), stateView()]
    })
    render(<EvalsPage refreshKey={0} />)
    await waitFor(() => expect(screen.getByTestId('evals-config-fake-flow-v1')).toBeTruthy())
    fireEvent.change(screen.getByTestId('evals-repeats'), { target: { value: '2' } })
    fireEvent.change(screen.getByTestId('evals-max-cases'), { target: { value: '5' } })
    await startBatch()
    await waitFor(() => expect(h.startEval).toHaveBeenCalledTimes(1))
    expect(h.startEval).toHaveBeenCalledWith({
      datasetVersion: 'personal_ops_v1',
      split: 'dev',
      executionKind: 'fake',
      configIds: ['fake-flow-v1'],
      repeats: 2,
      maxCases: 5
    })
    // 终态后:指标与报告展示(通过/失败/未启动/观测缺失分列)
    await waitFor(() => expect(screen.getByTestId('evals-metrics').textContent).toContain('通过:1'))
    expect(screen.getByTestId('evals-metrics').textContent).toContain('未启动:0')
    await waitFor(() => expect(screen.getByTestId('evals-report').textContent).toContain('评测报告'))
    expect(screen.getByTestId('evals-run-kind').textContent).toContain('Fake')
  }, 15000)

  it('运行中可取消:调用 cancelEvalRun 并显示取消态', async () => {
    const h = installApi({
      state: stateView({ status: 'running', results: [] }),
      afterCancel: stateView({ status: 'cancelled', stopReason: 'user_cancelled', results: [] })
    })
    render(<EvalsPage refreshKey={0} />)
    await waitFor(() => expect(screen.getByTestId('evals-config-fake-flow-v1')).toBeTruthy())
    await startBatch()
    await waitFor(() => expect((screen.getByTestId('evals-cancel') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('evals-cancel'))
    await waitFor(() => expect(h.cancelEval).toHaveBeenCalledWith('eval-t1'))
    await waitFor(() => expect(screen.getByTestId('evals-run-status').textContent).toContain('cancelled'))
  }, 15000)

  it('启动参数校验:未选配置时不发启动请求', async () => {
    const h = installApi()
    render(<EvalsPage refreshKey={0} />)
    await waitFor(() => expect(screen.getByTestId('evals-config-fake-flow-v1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('evals-config-fake-flow-v1')) // 取消勾选
    fireEvent.click(screen.getByTestId('evals-start'))
    await waitFor(() => expect(screen.getByTestId('evals-error').textContent).toContain('冻结配置'))
    expect(h.startEval).not.toHaveBeenCalled()
  })
})

// ---------- 案例详情与观测缺失 ----------

describe('EvalsPage 案例详情', () => {
  it('详情按钮按 (run, config, case, repeat) 查询产物并展示观测计数', async () => {
    const h = installApi()
    render(<EvalsPage refreshKey={0} />)
    await waitFor(() => expect(screen.getByTestId('evals-config-fake-flow-v1')).toBeTruthy())
    fireEvent.change(screen.getByTestId('evals-runid-input'), { target: { value: 'eval-t1' } })
    fireEvent.click(screen.getByTestId('evals-runid-open'))
    await waitFor(() => expect(screen.getByTestId('evals-run')).toBeTruthy())
    expect(h.getRun).toHaveBeenCalledWith('eval-t1')
    fireEvent.click(screen.getByTestId('evals-case-detail-0'))
    await waitFor(() =>
      expect((window.api as unknown as { getEvalCaseArtifacts: ReturnType<typeof vi.fn> }).getEvalCaseArtifacts).toHaveBeenCalledWith(
        'eval-t1', 'fake-flow-v1', 'case-1', 0
      )
    )
    await waitFor(() => expect(screen.getByTestId('evals-detail-observations').textContent).toContain('1 条'))
    expect(screen.getByTestId('evals-detail-manifest').textContent).toContain('complete=true')
  })

  it('观测缺失的案例显式标注「观测未测」;产物损坏显示完整性原因', async () => {
    installApi({
      state: stateView({
        results: [
          outcomeView({ toolObservations: null, status: 'failed', failureReasons: ['终态 failed ≠ 期望 succeeded'] }),
          outcomeView({ caseId: 'case-2' })
        ]
      }),
      artifacts: artifactsView({ ok: false, manifestError: 'manifest.complete !== true(导出未完成)' })
    })
    render(<EvalsPage refreshKey={0} />)
    await waitFor(() => expect(screen.getByTestId('evals-config-fake-flow-v1')).toBeTruthy())
    fireEvent.change(screen.getByTestId('evals-runid-input'), { target: { value: 'eval-t1' } })
    fireEvent.click(screen.getByTestId('evals-runid-open'))
    await waitFor(() => expect(screen.getByTestId('evals-run')).toBeTruthy())
    expect(screen.getByTestId('evals-case-unobserved-0').textContent).toContain('观测未测')
    expect(screen.getByTestId('evals-metrics').textContent).toContain('观测缺失:1')
    fireEvent.click(screen.getByTestId('evals-case-detail-0'))
    await waitFor(() => expect(screen.getByTestId('evals-detail-integrity').textContent).toContain('导出未完成'))
  })
})

// ---------- 人工审阅 ----------

describe('EvalsPage 人工审阅', () => {
  it('未审数量与 coverage 可见;提交调用 saveEvalReview 并携带六段引用与理由', async () => {
    const h = installApi()
    render(<EvalsPage refreshKey={0} />)
    await waitFor(() => expect(screen.getByTestId('evals-config-fake-flow-v1')).toBeTruthy())
    fireEvent.change(screen.getByTestId('evals-runid-input'), { target: { value: 'eval-t1' } })
    fireEvent.click(screen.getByTestId('evals-runid-open'))
    await waitFor(() => expect(screen.getByTestId('evals-review')).toBeTruthy())
    expect(screen.getByTestId('evals-review-unreviewed').textContent).toContain('未审:1 条')
    expect(screen.getByTestId('evals-review-coverage').textContent).toContain('0/1')
    expect(screen.getByTestId('evals-review-coverage').textContent).toContain('未完成')
    fireEvent.change(screen.getByTestId('evals-review-decision-0'), { target: { value: 'contradicted' } })
    fireEvent.change(screen.getByTestId('evals-review-reason-0'), { target: { value: '引用片段不支持该结论' } })
    fireEvent.click(screen.getByTestId('evals-review-submit-0'))
    await waitFor(() => expect(h.saveReview).toHaveBeenCalledTimes(1))
    expect(h.saveReview).toHaveBeenCalledWith({
      evalRunId: 'eval-t1',
      configId: 'fake-flow-v1',
      caseId: 'case-1',
      repeatIndex: 0,
      claimId: 'claim-1',
      evidenceId: 'ev-1',
      decision: 'contradicted',
      reason: '引用片段不支持该结论',
      reviewer: '人工'
    })
  })

  it('无待审对象(ops 批次)显示说明,不显示审阅表单', async () => {
    installApi({
      overview: overviewView({ subjects: [], unreviewed: [], coverage: { value: null, reviewed: 0, expected: 0 } })
    })
    render(<EvalsPage refreshKey={0} />)
    await waitFor(() => expect(screen.getByTestId('evals-config-fake-flow-v1')).toBeTruthy())
    fireEvent.change(screen.getByTestId('evals-runid-input'), { target: { value: 'eval-t1' } })
    fireEvent.click(screen.getByTestId('evals-runid-open'))
    await waitFor(() => expect(screen.getByTestId('evals-run')).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId('evals-review-unreviewed').textContent).toContain('未审:0 条'))
    expect(screen.getByTestId('evals-review').textContent).toContain('没有待审的 claim-evidence 对')
    expect(screen.queryByTestId('evals-review-submit-0')).toBeNull()
  })
})

// ---------- 导出与重开 ----------

describe('EvalsPage 导出与重开', () => {
  it('导出报告重新拉取报告内容并提供下载链接', async () => {
    installApi()
    render(<EvalsPage refreshKey={0} />)
    await waitFor(() => expect(screen.getByTestId('evals-config-fake-flow-v1')).toBeTruthy())
    fireEvent.change(screen.getByTestId('evals-runid-input'), { target: { value: 'eval-t1' } })
    fireEvent.click(screen.getByTestId('evals-runid-open'))
    await waitFor(() => expect(screen.getByTestId('evals-report')).toBeTruthy())
    fireEvent.click(screen.getByTestId('evals-report-export'))
    await waitFor(() =>
      expect((window.api as unknown as { getEvalReport: ReturnType<typeof vi.fn> }).getEvalReport).toHaveBeenCalledWith('eval-t1')
    )
    expect(screen.getByTestId('evals-report').textContent).toContain('| 指标 | 值 |')
    // jsdom 支持 Blob URL 时提供下载链接(真实应用点击保存)
    if (typeof URL.createObjectURL === 'function') {
      await waitFor(() => expect(screen.getByTestId('evals-report-download')).toBeTruthy())
    }
  })

  it('重开不存在的 run:显示未找到', async () => {
    installApi({ state: null })
    render(<EvalsPage refreshKey={0} />)
    await waitFor(() => expect(screen.getByTestId('evals-config-fake-flow-v1')).toBeTruthy())
    fireEvent.change(screen.getByTestId('evals-runid-input'), { target: { value: 'eval-missing' } })
    fireEvent.click(screen.getByTestId('evals-runid-open'))
    await waitFor(() => expect(screen.getByTestId('evals-error').textContent).toContain('未找到评测运行:eval-missing'))
  })

  it('real 执行类型切换后启动参数携带 executionKind=real', async () => {
    const h = installApi({ runStates: [stateView({ status: 'running', results: [] }), stateView()] })
    render(<EvalsPage refreshKey={0} />)
    await waitFor(() => expect(screen.getByTestId('evals-kind-real')).toBeTruthy())
    fireEvent.click(screen.getByTestId('evals-kind-real'))
    // 先取消默认勾选的 fake 配置,再勾选 real 配置
    fireEvent.click(screen.getByTestId('evals-config-fake-flow-v1'))
    fireEvent.click(screen.getByTestId('evals-config-real-x'))
    await startBatch()
    await waitFor(() => expect(h.startEval).toHaveBeenCalledTimes(1))
    const arg = h.startEval.mock.calls[0]![0] as Record<string, unknown>
    expect(arg.executionKind).toBe('real')
    expect(arg.configIds).toEqual(['real-x'])
  }, 15000)
})
