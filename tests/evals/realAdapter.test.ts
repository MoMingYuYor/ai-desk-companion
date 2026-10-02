import { expect, it, vi } from 'vitest'
import type { EvalTargetProfile, FrozenEvalConfig } from '../../src/shared/evals'
import { createRealCompleterFor } from '../../src/main/evals/realAdapter'
import { targetProfileSha256 } from '../../src/main/evals/freeze'

const target: EvalTargetProfile = { providerId: 'frozen-a', protocol: 'chat-completions', baseUrl: 'https://a.example.invalid/v1', model: 'model-a' }
function configFor(over: Partial<FrozenEvalConfig> = {}): FrozenEvalConfig {
  return { schemaVersion: 2, configId: 'test-real-baseline', executionKind: 'real', model: target.model, providerId: target.providerId, pipelineVariant: 'baseline', promptSha256: 'a'.repeat(64), toolsVersion: 'tools-v1', codeCommit: 'b'.repeat(40), datasetSha256: 'c'.repeat(64), fixtureSha256: 'd'.repeat(64), budgetSha256: 'e'.repeat(64), interactionScriptSha256: 'f'.repeat(64), rubricVersion: 'rubric-v1', targetSha256: targetProfileSha256('real', target), ...over }
}

it('独立固定路由始终使用 target A，凭据按 providerId 解析且不传 gold', async () => {
  const credentialOf = vi.fn((id: string) => id === 'frozen-a' ? 'synthetic-key' : 'other-key')
  const sent: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetchImpl = vi.fn(async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return new Response('data: {"choices":[{"delta":{"content":"{\\\"answer\\\":1}"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
  })
  const completer = createRealCompleterFor({ credentialOf, fetchImpl })(configFor(), target)
  const result = await completer.completeJson({ system: 'system', prompt: '任务原文' })
  expect(result.data).toEqual({ answer: 1 })
  expect(sent).toHaveLength(1)
  expect(sent[0]!.url).toBe('https://a.example.invalid/v1/chat/completions')
  expect(sent[0]!.body.model).toBe('model-a')
  expect(JSON.stringify(sent[0]!.body)).not.toMatch(/expected|gold|reviewer/)
  expect(result.actualProvider?.providerId).toBe('frozen-a')
  expect(result.attempts).toHaveLength(1)
})

it.each([401, 429])('HTTP %d 不自动重试或切换，实际尝试保留', async status => {
  const fetchImpl = vi.fn(async () => new Response('拒绝', { status }))
  const completer = createRealCompleterFor({ credentialOf: () => 'synthetic-key', fetchImpl })(configFor(), target)
  await expect(completer.completeJson({ system: 's', prompt: 'p' })).rejects.toMatchObject({ attempts: [{ httpStatus: status }] })
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

it('凭据缺失、目标 hash 或模型不同均在首个发送前拒绝', () => {
  const fetchImpl = vi.fn()
  const make = createRealCompleterFor({ credentialOf: () => null, fetchImpl })
  expect(() => make(configFor(), target)).toThrow('凭据')
  expect(() => make(configFor({ model: 'business-default-b' }), target)).toThrow('target')
  expect(() => make(configFor({ targetSha256: '0'.repeat(64) }), target)).toThrow('target')
  expect(fetchImpl).not.toHaveBeenCalled()
})
