import { describe, expect, it, vi } from 'vitest'
import { Engine } from '../../src/main/services/engine'
import { createConversation, insertMaterial } from '../../src/main/db/dao'
import { makeTestDb } from '../helpers'
import type { PetActivityChange } from '../../src/shared/pet'
import type { ModelRouter } from '../../src/main/services/modelRouter'

function makeRouterStub(result: { text: string } | { error: Error }): ModelRouter {
  return {
    call: async () => {
      if ('error' in result) throw result.error
      return { text: result.text, used: { providerName: 'test', model: 'm' } }
    }
  } as unknown as ModelRouter
}

describe('引擎活动通知(桌宠真值)', () => {
  it('分析成功发送 start 和 done', async () => {
    const db = await makeTestDb()
    const changes: PetActivityChange[] = []
    const engine = new Engine({
      db,
      router: makeRouterStub({ text: '{"title":"会议","actionItems":[]}' }),
      broadcast: vi.fn(),
      onPetActivity: (c) => changes.push(c)
    })
    const conv = createConversation(db, 'analysis', 't')
    insertMaterial(db, { conversationId: conv.id, name: 'n', type: 'text', content: 'hello' })

    await engine.runAnalysis(conv.id)
    expect(changes[0]).toEqual({ phase: 'start', taskId: `analysis:${conv.id}` })
    expect(changes[changes.length - 1]).toEqual({
      phase: 'finish',
      taskId: `analysis:${conv.id}`,
      outcome: 'done'
    })
  })

  it('模型失败发送 failed,取消发送 cancelled', async () => {
    const db = await makeTestDb()
    const changes: PetActivityChange[] = []
    const engine = new Engine({
      db,
      router: makeRouterStub({ error: new Error('network down') }),
      broadcast: vi.fn(),
      onPetActivity: (c) => changes.push(c)
    })
    const conv = createConversation(db, 'analysis', 't')
    insertMaterial(db, { conversationId: conv.id, name: 'n', type: 'text', content: 'hello' })

    await engine.runAnalysis(conv.id)
    expect(changes[changes.length - 1].phase).toBe('finish')
    expect((changes[changes.length - 1] as { outcome: string }).outcome).toBe('failed')
  })

  it('无材料时不发送任何活动通知', async () => {
    const db = await makeTestDb()
    const changes: PetActivityChange[] = []
    const engine = new Engine({
      db,
      router: makeRouterStub({ text: '{}' }),
      broadcast: vi.fn(),
      onPetActivity: (c) => changes.push(c)
    })
    const conv = createConversation(db, 'analysis', 't')

    await engine.runAnalysis(conv.id)
    expect(changes).toHaveLength(0)
  })
})
