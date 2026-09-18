import { describe, expect, it, vi } from 'vitest'
import { createAppearanceController, type AppearanceClientPort } from '../../src/renderer/shared/theme/controller'
import type { AppearanceResult, AppearanceSnapshot, ThemeMode } from '../../src/shared/appearance'

function fakeApi(over: Partial<AppearanceClientPort> = {}): AppearanceClientPort & {
  listeners: Array<(s: AppearanceSnapshot) => void>
  setCalls: ThemeMode[]
} {
  const listeners: Array<(s: AppearanceSnapshot) => void> = []
  const setCalls: ThemeMode[] = []
  return {
    listeners,
    setCalls,
    get: async () => ({ revision: 1, mode: 'light', resolved: 'light' }),
    set: async (mode) => {
      setCalls.push(mode)
      return { ok: true, value: { revision: 2, mode, resolved: mode === 'light' ? 'light' : 'dark' } }
    },
    subscribe: (fn) => {
      listeners.push(fn)
      return () => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    ...over
  }
}

describe('主题控制器', () => {
  it('启动快照迟到不覆盖用户刚切换的深色', async () => {
    let listener: (s: AppearanceSnapshot) => void = () => {}
    let resolveGet!: (s: AppearanceSnapshot) => void
    const apply = vi.fn()
    const c = createAppearanceController({
      apply,
      unavailable: vi.fn(),
      api: {
        get: () => new Promise((r) => (resolveGet = r)),
        set: async (): Promise<AppearanceResult> => ({ ok: false, code: 'UNAVAILABLE', message: 'test' }),
        subscribe: (fn) => {
          listener = fn
          return () => {}
        }
      }
    })
    const starting = c.start()
    listener({ revision: 2, mode: 'dark', resolved: 'dark' })
    resolveGet({ revision: 1, mode: 'light', resolved: 'light' })
    await starting
    expect(apply).toHaveBeenLastCalledWith({ revision: 2, mode: 'dark', resolved: 'dark' })
    c.dispose()
  })

  it('start 幂等:重复启动不重复订阅', async () => {
    const api = fakeApi()
    const c = createAppearanceController({ api, apply: vi.fn(), unavailable: vi.fn() })
    await c.start()
    await c.start()
    expect(api.listeners).toHaveLength(1)
    c.dispose()
  })

  it('set 成功快照与事件走同一应用路径;dispose 后忽略一切', async () => {
    const api = fakeApi()
    const apply = vi.fn()
    const c = createAppearanceController({ api, apply, unavailable: vi.fn() })
    await c.start()
    expect(apply).toHaveBeenLastCalledWith({ revision: 1, mode: 'light', resolved: 'light' })

    const result = await c.set('dark')
    expect(result).toMatchObject({ ok: true })
    expect(apply).toHaveBeenLastCalledWith({ revision: 2, mode: 'dark', resolved: 'dark' })

    c.dispose()
    api.listeners.forEach((fn) => fn({ revision: 9, mode: 'light', resolved: 'light' }))
    const calls = apply.mock.calls.length
    await c.set('light')
    expect(apply.mock.calls.length).toBe(calls)
    expect(api.listeners).toHaveLength(0)
  })

  it('set 失败不应用新快照,原已确认主题保留', async () => {
    const api = fakeApi({
      set: async () => ({ ok: false, code: 'STORAGE', message: '外观设置未保存: disk full' })
    })
    const apply = vi.fn()
    const c = createAppearanceController({ api, apply, unavailable: vi.fn() })
    await c.start()
    const result = await c.set('dark')
    expect(result).toMatchObject({ ok: false, code: 'STORAGE' })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenLastCalledWith({ revision: 1, mode: 'light', resolved: 'light' })
    c.dispose()
  })

  it('get 拒绝时触发 unavailable,不静默成功', async () => {
    const unavailable = vi.fn()
    const api = fakeApi({ get: async () => Promise.reject(new Error('ipc down')) })
    const c = createAppearanceController({ api, apply: vi.fn(), unavailable })
    await c.start()
    expect(unavailable).toHaveBeenCalledTimes(1)
    c.dispose()
  })

  it('api.set 抛异常被包装为 UNAVAILABLE,而不是未捕获拒绝', async () => {
    const api = fakeApi({ set: async () => Promise.reject(new Error('gone')) })
    const c = createAppearanceController({ api, apply: vi.fn(), unavailable: vi.fn() })
    await c.start()
    const result = await c.set('dark')
    expect(result).toMatchObject({ ok: false, code: 'UNAVAILABLE' })
    c.dispose()
  })
})
