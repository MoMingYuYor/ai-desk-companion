import { describe, expect, it } from 'vitest'
import { calculateMetrics, latencyPercentiles } from '../../src/main/evals/metrics'
import { checkComparable, registerFrozenConfig } from '../../src/main/evals/comparison'
import { ReviewStore, reviewCompliance } from '../../src/main/evals/reviews'
import { renderEvalReport } from '../../src/main/evals/report'
import type { EvalCaseOutcome, EvalRunState } from '../../src/main/evals/runner'
import type { EvalCase } from '../../src/main/evals/types'

// E-04~E-07:指标、对比、复核、报告。手算固定数组核对(E-04 验收)。

const NOW = '2026-09-28T01:00:00.000Z'

function outcome(over: Partial<EvalCaseOutcome>): EvalCaseOutcome {
  return {
    configId: 'cfg',
    caseId: 'c',
    repeatIndex: 0,
    status: 'passed',
    runId: 'r',
    terminalStatus: 'succeeded',
    failureReasons: [],
    executedTools: ['todo.list'],
    confirmedBypass: false,
    ...over
  }
}

function caseDef(id: string, toolSequence?: string[]): EvalCase {
  return {
    schema_version: 1,
    case_id: id,
    dataset_version: 'personal_ops_v1',
    mode: 'personal_ops',
    category: '测试',
    split: 'dev',
    input: '任务',
    fixture_id: 'ops-empty',
    clock: NOW,
    timezone: 'Asia/Shanghai',
    expected: { terminal_status: 'succeeded', ...(toolSequence ? { tool_sequence: toolSequence } : {}) },
    interaction_script: [],
    budgets: {},
    tags: []
  }
}

function stateOf(results: EvalCaseOutcome[]): Pick<EvalRunState, 'results'> {
  return { results }
}

describe('指标公式(手算核对)', () => {
  it('完成率:4 启动中 3 通过 = 0.75;not_run 不进分母', () => {
    const results = [
      outcome({ caseId: 'a', status: 'passed' }),
      outcome({ caseId: 'b', status: 'passed' }),
      outcome({ caseId: 'c', status: 'passed' }),
      outcome({ caseId: 'd', status: 'failed' }),
      outcome({ caseId: 'e', status: 'not_run' })
    ]
    const m = calculateMetrics(stateOf(results), [])
    expect(m.completion).toEqual({ value: 0.75, n: 3, denominator: 4 })
  })

  it('工具选择准确率:分母只算有 gold 序列的案例', () => {
    const cases = [caseDef('g1', ['todo.list']), caseDef('g2', ['todo.list']), caseDef('ng', undefined)]
    const results = [
      outcome({ caseId: 'g1', executedTools: ['todo.list'] }),
      outcome({ caseId: 'g2', executedTools: ['todo.create'] }),
      outcome({ caseId: 'ng', executedTools: [] })
    ]
    const m = calculateMetrics(stateOf(results), cases)
    expect(m.toolSelection).toEqual({ value: 0.5, n: 1, denominator: 2 })
  })

  it('零分母:N/A(不输出 NaN 或 100%)', () => {
    const m = calculateMetrics(stateOf([]), [])
    expect(m.completion.value).toBeNull()
    expect(m.completion.denominator).toBe(0)
    expect(m.toolSelection.value).toBeNull()
  })

  it('确认绕过与已尝试写次数分列', () => {
    const results = [
      outcome({ caseId: 'w1', executedTools: ['todo.create'], confirmedBypass: false }),
      outcome({ caseId: 'w2', executedTools: ['todo.create'], confirmedBypass: true })
    ]
    const m = calculateMetrics(stateOf(results), [])
    expect(m.confirmationBypass).toEqual({ count: 1, attemptedWrites: 2 })
  })
})

describe('latencyPercentiles', () => {
  it('p95 用排序后 ceil(0.95*n)-1 索引;n<20 标小样本', () => {
    const lat = latencyPercentiles([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0)
    expect(lat.p50Ms).toBe(50)
    expect(lat.p95Ms).toBe(100)
    expect(lat.smallSample).toBe(true)
  })

  it('空序列 N/A;null 值(未知 usage)被过滤', () => {
    const lat = latencyPercentiles([null, undefined as unknown as number], 0)
    expect(lat.p50Ms).toBeNull()
    expect(lat.p95Ms).toBeNull()
  })
})

describe('可比性守卫(E-05)', () => {
  it('不同 split 与 fake/real 混排:拒绝比较并给出理由', () => {
    registerFrozenConfig({
      config_id: 'cfg-a',
      description: 'A',
      execution_kind: 'fake',
      freeze_note: 'code@123, prompt@abc'
    })
    const a = {
      configId: 'cfg-a',
      datasetVersion: 'personal_ops_v1',
      casesSha256: 'hash1',
      splits: ['dev' as const],
      executionKind: 'fake' as const
    }
    const b = { ...a, splits: ['dev', 'holdout'] as const, executionKind: 'real' as const, configId: 'cfg-b' }
    const verdict = checkComparable(a, b)
    expect(verdict.comparable).toBe(false)
    expect(verdict.reasons.some((r) => r.includes('split'))).toBe(true)
    expect(verdict.reasons.some((r) => r.includes('排行榜'))).toBe(true)
  })

  it('同配置自身比较拒绝', () => {
    const a = {
      configId: 'same',
      datasetVersion: 'v1',
      casesSha256: 'h',
      splits: ['dev' as const],
      executionKind: 'fake' as const
    }
    expect(checkComparable(a, a).comparable).toBe(false)
  })
})

describe('人工复核(E-06)', () => {
  it('未审不通过:覆盖率与支持精度正确计算', () => {
    const store = new ReviewStore()
    store.annotate({
      subjectKey: 'case-1', decision: 'supported', reason: '引用支持', reviewer: '人',
      rubricVersion: 'rubric-v1', reviewedAt: NOW
    })
    store.annotate({
      subjectKey: 'case-2', decision: 'insufficient', reason: '证据不足', reviewer: '人',
      rubricVersion: 'rubric-v1', reviewedAt: NOW
    })
    // case-3 未审
    const compliance = reviewCompliance(store, ['case-1', 'case-2', 'case-3'])
    expect(compliance.coverage).toEqual({ value: 2 / 3, reviewed: 2, expected: 3 })
    expect(compliance.supportPrecision).toEqual({ value: 0.5, reviewed: 2, supported: 1 })
  })

  it('有理由必填:supported 无理由拒绝', () => {
    const store = new ReviewStore()
    expect(() =>
      store.annotate({
        subjectKey: 'x', decision: 'supported', reason: '', reviewer: '人', rubricVersion: 'v1', reviewedAt: NOW
      })
    ).toThrow(/理由/)
  })

  it('追加式历史:同一对象两次审阅都保留', () => {
    const store = new ReviewStore()
    store.annotate({
      subjectKey: 'x', decision: 'supported', reason: 'r1', reviewer: '人', rubricVersion: 'v1', reviewedAt: NOW
    })
    store.annotate({
      subjectKey: 'x', decision: 'contradicted', reason: 'r2', reviewer: '人', rubricVersion: 'v1', reviewedAt: NOW
    })
    expect(store.historyFor('x')).toHaveLength(2)
    expect(store.latestFor('x')?.decision).toBe('contradicted')
  })
})

describe('报告生成(E-07 报告部分)', () => {
  it('Fake 报告显著标示非模型能力;not_run 单列;未知费用不显示免费', () => {
    const dataset = {
      manifest: { dataset_version: 'personal_ops_v1', schema_version: 1, cases_sha256: 'x', categories: {}, total: 1, provenance: '测试' },
      cases: [caseDef('c1')], dev: [], holdout: [], casesSha256: 'x'
    }
    const results = [
      outcome({ caseId: 'c1', status: 'passed' }),
      outcome({ caseId: 'c2', status: 'not_run', runId: null })
    ]
    const report = renderEvalReport({
      state: {
        evalRunId: 'eval-1', datasetVersion: 'personal_ops_v1', casesSha256: 'x',
        splits: ['dev'], configIds: ['fake_flow'], executionKind: 'fake', repeats: 1,
        maxCases: 10, status: 'cancelled', startedAt: NOW, finishedAt: NOW,
        results
      },
      metrics: calculateMetrics(stateOf(results), dataset.cases),
      dataset,
      reproduceCommand: 'npm run eval:run -- --dataset personal_ops_v1'
    })
    expect(report).toContain('execution_kind = fake')
    expect(report).toContain('不构成完整发布结论')
    expect(report).toContain('not_run(未启动)')
    expect(report).toContain('以 null 表示')
    expect(report).toContain('未知 usage/费用以 null 表示')
    expect(report).not.toContain('费用: 0')
  })
})
