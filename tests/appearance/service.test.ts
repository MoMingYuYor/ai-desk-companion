import { describe, expect, it, vi } from 'vitest'
import type { ThemeMode } from '../../src/shared/appearance'
import { createAppearanceService } from '../../src/main/appearance/service'

type Listener = () => void

interface NativeMock {
  themeSource: ThemeMode
  shouldUseDarkColors: boolean
  onUpdated(listener: Listener): () => void
  fire(): void
  unsubscribed(): boolean
}

function makeNative(dark: boolean, themeSource: ThemeMode = 'system'): NativeMock {
  let listener: Listener | null = null
  let unsub = false
  return {
    themeSource,
    shouldUseDarkColors: dark,
    onUpdated(l: Listener) {
      listener = l
      return () => {
        unsub = true
      }
    },
    fire() {
      listener?.()
    },
    unsubscribed: () => unsub
  }
}

describe('AppearanceService', () => {
  it('原生 themeSource 设置失败时返回 STORAGE 且维护旧状态', async () => {
    const base = makeNative(false)
    let breakSetter = false
    const native = {
      get themeSource(): ThemeMode {
        return base.themeSource
      },
      set themeSource(value: ThemeMode) {
        if (breakSetter) throw new Error('native setter failed')
        base.themeSource = value
      },
      get shouldUseDarkColors(): boolean {
        return base.shouldUseDarkColors
      },
      onUpdated(listener: Listener): () => void {
        return base.onUpdated(listener)
      }
    }
    const emit = vi.fn()
    const service = createAppearanceService({
      native,
      emit,
      store: { read: () => 'light', write: async () => {} }
    })
    const before = service.get()
    breakSetter = true
    expect(await service.set('dark')).toMatchObject({ ok: false, code: 'STORAGE' })
    expect(service.get()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
    service.dispose()
  })

  it('写盘失败不切换已确认偏好或广播成功', async () => {
    const native = makeNative(false)
    const emit = vi.fn()
    const service = createAppearanceService({
      native,
      emit,
      store: { read: () => 'light', write: async () => { throw new Error('disk full') } }
    })
    const before = service.get()
    expect(await service.set('dark')).toMatchObject({ ok: false, code: 'STORAGE' })
    expect(service.get()).toEqual(before)
    expect(native.themeSource).toBe('light')
    expect(emit).not.toHaveBeenCalled()
    service.dispose()
  })

  it('无保存偏好时默认 system 并把 nativeTheme 设为 system', () => {
    const native = makeNative(true)
    const service = createAppearanceService({
      native,
      emit: () => {},
      store: { read: () => null, write: async () => {} }
    })
    expect(service.get()).toEqual({ revision: 0, mode: 'system', resolved: 'dark' })
    expect(native.themeSource).toBe('system')
    service.dispose()
  })

  it('启动时应用已保存偏好并同步 nativeTheme', () => {
    const native = makeNative(false, 'dark')
    const service = createAppearanceService({
      native,
      emit: () => {},
      store: { read: () => 'dark', write: async () => {} }
    })
    expect(service.get()).toEqual({ revision: 0, mode: 'dark', resolved: 'dark' })
    expect(native.themeSource).toBe('dark')
    service.dispose()
  })

  it('显式偏好不随系统外观变化', () => {
    const native = makeNative(true, 'dark')
    const emit = vi.fn()
    const service = createAppearanceService({
      native,
      emit,
      store: { read: () => 'dark', write: async () => {} }
    })
    native.shouldUseDarkColors = false
    native.fire()
    expect(service.get()).toEqual({ revision: 0, mode: 'dark', resolved: 'dark' })
    expect(emit).not.toHaveBeenCalled()
    service.dispose()
  })

  it('system 偏好即时跟随系统明暗并递增 revision', () => {
    const native = makeNative(false)
    const emit = vi.fn()
    const service = createAppearanceService({
      native,
      emit,
      store: { read: () => 'system', write: async () => {} }
    })
    expect(service.get()).toEqual({ revision: 0, mode: 'system', resolved: 'light' })
    native.shouldUseDarkColors = true
    native.fire()
    expect(service.get()).toEqual({ revision: 1, mode: 'system', resolved: 'dark' })
    expect(emit).toHaveBeenCalledWith({ revision: 1, mode: 'system', resolved: 'dark' })
    service.dispose()
  })

  it('一次保存引发的原生 updated 事件不重复广播', async () => {
    const native = makeNative(false)
    const emit = vi.fn()
    const service = createAppearanceService({
      native,
      emit,
      store: { read: () => 'light', write: async () => {} }
    })
    await service.set('dark')
    native.fire()
    expect(emit).toHaveBeenCalledTimes(1)
    expect(service.get().revision).toBe(1)
    service.dispose()
  })

  it('快速连续 dark/light 串行执行且最终值正确', async () => {
    const native = makeNative(false)
    const order: string[] = []
    const emit = vi.fn()
    const store = {
      read: () => 'light' as ThemeMode | null,
      write: async (mode: ThemeMode) => {
        order.push(`write-${mode}`)
        await new Promise((r) => setTimeout(r, 5))
      }
    }
    const service = createAppearanceService({ native, emit, store })
    const p1 = service.set('dark')
    const p2 = service.set('light')
    expect(await p1).toMatchObject({ ok: true })
    expect(await p2).toMatchObject({ ok: true })
    expect(order).toEqual(['write-dark', 'write-light'])
    expect(service.get()).toEqual({ revision: 2, mode: 'light', resolved: 'light' })
    expect(native.themeSource).toBe('light')
    service.dispose()
  })

  it('失败的保存不阻塞后续保存', async () => {
    const native = makeNative(false)
    const emit = vi.fn()
    let fail = true
    const service = createAppearanceService({
      native,
      emit,
      store: {
        read: () => 'light',
        write: async () => {
          if (fail) throw new Error('disk full')
        }
      }
    })
    expect(await service.set('dark')).toMatchObject({ ok: false, code: 'STORAGE' })
    fail = false
    expect(await service.set('dark')).toMatchObject({ ok: true })
    expect(service.get()).toEqual({ revision: 1, mode: 'dark', resolved: 'dark' })
    service.dispose()
  })

  it('相同偏好不重复写盘也不广播', async () => {
    const native = makeNative(false)
    const emit = vi.fn()
    const write = vi.fn(async () => {})
    const service = createAppearanceService({
      native,
      emit,
      store: { read: () => 'light', write }
    })
    const before = service.get()
    expect(await service.set('light')).toMatchObject({ ok: true, value: before })
    expect(write).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect(service.get()).toEqual(before)
    service.dispose()
  })

  it('非法偏好值返回 INVALID_MODE', async () => {
    const native = makeNative(false)
    const service = createAppearanceService({
      native,
      emit: () => {},
      store: { read: () => 'light', write: async () => {} }
    })
    expect(await service.set('night' as never)).toMatchObject({ ok: false, code: 'INVALID_MODE' })
    service.dispose()
  })

  it('广播监听器抛错不影响保存成功', async () => {
    const native = makeNative(false)
    const service = createAppearanceService({
      native,
      emit: () => {
        throw new Error('listener gone')
      },
      store: { read: () => 'light', write: async () => {} }
    })
    expect(await service.set('dark')).toMatchObject({ ok: true, value: { mode: 'dark' } })
    expect(service.get().mode).toBe('dark')
    service.dispose()
  })

  it('dispose 后退订原生事件且拒绝新的保存', async () => {
    const native = makeNative(false)
    const write = vi.fn(async () => {})
    const service = createAppearanceService({
      native,
      emit: () => {},
      store: { read: () => 'light', write }
    })
    service.dispose()
    service.dispose()
    expect(native.unsubscribed()).toBe(true)
    expect(await service.set('dark')).toMatchObject({ ok: false, code: 'UNAVAILABLE' })
    expect(write).not.toHaveBeenCalled()
  })
})
