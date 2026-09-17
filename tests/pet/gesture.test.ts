import { describe, expect, it, vi } from 'vitest'
import { createPetGesture } from '../../src/renderer/pet/gesture'

describe('桌宠手势与原生拖动区分', () => {
  it('阈值以内只点击，主进程不开始轮询', async () => {
    const port = {
      petDragStart: vi.fn(async () => {}),
      petDragEnd: vi.fn(async () => {})
    }
    const click = vi.fn()
    const change = vi.fn()
    const error = vi.fn()
    const g = createPetGesture(port, { click, change, error })

    g.down({ x: 10, y: 10 })
    g.move({ x: 13, y: 14 }) // hypot = 5 < 6
    g.up()

    expect(port.petDragStart).not.toHaveBeenCalled()
    expect(click).toHaveBeenCalledTimes(1)
    await g.dispose()
  })

  it('移动位移达到 6px 后触发原生拖动且释放时不触发点击', async () => {
    const port = {
      petDragStart: vi.fn(async () => {}),
      petDragEnd: vi.fn(async () => {})
    }
    const click = vi.fn()
    const change = vi.fn()
    const error = vi.fn()
    const g = createPetGesture(port, { click, change, error })

    g.down({ x: 10, y: 10 })
    g.move({ x: 16, y: 18 }) // dx=6, dy=8, dist=10 >= 6
    expect(port.petDragStart).toHaveBeenCalledTimes(1)

    g.up()
    expect(port.petDragEnd).toHaveBeenCalledTimes(1)
    expect(click).not.toHaveBeenCalled()
    await g.dispose()
  })

  it('cancel 重置拖动状态', async () => {
    const port = {
      petDragStart: vi.fn(async () => {}),
      petDragEnd: vi.fn(async () => {})
    }
    const click = vi.fn()
    const change = vi.fn()
    const g = createPetGesture(port, { click, change, error: vi.fn() })

    g.down({ x: 10, y: 10 })
    g.move({ x: 20, y: 20 })
    g.cancel()
    expect(port.petDragEnd).toHaveBeenCalledTimes(1)
    expect(click).not.toHaveBeenCalled()
    await g.dispose()
  })
})
