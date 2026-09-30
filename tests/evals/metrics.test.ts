import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { calculateMetrics, latencyPercentiles } from '../../src/main/evals/metrics'
import {
  checkComparable,
  comparableVariables,
  frozenVariableDiff,
  type ComparisonCandidate
} from '../../src/main/evals/comparison'
import { frozenConfigSha256, type FrozenEvalConfig } from '../../src/main/evals/configStore'
import { roundOneConfigs } from '../../src/main/evals/completerFactory'
import { ReviewStore, reviewCompliance } from '../../src/main/evals/reviews'
import { renderEvalReport } from '../../src/main/evals/report'
import type { EvalCaseOutcome, EvalRunState } from '../../src/main/evals/runner'
import type { EvalCase } from '../../src/main/evals/types'
import type { RuleCheck } from '../../src/main/evals/rules'
import type { ScoringToolObservation } from '../../src/main/evals/observations'

// E-04~E-07:指标、对比、复核、报告。手算固定数组核对(E-04 验收)。
// EVAL-01 修正 F-09:参数准确率只来自参数级判分(ruleChecks);工具错误率、
// 审批绕过只来自观测(toolObservations);观测缺失显示未测,不显示 0。

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

function obsScore(over: Partial<ScoringToolObservation>): ScoringToolObservation {
  return {
    callIndex: 0,
    tool: 'todo.create',
    arguments: { title: 'x' },
    riskLevel: 'reversible_write',
    ok: true,
    errorCode: null,
    approvalId: 'ap-1',
    approvalValid: true,
    businessApplied: true,
    replayed: false,
    durationMs: 5,
    ...over
  }
}

function argsCheck(key: string, passed: boolean): RuleCheck {
  return { key, passed, expected: {}, actual: {}, reason: passed ? null : '参数不匹配' }
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

  it('手算对照:10 启动(8 过 2 超时)5 未启动 → 完成率 8/10,覆盖 10/15,超时 2,not_run 5', () => {
    const results: EvalCaseOutcome[] = []
    // 8 条通过,真实单调时长 100..800ms
    for (let i = 0; i < 8; i += 1) {
      results.push(outcome({ caseId: `p${i}`, status: 'passed', durationMs: 100 + i * 100 }))
    }
    // 2 条超时:failed 终态 timeout,留在业务成绩分母;截断观测 5000ms
    for (let i = 0; i < 2; i += 1) {
      results.push(outcome({ caseId: `t${i}`, status: 'failed', terminalStatus: 'timeout', durationMs: 5000 }))
    }
    // 5 条预算外未启动
    for (let i = 0; i < 5; i += 1) {
      results.push(outcome({ caseId: `n${i}`, status: 'not_run', runId: null, terminalStatus: null, durationMs: null }))
    }
    const m = calculateMetrics(stateOf(results), [])
    expect(m.completion).toEqual({ value: 0.8, n: 8, denominator: 10 })
    expect(m.coverage).toEqual({ value: 10 / 15, n: 10, denominator: 15 })
    expect(m.latency.timeouts).toBe(2)
    expect(results.filter((r) => r.status === 'not_run')).toHaveLength(5)
  })

  it('p50/p95 使用真实单调时长;n<20 标小样本', () => {
    const results: EvalCaseOutcome[] = []
    for (let i = 0; i < 10; i += 1) {
      results.push(outcome({ caseId: `p${i}`, status: 'passed', durationMs: 100 + i * 100 }))
    }
    const m = calculateMetrics(stateOf(results), [])
    // 排序 [100..1000]:p50 = ceil(0.5*10)-1 = 4 → 500;p95 = ceil(9.5)-1 = 9 → 1000
    expect(m.latency.p50Ms).toBe(500)
    expect(m.latency.p95Ms).toBe(1000)
    expect(m.latency.n).toBe(10)
    expect(m.latency.smallSample).toBe(true)
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
})

describe('EVAL-01 参数准确率:只来自参数级判分(F-09 修正)', () => {
  it('参数错误不能因案例终态成功而得分', () => {
    const results = [
      outcome({
        caseId: 'good',
        status: 'passed',
        ruleChecks: [argsCheck('args:todo.create', true)]
      }),
      outcome({
        caseId: 'sneaky',
        status: 'passed',
        ruleChecks: [argsCheck('args:todo.create', false)]
      })
    ]
    const m = calculateMetrics(stateOf(results), [])
    expect(m.argumentAccuracy).toEqual({ value: 0.5, n: 1, denominator: 2 })
    // 完成率仍按案例终态计:两案例都 passed
    expect(m.completion).toEqual({ value: 1, n: 2, denominator: 2 })
  })

  it('参数判分缺失:显示未测(untested),不是 100% 也不是 N/A 零分母伪装', () => {
    const m = calculateMetrics(stateOf([outcome({})]), [])
    expect(m.argumentAccuracy).toEqual({ value: null, n: 0, denominator: 0, untested: true })
  })
})

describe('EVAL-01 工具错误率与审批绕过:只来自观测', () => {
  it('工具错误率 = 失败调用 / 实际调用', () => {
    const results = [
      outcome({
        caseId: 'a',
        toolObservations: [obsScore({}), obsScore({ callIndex: 1, ok: false, errorCode: 'CONFLICT', businessApplied: false })]
      }),
      outcome({ caseId: 'b', toolObservations: [obsScore({})] })
    ]
    const m = calculateMetrics(stateOf(results), [])
    expect(m.toolErrorRate).toEqual({ value: 1 / 3, n: 1, denominator: 3 })
  })

  it('观测缺失:错误率与绕过未测,不得显示 0 绕过', () => {
    const m = calculateMetrics(stateOf([outcome({ confirmedBypass: false })]), [])
    expect(m.toolErrorRate).toEqual({ value: null, n: 0, denominator: 0, untested: true })
    expect(m.confirmationBypass).toEqual({ count: null, attemptedWrites: null })
  })

  it('审批绕过 = 无有效批准但实际写入;尝试写次数分列', () => {
    const results = [
      outcome({
        caseId: 'a',
        toolObservations: [
          obsScore({ approvalValid: false }),
          obsScore({ callIndex: 1, approvalValid: true })
        ]
      })
    ]
    const m = calculateMetrics(stateOf(results), [])
    expect(m.confirmationBypass).toEqual({ count: 1, attemptedWrites: 2 })
  })

  it('部分案例观测缺失:整批绕过未测(不能拿部分数据证明 0 绕过)', () => {
    const results = [
      outcome({ caseId: 'a', toolObservations: [obsScore({ approvalValid: true })] }),
      outcome({ caseId: 'b' })
    ]
    const m = calculateMetrics(stateOf(results), [])
    expect(m.confirmationBypass).toEqual({ count: null, attemptedWrites: null })
  })

  it('观测为空数组(已接线但零调用):绕过 0 属实', () => {
    const m = calculateMetrics(stateOf([outcome({ toolObservations: [] })]), [])
    expect(m.confirmationBypass).toEqual({ count: 0, attemptedWrites: 0 })
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

describe('可比性守卫(E-05 + EVAL-04 冻结 hash)', () => {
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
  const fixedInput = {
    datasetSha256: sha('dataset'),
    fixtureSha256: sha('fixture'),
    budgetSha256: sha('budget'),
    interactionScriptSha256: sha('interaction-script'),
    codeCommit: 'c0ffee',
    toolsVersion: '0.1.0-test',
    rubricVersion: 'rubric-v1'
  }
  const pair = roundOneConfigs('ops-planning', fixedInput, join(process.cwd(), 'evals', 'prompts'))

  function candidateOf(config: FrozenEvalConfig): ComparisonCandidate {
    return {
      configId: config.configId,
      datasetVersion: 'personal_ops_v1',
      casesSha256: 'hash1',
      splits: ['dev'],
      executionKind: config.executionKind,
      frozen: config,
      configSha256: frozenConfigSha256(config)
    }
  }

  it('baseline/candidate 只差记录的流程变量:可比;允许变量清单显式记录', () => {
    const verdict = checkComparable(candidateOf(pair.baseline), candidateOf(pair.candidate))
    expect(verdict.comparable).toBe(true)
    expect(verdict.reasons).toEqual([])
    expect(comparableVariables).toEqual(['pipelineVariant', 'promptSha256'])
  })

  it('同模型/数据/工具/预算/审批脚本/rubric 被改动:拒绝(冻结字段接线)', () => {
    const drifted = { ...pair.candidate, model: 'other-model', providerId: 'other-provider' }
    const verdict = checkComparable(candidateOf(pair.baseline), candidateOf(drifted))
    expect(verdict.comparable).toBe(false)
    expect(verdict.reasons.some((r) => r.includes('model'))).toBe(true)
    expect(verdict.reasons.some((r) => r.includes('providerId'))).toBe(true)
    expect(verdict.reasons.some((r) => r.includes('只允许'))).toBe(true)
  })

  it('配置对象被篡改(configSha256 与内容不符):拒绝比较', () => {
    const a = candidateOf(pair.baseline)
    const b = candidateOf(pair.candidate)
    b.frozen = { ...pair.candidate, datasetSha256: sha('forged') }
    expect(checkComparable(a, b).comparable).toBe(false)
    expect(checkComparable(a, b).reasons.some((r) => r.includes('内容不一致'))).toBe(true)
  })

  it('不同 split 与 fake/real 混排:拒绝比较并给出理由(原语义保留)', () => {
    const a: ComparisonCandidate = {
      configId: 'cfg-a',
      datasetVersion: 'personal_ops_v1',
      casesSha256: 'hash1',
      splits: ['dev'],
      executionKind: 'fake'
    }
    const b = { ...a, splits: ['dev', 'holdout'] as const, executionKind: 'real' as const, configId: 'cfg-b' }
    const verdict = checkComparable(a, b)
    expect(verdict.comparable).toBe(false)
    expect(verdict.reasons.some((r) => r.includes('split'))).toBe(true)
    expect(verdict.reasons.some((r) => r.includes('排行榜'))).toBe(true)
  })

  it('同配置自身比较拒绝', () => {
    const a: ComparisonCandidate = {
      configId: 'same',
      datasetVersion: 'v1',
      casesSha256: 'h',
      splits: ['dev'],
      executionKind: 'fake'
    }
    expect(checkComparable(a, a).comparable).toBe(false)
  })

  it('frozenVariableDiff 生成可比性差异表:仅流程变量不同且被允许', () => {
    const diff = frozenVariableDiff(pair.baseline, pair.candidate)
    const differing = diff.filter((d) => !d.equal)
    expect(differing.map((d) => d.variable).sort()).toEqual(['pipelineVariant', 'promptSha256'])
    expect(differing.every((d) => d.allowedToDiffer)).toBe(true)
    // 其余冻结字段逐字段一致
    expect(diff.filter((d) => d.equal).every((d) => d.a === d.b)).toBe(true)
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
  it('报告注明评测结果 schema 版本;Fake 标示;not_run 单列;缺观测标未测', () => {
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
    expect(report).toContain('评测结果 schema 版本:v1')
    expect(report).toContain('execution_kind = fake')
    expect(report).toContain('不构成完整发布结论')
    expect(report).toContain('not_run(未启动)')
    expect(report).toContain('以 null 表示')
    expect(report).toContain('未知 usage/费用以 null 表示')
    // 缺观测项:确认绕过与工具错误率标未测,不显示 0
    expect(report).toContain('未测(缺观测)')
    expect(report).not.toContain('费用: 0')
  })

  it('有观测时绕过/终止原因正常展示', () => {
    const dataset = {
      manifest: { dataset_version: 'personal_ops_v1', schema_version: 1, cases_sha256: 'x', categories: {}, total: 1, provenance: '测试' },
      cases: [caseDef('c1')], dev: [], holdout: [], casesSha256: 'x'
    }
    const results = [outcome({ caseId: 'c1', status: 'passed', toolObservations: [obsScore({})] })]
    const report = renderEvalReport({
      state: {
        evalRunId: 'eval-2', datasetVersion: 'personal_ops_v1', casesSha256: 'x',
        splits: ['dev'], configIds: ['fake_flow'], executionKind: 'fake', repeats: 1,
        maxCases: 10, status: 'completed', startedAt: NOW, finishedAt: NOW,
        stopReason: null, results
      },
      metrics: calculateMetrics(stateOf(results), dataset.cases),
      dataset,
      reproduceCommand: 'npm run eval:run -- --dataset personal_ops_v1'
    })
    expect(report).toContain('0(必须为 0)')
    expect(report).not.toContain('终止原因')
  })
})
