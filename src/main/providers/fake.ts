// FakeProvider(C-04):可分发的结构化补全替身。
//
// 来源:测试内曾以 fetchImpl 注入 + 假会话方式驱动(审计报告 §6.8),
// 本模块把它提取为正式实现,供规划器开发与 Eval 的 fake 执行模式使用。
//
// 四条契约:
// 1. 无网络:构造与调用全程不发起任何请求(测试以"全局 fetch 被替换为抛错"验证);
// 2. 确定性:按脚本逐次返回,脚本耗尽抛错而不是静默循环——静默复用会掩盖调用次数错误;
// 3. 用量契约:未提供 usage 时四个字段全为 null,不记 0;
// 4. RES-01:结果返回 actualProvider=null、actualAttempts=0、attempts=[]——
//    自身脚本次数不能冒充网络发送次数;请求携带 control 时仍同步执行 beforeSend
//    (预算准入),使上层预算账本与真实链路同一口径扣减,但不发 sent/settled 观测。

import { randomUUID } from 'node:crypto'
import type { Clock } from '../../shared/clock'
import { systemClock } from '../../shared/clock'
import type { TokenUsage } from '../../shared/agent'
import type {
  StructuredCompleteRequest,
  StructuredCompleteResult,
  StructuredCompleter
} from '../agent/llm'

export interface FakeProviderDeps {
  /** 逐次调用的返回值(脚本的 data 部分);耗尽即抛错 */
  responses?: readonly unknown[]
  /** 更灵活的脚本:按调用序号与请求返回 data;与 responses 二选一 */
  script?: (callIndex: number, request: StructuredCompleteRequest) => unknown
  /** 报告的模型标识 */
  model?: string
  /** 报告的用量;缺省全 null(供应商未返回 usage 记 null 不记 0) */
  usage?: TokenUsage | null
  clock?: Clock
}

export interface FakeProviderCall {
  callIndex: number
  request: StructuredCompleteRequest
}

export class FakeProvider implements StructuredCompleter {
  private callCount = 0
  readonly calls: FakeProviderCall[] = []
  private readonly model: string
  private readonly usage: TokenUsage | null
  private readonly clock: Clock

  constructor(private readonly deps: FakeProviderDeps = {}) {
    this.model = deps.model ?? 'fake-model'
    this.usage = deps.usage ?? null
    this.clock = deps.clock ?? systemClock
  }

  async completeJson<T>(request: StructuredCompleteRequest): Promise<StructuredCompleteResult<T>> {
    // RES-01:携带 control 时同步执行预算准入(beforeSend),不发 sent/settled 观测
    if (request.control) {
      request.control.beforeSend({
        providerId: 'fake',
        providerName: 'FakeProvider',
        model: this.model,
        requestId: request.control.requestId,
        attemptId: randomUUID(),
        ordinal: 1
      })
    }
    const callIndex = this.callCount
    this.callCount += 1
    this.calls.push({ callIndex, request })

    const data =
      this.deps.script !== undefined
        ? this.deps.script(callIndex, request)
        : this.nextFromResponses(callIndex)

    const started = this.clock.monotonicMs()
    const latencyMs = this.clock.monotonicMs() - started
    return {
      data: data as T,
      model: this.model,
      usage: this.usage ?? this.nullUsage(),
      latencyMs,
      // 脚本调用不是网络发送:actualProvider/actualAttempts/attempts 如实为空
      actualProvider: null,
      actualAttempts: 0,
      attempts: []
    }
  }

  /** 已发生的调用次数(评测断言"重试也占预算"用) */
  get callTotal(): number {
    return this.callCount
  }

  private nextFromResponses(callIndex: number): unknown {
    const responses = this.deps.responses
    if (!responses || callIndex >= responses.length) {
      throw new Error(`FakeProvider 脚本耗尽:第 ${callIndex + 1} 次调用没有可用响应`)
    }
    return responses[callIndex]
  }

  private nullUsage(): TokenUsage {
    return { inputTokens: null, outputTokens: null, totalTokens: null, source: null }
  }
}
