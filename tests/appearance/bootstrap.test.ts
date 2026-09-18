// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyAppearance, bootstrapAppearance } from '../../src/renderer/shared/theme/bootstrap'
import type { AppearanceClientPort } from '../../src/renderer/shared/theme/controller'
import type { AppearanceSnapshot } from '../../src/shared/appearance'

function stubMatchMedia(dark: boolean): void {
  window.matchMedia = vi.fn((query: string) => ({
    matches: dark && query.includes('dark'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}

function pendingApi(): AppearanceClientPort & { emit(s: AppearanceSnapshot): void } {
  let listener: (s: AppearanceSnapshot) => void = () => {}
  return {
    get: () => new Promise(() => {}),
    set: async () => ({ ok: false, code: 'UNAVAILABLE', message: 'test' }),
    subscribe: (fn) => {
      listener = fn
      return () => {}
    },
    emit: (s) => listener(s)
  }
}

describe('applyAppearance', () => {
  it('把生效主题写入 data-theme/colorScheme/themeReady', () => {
    const root = document.documentElement
    applyAppearance(root, { revision: 0, mode: 'dark', resolved: 'dark' })
    expect(root.dataset.theme).toBe('dark')
    expect(root.style.colorScheme).toBe('dark')
    expect(root.dataset.themeReady).toBe('true')
    delete root.dataset.theme
    delete root.dataset.themeReady
    root.style.colorScheme = ''
  })
})

describe('bootstrapAppearance', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stubMatchMedia(true)
    document.body.innerHTML = ''
    delete document.documentElement.dataset.theme
    delete document.documentElement.dataset.themeReady
    delete document.documentElement.dataset.themeBoot
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('正常快照到达:应用真实主题并清除启动隐藏与定时器', async () => {
    const root = document.documentElement
    const api = pendingApi()
    const unavailable = vi.fn()
    const cleanup = bootstrapAppearance(api, root, unavailable)
    expect(root.dataset.themeBoot).toBe('pending')

    api.emit({ revision: 0, mode: 'system', resolved: 'dark' })
    await Promise.resolve()

    expect(root.dataset.theme).toBe('dark')
    expect(root.dataset.themeBoot).toBeUndefined()
    expect(unavailable).not.toHaveBeenCalled()
    // 定时器已清:继续推进时间不应再触发回退覆盖
    api.emit({ revision: 1, mode: 'light', resolved: 'light' })
    vi.advanceTimersByTime(5000)
    expect(root.dataset.theme).toBe('light')
    expect(document.querySelector('.theme-fallback-notice')).toBeNull()
    cleanup()
  })

  it('IPC 超时:按系统外观回退、显示非阻断提示、内容不永久隐藏', () => {
    const root = document.documentElement
    const unavailable = vi.fn()
    const cleanup = bootstrapAppearance(pendingApi(), root, unavailable)

    vi.advanceTimersByTime(3100)

    expect(root.dataset.theme).toBe('dark') // matchMedia 深色回退
    expect(root.dataset.themeReady).toBe('true')
    expect(root.dataset.themeBoot).toBeUndefined()
    expect(unavailable).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.theme-fallback-notice')?.textContent).toContain('超时')
    cleanup()
  })

  it('回退之后真实快照到达仍允许覆盖回退值', async () => {
    const root = document.documentElement
    const api = pendingApi()
    const cleanup = bootstrapAppearance(api, root, vi.fn())

    vi.advanceTimersByTime(3100)
    expect(root.dataset.theme).toBe('dark')

    api.emit({ revision: 0, mode: 'light', resolved: 'light' })
    await Promise.resolve()
    expect(root.dataset.theme).toBe('light')
    cleanup()
  })

  it('IPC 拒绝:走回退且不重复提示', async () => {
    const root = document.documentElement
    const api = pendingApi()
    api.get = () => Promise.reject(new Error('no handler'))
    const unavailable = vi.fn()
    const cleanup = bootstrapAppearance(api, root, unavailable)
    await Promise.resolve()
    await Promise.resolve()

    expect(root.dataset.theme).toBe('dark')
    expect(unavailable).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5000)
    expect(unavailable).toHaveBeenCalledTimes(1)
    expect(document.querySelectorAll('.theme-fallback-notice')).toHaveLength(1)
    cleanup()
  })

  it('清理函数之后不再触碰 DOM', async () => {
    const root = document.documentElement
    const api = pendingApi()
    const cleanup = bootstrapAppearance(api, root, vi.fn())
    cleanup()

    vi.advanceTimersByTime(3100)
    expect(root.dataset.theme).toBeUndefined()
    expect(document.querySelector('.theme-fallback-notice')).toBeNull()

    api.emit({ revision: 5, mode: 'dark', resolved: 'dark' })
    await Promise.resolve()
    expect(root.dataset.theme).toBeUndefined()
  })
})
