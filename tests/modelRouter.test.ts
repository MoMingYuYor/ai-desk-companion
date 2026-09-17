import { describe, expect, it, vi } from 'vitest'
import type { ProviderInfo } from '../src/shared/types'
import {
  buildChain,
  describeHttpError,
  isRetryableStatus,
  ModelCallError,
  ModelRouter,
  type LlmMessage
} from '../src/main/services/modelRouter'

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
