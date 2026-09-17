import { describe, expect, it, vi } from 'vitest'
import { resolvePetPlacement } from '../../src/main/pet/geometry'
import { PET_LAYOUT } from '../../src/shared/pet'

// vi.mock 会被提升到 import 之前,geometry.ts 顶部的 `import { screen } from 'electron'`
// 将拿到这里的假 screen。
vi.mock('electron', () => ({
  screen: {
    getAllDisplays: vi.fn(() => [
      { workArea: { x: -1920, y: 0, width: 1920, height: 1040 } },
      { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
    ]),
    getPrimaryDisplay: vi.fn(() => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1040 }
    }))
  }
}))

const SIZE = { width: PET_LAYOUT.width, height: PET_LAYOUT.height }
const FALLBACK = {
  x: 0 + 1920 - PET_LAYOUT.width - 24,
  y: 0 + 1040 - PET_LAYOUT.height - 24
}

describe('resolvePetPlacement', () => {
  it('合法旧位置且与某工作区相交时原样返回(含负坐标副屏)', () => {
    expect(resolvePetPlacement('100', '100', SIZE)).toEqual({ x: 100, y: 100 })
    expect(resolvePetPlacement('-100', '500', SIZE)).toEqual({ x: -100, y: 500 })
  })

  it('与所有工作区无交集时回主屏工作区右下角内缩 24', () => {
    expect(resolvePetPlacement('5000', '5000', SIZE)).toEqual(FALLBACK)
    expect(FALLBACK).toEqual({ x: 1576, y: 616 })
  })

  it('NaN、非数字或缺失的旧位置都走默认位置', () => {
    expect(resolvePetPlacement('abc', '100', SIZE)).toEqual(FALLBACK)
    expect(resolvePetPlacement('100', 'NaN', SIZE)).toEqual(FALLBACK)
    expect(resolvePetPlacement(null, '100', SIZE)).toEqual(FALLBACK)
    expect(resolvePetPlacement(undefined, undefined, SIZE)).toEqual(FALLBACK)
  })
})
