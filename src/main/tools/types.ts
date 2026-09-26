// 工具契约(C-04):定义、输入 schema、提案与执行输入的共享形态。
// 风险等级(RiskLevel)复用 shared/agent 的定义——服务端固定,模型不可降低。

import type { AppError, Result } from '../../shared/operations'
import type { Clock } from '../../shared/clock'
import type { RiskLevel } from '../../shared/agent'
import type { SqliteDb } from '../db/connection'

export type { RiskLevel }

// ---------- 输入 schema ----------
//
// 轻量字段规格,不引入 JSON Schema 依赖;与 shared/extraction.ts 的
// "schema 单一事实源"取向一致。严格性由 validateToolInput 保证:
// 未知字段、缺失必填、类型不符、枚举越界、数值越界一律拒绝。

export type ToolFieldType = 'string' | 'number' | 'boolean' | 'string[]'

export interface ToolFieldSpec {
  name: string
  type: ToolFieldType
  required?: boolean
  /** string 字段的封闭枚举 */
  enum?: readonly string[]
  /** number 的含端点范围 */
  min?: number
  max?: number
  description?: string
}

export interface ToolInputSchema {
  fields: readonly ToolFieldSpec[]
}

// ---------- 工具定义 ----------

export interface ToolExecutionContext {
  db: SqliteDb
  /** 注入时钟:领域时间可固定,耗时测量仍走单调钟(C-02 契约) */
  clock: Clock
  /**
   * 写工具的已批准目标记录版本(gateway 从审批记录注入)。
   * update 类工具用它做 assertRevision 双重校验:批准到执行之间
   * 目标记录若再被修改,执行以 CONFLICT 失败而非覆盖他人修改。
   */
  targetVersion?: number | null
}

/**
 * 工具执行结果:工具级失败(参数错误、业务拒绝)以 ToolFailure 返回,
 * 由运行策略决定继续或收尾;网关级拒绝(未注册、未批准)直接抛错。
 */
export interface ToolSuccess {
  ok: true
  data: unknown
}
export interface ToolFailure {
  ok: false
  error: AppError
}
export type ToolResult = ToolSuccess | ToolFailure

export function toolSuccess(data: unknown): ToolSuccess {
  return { ok: true, data }
}

export function toolFailure(error: AppError): ToolFailure {
  return { ok: false, error }
}

/** Result → ToolResult 的便捷转换(工具内部复用既有 Result 风格时) */
export function fromResult<T>(result: Result<T>): ToolResult {
  return result.ok ? { ok: true, data: result.value } : { ok: false, error: result.error }
}

export interface ToolDefinition {
  /** 点分名称,如 todo.list、calendar.create_event */
  name: string
  description: string
  /** 服务端固定风险等级;调用方或模型提供的任何风险声明一律不采信 */
  riskLevel: RiskLevel
  /** 单次执行超时(毫秒);超时强制在执行器(A-04)接线,定义阶段先作为元数据 */
  timeoutMs: number
  /** 失败是否可重试;执行器据此决定重试策略 */
  retryable: boolean
  inputSchema: ToolInputSchema
  /**
   * 写工具可选:把已校验参数解析为目标记录版本。
   * 返回 null 表示引用的记录不存在——模型虚构 ID 在 propose 阶段即被拒绝,
   * 无法形成待批准提案(模块规格第 7 节"得到真实对象 ID 后才能生成修改提案")。
   */
  resolveTargetVersion?: (args: Record<string, unknown>, ctx: ToolExecutionContext) => number | null
  /**
   * 同步执行(sql.js 事务语义:runOperation 的 apply 不等待 Promise,
   * 异步工具会使回执写入未决结果)。失败语义:
   * - 业务级失败以 ToolFailure 返回:该次尝试已完成并写入回执,
   *   同 callIndex 重试将重放该失败,由运行策略推进(partial 等);
   * - 意外异常直接抛出:runOperation 回滚、不写回执,同 callIndex 可重试。
   */
  execute(args: Record<string, unknown>, ctx: ToolExecutionContext): ToolResult
}

// ---------- 提案与执行 ----------

export interface ToolProposal {
  tool: string
  riskLevel: RiskLevel
  requiresConfirmation: boolean
  /** 校验并归一化后的参数(仅保留 schema 内字段) */
  arguments: Record<string, unknown>
  /** 稳定序列化后的 sha256;批准绑定此 hash,参数变化即失效 */
  argumentsHash: string
  planVersion: number
  targetVersion: number | null
  /** 写工具的审批记录 id;读工具为 null */
  approvalId: string | null
  /** 写工具提案有效期(UTC ISO 8601);读工具为 null */
  expiresAt: string | null
}

export interface ProposeToolInput {
  runId: string
  tool: string
  arguments: unknown
  planVersion: number
  targetVersion?: number | null
  /**
   * 调用方信封。契约规定:出现 approved 键(无论值)一律拒绝,
   * 不能凭客户端声明执行写操作(总体规格第 7 节)。
   */
  approved?: unknown
}

export interface ExecuteToolInput extends Omit<ProposeToolInput, 'targetVersion'> {
  /** 幂等键 = runId:tool:callIndex(总体规格第 7 节) */
  callIndex: number
  /** 写工具必须携带 propose 返回的 approvalId */
  approvalId?: string | null
  /**
   * 目标版本不由调用方提供:执行时用 resolveTargetVersion 重解析当前版本,
   * 与批准时绑定版本比对——批准到执行之间目标被再修改即 CONFLICT(OPS-06)。
   */
}

/** 网关依赖的注册表最小接口(便于测试注入替身) */
export interface ToolRegistryLike {
  get(name: string): ToolDefinition
  has(name: string): boolean
  list(): string[]
}
