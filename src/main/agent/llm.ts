// 结构化补全协议(C-04):规划器(A-03)与评测(E-03)依赖的最小模型接口。
//
// 与具体供应商解耦:真实适配器(A-03 基于 ModelRouter 实现)与 FakeProvider
// 实现同一接口,评测据此做 Fake/real 分离。
// 用量契约(总体规格第 7 节):供应商未返回的字段记 null,不记 0。
// RES-01:请求可携带 ModelRequestControl(传输控制与观测);结果携带实际路由、
// 发送次数与逐尝试记录。control 缺省时真实适配器生成一次发送的默认控制。

import type { TokenUsage } from '../../shared/agent'
import type { ActualProvider, ModelAttemptRecord, ModelRequestControl } from '../services/modelRequest'

export interface StructuredCompleteRequest {
  /** 系统规则(工具权限、输出约束) */
  system: string
  /** 用户任务与已检索上下文 */
  prompt: string
  /** 期望的 JSON 结构描述;Fake 不校验,真实适配器据此启用协议级约束 */
  schemaHint?: Record<string, unknown>
  /** 传输控制与观测;Research 所有模型阶段必填,缺省由真实适配器生成默认单发送控制 */
  control?: ModelRequestControl
}

export interface StructuredCompleteResult<T = unknown> {
  /** 解析后的结构化输出 */
  data: T
  /** 实际服务的模型标识 */
  model: string
  usage: TokenUsage
  /** 单调钟测量的耗时(毫秒);固定时钟不冻结本字段 */
  latencyMs: number
  /** 实际派发路由;FakeProvider 等无网络实现返回 null */
  actualProvider: ActualProvider | null
  /** 实际网络发送次数;FakeProvider 返回 0(脚本次数不冒充网络发送) */
  actualAttempts: number
  /** 逐尝试结算记录;无网络实现为空数组 */
  attempts: readonly ModelAttemptRecord[]
}

/** 结构化补全的最小接口;实现不得在构造与调用之外发起任何网络请求 */
export interface StructuredCompleter {
  completeJson<T = unknown>(request: StructuredCompleteRequest): Promise<StructuredCompleteResult<T>>
}
