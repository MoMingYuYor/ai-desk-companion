// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createPetController } from '../../../src/renderer/pet/controller'
import type { PetPort } from '../../../src/renderer/pet/contracts'

function makeClock() {
  let now = 1000
  const timeouts = new Map<number, { fn: () => void; at: number }>()
  let seq = 1
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const id = seq++
      timeouts.set(id, { fn, at: now + ms })
      return id
    },
    clearTimeout(id: number) {
      timeouts.delete(id)
    },
    advance(ms: number) {
      now += ms
      for (const [id, t] of Array.from(timeouts.entries())) {
        if (t.at <= now) {
          timeouts.delete(id)
          t.fn()
        }
      }
    }
  }
}

function makeApi() {
  const handlers = new Map<string, (p: unknown) => void>()
  return {
    on: ((channel: string, listener: (p: unknown) => void) => {
      handlers.set(channel, listener)
      return () => handlers.delete(channel)
    }) as PetPort['on'],
    emit(channel: string, payload: unknown) {
      handlers.get(channel)?.(payload)
    },
    getDayAgenda: vi.fn(async () => ({ events: [], courses: [], todos: [] })),
    addMaterials: vi.fn(async () => {}),
    getPetActivitySnapshot: vi.fn(async () => ({ revision: 0, activeIds: [] })),
    pathForFile: () => null,
    petDragStart: vi.fn(async () => {}),
    petDragEnd: vi.fn(async () => {}),
    petOpenMenu: vi.fn(async () => {})
  } as unknown as PetPort & { emit(channel: string, payload: unknown): void }
}

describe('桌宠控制器', () => {
  it('分析 done 移除忙碌并弹完成气泡;失败弹提醒', () => {
    const clock = makeClock()
    const api = makeApi()
    const renders: string[] = []
    const c = createPetController(api, clock, (_s, mode) => renders.push(mode))
    c.start()

    api.emit('evt:pet-activity', { revision: 1, activeIds: ['t1'] })
    expect(c.mode()).toBe('busy')

    api.emit('evt:pet-activity', {
      revision: 2,
      activeIds: [],
      finished: { taskId: 't1', outcome: 'done' }
    })
    expect(c.mode()).toBe('idle')
    expect(c.state().bubbles.some((b) => b.text.includes('分析完成'))).toBe(true)

    api.emit('evt:pet-activity', {
      revision: 3,
      activeIds: [],
      finished: { taskId: 't2', outcome: 'failed' }
    })
    expect(c.mode()).toBe('alert')
  })

  it('提醒按 key 去重', () => {
    const clock = makeClock()
    const api = makeApi()
    const c = createPetController(api, clock, () => {})
    c.start()
    api.emit('evt:reminder-fired', { key: 'k1', title: '喝水' })
    api.emit('evt:reminder-fired', { key: 'k1', title: '喝水' })
    expect(c.state().bubbles.filter((b) => b.text.includes('喝水'))).toHaveLength(1)
  })

  it('pendingIntakes 在 addMaterials 失败后回落', async () => {
    const clock = makeClock()
    const api = makeApi()
    ;(api as unknown as { addMaterials: (i: unknown) => Promise<void> }).addMaterials = vi.fn(
      async () => {
        throw new Error('x')
      }
    )
    const c = createPetController(api, clock, () => {})
    c.start()
    await c.acceptDrop({ texts: [{ name: 'n', content: 'c' }] })
    expect(c.state().pendingIntakes).toBe(0)
    expect(c.state().bubbles.some((b) => b.text === '接收材料失败')).toBe(true)
  })

  it('取消不提示成功', () => {
    const clock = makeClock()
    const api = makeApi()
    const c = createPetController(api, clock, () => {})
    c.start()
    api.emit('evt:pet-activity', { revision: 1, activeIds: ['t1'] })
    api.emit('evt:pet-activity', {
      revision: 2,
      activeIds: [],
      finished: { taskId: 't1', outcome: 'cancelled' }
    })
    expect(c.mode()).toBe('idle')
    expect(c.state().bubbles).toHaveLength(0)
  })
})
