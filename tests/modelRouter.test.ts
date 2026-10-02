import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderInfo } from '../src/shared/types'
import type { TokenUsage } from '../src/shared/agent'
import {
  buildChain,
  describeHttpError,
  isRetryableStatus,
  ModelCallError,
  ModelRouter,
  type LlmMessage
} from '../src/main/services/modelRouter'
import { ModelRequestError, type ModelAttemptEvent, type ModelRequestControl } from '../src/main/services/modelRequest'

function provider(partial: Partial<ProviderInfo>): ProviderInfo {
  return {
    id: partial.id ?? 'p',
    name: partial.name ?? 'P',
    baseUrl: partial.baseUrl ?? 'https://api.example.com/v1',
    protocol: partial.protocol ?? 'chat-completions',
    models: partial.models ?? ['m1'],
    defaultModel: partial.defaultModel ?? 'm1',
    supportsVision: partial.supportsVision ?? true,
    supportsJsonMode: partial.supportsJsonMode ?? false,
    isDefault: partial.isDefault ?? false,
    sortOrder: partial.sortOrder ?? 0,
    hasApiKey: partial.hasApiKey ?? true,
    createdAt: '',
    updatedAt: ''
  }
}

const keyOf = (id: string): string | null => (id === 'nokey' ? null : 'sk-' + id)

describe('故障切换链', () => {
  it('默认模型排第一,其余按顺序作为备用', () => {
    const providers = [
      provider({ id: 'b', name: '备用A', sortOrder: 1 }),
      provider({ id: 'd', name: '默认', isDefault: true, defaultModel: 'dm' }),
      provider({ id: 'c', name: '备用B', sortOrder: 2 })
    ]
    const chain = buildChain(providers, keyOf, { needVision: false })
    expect(chain.map((a) => a.provider.id)).toEqual(['d', 'b', 'c'])
    expect(chain[0].model).toBe('dm')
  })

  it('需要视觉能力时跳过不支持的模型', () => {
    const providers = [
      provider({ id: 'd', isDefault: true, supportsVision: false }),
      provider({ id: 'v', supportsVision: true })
    ]
    const chain = buildChain(providers, keyOf, { needVision: true })
    expect(chain.map((a) => a.provider.id)).toEqual(['v'])
  })
})

describe('自动切换行为', () => {
  const messages: LlmMessage[] = [{ role: 'user', content: '分析这段通知' }]

  function sse(text: string): Response {
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`
    return new Response(body, { status: 200 })
  }

  it('默认模型连续失败后切换备用并完成,产生 switched 提示', async () => {
    let calls = 0
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request): Promise<Response> => {
      calls++
      urls.push(String(url))
      if (String(url).includes('default.com')) throw new Error('connect ECONNREFUSED')
      return sse('备用结果')
    })
    const router = new ModelRouter({ apiKeyOf: keyOf, fetchImpl: fetchImpl as unknown as typeof fetch })
    const providers = [
      provider({ id: 'd', name: '默认', baseUrl: 'https://default.com/v1', isDefault: true }),
      provider({ id: 'b', name: '备用', baseUrl: 'https://backup.com/v1' })
    ]
    const notices: unknown[] = []
    const result = await router.call(providers, {
      messages,
      maxRetriesPerProvider: 1,
      onNotice: (n) => notices.push(n)
    })
    expect(result.text).toBe('备用结果')
    expect(result.used.providerName).toBe('备用')
    expect(urls.every((u) => !u.includes('undefined'))).toBe(true)
    const switched = notices.find((n) => (n as { type: string }).type === 'switched')
    expect(switched).toBeTruthy()
    // 默认模型重试 2 次(初始+1),然后切换备用
    expect(urls.filter((u) => u.includes('default.com')).length).toBe(2)
  })

  it('全部失败时保留材料并抛错(不再无限循环)', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      throw new Error('connect timeout')
    })
    const router = new ModelRouter({ apiKeyOf: keyOf, fetchImpl: fetchImpl as unknown as typeof fetch })
    const providers = [provider({ id: 'd', isDefault: true }), provider({ id: 'b' })]
    await expect(
      router.call(providers, { messages, maxRetriesPerProvider: 1 })
    ).rejects.toBeInstanceOf(ModelCallError)
    expect(fetchImpl).toHaveBeenCalledTimes(4) // 2 providers × 2 attempts
  })

  it('用户取消后不再发起后续请求', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      await new Promise((r) => setTimeout(r, 50))
      throw new Error('connect timeout')
    })
    const router = new ModelRouter({ apiKeyOf: keyOf, fetchImpl: fetchImpl as unknown as typeof fetch })
    const providers = [provider({ id: 'd', isDefault: true }), provider({ id: 'b' })]
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10)
    await expect(
      router.call(providers, { messages, maxRetriesPerProvider: 1, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    const callsBefore = fetchImpl.mock.calls.length
    await new Promise((r) => setTimeout(r, 120))
    expect(fetchImpl.mock.calls.length).toBe(callsBefore)
  })

  it('鉴权失败(4xx)不重试,直接切换', async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request): Promise<Response> => {
      urls.push(String(url))
      if (String(url).includes('default.com')) {
        return new Response('{"error":"bad key"}', { status: 401 })
      }
      return sse('ok')
    })
    const router = new ModelRouter({ apiKeyOf: keyOf, fetchImpl: fetchImpl as unknown as typeof fetch })
    const providers = [
      provider({ id: 'd', baseUrl: 'https://default.com/v1', isDefault: true }),
      provider({ id: 'b', baseUrl: 'https://backup.com/v1' })
    ]
    const result = await router.call(providers, { messages, maxRetriesPerProvider: 2 })
    expect(result.text).toBe('ok')
    expect(urls.filter((u) => u.includes('default.com')).length).toBe(1)
  })
})

describe('错误描述与重试判定', () => {
  it('429/5xx 可重试,4xx 不可', () => {
    expect(isRetryableStatus(500)).toBe(true)
    expect(isRetryableStatus(429)).toBe(true)
    expect(isRetryableStatus(401)).toBe(false)
    expect(isRetryableStatus(404)).toBe(false)
  })

  it('错误信息说明原因', () => {
    expect(describeHttpError(401, '')).toContain('API Key')
    expect(describeHttpError(404, '')).toContain('接口地址')
  })
})

describe('JSON 结构化输出能力', () => {
  it('声明支持的 provider 注入 response_format,未声明的不注入', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      const text = `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`
      return new Response(text, { status: 200 })
    })
    const router = new ModelRouter({ apiKeyOf: keyOf, fetchImpl: fetchImpl as unknown as typeof fetch })
    const messages: LlmMessage[] = [{ role: 'user', content: 'x' }]
    await router.call([provider({ id: 'on', supportsJsonMode: true })], { messages })
    await router.call([provider({ id: 'off', supportsJsonMode: false })], { messages })
    expect(bodies[0].response_format).toEqual({ type: 'json_object' })
    expect(bodies[1].response_format).toBeUndefined()
  })
})

// ---------- RES-01 单发送契约(带 control 的调用;fetchImpl 只返回本地响应) ----------

describe('RES-01 单发送契约', () => {
  const messages: LlmMessage[] = [{ role: 'user', content: 'x' }]

  function controlOf(over: Partial<ModelRequestControl> = {}): ModelRequestControl {
    return {
      requestId: 'res-01',
      signal: new AbortController().signal,
      timeoutMs: 20,
      policy: { maxAttempts: 1, fallback: 'disabled' },
      beforeSend: () => {},
      onAttempt: () => {},
      ...over
    }
  }

  it('RES-01 单发送策略不隐藏重试或备用切换', async () => {
    const events: ModelAttemptEvent[] = []
    const fetchImpl = vi.fn(async () => new Response('限流', { status: 429 }))
    const router = new ModelRouter({ apiKeyOf: () => 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch })
    const control = controlOf({ onAttempt: (event) => events.push(event) })
    await expect(
      router.call([provider({ id: 'a', isDefault: true }), provider({ id: 'b' })], { messages, control })
    ).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(events.filter((e) => e.type === 'sent')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'settled')).toHaveLength(1)
  })

  it('RES-01 准入拒绝或预取消发送 0 次、不发 sent、错误原样传播', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => new Response('ok', { status: 200 }))
    const router = new ModelRouter({ apiKeyOf: () => 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    // beforeSend 抛错(预算准入失败):不 fetch、不发 sent
    await expect(
      router.call([provider({ id: 'a', isDefault: true })], {
        messages,
        control: controlOf({ beforeSend: () => { throw new Error('预算准入失败') } })
      })
    ).rejects.toThrow('预算准入失败')
    // 预取消:signal 在派发前已 aborted,不发送
    const aborted = new AbortController()
    aborted.abort()
    await expect(
      router.call([provider({ id: 'a', isDefault: true })], {
        messages,
        control: controlOf({ signal: aborted.signal })
      })
    ).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('RES-01 指定 policy.providerId 不存在时发送 0 次并拒绝', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => new Response('ok', { status: 200 }))
    const router = new ModelRouter({ apiKeyOf: () => 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(
      router.call([provider({ id: 'a', isDefault: true })], {
        messages,
        control: controlOf({ policy: { maxAttempts: 1, fallback: 'disabled', providerId: 'missing' } })
      })
    ).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('RES-01 chat 协议请求 include_usage 并把 usage 流事件映射为 TokenUsage', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      const body =
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [], model: 'm1-real', usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\n` +
        'data: [DONE]\n\n'
      return new Response(body, { status: 200 })
    })
    const router = new ModelRouter({ apiKeyOf: () => 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    const events: ModelAttemptEvent[] = []
    const result = await router.call([provider({ id: 'a', isDefault: true })], {
      messages,
      control: controlOf({ timeoutMs: 2000, onAttempt: (event) => events.push(event) })
    })
    expect(bodies[0]!.stream_options).toEqual({ include_usage: true })
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18, source: 'provider-reported' })
    expect(result.actualProvider).toEqual({ providerId: 'a', providerName: 'P', model: 'm1' })
    expect(result.actualAttempts).toBe(1)
    expect(result.attempts).toHaveLength(1)
    const settled = events.find((e) => e.type === 'settled') as Extract<ModelAttemptEvent, { type: 'settled' }>
    expect(settled.attempt.outcome).toBe('succeeded')
    expect(settled.attempt.usage.totalTokens).toBe(18)
    expect(settled.attempt.responseModel).toBe('m1-real')
  })

  it('RES-01 缺 usage 的成功保留全 null;responses 协议 response.completed.usage 亦映射', async () => {
    // chat 协议:无 usage 块
    const fetchNoUsage = vi.fn(async (): Promise<Response> => {
      const body = `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`
      return new Response(body, { status: 200 })
    })
    const routerA = new ModelRouter({ apiKeyOf: () => 'k', fetchImpl: fetchNoUsage as unknown as typeof fetch })
    const resultA = await routerA.call([provider({ id: 'a', isDefault: true })], { messages, control: controlOf({ timeoutMs: 2000 }) })
    expect(resultA.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, source: null })

    // responses 协议:response.completed.response.usage
    const fetchResponses = vi.fn(async (): Promise<Response> => {
      const body =
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n` +
        `data: ${JSON.stringify({ type: 'response.completed', response: { model: 'm1-resp', usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } })}\n\n`
      return new Response(body, { status: 200 })
    })
    const routerB = new ModelRouter({ apiKeyOf: () => 'k', fetchImpl: fetchResponses as unknown as typeof fetch })
    const resultB = await routerB.call(
      [provider({ id: 'r', isDefault: true, protocol: 'responses' })],
      { messages, control: controlOf({ timeoutMs: 2000 }) }
    )
    expect(resultB.usage).toEqual({ inputTokens: 5, outputTokens: 3, totalTokens: 8, source: 'provider-reported' })
    expect(resultB.actualProvider!.model).toBe('m1')
    expect(resultB.text).toBe('ok')
  })

  it('RES-01 fetch 同步抛错也记录一次 sent 与一次 settled', async () => {
    const events: ModelAttemptEvent[] = []
    const fetchImpl = vi.fn((): Response => {
      throw new Error('boom')
    })
    const router = new ModelRouter({ apiKeyOf: () => 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(
      router.call([provider({ id: 'a', isDefault: true })], {
        messages,
        control: controlOf({ onAttempt: (event) => events.push(event) })
      })
    ).rejects.toThrow('boom')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(events.filter((e) => e.type === 'sent')).toHaveLength(1)
    const settled = events.filter((e) => e.type === 'settled') as Array<Extract<ModelAttemptEvent, { type: 'settled' }>>
    expect(settled).toHaveLength(1)
    expect(settled[0]!.attempt.outcome).toBe('failed')
    expect(settled[0]!.attempt.httpStatus).toBeNull()
    expect(settled[0]!.attempt.usage.totalTokens).toBeNull()
  })
})

describe('T08 受控流观测与资源清理', () => {
  const messages: LlmMessage[] = [{ role: 'user', content: 'synthetic request' }]
  const observedUsage: TokenUsage = { inputTokens: 11, outputTokens: 7, totalTokens: 18, source: 'provider-reported' }
  const noUsage: TokenUsage = { inputTokens: null, outputTokens: null, totalTokens: null, source: null }
  let external: AbortController
  let timeout: AbortController
  let events: ModelAttemptEvent[]

  beforeEach(() => {
    external = new AbortController()
    timeout = new AbortController()
    events = []
    // 用受控超时信号触发 abort，不依赖真实时钟。
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    vi.spyOn(timeout.signal, 'addEventListener')
    vi.spyOn(timeout.signal, 'removeEventListener')
    vi.spyOn(external.signal, 'addEventListener')
    vi.spyOn(external.signal, 'removeEventListener')
  })

  afterEach(() => vi.restoreAllMocks())

  function control(onAttempt: ModelRequestControl['onAttempt'] = (event) => { events.push(event) }): ModelRequestControl {
    return {
      requestId: 't08-synthetic', signal: external.signal, timeoutMs: 1000,
      policy: { maxAttempts: 1, fallback: 'disabled' }, beforeSend: () => {}, onAttempt
    }
  }

  function frame(json: unknown): string {
    return `data: ${JSON.stringify(json)}\n\n`
  }

  function metadata(protocol: string): string {
    return protocol === 'responses'
      ? frame({ type: 'response.completed', response: { model: 'reported-model', usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } } })
      : frame({ model: 'reported-model', choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })
  }

  function delta(protocol = 'chat-completions'): string {
    return protocol === 'responses'
      ? frame({ type: 'response.output_text.delta', delta: 'ok' })
      : frame({ choices: [{ delta: { content: 'ok' } }] })
  }

  function streamResponse(
    frames: string[],
    finish: (controller: ReadableStreamDefaultController<Uint8Array>) => void = (controller) => controller.close(),
    faults: { cancel?: Error; release?: Error; beforeCancel?: () => Promise<void> } = {}
  ) {
    let index = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < frames.length) controller.enqueue(new TextEncoder().encode(frames[index++]!))
        else finish(controller)
      }
    }, { highWaterMark: 0 })
    const acquire = stream.getReader.bind(stream)
    let cancelReader: () => Promise<void> = async () => {}
    let releaseReader: () => void = () => {}
    const cancel = vi.fn(async () => {
      await faults.beforeCancel?.()
      if (faults.cancel) throw faults.cancel
      await cancelReader()
    })
    const releaseLock = vi.fn(() => {
      releaseReader()
      if (faults.release) throw faults.release
    })
    vi.spyOn(stream, 'getReader').mockImplementation(() => {
      const reader = acquire()
      cancelReader = reader.cancel.bind(reader)
      releaseReader = reader.releaseLock.bind(reader)
      vi.spyOn(reader, 'cancel').mockImplementation(cancel)
      vi.spyOn(reader, 'releaseLock').mockImplementation(releaseLock)
      return reader
    })
    return { response: new Response(stream, { status: 200 }), stream, cancel, releaseLock }
  }

  function assertListenersRemoved(): void {
    for (const signal of [timeout.signal, external.signal]) {
      const added = vi.mocked(signal.addEventListener).mock.calls.filter(([type]) => type === 'abort')
      expect(added).toHaveLength(1)
      expect(signal.removeEventListener).toHaveBeenCalledExactlyOnceWith('abort', added[0]![1])
    }
  }

  function assertOneSettlement(error: unknown, outcome: string, usage = observedUsage, responseModel: string | null = 'reported-model'): void {
    expect(error).toBeInstanceOf(ModelRequestError)
    const attempts = (error as ModelRequestError).attempts
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ outcome, httpStatus: 200, responseModel, usage })
    const sent = events.filter((event) => event.type === 'sent')
    const settled = events.filter((event) => event.type === 'settled')
    expect(sent).toHaveLength(1)
    expect(settled).toHaveLength(1)
    expect(settled[0]!.attempt).toBe(attempts[0])
    expect(settled[0]!.attempt.attemptId).toBe(sent[0]!.attempt.attemptId)
  }

  it.each(['chat-completions', 'responses'] as const)('T08 %s usage 后 read 抛错保留已观察字段', async (protocol) => {
    const sourceError = new Error('synthetic reader failure')
    const resource = streamResponse([metadata(protocol)], (controller) => controller.error(sourceError))
    const fetchImpl = vi.fn(async () => resource.response)
    const router = new ModelRouter({ apiKeyOf: () => 'synthetic-key', fetchImpl })
    const error = await router.call([provider({ protocol })], { messages, control: control() }).catch((err: unknown) => err)
    expect(error).toMatchObject({ code: 'TRANSPORT', message: sourceError.message })
    assertOneSettlement(error, 'failed')
    expect(resource.cancel).toHaveBeenCalledTimes(1)
    expect(resource.releaseLock).toHaveBeenCalledTimes(1)
    expect(resource.stream.locked).toBe(false)
    assertListenersRemoved()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each(['cancel', 'timeout'] as const)('T08 usage 后 %s 保留字段并通过 signal 终止传输', async (ending) => {
    let requestSignal: AbortSignal
    const resource = streamResponse([metadata('chat-completions')], (controller) => {
      if (ending === 'cancel') external.abort(new Error('synthetic cancellation'))
      else timeout.abort(new DOMException('synthetic timeout', 'TimeoutError'))
      // 合成传输遵守合并后的 signal，不把在途请求留在后台。
      controller.error(requestSignal.reason)
    })
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal
      return resource.response
    })
    const router = new ModelRouter({ apiKeyOf: () => 'synthetic-key', fetchImpl })
    const error = await router.call([provider({})], { messages, control: control() }).catch((err: unknown) => err)
    expect(error).toMatchObject({ code: ending === 'cancel' ? 'CANCELLED' : 'TIMEOUT' })
    expect(requestSignal!.aborted).toBe(true)
    assertOneSettlement(error, ending === 'cancel' ? 'cancelled' : 'timeout')
    expect(resource.cancel).toHaveBeenCalledTimes(1)
    expect(resource.releaseLock).toHaveBeenCalledTimes(1)
    expect(resource.stream.locked).toBe(false)
    assertListenersRemoved()
  })

  it('T08 同一事件内 onDelta 抛错仍保留 model/usage；清理失败不覆盖原错', async () => {
    const sourceError = new Error('synthetic delta failure')
    const resource = streamResponse([
      frame({ model: 'reported-model', usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }, choices: [{ delta: { content: 'ok' } }] })
    ], undefined, { cancel: new Error('synthetic cancel failure'), release: new Error('synthetic release failure') })
    const router = new ModelRouter({ apiKeyOf: () => 'synthetic-key', fetchImpl: async () => resource.response })
    const error = await router.call([provider({})], {
      messages, control: control(), onDelta: () => { throw sourceError }
    }).catch((err: unknown) => err)
    expect(error).toMatchObject({ code: 'TRANSPORT', message: sourceError.message })
    assertOneSettlement(error, 'failed')
    expect(resource.cancel).toHaveBeenCalledTimes(1)
    expect(resource.releaseLock).toHaveBeenCalledTimes(1)
    expect(resource.stream.locked).toBe(false)
    assertListenersRemoved()
  })

  it.each(['success', 'read failure', 'cancel', 'timeout', 'HTTP rejection', 'sync fetch failure'] as const)(
    'T08 %s 的 settled 观测失败只结算一次并报 OBSERVATION_FAILED', async (ending) => {
      let requestSignal: AbortSignal
      const resource = streamResponse([metadata('chat-completions'), delta()], (controller) => {
        if (ending === 'success') controller.close()
        else {
          if (ending === 'cancel') external.abort()
          if (ending === 'timeout') timeout.abort()
          controller.error(ending === 'read failure' ? new Error('synthetic read failure') : requestSignal.reason)
        }
      })
      const fetchImpl = vi.fn((_url: string, init: RequestInit): Promise<Response> => {
        requestSignal = init.signal as AbortSignal
        if (ending === 'sync fetch failure') throw new Error('synthetic sync fetch failure')
        return Promise.resolve(ending === 'HTTP rejection' ? new Response('synthetic rejection', { status: 403 }) : resource.response)
      })
      const router = new ModelRouter({ apiKeyOf: () => 'synthetic-key', fetchImpl })
      const error = await router.call([provider({})], {
        messages, control: control((event) => {
          events.push(event)
          if (event.type === 'settled') throw new Error('synthetic observation failure')
        })
      }).catch((err: unknown) => err)
      expect(error).toMatchObject({ code: 'OBSERVATION_FAILED', retryable: false })
      expect((error as Error).message).toContain('synthetic observation failure')
      expect((error as ModelRequestError).attempts).toHaveLength(1)
      expect(events.filter((event) => event.type === 'settled')).toHaveLength(1)
      const record = (error as ModelRequestError).attempts[0]!
      expect(record.outcome).toBe(ending === 'success' ? 'succeeded' : ending === 'cancel' ? 'cancelled' : ending === 'timeout' ? 'timeout' : 'failed')
      expect(record.httpStatus).toBe(ending === 'sync fetch failure' ? null : ending === 'HTTP rejection' ? 403 : 200)
      expect(record.usage).toEqual(ending === 'HTTP rejection' || ending === 'sync fetch failure' ? noUsage : observedUsage)
      if (ending !== 'HTTP rejection' && ending !== 'sync fetch failure') {
        expect(resource.cancel).toHaveBeenCalledTimes(ending === 'success' ? 0 : 1)
        expect(resource.releaseLock).toHaveBeenCalledTimes(1)
        expect(resource.stream.locked).toBe(false)
      }
      expect(requestSignal!.aborted).toBe(true)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      assertListenersRemoved()
    }
  )

  it.each([null, new Error('synthetic sent failure')] as const)('T08 sent 失败中止并等待传输，不发 settled（%s）', async (reason) => {
    let requestSignal: AbortSignal
    let transportStopped = false
    const fetchImpl = vi.fn((_url: string, init: RequestInit): Promise<Response> => {
      requestSignal = init.signal as AbortSignal
      return new Promise((_resolve, reject) => {
        requestSignal.addEventListener('abort', () => {
          transportStopped = true
          reject(requestSignal.reason)
        }, { once: true })
      })
    })
    const router = new ModelRouter({ apiKeyOf: () => 'synthetic-key', fetchImpl })
    const error = await router.call([provider({})], {
      messages, control: control((event) => { events.push(event); throw reason })
    }).catch((err: unknown) => err)
    expect(error).toMatchObject({ code: 'OBSERVATION_FAILED', retryable: false })
    expect((error as ModelRequestError).attempts).toHaveLength(1)
    expect((error as ModelRequestError).attempts[0]).toMatchObject({ outcome: 'cancelled', httpStatus: null, responseModel: null, usage: noUsage })
    expect(events.map((event) => event.type)).toEqual(['sent'])
    expect(transportStopped).toBe(true)
    expect(requestSignal!.aborted).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    assertListenersRemoved()
  })

  it('T08 成功 EOF 只释放 reader、移除监听器；后续 abort 不再传入已结束请求', async () => {
    let requestSignal: AbortSignal
    const resource = streamResponse([metadata('chat-completions'), delta()])
    const router = new ModelRouter({ apiKeyOf: () => 'synthetic-key', fetchImpl: async (_url, init) => {
      requestSignal = init.signal as AbortSignal
      return resource.response
    } })
    const result = await router.call([provider({})], { messages, control: control() })
    expect(result.text).toBe('ok')
    expect(result.usage).toEqual(observedUsage)
    expect(result.attempts).toHaveLength(1)
    expect(events.filter((event) => event.type === 'settled')).toHaveLength(1)
    expect(resource.cancel).not.toHaveBeenCalled()
    expect(resource.releaseLock).toHaveBeenCalledTimes(1)
    expect(resource.stream.locked).toBe(false)
    assertListenersRemoved()
    external.abort()
    timeout.abort()
    expect(requestSignal!.aborted).toBe(false)
  })

  it('T08 等待异步 cancel 完成后才释放锁并向调用方返回原错', async () => {
    const sourceError = new Error('synthetic consumer failure')
    let finishCancel!: () => void
    let notifyCancel!: () => void
    const cancelStarted = new Promise<void>((resolve) => { notifyCancel = resolve })
    const cancelPending = new Promise<void>((resolve) => { finishCancel = resolve })
    const resource = streamResponse([metadata('chat-completions'), delta()], undefined, {
      beforeCancel: async () => { notifyCancel(); await cancelPending }
    })
    const router = new ModelRouter({ apiKeyOf: () => 'synthetic-key', fetchImpl: async () => resource.response })
    let returned = false
    const request = router.call([provider({})], {
      messages, control: control(), onDelta: () => { throw sourceError }
    }).catch((err: unknown) => { returned = true; return err })
    await cancelStarted
    try {
      expect(returned).toBe(false)
      expect(resource.releaseLock).not.toHaveBeenCalled()
      expect(resource.stream.locked).toBe(true)
    } finally {
      finishCancel()
    }
    const error = await request
    expect(error).toMatchObject({ code: 'TRANSPORT', message: sourceError.message })
    assertOneSettlement(error, 'failed')
    expect(resource.cancel).toHaveBeenCalledTimes(1)
    expect(resource.releaseLock).toHaveBeenCalledTimes(1)
    expect(resource.stream.locked).toBe(false)
    assertListenersRemoved()
  })

  it('T08 成功后的 releaseLock 抛错不覆盖结果或重复结算', async () => {
    const resource = streamResponse([metadata('chat-completions'), delta()], undefined, {
      release: new Error('synthetic release failure')
    })
    const router = new ModelRouter({ apiKeyOf: () => 'synthetic-key', fetchImpl: async () => resource.response })
    const result = await router.call([provider({})], { messages, control: control() })
    expect(result.text).toBe('ok')
    expect(result.usage).toEqual(observedUsage)
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts?.[0]?.outcome).toBe('succeeded')
    expect(events.filter((event) => event.type === 'settled')).toHaveLength(1)
    expect(resource.cancel).not.toHaveBeenCalled()
    expect(resource.releaseLock).toHaveBeenCalledTimes(1)
    expect(resource.stream.locked).toBe(false)
    assertListenersRemoved()
  })

  it.each(['HTTP rejection', 'no body', 'sync fetch failure'] as const)('T08 %s 保留已知状态、空观测并清理监听器', async (ending) => {
    const fetchImpl = vi.fn((): Promise<Response> => {
      if (ending === 'sync fetch failure') throw new Error('synthetic sync failure')
      return Promise.resolve(ending === 'HTTP rejection' ? new Response('synthetic denied', { status: 403 }) : new Response(null, { status: 200 }))
    })
    const router = new ModelRouter({ apiKeyOf: () => 'synthetic-key', fetchImpl })
    const error = await router.call([provider({})], { messages, control: control() }).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(ModelRequestError)
    expect(error).toMatchObject({ code: 'TRANSPORT', retryable: ending !== 'HTTP rejection' })
    expect((error as ModelRequestError).attempts).toHaveLength(1)
    expect((error as ModelRequestError).attempts[0]).toMatchObject({
      outcome: 'failed', httpStatus: ending === 'sync fetch failure' ? null : ending === 'HTTP rejection' ? 403 : 200,
      responseModel: null, usage: noUsage
    })
    expect(events.filter((event) => event.type === 'sent')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'settled')).toHaveLength(1)
    assertListenersRemoved()
  })

  it('T08 无 usage 的流中断保持全 null，不以请求 model 代替响应 model', async () => {
    const resource = streamResponse([delta()], (controller) => controller.error(new Error('synthetic interruption')))
    const router = new ModelRouter({ apiKeyOf: () => 'synthetic-key', fetchImpl: async () => resource.response })
    const error = await router.call([provider({})], { messages, control: control() }).catch((err: unknown) => err)
    assertOneSettlement(error, 'failed', noUsage, null)
    expect(resource.releaseLock).toHaveBeenCalledTimes(1)
    expect(resource.stream.locked).toBe(false)
    assertListenersRemoved()
  })

  it.each(['chat-completions', 'responses'] as const)('T08 %s 后续缺失 usage 字段不会抹去已观察值（零值仍可更新）', async (protocol) => {
    const partial = protocol === 'responses'
      ? { type: 'response.completed', response: { usage: { output_tokens: 0 } } }
      : { choices: [], usage: { completion_tokens: 0 } }
    const resource = streamResponse([metadata(protocol), frame(partial), delta(protocol)])
    const router = new ModelRouter({ apiKeyOf: () => 'synthetic-key', fetchImpl: async () => resource.response })
    const result = await router.call([provider({ protocol })], { messages, control: control() })
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 0, totalTokens: 18, source: 'provider-reported' })
    expect(result.attempts?.[0]?.responseModel).toBe('reported-model')
    expect(resource.cancel).not.toHaveBeenCalled()
    expect(resource.releaseLock).toHaveBeenCalledTimes(1)
    assertListenersRemoved()
  })
})
