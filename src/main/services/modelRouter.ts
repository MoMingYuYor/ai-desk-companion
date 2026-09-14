// 模型服务:多服务商配置、流式调用、多模态、有限重试与自动故障切换
import type { ProviderInfo } from '../../shared/types'

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
}

export interface CallResult {
  text: string
  used: { providerId: string; providerName: string; model: string }
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

  private async callAttempt(attempt: Attempt, options: CallOptions, timeoutMs: number): Promise<string> {
    // 合并"用户取消"与"单次超时"两个信号
    const controller = new AbortController()
    const timer = AbortSignal.timeout(timeoutMs)
    timer.addEventListener('abort', () => controller.abort(timer.reason), { once: true })
    if (options.signal) {
      if (options.signal.aborted) controller.abort(options.signal.reason)
      else options.signal.addEventListener('abort', () => controller.abort(options.signal!.reason), { once: true })
    }
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
      body = { model: attempt.model, stream: true, messages: options.messages }
    }

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

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''
    let sawDone = false
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
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
