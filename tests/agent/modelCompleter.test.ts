// RES-01:真实 ModelCompleter 的结果契约与观测(网络全部经注入 fetchImpl 替换)。
// 覆盖:坏 JSON 保留真实 route/usage;缺省 control 时生成一次发送的默认控制;
// usage 缺失保留 null;未配置供应商明确报错。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openDatabase, type SqliteDb } from '../../src/main/db/connection'
import { initSchema, saveProvider } from '../../src/main/db/dao'
import { ModelRouter } from '../../src/main/services/modelRouter'
import { ModelCompleter } from '../../src/main/agent/completer'
import { ModelRequestError, type ModelAttemptEvent } from '../../src/main/services/modelRequest'

const SQL_JS_DIST = join(process.cwd(), 'node_modules', 'sql.js', 'dist')

async function makeDb(seedProvider: boolean): Promise<SqliteDb> {
  const dir = mkdtempSync(join(tmpdir(), 'model-completer-'))
  const { db } = await openDatabase(join(dir, 'test.sqlite'), SQL_JS_DIST)
  initSchema(db)
  if (seedProvider) {
    saveProvider(db, {
      id: 'p1',
      name: '主供应商',
      baseUrl: 'https://api.example.invalid/v1',
      protocol: 'chat-completions',
      models: ['m1'],
      defaultModel: 'm1',
      supportsVision: false,
      isDefault: true,
      apiKeyEnc: 'plain:sk-test'
    })
  }
  return db
}

function chatSse(contentChunks: string[], usage: Record<string, number> | null): string {
  const parts = contentChunks.map(
    (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
  )
  if (usage !== null) {
    parts.push(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens } })}\n\n`
    )
  }
  parts.push('data: [DONE]\n\n')
  return parts.join('')
}

describe('RES-01 ModelCompleter 观测契约', () => {
  it('RES-01 坏 JSON 保留真实 route/usage 并按 MODEL_OUTPUT_INVALID 可重试', async () => {
    const db = await makeDb(true)
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      return new Response(chatSse(['不是 JSON'], { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }), { status: 200 })
    })
    const router = new ModelRouter({ apiKeyOf: () => 'sk-test', fetchImpl: fetchImpl as unknown as typeof fetch })
    const completer = new ModelCompleter({ db, router })
    const events: ModelAttemptEvent[] = []
    let admissions = 0
    const error: unknown = await completer
      .completeJson({
        system: 's',
        prompt: 'p',
        control: {
          requestId: 'req-1',
          signal: new AbortController().signal,
          timeoutMs: 2000,
          policy: { maxAttempts: 1, fallback: 'disabled' },
          beforeSend: () => {
            admissions += 1
          },
          onAttempt: (event) => events.push(event)
        }
      })
      .then(
        () => null,
        (err: unknown) => err
      )
    expect(error).toBeInstanceOf(ModelRequestError)
    const modelError = error as ModelRequestError
    expect(modelError.code).toBe('MODEL_OUTPUT_INVALID')
    expect(modelError.retryable).toBe(true)
    // 坏 JSON 也保留已完成传输的 usage/route
    expect(modelError.attempts).toHaveLength(1)
    expect(modelError.attempts[0]!.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      source: 'provider-reported'
    })
    expect(modelError.attempts[0]!.providerId).toBe('p1')
    expect(modelError.attempts[0]!.providerName).toBe('主供应商')
    expect(modelError.attempts[0]!.model).toBe('m1')
    expect(modelError.attempts[0]!.outcome).toBe('succeeded')
    expect(admissions).toBe(1)
    expect(events.filter((e) => e.type === 'sent')).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('RES-01 未提供 control 时生成默认单发送控制;缺 usage 保留 null', async () => {
    const db = await makeDb(true)
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      return new Response(chatSse(['{"ok":1}'], null), { status: 200 })
    })
    const router = new ModelRouter({ apiKeyOf: () => 'sk-test', fetchImpl: fetchImpl as unknown as typeof fetch })
    const completer = new ModelCompleter({ db, router })
    const result = await completer.completeJson({ system: 's', prompt: 'p' })
    // 单发送:无 control 也不重试、不备用切换
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result.data).toEqual({ ok: 1 })
    expect(result.actualProvider).not.toBeNull()
    expect(result.actualProvider!.providerId).toBe('p1')
    expect(result.actualAttempts).toBe(1)
    expect(result.attempts).toHaveLength(1)
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, source: null })
    expect(result.model).toBe('m1')
  })

  it('RES-01 未配置模型服务商时明确报错且不发送', async () => {
    const db = await makeDb(false)
    const fetchImpl = vi.fn(async (): Promise<Response> => new Response('{}', { status: 200 }))
    const router = new ModelRouter({ apiKeyOf: () => 'sk-test', fetchImpl: fetchImpl as unknown as typeof fetch })
    const completer = new ModelCompleter({ db, router })
    await expect(completer.completeJson({ system: 's', prompt: 'p' })).rejects.toThrow('未配置模型服务商')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
