import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeProvider } from '../../src/main/providers/fake'
import { fixedClock } from '../../src/shared/clock'

// C-04:FakeProvider。三条契约:无网络、确定性脚本、用量缺省为 null 不为 0。

afterEach(() => {
  vi.restoreAllMocks()
})

describe('无网络契约', () => {
  it('全局 fetch 被替换为抛错时,completeJson 仍正常工作', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('测试期间禁止网络')
    })
    const provider = new FakeProvider({ responses: [{ goal: 'x' }] })
    const result = await provider.completeJson({ system: 's', prompt: 'p' })
    expect(result.data).toEqual({ goal: 'x' })
    vi.unstubAllGlobals()
  })
})

describe('确定性脚本', () => {
  it('按序返回 responses;第 N 次调用拿第 N 项', async () => {
    const provider = new FakeProvider({ responses: ['first', { goal: 'g', steps: [] }] })
    expect((await provider.completeJson({ system: 's', prompt: 'p1' })).data).toBe('first')
    expect((await provider.completeJson({ system: 's', prompt: 'p2' })).data).toEqual({ goal: 'g', steps: [] })
  })

  it('脚本耗尽抛错,不静默循环复用', async () => {
    const provider = new FakeProvider({ responses: ['only'] })
    await provider.completeJson({ system: 's', prompt: 'p1' })
    await expect(provider.completeJson({ system: 's', prompt: 'p2' })).rejects.toThrow(/脚本耗尽/)
  })

  it('script 函数可按调用序号与请求内容动态返回', async () => {
    const provider = new FakeProvider({
      script: (callIndex, request) => ({ call: callIndex, promptLen: request.prompt.length })
    })
    const first = await provider.completeJson({ system: 's', prompt: 'abcde' })
    expect(first.data).toEqual({ call: 0, promptLen: 5 })
    const second = await provider.completeJson({ system: 's', prompt: 'x' })
    expect(second.data).toEqual({ call: 1, promptLen: 1 })
  })

  it('调用日志可回放(评测断言调用次数用)', async () => {
    const provider = new FakeProvider({ responses: [1, 2, 3] })
    await provider.completeJson({ system: 's1', prompt: 'a' })
    await provider.completeJson({ system: 's2', prompt: 'b' })
    expect(provider.callTotal).toBe(2)
    expect(provider.calls[0]!.request.system).toBe('s1')
    expect(provider.calls[1]!.request.prompt).toBe('b')
  })
})

describe('用量与耗时契约', () => {
  it('未提供 usage 时四个字段全为 null,不记 0', async () => {
    const provider = new FakeProvider({ responses: [{}] })
    const result = await provider.completeJson({ system: 's', prompt: 'p' })
    expect(result.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      source: null
    })
    expect(result.usage.inputTokens).not.toBe(0)
  })

  it('提供 usage 时原样报告', async () => {
    const provider = new FakeProvider({
      responses: [{}],
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, source: 'fake' }
    })
    const result = await provider.completeJson({ system: 's', prompt: 'p' })
    expect(result.usage.totalTokens).toBe(150)
  })

  it('固定时钟冻结领域时间,但 latencyMs 仍来自单调钟(非恒 0)', async () => {
    const provider = new FakeProvider({ responses: [1], clock: fixedClock('2026-09-28T00:00:00.000Z') })
    const result = await provider.completeJson({ system: 's', prompt: 'p' })
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(result.latencyMs)).toBe(true)
  })

  it('model 标识可配置,缺省 fake-model', async () => {
    const defaults = new FakeProvider({ responses: [1] })
    expect((await defaults.completeJson({ system: 's', prompt: 'p' })).model).toBe('fake-model')
    const custom = new FakeProvider({ responses: [1], model: 'fake-model-v2' })
    expect((await custom.completeJson({ system: 's', prompt: 'p' })).model).toBe('fake-model-v2')
  })
})
