// 模型请求传输控制与观测类型(RES-01):集中定义 Research 对真实模型发送的
// 单发送契约,避免服务层反向依赖 Research。TokenUsage 复用 shared/agent 的共享类型。
//
// 关键语义(实现见 ModelRouter.call 的 control 分支与 ModelCompleter):
// - 带 control 的一次 call 最多调用 fetchImpl 一次:忽略旧 maxRetriesPerProvider,
//   禁止内部备用切换;重试只由上层工作流发起(每次新 call、新 attemptId)。
// - beforeSend 同步执行预算准入、取消检查与 checkpoint 保存;失败则不调用 fetch、
//   不发 sent。实际调用 fetchImpl 后在同一同步段立即发 sent;fetch 同步抛错也记录
//   一次 sent。sent 表示一次传输派发,网络是否到达供应商及是否计费可能未知。
// - sent/settled 用 attemptId 去重;结果、错误与回调不得重复累加。
// - onAttempt 回调持久化失败必须 abort 已派发请求、停止后续发送,并以
//   OBSERVATION_FAILED 失败,保留已经派发的记录。
// - usage 未返回的字段记 null,不记 0;每次 attempt 留独立 usage。
// - actualProvider.model 记录实际派发路由的模型;responseModel 仅记录响应中可取得
//   的模型标识,否则为 null(不把冻结配置冒充供应商实测返回)。

import type { TokenUsage } from '../../shared/agent'

/** 实际派发路由的服务商与模型(providerId 为候选链内 ID) */
export type ActualProvider = { providerId: string; providerName: string; model: string }

/** 一次发送尝试的标识信息(sent 事件与准入回调共用) */
export type ModelAttemptInfo = ActualProvider & { requestId: string; attemptId: string; ordinal: number }

/** 一次发送尝试的结算记录;usage 各字段供应商未返回时为 null */
export type ModelAttemptRecord = ModelAttemptInfo & {
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'timeout'
  latencyMs: number
  httpStatus: number | null
  responseModel: string | null
  usage: TokenUsage
}

/** 观测事件:sent(派发)与 settled(结算);调用方按 attemptId 去重 */
export type ModelAttemptEvent =
  | { type: 'sent'; attempt: ModelAttemptInfo }
  | { type: 'settled'; attempt: ModelAttemptRecord }

/**
 * 单发送请求控制。Research 所有模型阶段必填;其他调用方由 ModelCompleter
 * 生成一次发送的默认控制。maxAttempts 恒为 1、fallback 恒为 disabled。
 */
export interface ModelRequestControl {
  requestId: string
  signal: AbortSignal
  timeoutMs: number
  policy: { maxAttempts: 1; fallback: 'disabled'; providerId?: string }
  beforeSend: (attempt: ModelAttemptInfo) => void
  onAttempt: (event: ModelAttemptEvent) => void
}

/** 领域错误码词表;这些领域原因映射既有 AppError,不新增共享错误枚举 */
export type ModelRequestErrorCode =
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'TRANSPORT'
  | 'MODEL_OUTPUT_INVALID'
  | 'BUDGET_EXHAUSTED'
  | 'OBSERVATION_FAILED'

/**
 * 模型请求领域错误:携带已完成传输的尝试记录——坏 JSON 解析失败等也保留
 * 已完成传输的 usage/route,不把失败尝试丢弃。
 */
export class ModelRequestError extends Error {
  readonly code: ModelRequestErrorCode
  readonly attempts: readonly ModelAttemptRecord[]
  readonly retryable: boolean

  constructor(code: ModelRequestErrorCode, message: string, attempts: readonly ModelAttemptRecord[], retryable: boolean) {
    super(message)
    this.name = 'ModelRequestError'
    this.code = code
    this.attempts = attempts
    this.retryable = retryable
  }
}

/** 全 null 的 TokenUsage(供应商未返回 usage 记 null 不记 0) */
export function nullTokenUsage(): TokenUsage {
  return { inputTokens: null, outputTokens: null, totalTokens: null, source: null }
}
