import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  invoke: vi.fn(async () => ({})),
  getPathForFile: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: {
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
    invoke: electronMocks.invoke
  },
  webUtils: { getPathForFile: electronMocks.getPathForFile }
}))

// 导入 preload 即触发 contextBridge.exposeInMainWorld('api', ...)
import { contextBridge } from 'electron'
import '../../src/preload/index'

type OnFn = (channel: string, listener: (...args: unknown[]) => void) => () => void

function exposedApi(): { on: OnFn; subscribeMail: OnFn } {
  const call = electronMocks.exposeInMainWorld.mock.calls.find(([name]) => name === 'api')
  if (!call) throw new Error('preload 未暴露 window.api')
  return call[1] as { on: OnFn; subscribeMail: OnFn }
}

describe('preload 通用 on() 事件通道白名单', () => {
  beforeEach(() => {
    electronMocks.on.mockClear()
    electronMocks.removeListener.mockClear()
  })

  it('evt: 前缀通道允许订阅,回调剥离 event 参数并可退订', () => {
    const { on } = exposedApi()
    const listener = vi.fn()
    const off = on('evt:data-changed', listener)

    expect(electronMocks.on).toHaveBeenCalledWith('evt:data-changed', expect.any(Function))

    const wrapped = electronMocks.on.mock.calls[0][1] as (...args: unknown[]) => void
    wrapped({ senderId: 1 }, { at: 123 })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({ at: 123 })

    off()
    expect(electronMocks.removeListener).toHaveBeenCalledWith('evt:data-changed', wrapped)
  })

  it('非 evt: 通道(invoke 类与任意自定义通道)抛错且不注册监听', () => {
    const { on } = exposedApi()
    for (const channel of ['mail:list', 'app:info', 'pet:drag-start', '', 'evt', 'event:mail-sync']) {
      expect(() => on(channel, () => {})).toThrowError(/不允许订阅通道/)
    }
    expect(electronMocks.on).not.toHaveBeenCalled()
  })

  it('subscribeMail 保持精确白名单:mail 事件可订阅,其他 evt: 通道仍被拒绝', () => {
    const { subscribeMail } = exposedApi()
    expect(() => subscribeMail('evt:mail-sync', () => {})).not.toThrow()
    expect(() => subscribeMail('evt:pet-activity', () => {})).toThrowError(/不允许订阅通道/)
  })
})
