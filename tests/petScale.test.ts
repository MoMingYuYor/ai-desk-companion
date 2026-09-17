import { describe, expect, it } from 'vitest'
import { clampPetScale, createPetZoom, PET_SCALE_MAX, PET_SCALE_MIN } from '../src/shared/petScale'

describe('clampPetScale', () => {
  it('限制在 [0.5, 2] 并保留两位小数', () => {
    expect(clampPetScale(0.2)).toBe(PET_SCALE_MIN)
    expect(clampPetScale(3)).toBe(PET_SCALE_MAX)
    expect(clampPetScale(1.234)).toBe(1.23)
    expect(clampPetScale(1)).toBe(1)
  })
})

describe('createPetZoom', () => {
  it('滚轮向上放大、向下缩小,每 100 增量一步', () => {
    const zoom = createPetZoom(1)
    expect(zoom.wheel(-120)).toBe(1.1)
    expect(zoom.wheel(120)).toBe(1)
  })

  it('触控板小增量累积到 100 才步进', () => {
    const zoom = createPetZoom(1)
    expect(zoom.wheel(-30)).toBe(1)
    expect(zoom.wheel(-40)).toBe(1)
    expect(zoom.wheel(-40)).toBe(1.1)
  })

  it('到达上下限后不再变化', () => {
    const zoom = createPetZoom(PET_SCALE_MAX)
    expect(zoom.wheel(-500)).toBe(PET_SCALE_MAX)
    expect(zoom.wheel(500)).toBe(1.9)
    const small = createPetZoom(PET_SCALE_MIN)
    expect(small.wheel(500)).toBe(PET_SCALE_MIN)
    expect(small.wheel(-500)).toBe(0.6)
  })

  it('set 重置累积并应用初始值', () => {
    const zoom = createPetZoom(1)
    zoom.wheel(-90)
    expect(zoom.set(1.5)).toBe(1.5)
    expect(zoom.wheel(10)).toBe(1.5)
  })
})
