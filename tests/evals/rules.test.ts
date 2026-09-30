import { describe, expect, it } from 'vitest'
import { mergeObservations, type ScoringToolObservation } from '../../src/main/evals/observations'
import {
  matchesRequired,
  evaluateParameterRules,
  summarizeObservations
} from '../../src/main/evals/rules'
import type { ToolObservationV1 } from '../../src/main/tools/types'

// EVAL-01 纯规则部分:参数子集匹配、观测合并与汇总。
// 三条负向场景(规范要求):参数错误但终态成功、业务失败、无有效审批写入。
// 观测对象由测试构造(端到端网关接线留给 EVAL 收口任务)。

let seq = 0

/** 构造一条 tool 阶段观测(persistence 阶段按需补充) */
function obs(over: Partial<ToolObservationV1>): ToolObservationV1 {
  seq += 1
  return {
    observationVersion: 1,
    runId: 'r1',
    tool: 'todo.create',
    callIndex: 0,
    operationId: `op-${seq}`,
    attempt: 1,
    planVersion: 1,
    phase: 'tool',
    riskLevel: 'reversible_write',
    attemptedArguments: over.arguments ?? null,
    arguments: null,
    approvalId: null,
    approvalDecision: null,
    approvalValidated: false,
    targetVersion: null,
    executed: true,
    replayed: false,
    committed: false,
    outcome: 'success',
    result: null,
    error: null,
    durationMs: 5,
    ...over
  }
}

function score(over: Partial<ScoringToolObservation>): ScoringToolObservation {
  return {
    callIndex: 0,
    tool: 'todo.create',
    arguments: { title: '整理 JD' },
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

describe('matchesRequired:参数子集匹配', () => {
  it('参数错误不能因案例终态成功而得分(规范逐字用例)', () => {
    expect(matchesRequired({ title: '错误标题' }, { title: '整理 JD' })).toBe(false)
    expect(matchesRequired({}, { title: '整理 JD' })).toBe(false)
  })

  it('对象递归子集匹配:多余键不影响,缺失键判错', () => {
    expect(matchesRequired({ title: '整理 JD', priority: 'high' }, { title: '整理 JD' })).toBe(true)
    expect(matchesRequired({ priority: 'high' }, { title: '整理 JD' })).toBe(false)
    expect(
      matchesRequired({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })
    ).toBe(true)
    expect(matchesRequired({ a: { b: [1] } }, { a: { b: [1, 2] } })).toBe(false)
  })

  it('数组按序比较:顺序不同或长度不同判错', () => {
    expect(matchesRequired(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(matchesRequired(['b', 'a'], ['a', 'b'])).toBe(false)
    expect(matchesRequired(['a'], ['a', 'b'])).toBe(false)
  })

  it('字符串保持原值:不做大小写或空白归一化(归一化只能来自 rubric)', () => {
    expect(matchesRequired('整理 JD', '整理 jd')).toBe(false)
    expect(matchesRequired('整理 JD', '整理 JD ')).toBe(false)
    expect(matchesRequired('整理 JD', '整理 JD')).toBe(true)
  })

  it('缺调用不能通过工具名相同补分:actual 为 null 判错', () => {
    expect(matchesRequired(null, { title: '整理 JD' })).toBe(false)
  })
})

describe('evaluateParameterRules:参数判分', () => {
  it('负向 1:工具名正确但必需参数错误 → 判错,不因 ok=true 得分', () => {
    const result = evaluateParameterRules(
      { 'todo.create': { title: '整理 JD' } },
      [score({ arguments: { title: '错误标题' }, ok: true, businessApplied: true })]
    )
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0]!.passed).toBe(false)
    expect(result.checks[0]!.key).toBe('args:todo.create')
    expect(result.ambiguousTools).toHaveLength(0)
  })

  it('负向 1b:缺调用判错,不能凭工具名补分', () => {
    const result = evaluateParameterRules(
      { 'todo.create': { title: '整理 JD' } },
      []
    )
    expect(result.checks[0]!.passed).toBe(false)
    expect(result.checks[0]!.reason).toContain('缺少')
  })

  it('参数匹配时通过', () => {
    const result = evaluateParameterRules(
      { 'todo.create': { title: '整理 JD' } },
      [score({})]
    )
    expect(result.checks[0]!.passed).toBe(true)
  })

  it('同一工具重复且恰一次匹配:唯一对应,判该次调用', () => {
    const result = evaluateParameterRules(
      { 'todo.update': { priority: 'high' } },
      [
        score({ tool: 'todo.update', callIndex: 0, arguments: { title: 'A' } }),
        score({ tool: 'todo.update', callIndex: 1, arguments: { title: 'B', priority: 'high' } })
      ]
    )
    expect(result.checks[0]!.passed).toBe(true)
    expect(result.ambiguousTools).toHaveLength(0)
  })

  it('同一工具重复且多次匹配:标注歧义,阻止数据版本冻结,不选最有利调用', () => {
    const result = evaluateParameterRules(
      { 'todo.update': { priority: 'high' } },
      [
        score({ tool: 'todo.update', callIndex: 0, arguments: { priority: 'high' } }),
        score({ tool: 'todo.update', callIndex: 1, arguments: { priority: 'high', note: 'x' } })
      ]
    )
    expect(result.checks[0]!.passed).toBe(false)
    expect(result.ambiguousTools).toEqual(['todo.update'])
    expect(result.checks[0]!.reason).toContain('歧义')
  })

  it('同一工具重复且零匹配:判参数错误(非歧义)', () => {
    const result = evaluateParameterRules(
      { 'todo.update': { priority: 'high' } },
      [
        score({ tool: 'todo.update', callIndex: 0, arguments: { priority: 'low' } }),
        score({ tool: 'todo.update', callIndex: 1, arguments: { priority: 'normal' } })
      ]
    )
    expect(result.checks[0]!.passed).toBe(false)
    expect(result.ambiguousTools).toHaveLength(0)
  })

  it('无 required_arguments 时不产生判分项', () => {
    expect(evaluateParameterRules(undefined, [score({})]).checks).toHaveLength(0)
  })
})

describe('summarizeObservations:错误与越权写汇总', () => {
  it('负向 2:工具返回业务失败 → 失败次数递增,计入错误率分母', () => {
    const summary = summarizeObservations([
      score({ ok: true }),
      score({ callIndex: 1, ok: false, errorCode: 'CONFLICT', businessApplied: false })
    ])
    expect(summary.totalAttempts).toBe(2)
    expect(summary.failedAttempts).toBe(1)
  })

  it('负向 3:无有效审批但实际写入 → 越权写次数递增', () => {
    const summary = summarizeObservations([
      score({ approvalValid: false, businessApplied: true }),
      score({ callIndex: 1, approvalValid: true, businessApplied: true })
    ])
    expect(summary.attemptedWrites).toBe(2)
    expect(summary.unauthorizedAppliedWrites).toBe(1)
  })

  it('被拒写入算尝试;审批状态未知(null)的实际写入保守计越权', () => {
    const summary = summarizeObservations([
      // 网关拒绝(未执行):写形状尝试仍计入分母
      score({ callIndex: 0, ok: false, errorCode: 'APPROVAL_REQUIRED', businessApplied: false }),
      // 审批有效性未知但业务已应用:保守计越权
      score({ callIndex: 1, approvalValid: null, businessApplied: true })
    ])
    expect(summary.attemptedWrites).toBe(2)
    expect(summary.unauthorizedAppliedWrites).toBe(1)
  })

  it('读工具不进写分母', () => {
    const summary = summarizeObservations([
      score({ tool: 'todo.list', riskLevel: 'read', approvalId: null, approvalValid: null, businessApplied: false })
    ])
    expect(summary.attemptedWrites).toBe(0)
    expect(summary.unauthorizedAppliedWrites).toBe(0)
    expect(summary.totalAttempts).toBe(1)
  })
})

describe('mergeObservations:两阶段合并', () => {
  it('按 (operationId, attempt) 合并 tool/persistence:一次尝试;ok 取 tool 阶段', () => {
    const merged = mergeObservations([
      obs({ operationId: 'op-x', phase: 'persistence', committed: true, outcome: 'success', durationMs: 2 }),
      obs({ operationId: 'op-x', arguments: { title: '整理 JD' }, approvalId: 'ap-1', approvalValidated: true })
    ])
    expect(merged).toHaveLength(1)
    const m = merged[0]!
    expect(m.tool).toBe('todo.create')
    expect(m.ok).toBe(true)
    expect(m.arguments).toEqual({ title: '整理 JD' })
    expect(m.approvalValid).toBe(true)
    expect(m.businessApplied).toBe(true)
    expect(m.replayed).toBe(false)
    expect(m.durationMs).toBe(5)
  })

  it('负向 3(合并层):业务应用但无有效批准 → businessApplied=true 供越权判定', () => {
    const merged = mergeObservations([
      obs({ operationId: 'op-y', arguments: { title: 'x' }, approvalId: null, approvalValidated: false }),
      obs({ operationId: 'op-y', phase: 'persistence', committed: true, outcome: 'success' })
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.businessApplied).toBe(true)
    expect(merged[0]!.approvalValid).toBe(false)
    expect(summarizeObservations(merged).unauthorizedAppliedWrites).toBe(1)
  })

  it('回执重放:单列尝试但不算第二次业务写入', () => {
    const merged = mergeObservations([
      obs({ operationId: 'op-replay', replayed: true, executed: false, phase: 'tool' }),
      obs({ operationId: 'op-replay', replayed: true, executed: false, phase: 'persistence', committed: true, outcome: 'success' })
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.replayed).toBe(true)
    expect(merged[0]!.businessApplied).toBe(false)
  })

  it('落盘失败:工具业务结果与落盘失败分别报告,不得计为已应用', () => {
    const merged = mergeObservations([
      obs({ operationId: 'op-z', arguments: { title: 'x' }, outcome: 'success' }),
      obs({
        operationId: 'op-z',
        phase: 'persistence',
        committed: true,
        outcome: 'persist_error',
        error: { code: 'PERSIST_FAILED', message: '回执写入失败', retryable: true }
      })
    ])
    const m = merged[0]!
    expect(m.ok).toBe(true) // 工具业务结果成功
    expect(m.businessApplied).toBe(false) // 落盘失败:不计真实业务变更
    expect(m.errorCode).toBe('PERSIST_FAILED')
  })

  it('验证拒绝:arguments 为 null,ok=false,仍计一次尝试', () => {
    const merged = mergeObservations([
      obs({
        executed: false,
        outcome: 'gateway_error',
        attemptedArguments: { approved: true },
        arguments: null,
        error: { code: 'VALIDATION', message: '未知字段:approved', retryable: false }
      })
    ])
    const m = merged[0]!
    expect(m.ok).toBe(false)
    expect(m.arguments).toBeNull()
    expect(m.businessApplied).toBe(false)
    expect(summarizeObservations(merged).totalAttempts).toBe(1)
  })

  it('多个调用按 callIndex 升序输出', () => {
    const merged = mergeObservations([
      obs({ operationId: 'op-b', callIndex: 1 }),
      obs({ operationId: 'op-a', callIndex: 0 })
    ])
    expect(merged.map((m) => m.callIndex)).toEqual([0, 1])
  })
})
