// 真实模型的结构化补全适配器(A-05):基于既有 ModelRouter。
// 用量契约:供应商未返回的字段记 null,不记 0(总体规格第 7 节)。
// 解析:优先解析纯 JSON;失败时剥离 ```json 围栏后重试一次;仍失败抛
// MODEL_OUTPUT_INVALID(由编排器转为运行失败,不悄悄降级)。
// RES-01:control 缺省时生成一次发送的默认控制(自身从不重试);坏 JSON 解析
// 失败抛 ModelRequestError(MODEL_OUTPUT_INVALID),保留已完成传输的 usage/route。

import { randomUUID } from 'node:crypto'
import type { SqliteDb } from '../db/connection'
import { listProviders } from '../db/dao'
import { ModelRouter, type LlmMessage } from '../services/modelRouter'
import { ModelRequestError, nullTokenUsage, type ModelRequestControl } from '../services/modelRequest'
import { appError } from '../../shared/operations'
import { systemClock, type Clock } from '../../shared/clock'
import type { TokenUsage } from '../../shared/agent'
import type { ProviderInfo } from '../../shared/types'
import type {
  StructuredCompleteRequest,
  StructuredCompleteResult,
  StructuredCompleter
} from './llm'

export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelOutputError'
  }
  toAppError() {
    return appError('MODEL_OUTPUT_INVALID', this.message, { retryable: true })
  }
}

/** 从模型文本中提取 JSON:纯 JSON 或 ```json 围栏 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
    if (fenced?.[1]) return JSON.parse(fenced[1]!.trim())
    throw new ModelOutputError('模型输出不是合法的 JSON')
  }
}

export type ModelCompleterDeps = ({ db: SqliteDb; providers?: never } | { providers: () => ProviderInfo[]; db?: never }) & {
  router: ModelRouter
  clock?: Clock
  /** 单次请求超时(毫秒);缺省 control 时的默认超时仍取本配置 */
  timeoutMs?: number
}

export class ModelCompleter implements StructuredCompleter {
  constructor(private readonly deps: ModelCompleterDeps) {}

  async completeJson<T>(request: StructuredCompleteRequest): Promise<StructuredCompleteResult<T>> {
    const providers = this.deps.providers ? this.deps.providers() : listProviders(this.deps.db)
    if (providers.length === 0) {
      throw new ModelOutputError('未配置模型服务商')
    }
    const messages: LlmMessage[] = [
      { role: 'system', content: request.system },
      { role: 'user', content: request.prompt }
    ]
    const clock = this.deps.clock ?? systemClock
    const started = clock.monotonicMs()
    const result = await this.deps.router.call(providers, {
      messages,
      // control 缺省:生成一次发送的默认控制(默认超时取构造配置;自身从不重试)
      control: request.control ?? this.defaultControl()
    })
    const latencyMs = clock.monotonicMs() - started

    const attempts = result.attempts ?? []
    const usage: TokenUsage = result.usage ?? nullTokenUsage()
    const actualProvider = result.actualProvider ?? { ...result.used }
    const actualAttempts = result.actualAttempts ?? 1

    let data: unknown
    try {
      data = extractJson(result.text)
    } catch (err) {
      const message = err instanceof ModelOutputError ? err.message : String(err instanceof Error ? err.message : err)
      // 坏 JSON 也保留已完成传输的 usage/route,不把失败尝试丢弃
      throw new ModelRequestError('MODEL_OUTPUT_INVALID', message, attempts, true)
    }

    return { data: data as T, model: result.used.model, usage, latencyMs, actualProvider, actualAttempts, attempts }
  }

  /** 非研究调用方的默认控制:一次发送、从不取消、不观测 */
  private defaultControl(): ModelRequestControl {
    return {
      requestId: randomUUID(),
      signal: new AbortController().signal,
      timeoutMs: this.deps.timeoutMs ?? 180_000,
      policy: { maxAttempts: 1, fallback: 'disabled' },
      beforeSend: () => {},
      onAttempt: () => {}
    }
  }
}
