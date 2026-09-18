import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import {
  AppearanceChannels,
  type AppearanceResult,
  type AppearanceSnapshot,
  type ThemeMode
} from '../../src/shared/appearance'
import type { AppearanceService } from '../../src/main/appearance/service'
import { registerAppearanceIpc } from '../../src/main/appearance/ipc'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    })
  }
}))

const SNAPSHOT: AppearanceSnapshot = { revision: 3, mode: 'system', resolved: 'dark' }

function makeService(over: Partial<AppearanceService> = {}): AppearanceService {
  return {
    get: vi.fn(() => SNAPSHOT),
    set: vi.fn(async (mode: ThemeMode): Promise<AppearanceResult> => ({
      ok: true,
      value: { revision: 4, mode, resolved: mode === 'light' ? 'light' : 'dark' }
    })),
    dispose: vi.fn(),
    ...over
  }
}

const fakeEvent = {} as IpcMainInvokeEvent

describe('外观 IPC 来源校验', () => {
  beforeEach(() => handlers.clear())

  it('注册 get/set 两个通道,撤销函数移除 handler', () => {
    const service = makeService()
    const unregister = registerAppearanceIpc(service, () => true)
    expect(handlers.has(AppearanceChannels.get)).toBe(true)
    expect(handlers.has(AppearanceChannels.set)).toBe(true)
    unregister()
    expect(handlers.has(AppearanceChannels.get)).toBe(false)
    expect(handlers.has(AppearanceChannels.set)).toBe(false)
  })

  it('受信任窗口可读取快照,返回值只含主题字段', () => {
    const service = makeService()
    registerAppearanceIpc(service, () => true)
    const result = handlers.get(AppearanceChannels.get)!(fakeEvent)
    expect(result).toEqual(SNAPSHOT)
    expect(Object.keys(result as object).sort()).toEqual(['mode', 'resolved', 'revision'])
  })

  it('不受信任来源读取被拒绝', () => {
    registerAppearanceIpc(makeService(), () => false)
    expect(() => handlers.get(AppearanceChannels.get)!(fakeEvent)).toThrow()
  })

  it('主窗口可 set 并透传 service 结果', async () => {
    const service = makeService()
    registerAppearanceIpc(service, () => true)
    const result = await handlers.get(AppearanceChannels.set)!(fakeEvent, 'dark')
    expect(result).toMatchObject({ ok: true })
    expect(service.set).toHaveBeenCalledWith('dark')
  })

  it('只读窗口 set 返回 UNAVAILABLE,不调用 service', async () => {
    const service = makeService()
    registerAppearanceIpc(service, (_event, write) => !write)
    const result = await handlers.get(AppearanceChannels.set)!(fakeEvent, 'dark')
    expect(result).toMatchObject({ ok: false, code: 'UNAVAILABLE' })
    expect(service.set).not.toHaveBeenCalled()
  })

  it('非法 mode 被运行时校验拦截,不进入 service', async () => {
    const service = makeService()
    registerAppearanceIpc(service, () => true)
    for (const bad of ['night', '', { mode: 'dark' }, 42, null, undefined]) {
      const result = (await handlers.get(AppearanceChannels.set)!(fakeEvent, bad)) as { ok: boolean; code?: string }
      expect(result.ok).toBe(false)
      expect(result.code).toBe('INVALID_MODE')
    }
    expect(service.set).not.toHaveBeenCalled()
  })
})
