import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_BUDGET,
  DEFAULT_AGENT_TIMEOUTS,
  resolveAgentBudget,
  resolveAgentTimeouts
} from '../../src/main/agent/config'

// C-02:预算与超时默认值。核心约束是"只允许下调,不允许模型或客户端提高默认上限"。

describe('默认值', () => {
  it('预算默认值与总体规格第 7 节一致', () => {
    expect(DEFAULT_AGENT_BUDGET.maxModelCalls).toBe(6)
    expect(DEFAULT_AGENT_BUDGET.maxActiveSeconds).toBe(120)
    expect(DEFAULT_AGENT_BUDGET.maxRetrievalChunks).toBe(8)
  })

  it('待批准提案默认 24 小时过期', () => {
    expect(DEFAULT_AGENT_TIMEOUTS.approvalTtlHours).toBe(24)
  })

  it('默认值是冻结对象,调用方无法就地改写', () => {
    expect(Object.isFrozen(DEFAULT_AGENT_BUDGET)).toBe(true)
    expect(Object.isFrozen(DEFAULT_AGENT_TIMEOUTS)).toBe(true)
  })
})

describe('resolveAgentBudget 只允许下调', () => {
  it('无覆盖时返回默认值副本', () => {
    const got = resolveAgentBudget()
    expect(got).toEqual({ ...DEFAULT_AGENT_BUDGET })
    expect(got).not.toBe(DEFAULT_AGENT_BUDGET)
  })

  it('下调被接受', () => {
    expect(resolveAgentBudget({ maxModelCalls: 3, maxRetrievalChunks: 1 })).toMatchObject({
      maxModelCalls: 3,
      maxRetrievalChunks: 1,
      maxActiveSeconds: DEFAULT_AGENT_BUDGET.maxActiveSeconds
    })
  })

  it('上调被拒绝', () => {
    expect(() => resolveAgentBudget({ maxModelCalls: 7 })).toThrow(/不允许高于默认上限/)
    expect(() => resolveAgentBudget({ maxActiveSeconds: 300 })).toThrow(/不允许高于默认上限/)
  })

  it('非正数与小数被拒绝', () => {
    expect(() => resolveAgentBudget({ maxModelCalls: 0 })).toThrow(/大于 0 的整数/)
    expect(() => resolveAgentBudget({ maxModelCalls: -1 })).toThrow(/大于 0 的整数/)
    expect(() => resolveAgentBudget({ maxModelCalls: 2.5 })).toThrow(/大于 0 的整数/)
  })

  it('未定义字段被忽略,不覆盖默认值', () => {
    const got = resolveAgentBudget({ maxModelCalls: undefined })
    expect(got.maxModelCalls).toBe(DEFAULT_AGENT_BUDGET.maxModelCalls)
  })
})

describe('resolveAgentTimeouts 只允许下调', () => {
  it('下调被接受,上调被拒绝', () => {
    expect(resolveAgentTimeouts({ approvalTtlHours: 1 }).approvalTtlHours).toBe(1)
    expect(() => resolveAgentTimeouts({ approvalTtlHours: 48 })).toThrow(/不允许高于默认上限/)
    expect(() => resolveAgentTimeouts({ modelCallMs: 60000 })).toThrow(/不允许高于默认上限/)
  })

  it('拒绝非法值', () => {
    expect(() => resolveAgentTimeouts({ toolMs: 0 })).toThrow(/大于 0 的整数/)
  })
})
