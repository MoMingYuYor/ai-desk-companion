// Agent 运行预算与超时默认值(C-02)。
// 约束(总体规格第 7 节):统一预算包括模型调用次数、active time、检索规模和 Token;
// 人工等待独立统计,不计入 active time;待批准提案默认 24 小时过期。
// 约束(研究模块第 8 节):默认配置的提高需要同步预算测试、UI 提示和 Eval 实验,
// 因此 resolveAgentBudget 只接受下调,上调一律拒绝。

export interface AgentBudget {
  /** 模型调用次数上限(含所有重试) */
  maxModelCalls: number
  /** 累计活动时间上限(秒),不含排队与等待用户 */
  maxActiveSeconds: number
  /** 进入抽取/上下文的实际检索片段上限 */
  maxRetrievalChunks: number
  /** 输入与输出 Token 合计上限 */
  maxTotalTokens: number
}

export interface AgentTimeouts {
  /** 单次模型请求上限(毫秒) */
  modelCallMs: number
  /** 单次工具执行上限(毫秒) */
  toolMs: number
  /** 待批准提案有效期(小时) */
  approvalTtlHours: number
}

/** 首期默认预算;均为设计目标,尚无实测。运行时冻结,避免调用方就地改写共享默认值 */
export const DEFAULT_AGENT_BUDGET: Readonly<AgentBudget> = Object.freeze({
  maxModelCalls: 6,
  maxActiveSeconds: 120,
  maxRetrievalChunks: 8,
  maxTotalTokens: 18000
})

/** 首期默认超时;approvalTtlHours=24 来自总体规格第 7 节。运行时冻结,理由同上 */
export const DEFAULT_AGENT_TIMEOUTS: Readonly<AgentTimeouts> = Object.freeze({
  modelCallMs: 30000,
  toolMs: 10000,
  approvalTtlHours: 24
})

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} 必须是大于 0 的整数,收到 ${String(value)}`)
  }
}

/**
 * 合并调用方给出的预算覆盖值:只允许下调,上调或非法值一律拒绝。
 * 返回新对象,不修改默认值(默认值为冻结对象)。
 */
export function resolveAgentBudget(override: Partial<AgentBudget> = {}): AgentBudget {
  const merged: AgentBudget = { ...DEFAULT_AGENT_BUDGET }
  for (const key of Object.keys(override) as Array<keyof AgentBudget>) {
    const value = override[key]
    if (value === undefined) continue
    assertPositiveInt(key, value)
    const ceiling = DEFAULT_AGENT_BUDGET[key]
    if (value > ceiling) {
      throw new Error(`${key} 不允许高于默认上限 ${ceiling},收到 ${value}`)
    }
    merged[key] = value
  }
  return merged
}

/** 合并超时覆盖值:规则同预算,只允许下调 */
export function resolveAgentTimeouts(override: Partial<AgentTimeouts> = {}): AgentTimeouts {
  const merged: AgentTimeouts = { ...DEFAULT_AGENT_TIMEOUTS }
  for (const key of Object.keys(override) as Array<keyof AgentTimeouts>) {
    const value = override[key]
    if (value === undefined) continue
    assertPositiveInt(key, value)
    const ceiling = DEFAULT_AGENT_TIMEOUTS[key]
    if (value > ceiling) {
      throw new Error(`${key} 不允许高于默认上限 ${ceiling},收到 ${value}`)
    }
    merged[key] = value
  }
  return merged
}
