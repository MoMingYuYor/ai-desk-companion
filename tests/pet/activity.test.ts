import { describe, expect, it, vi } from 'vitest'
import { createPetActivityRegistry } from '../../src/main/pet/activity'

describe('桌宠活动注册器', () => {
  it('一项完成不清空其他任务，重复完成不重发提示', () => {
    const emit = vi.fn()
    const r = createPetActivityRegistry(emit)
    r.apply({ phase: 'start', taskId: 'a' })
    r.apply({ phase: 'start', taskId: 'b' })
    r.apply({ phase: 'finish', taskId: 'a', outcome: 'done' })

    expect(r.snapshot()).toEqual({ revision: 3, activeIds: ['b'] })
    expect(emit).toHaveBeenLastCalledWith({
      revision: 3,
      activeIds: ['b'],
      finished: { taskId: 'a', outcome: 'done' }
    })

    // 重复完成不自增 revision
    r.apply({ phase: 'finish', taskId: 'a', outcome: 'done' })
    expect(r.snapshot().revision).toBe(3)
  })
})
