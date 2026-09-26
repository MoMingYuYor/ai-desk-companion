// 真实模型的结构化补全适配器(A-05):基于既有 ModelRouter。
// 用量契约:CallResult 不返回 token 用量 → 记 null 不记 0(总体规格第 7 节)。
// 解析:优先解析纯 JSON;失败时剥离 ```json 围栏后重试一次;仍失败抛
// MODEL_OUTPUT_INVALID(由编排器转为运行失败,不悄悄降级)。

import type { SqliteDb } from '../db/connection'
import { listProviders } from '../db/dao'
import { ModelRouter, type LlmMessage } from '../services/modelRouter'
import { appError } from '../../shared/operations'
import { systemClock, type Clock } from '../../shared/clock'
import type { TokenUsage } from '../../shared/agent'
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

export interface ModelCompleterDeps {
  db: SqliteDb
  router: ModelRouter
  clock?: Clock
  /** 单次请求超时(毫秒) */
  timeoutMs?: number
}

export class ModelCompleter implements StructuredCompleter {
  constructor(private readonly deps: ModelCompleterDeps) {}

  async completeJson<T>(request: StructuredCompleteRequest): Promise<StructuredCompleteResult<T>> {
    const providers = listProviders(this.deps.db)
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
      timeoutMs: this.deps.timeoutMs
    })
    const latencyMs = clock.monotonicMs() - started

    let data: unknown
    try {
      data = extractJson(result.text)
    } catch (err) {
      if (err instanceof ModelOutputError) throw err
      throw new ModelOutputError(String(err instanceof Error ? err.message : err))
    }

    // CallResult 未返回用量:未知记 null,不记 0
    const usage: TokenUsage = {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      source: null
    }
    return { data: data as T, model: result.used.model, usage, latencyMs }
  }
}
