import { describe, expect, it } from 'vitest'
import {
  initialPetState,
  applyActivity,
  setAlert,
  expire,
  selectMode,
  addBubble
} from '../../src/renderer/pet/model'

describe('桌宠纯状态模型', () => {
  it('提醒消退后恢复仍在执行的分析', () => {
    let s = applyActivity(initialPetState(), { revision: 2, activeIds: ['run-a'] })
    s = setAlert(s, 1000, 8000)
    expect(selectMode(s, 1001)).toBe('alert')
    s = expire(s, 9000)
    expect(selectMode(s, 9000)).toBe('busy')
    // 旧快照不得覆盖新状态
    s = applyActivity(s, { revision: 1, activeIds: [] })
    expect(selectMode(s, 9000)).toBe('busy')
  })

  it('两个活动结束一个仍 busy', () => {
    let s = applyActivity(initialPetState(), { revision: 1, activeIds: ['a', 'b'] })
    expect(selectMode(s, 100)).toBe('busy')
    s = applyActivity(s, { revision: 2, activeIds: ['b'] })
    expect(selectMode(s, 100)).toBe('busy')
    s = applyActivity(s, { revision: 3, activeIds: [] })
    expect(selectMode(s, 100)).toBe('idle')
  })

  it('气泡最多保留 3 条并按先进先出淘汰', () => {
    let s = initialPetState()
    s = addBubble(s, '第一条', 1000, 5000)
    s = addBubble(s, '第二条', 1000, 5000)
    s = addBubble(s, '第三条', 1000, 5000)
    s = addBubble(s, '第四条', 1000, 5000)
    expect(s.bubbles).toHaveLength(3)
    expect(s.bubbles[0].text).toBe('第二条')
    expect(s.bubbles[2].text).toBe('第四条')
  })

  it('空提示忽略', () => {
    const s = initialPetState()
    const next = addBubble(s, '   ', 1000)
    expect(next.bubbles).toHaveLength(0)
  })
})
