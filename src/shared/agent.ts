// Agent 运行契约(C-02):计划、工具、轨迹、审批的共享类型与纯校验函数。
// 主进程与渲染层均可引用;不含 electron 依赖,不含执行语义。
//
// 两条结构性约束:
// 1. 风险等级由服务端注册表决定。模型自报的 risk_level / needs_confirmation 一律不采信,
//    因此把 RawPlanStep(模型可输出)与 PlanStep(归一化后)分成两个类型,
//    受信管道在类型层面就读不到模型自报的风险值(总体规格第 6 节)。
// 2. 供应商未返回 usage 时记 null,不记 0(总体规格第 7 节)。

import type { ErrorCode } from './operations'

export type { ErrorCode }

/** 运行模式;首期只有两种 */
export type RunMode = 'personal_ops' | 'research'

/** 统一状态集(总体规格第 6 节) */
export type RunStatus =
  | 'queued'
  | 'planning'
  | 'awaiting_input'
  | 'awaiting_confirmation'
  | 'executing'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled'

/** 风险等级:由服务端注册表固定,模型不可降低 */
export type RiskLevel = 'read' | 'reversible_write' | 'irreversible_write'

/** 工具调用状态 */
export type ToolCallStatus =
  | 'planned'
  | 'awaiting_confirmation'
  | 'approved'
  | 'rejected'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown'

/** 轨迹事件类型 */
export type TraceEventType =
  | 'input'
  | 'retrieval'
  | 'plan'
  | 'tool_call'
  | 'confirmation'
  | 'model'
  | 'output'
  | 'error'

/** 审批决策 */
export type ApprovalDecision = 'pending' | 'approved' | 'rejected' | 'expired'

export const RUN_MODES: readonly RunMode[] = ['personal_ops', 'research']

export const RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'planning',
  'awaiting_input',
  'awaiting_confirmation',
  'executing',
  'succeeded',
  'partial',
  'failed',
  'cancelled'
]

export const RISK_LEVELS: readonly RiskLevel[] = ['read', 'reversible_write', 'irreversible_write']

export const TOOL_CALL_STATUSES: readonly ToolCallStatus[] = [
  'planned',
  'awaiting_confirmation',
  'approved',
  'rejected',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'unknown'
]

export const TRACE_EVENT_TYPES: readonly TraceEventType[] = [
  'input',
  'retrieval',
  'plan',
  'tool_call',
  'confirmation',
  'model',
  'output',
  'error'
]

export const APPROVAL_DECISIONS: readonly ApprovalDecision[] = ['pending', 'approved', 'rejected', 'expired']

/** 终态:进入后不再发生状态转移 */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['succeeded', 'partial', 'failed', 'cancelled']

// ---------- 计划 ----------

/** 模型可能输出的原始步骤;riskLevel / needsConfirmation 存在但一律不采信 */
export interface RawPlanStep {
  tool: string
  arguments: Record<string, unknown>
  riskLevel?: unknown
  needsConfirmation?: unknown
}

/** 归一化后的步骤:只保留工具名与参数 */
export interface PlanStep {
  tool: string
  arguments: Record<string, unknown>
}

/** 结构化计划:模型输出经归一化后的形态 */
export interface Plan {
  goal: string
  steps: PlanStep[]
  assumptions: string[]
}

/** 服务端校验后的步骤:风险等级、是否需确认、计划版本与目标版本均由服务端补齐 */
export interface PreparedStep extends PlanStep {
  riskLevel: RiskLevel
  requiresConfirmation: boolean
  planVersion: number
  /** 修改类工具的目标记录版本;创建类为 null */
  targetVersion: number | null
}

// ---------- 轨迹 ----------

/** 供应商未返回的字段记 null,不记 0 */
export interface TokenUsage {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  /** 用量来源标识;未知时为 null */
  source: string | null
}

export interface TraceEvent {
  runId: string
  /** 同一 run 内从 1 连续递增;唯一约束 (runId, seq) */
  seq: number
  eventType: TraceEventType
  schemaVersion: 1
  /** 脱敏后的操作摘要;不保存模型内部思维链 */
  payload: Record<string, unknown>
  durationMs: number | null
  tokenUsage: TokenUsage | null
  /** UTC ISO 8601 */
  createdAt: string
}

// ---------- 审批 ----------

/** 审批记录:批准绑定参数 hash、计划版本、目标版本与有效期 */
export interface Approval {
  approvalId: string
  runId: string
  toolName: string
  argumentsHash: string
  planVersion: number
  targetVersion: number | null
  /** UTC ISO 8601 */
  expiresAt: string
  decision: ApprovalDecision
  decidedAt: string | null
}

// ---------- 纯校验 ----------

export function isRunMode(value: unknown): value is RunMode {
  return typeof value === 'string' && (RUN_MODES as readonly string[]).includes(value)
}

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === 'string' && (RUN_STATUSES as readonly string[]).includes(value)
}

export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === 'string' && (RISK_LEVELS as readonly string[]).includes(value)
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status)
}

/** 写入风险:需要审批记录才能执行 */
export function isWriteRisk(level: RiskLevel): boolean {
  return level !== 'read'
}

/**
 * 归一化模型给出的步骤:丢弃 riskLevel / needsConfirmation,只保留工具名与参数。
 * 工具名缺失或参数不是对象时返回 null,由调用方按策略拒绝整份计划。
 */
export function normalizePlanStep(raw: RawPlanStep): PlanStep | null {
  if (typeof raw?.tool !== 'string' || raw.tool.trim() === '') return null
  const args = raw.arguments
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
  return { tool: raw.tool, arguments: args as Record<string, unknown> }
}

/**
 * 校验轨迹事件的 seq 是否从 1 连续递增且无重复。
 * 返回第一个缺口或重复的位置(0 基下标);合法时返回 null。
 */
export function findSeqAnomaly(events: readonly Pick<TraceEvent, 'seq'>[]): number | null {
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]!.seq !== i + 1) return i
  }
  return null
}
