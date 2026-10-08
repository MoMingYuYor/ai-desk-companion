// 模型服务:多服务商配置、流式调用、多模态、有限重试与自动故障切换。
// RES-01:带 control 的 call 走单发送分支——一次 call 最多一次 fetchImpl,
// 强制忽略旧 maxRetriesPerProvider,禁止内部备用切换;重试只由上层工作流发起。
import { randomUUID } from 'node:crypto'
import type { ProviderInfo } from '../../shared/types'
import type { TokenUsage } from '../../shared/agent'
import {
  ModelRequestError,
  nullTokenUsage,
  type ActualProvider,
  type ModelAttemptEvent,
  type ModelAttemptInfo,
  type ModelAttemptRecord,
  type ModelRequestControl
} from './modelRequest'

export type LlmPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | LlmPart[]
}

export interface Attempt {
  provider: ProviderInfo
  apiKey: string | null
  model: string
  isDefault: boolean
}

export type RouterNotice =
  | { type: 'attempt-failed'; attempt: string; reason: string; retryable: boolean }
  | { type: 'switched'; from: string; to: string; reason: string }
  | { type: 'exhausted'; reason: string }

export interface CallOptions {
  messages: LlmMessage[]
  needVision?: boolean
  signal?: AbortSignal
  onDelta?: (delta: string) => void
  onNotice?: (n: RouterNotice) => void
  maxRetriesPerProvider?: number
  timeoutMs?: number
  /** RES-01 单发送控制;携带时忽略 maxRetriesPerProvider 并禁用备用切换 */
  control?: ModelRequestControl
}

export interface CallResult {
  text: string
  used: { providerId: string; providerName: string; model: string }
  /** 实际派发路由(仅 control 分支返回;旧流式调用方按原职责使用 text/used) */
  actualProvider?: ActualProvider | null
  /** 实际网络发送次数 */
  actualAttempts?: number
  /** 逐尝试结算记录 */
  attempts?: readonly ModelAttemptRecord[]
  /** 供应商上报的 token 用量;未返回字段记 null */
  usage?: TokenUsage
}

export class ModelCallError extends Error {
  constructor(
    message: string,
    public readonly attempts: Array<{ attempt: string; reason: string }>
  ) {
    super(message)
    this.name = 'ModelCallError'
  }
}

/** 按计划规则构建尝试链:默认模型优先,失败后按备用顺序切换;不支持所需模态的跳过 */
export function buildChain(
  providers: ProviderInfo[],
  apiKeyOf: (id: string) => string | null,
  opts: { needVision: boolean }
): Attempt[] {
  const capable = providers.filter((p) => (opts.needVision ? p.supportsVision : true))
  const pickModel = (p: ProviderInfo): string =>
    p.defaultModel || p.models[0] || ''
  const attempts: Attempt[] = []
  const def = capable.find((p) => p.isDefault)
  if (def) {
    attempts.push({ provider: def, apiKey: apiKeyOf(def.id), model: pickModel(def), isDefault: true })
  }
  for (const p of capable) {
    if (p === def) continue
    attempts.push({ provider: p, apiKey: apiKeyOf(p.id), model: pickModel(p), isDefault: false })
  }
  return attempts.filter((a) => a.model.trim().length > 0)
}

export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429
}

export function describeHttpError(status: number, bodyText: string): string {
  const brief = bodyText.length > 300 ? bodyText.slice(0, 300) + '…' : bodyText
  if (status === 401 || status === 403) return `鉴权失败(HTTP ${status}):请检查 API Key。${brief}`
  if (status === 404) return `接口地址或模型不存在(HTTP 404):${brief}`
  if (status === 429) return `请求过于频繁或额度不足(HTTP 429):${brief}`
  return `服务返回错误(HTTP ${status}):${brief}`
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '')
  return `${b}${path}`
}

interface FetchLike {
  (url: string, init: RequestInit): Promise<Response>
}

export class ModelRouter {
  constructor(
    private opts: {
      apiKeyOf: (providerId: string) => string | null
      fetchImpl?: FetchLike
    }
  ) {}

  private get fetchImpl(): FetchLike {
    return this.opts.fetchImpl ?? ((url, init) => fetch(url, init))
  }

  async call(providers: ProviderInfo[], options: CallOptions): Promise<CallResult> {
    // RES-01 单发送分支:带 control 的调用不重试、不切换,由上层工作流控制重试
    if (options.control) return this.callControlled(providers, options)
    const needVision = options.needVision ?? false
    const chain = buildChain(providers, this.opts.apiKeyOf, { needVision })
    if (chain.length === 0) {
      throw new ModelCallError(
        needVision
          ? '没有可用的模型服务:请先在"设置 → 模型服务"中配置默认模型(需支持图片)。'
          : '没有可用的模型服务:请先在"设置 → 模型服务"中配置默认模型。',
        []
      )
    }

    const failures: Array<{ attempt: string; reason: string }> = []
    const maxRetries = options.maxRetriesPerProvider ?? 2
    const timeoutMs = options.timeoutMs ?? 180_000

    for (let i = 0; i < chain.length; i++) {
      const attempt = chain[i]
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const label = `${attempt.provider.name} / ${attempt.model}`

      for (let retry = 0; retry <= maxRetries; retry++) {
        if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        try {
          const text = await this.callAttempt(attempt, options, timeoutMs)
          if (i > 0) {
            options.onNotice?.({
              type: 'switched',
              from: chain[0] ? `${chain[0].provider.name} / ${chain[0].model}` : '',
              to: label,
              reason: '默认模型访问失败,已自动切换备用模型'
            })
          }
          return {
            text,
            used: { providerId: attempt.provider.id, providerName: attempt.provider.name, model: attempt.model }
          }
        } catch (err) {
          if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
          const reason = err instanceof Error ? err.message : String(err)
          const retryable = !(err instanceof NonRetryableError)
          failures.push({ attempt: label, reason })
          options.onNotice?.({ type: 'attempt-failed', attempt: label, reason, retryable })
          if (!retryable) break
        }
      }
    }

    options.onNotice?.({
      type: 'exhausted',
      reason: '所有模型服务均不可用,本次材料已保留,可稍后重试。'
    })
    throw new ModelCallError(
      '所有模型服务均不可用:' + failures.map((f) => `${f.attempt}(${f.reason})`).join(';'),
      failures
    )
  }

  /**
   * RES-01 单发送分支:一次 call 最多调用 fetchImpl 一次,忽略旧 maxRetriesPerProvider,
   * 禁止内部备用切换。请求 policy.providerId 缺省时选候选链第一项;指定 ID 不存在则
   * 发送数为 0 并拒绝。beforeSend 同步执行预算准入/取消检查/checkpoint 保存,失败则
   * 不调用 fetch、不发 sent;实际调用 fetchImpl 后在同一同步段立即发 sent(fetch 同步
   * 抛错也记录一次 sent)。onAttempt 回调持久化失败必须 abort 已派发请求,以
   * OBSERVATION_FAILED 失败并保留已派发记录。超时与取消经真实 abort 终止网络,
   * 不用单独 Promise.race 留下后台请求。
   */
  private async callControlled(providers: ProviderInfo[], options: CallOptions): Promise<CallResult> {
    const control = options.control!
    const needVision = options.needVision ?? false
    const chain = buildChain(providers, this.opts.apiKeyOf, { needVision })
    let attempt: Attempt | undefined
    const wanted = control.policy.providerId
    if (wanted !== undefined) {
      attempt = chain.find((a) => a.provider.id === wanted)
      if (!attempt) {
        // 指定 ID 不存在:发送数为 0 并拒绝
        throw new ModelCallError(`指定的模型服务不存在:${wanted}`, [])
      }
    } else {
      attempt = chain[0]
    }
    if (!attempt) {
      throw new ModelCallError(
        needVision
          ? '没有可用的模型服务:请先在"设置 → 模型服务"中配置默认模型(需支持图片)。'
          : '没有可用的模型服务:请先在"设置 → 模型服务"中配置默认模型。',
        []
      )
    }

    const info: ModelAttemptInfo = {
      providerId: attempt.provider.id,
      providerName: attempt.provider.name,
      model: attempt.model,
      requestId: control.requestId,
      attemptId: randomUUID(),
      ordinal: 1
    }

    // 准入:beforeSend 失败则不调用 fetch、不发 sent,错误原样传播(预算语义由上层解释)
    control.beforeSend(info)
    // beforeSend 后再检查 signal:避免准入期间取消仍发送
    if (control.signal.aborted) {
      throw new ModelRequestError('CANCELLED', '发送前已取消,未派发任何请求', [], false)
    }

    // 合并"用户取消"与"单次超时"两个信号;超时经真实 abort 终止网络
    const controller = new AbortController()
    let timedOut = false
    const timer = AbortSignal.timeout(control.timeoutMs)
    const onTimeout = (): void => {
      timedOut = true
      controller.abort(timer.reason)
    }
    timer.addEventListener('abort', onTimeout, { once: true })
    const onExternalAbort = (): void => controller.abort(control.signal.reason)
    if (control.signal.aborted) controller.abort(control.signal.reason)
    else control.signal.addEventListener('abort', onExternalAbort, { once: true })

    const records: ModelAttemptRecord[] = []
    let callbackFailed = false
    let callbackError: unknown
    // 观测派发;回调持久化失败:abort 已派发请求、停止后续发送与观测
    const emit = (event: ModelAttemptEvent): void => {
      if (callbackFailed) return
      try {
        control.onAttempt(event)
      } catch (err) {
        callbackFailed = true
        callbackError = err
        controller.abort(new ModelRequestError('OBSERVATION_FAILED', '观测回调失败,已中止在途请求', records, false))
      }
    }
    const startedAt = Date.now()
    const latency = (): number => Math.max(0, Date.now() - startedAt)
    const recordOf = (base: Omit<ModelAttemptRecord, keyof ModelAttemptInfo>): ModelAttemptRecord => ({ ...info, ...base })
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    let readCompleted = false
    let responseModel: string | null = null
    let usage = nullTokenUsage()
    let httpStatus: number | null = null
    const settle = (outcome: ModelAttemptRecord['outcome']): ModelAttemptRecord => {
      // 先保存再观测；回调失败进入 catch 时仍复用同一条结算，不重复计费。
      if (records.length > 0) return records[0]!
      const record = recordOf({ outcome, latencyMs: latency(), httpStatus, responseModel, usage })
      records.push(record)
      emit({ type: 'settled', attempt: record })
      return record
    }
    const observationFailure = (): ModelRequestError => {
      const reason = callbackError instanceof Error ? callbackError.message : String(callbackError)
      return new ModelRequestError('OBSERVATION_FAILED', `观测回调持久化失败,已停止后续发送:${reason}`, records, false)
    }

    const { provider } = attempt
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (attempt.apiKey) headers.Authorization = `Bearer ${attempt.apiKey}`
    let body: unknown
    let path: string
    if (provider.protocol === 'responses') {
      path = '/responses'
      body = {
        model: attempt.model,
        stream: true,
        input: options.messages.map((m) => ({ role: m.role, content: m.content }))
      }
    } else {
      path = '/chat/completions'
      body = {
        model: attempt.model,
        stream: true,
        messages: options.messages,
        // 声明支持 JSON 结构化输出的服务商启用 response_format;其余靠提示词约束
        ...(provider.supportsJsonMode ? { response_format: { type: 'json_object' } } : {}),
        // RES-01:按协议请求其支持的 usage 流选项
        stream_options: { include_usage: true }
      }
    }

    try {
      let fetchPromise: Promise<Response>
      try {
        fetchPromise = this.fetchImpl(joinUrl(provider.baseUrl, path), {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        })
      } finally {
        // 实际调用 fetch 后立即观测；同步抛错也只发一次 sent。
        emit({ type: 'sent', attempt: info })
      }
      const res = await fetchPromise
      httpStatus = res.status
      if (callbackFailed) throw observationFailure()
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new ModelRequestError('TRANSPORT', describeHttpError(res.status, text), records, isRetryableStatus(res.status))
      }
      if (!res.body) {
        throw new ModelRequestError('TRANSPORT', '服务未返回流式响应体', records, true)
      }

      reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let full = ''
      let sawDone = false
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          readCompleted = true
          break
        }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') {
            sawDone = true
            continue
          }
          if (!data) continue
          let json: Record<string, unknown>
          try {
            json = JSON.parse(data) as Record<string, unknown>
          } catch {
            continue
          }
          // 先捕获供应商元数据，避免同一事件的消费回调抛错后丢失已观察字段。
          const parsedUsage = extractUsage(json, provider.protocol)
          if (parsedUsage) {
            usage = {
              inputTokens: parsedUsage.inputTokens ?? usage.inputTokens,
              outputTokens: parsedUsage.outputTokens ?? usage.outputTokens,
              totalTokens: parsedUsage.totalTokens ?? usage.totalTokens,
              source: parsedUsage.source ?? usage.source
            }
          }
          const parsedModel = extractResponseModel(json)
          if (parsedModel) responseModel = parsedModel
          const delta = extractDelta(json, provider.protocol)
          if (delta) {
            full += delta
            options.onDelta?.(delta)
          }
        }
      }
      if (!sawDone && full.length === 0) {
        throw new Error('模型没有返回任何内容(连接提前中断)')
      }

      settle('succeeded')
      if (callbackFailed) throw observationFailure()
      const actualProvider: ActualProvider = { providerId: attempt.provider.id, providerName: attempt.provider.name, model: attempt.model }
      return {
        text: full,
        used: actualProvider,
        actualProvider,
        actualAttempts: 1,
        attempts: records,
        usage
      }
    } catch (err) {
      settle(callbackFailed ? 'cancelled' : timedOut ? 'timeout' : control.signal.aborted ? 'cancelled' : 'failed')
      // settled 观测也可能失败；检查必须在结算后，且优先于传输错误分类。
      if (callbackFailed) throw observationFailure()
      if (err instanceof ModelRequestError) throw err
      if (timedOut) {
        throw new ModelRequestError('TIMEOUT', `单次请求超时(${control.timeoutMs}ms)`, records, true)
      }
      if (control.signal.aborted) {
        throw new ModelRequestError('CANCELLED', '请求已取消', records, false)
      }
      throw new ModelRequestError('TRANSPORT', err instanceof Error ? err.message : String(err), records, true)
    } finally {
      timer.removeEventListener('abort', onTimeout)
      control.signal.removeEventListener('abort', onExternalAbort)
      if (reader !== null) {
        try {
          if (!readCompleted) await reader.cancel()
        } catch { /* 取消清理失败不能覆盖传输或观测错误。 */ }
        try {
          reader.releaseLock()
        } catch { /* 释放锁失败不能覆盖已经结算的结果。 */ }
      }
    }
  }

  private async callAttempt(attempt: Attempt, options: CallOptions, timeoutMs: number): Promise<string> {
    // 合并"用户取消"与"单次超时"两个信号
    const controller = new AbortController()
    const timer = AbortSignal.timeout(timeoutMs)
    // REL-01:具名回调,结束时在 finally 成对移除——旧实现注册匿名监听器从不移除,
    // 每次普通 Chat 请求都会泄漏 timer/外部 signal 上的 abort 监听器
    const onTimeout = (): void => controller.abort(timer.reason)
    const onExternalAbort = (): void => controller.abort(options.signal?.reason)
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    let readCompleted = false
    timer.addEventListener('abort', onTimeout, { once: true })
    if (options.signal?.aborted) onExternalAbort()
    else options.signal?.addEventListener('abort', onExternalAbort, { once: true })
    const signal: AbortSignal = controller.signal
    const { provider } = attempt
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (attempt.apiKey) headers.Authorization = `Bearer ${attempt.apiKey}`

    let body: unknown
    let path: string
    if (provider.protocol === 'responses') {
      path = '/responses'
      body = {
        model: attempt.model,
        stream: true,
        input: options.messages.map((m) => ({ role: m.role, content: m.content }))
      }
    } else {
      path = '/chat/completions'
      body = {
        model: attempt.model,
        stream: true,
        messages: options.messages,
        // 声明支持 JSON 结构化输出的服务商启用 response_format;其余靠提示词约束
        ...(provider.supportsJsonMode ? { response_format: { type: 'json_object' } } : {})
      }
    }

    // REL-01:try/finally 覆盖整个 fetch 与消费周期,Promise 完成前完成清理
    try {
      const res = await this.fetchImpl(joinUrl(provider.baseUrl, path), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        const err = new Error(describeHttpError(res.status, text))
        if (!isRetryableStatus(res.status)) throw new NonRetryableError(err.message)
        throw err
      }
      if (!res.body) throw new Error('服务未返回流式响应体')

      reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let full = ''
      let sawDone = false
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          // REL-01:仅真实 EOF 置位;[DONE] 只是协议标记,底层 reader 仍需继续读到 done
          readCompleted = true
          break
        }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') {
            sawDone = true
            continue
          }
          if (!data) continue
          let json: Record<string, unknown>
          try {
            json = JSON.parse(data) as Record<string, unknown>
          } catch {
            continue
          }
          const delta = extractDelta(json, provider.protocol)
          if (delta) {
            full += delta
            options.onDelta?.(delta)
          }
        }
      }
      if (!sawDone && full.length === 0) {
        throw new Error('模型没有返回任何内容(连接提前中断)')
      }
      return full
    } finally {
      // REL-01:监听器成对移除;未读到 EOF 的流先 abort 在途网络再 cancel,最后释放锁。
      // 清理失败一律吞掉,不覆盖原始传输/回调错误或成功结果。
      timer.removeEventListener('abort', onTimeout)
      options.signal?.removeEventListener('abort', onExternalAbort)
      if (reader) {
        if (!readCompleted) {
          controller.abort()
          try {
            await reader.cancel()
          } catch { /* 保留原始错误 */ }
        }
        try {
          reader.releaseLock()
        } catch { /* 不覆盖已确定的结果 */ }
      }
    }
  }

  async testProvider(input: {
    baseUrl: string
    protocol: string
    apiKey: string | null
    model: string
  }): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const start = Date.now()
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`
      const body =
        input.protocol === 'responses'
          ? { model: input.model, input: 'ping', max_output_tokens: 8 }
          : { model: input.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: false }
      const res = await this.fetchImpl(joinUrl(input.baseUrl, input.protocol === 'responses' ? '/responses' : '/chat/completions'), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000)
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return { ok: false, error: describeHttpError(res.status, text) }
      }
      await res.text()
      return { ok: true, latencyMs: Date.now() - start }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async fetchModelList(input: { baseUrl: string; apiKey: string | null }): Promise<string[]> {
    const headers: Record<string, string> = {}
    if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`
    const res = await this.fetchImpl(joinUrl(input.baseUrl, '/models'), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(describeHttpError(res.status, text))
    }
    const json = (await res.json()) as { data?: Array<{ id?: string }> }
    return (json.data ?? []).map((m) => m.id ?? '').filter((id) => id.length > 0).sort()
  }
}

class NonRetryableError extends Error {}

function extractDelta(json: Record<string, unknown>, protocol: string): string {
  if (protocol === 'responses') {
    if (json.type === 'response.output_text.delta' && typeof json.delta === 'string') return json.delta
    return ''
  }
  const choices = json.choices as Array<{ delta?: { content?: unknown } }> | undefined
  const delta = choices?.[0]?.delta?.content
  if (typeof delta === 'string') return delta
  if (Array.isArray(delta)) {
    return delta
      .map((p) => (typeof (p as { text?: string }).text === 'string' ? (p as { text: string }).text : ''))
      .join('')
  }
  return ''
}

/**
 * RES-01:从流事件提取供应商上报的 usage。
 * Responses 协议取 response.completed.response.usage(input_tokens 等);
 * Chat Completions 协议取 usage 流事件(prompt_tokens 等)。
 * 未返回的字段记 null,不估算、不填零。
 */
function extractUsage(json: Record<string, unknown>, protocol: string): TokenUsage | null {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  if (protocol === 'responses') {
    if (json.type !== 'response.completed') return null
    const response = json.response as Record<string, unknown> | undefined
    const u = response?.usage
    if (typeof u !== 'object' || u === null) return null
    const usage = u as Record<string, unknown>
    const input = num(usage.input_tokens)
    const output = num(usage.output_tokens)
    const total = num(usage.total_tokens) ?? (input !== null && output !== null ? input + output : null)
    return { inputTokens: input, outputTokens: output, totalTokens: total, source: 'provider-reported' }
  }
  const u = json.usage
  if (typeof u !== 'object' || u === null) return null
  const usage = u as Record<string, unknown>
  const input = num(usage.prompt_tokens)
  const output = num(usage.completion_tokens)
  const total = num(usage.total_tokens) ?? (input !== null && output !== null ? input + output : null)
  return { inputTokens: input, outputTokens: output, totalTokens: total, source: 'provider-reported' }
}

/** RES-01:响应中可取得的模型标识(responseModel);取不到为 null,不冒充冻结配置 */
function extractResponseModel(json: Record<string, unknown>): string | null {
  if (json.type === 'response.completed') {
    const response = json.response as Record<string, unknown> | undefined
    return typeof response?.model === 'string' ? response.model : null
  }
  return typeof json.model === 'string' ? json.model : null
}
