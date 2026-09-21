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

// preload 顶层读取 window.location 判定文档合格性:必须在导入前给出合格页面
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window = {
    location: { href: 'file:///D:/app/out/renderer/workbench.html' }
  }
})

// 导入 preload 即触发 contextBridge.exposeInMainWorld('api', ...)
import { contextBridge } from 'electron'
import { isQualifiedRendererDocument } from '../../src/preload/index'

type OnFn = (channel: string, listener: (...args: unknown[]) => void) => () => void

// vitest 5 迁移:静态导入阶段触发的 mock 调用会在测试开始前被重置,
// 须以 resetModules + 动态导入获取 exposeInMainWorld 调用记录(与下方 importPreloadWith 同模式)
async function exposedApi(): Promise<{ on: OnFn; subscribeMail: OnFn }> {
  vi.resetModules()
  electronMocks.exposeInMainWorld.mockClear()
  ;(globalThis as { window?: unknown }).window = {
    location: { href: 'file:///D:/app/out/renderer/workbench.html' }
  }
  await import('../../src/preload/index')
  const call = electronMocks.exposeInMainWorld.mock.calls.find(([name]) => name === 'api')
  if (!call) throw new Error('preload 未暴露 window.api')
  return call[1] as { on: OnFn; subscribeMail: OnFn }
}

describe('preload 通用 on() 事件通道白名单', () => {
  beforeEach(() => {
    electronMocks.on.mockClear()
    electronMocks.removeListener.mockClear()
  })

  it('evt: 前缀通道允许订阅,回调剥离 event 参数并可退订', async () => {
    const { on } = await exposedApi()
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

  it('非 evt: 通道(invoke 类与任意自定义通道)抛错且不注册监听', async () => {
    const { on } = await exposedApi()
    for (const channel of ['mail:list', 'app:info', 'pet:drag-start', '', 'evt', 'event:mail-sync']) {
      expect(() => on(channel, () => {})).toThrowError(/不允许订阅通道/)
    }
    expect(electronMocks.on).not.toHaveBeenCalled()
  })

  it('subscribeMail 保持精确白名单:mail 事件可订阅,其他 evt: 通道仍被拒绝', async () => {
    const { subscribeMail } = await exposedApi()
    expect(() => subscribeMail('evt:mail-sync', () => {})).not.toThrow()
    expect(() => subscribeMail('evt:pet-activity', () => {})).toThrowError(/不允许订阅通道/)
  })
})

describe('preload 文档合格性门禁(R3:仅对合格文档暴露 api)', () => {
  /** 清模块缓存后按指定 href 重新加载 preload,返回 exposeInMainWorld 的调用 */
  async function importPreloadWith(href: string | null): Promise<Array<[string, unknown]>> {
    vi.resetModules()
    electronMocks.exposeInMainWorld.mockClear()
    const g = globalThis as { window?: unknown }
    if (href === null) delete g.window
    else g.window = { location: { href } }
    await import('../../src/preload/index')
    return electronMocks.exposeInMainWorld.mock.calls as Array<[string, unknown]>
  }

  it('生产 file: 精确应用页面暴露 api', async () => {
    const calls = await importPreloadWith('file:///D:/app/out/renderer/pet.html')
    expect(calls.some(([name]) => name === 'api')).toBe(true)
  })

  it('外部 file: 页面与其他 html 文件不暴露 api', async () => {
    expect((await importPreloadWith('file:///C:/Users/x/evil.html')).some(([n]) => n === 'api')).toBe(false)
    expect((await importPreloadWith('file:///D:/app/out/renderer/other.html')).some(([n]) => n === 'api')).toBe(false)
  })

  it('开发态精确 dev 页面暴露,同前缀恶意主机不暴露', async () => {
    const g = globalThis as { window?: unknown }
    const savedDevUrl = process.env.ELECTRON_RENDERER_URL
    delete process.env.ELECTRON_RENDERER_URL
    try {
      g.window = { location: { href: 'http://localhost:5173/workbench.html' } }
      // 进程 env 中没有 ELECTRON_RENDERER_URL 时按精确路径判定(见 isQualifiedRendererDocument)
      expect((await importPreloadWith('http://localhost:5173/workbench.html')).some(([n]) => n === 'api')).toBe(true)
      expect((await importPreloadWith('http://localhost:5173.evil.com/workbench.html')).some(([n]) => n === 'api')).toBe(false)
    } finally {
      if (savedDevUrl === undefined) delete process.env.ELECTRON_RENDERER_URL
      else process.env.ELECTRON_RENDERER_URL = savedDevUrl
      g.window = { location: { href: 'file:///D:/app/out/renderer/workbench.html' } }
    }
  })

  it('无 window(非渲染环境)不暴露 api', async () => {
    expect((await importPreloadWith(null)).some(([n]) => n === 'api')).toBe(false)
  })
})

describe('isQualifiedRendererDocument 判定矩阵', () => {
  it('file: 只认精确应用页面;http(s) 只认精确页面路径;其他一律不合格', () => {
    expect(isQualifiedRendererDocument('file:///D:/app/out/renderer/workbench.html')).toBe(true)
    expect(isQualifiedRendererDocument('file:///D:/app/out/renderer/panel.html')).toBe(true)
    expect(isQualifiedRendererDocument('file:///C:/evil.html')).toBe(false)
    expect(isQualifiedRendererDocument('http://localhost:5173/pet.html')).toBe(true)
    expect(isQualifiedRendererDocument('http://localhost:5173.evil.com/pet.html')).toBe(false)
    expect(isQualifiedRendererDocument('https://example.com/workbench.html?x=1')).toBe(false)
    expect(isQualifiedRendererDocument('ftp://example.com/pet.html')).toBe(false)
    expect(isQualifiedRendererDocument('')).toBe(false)
    expect(isQualifiedRendererDocument(undefined)).toBe(false)
    expect(isQualifiedRendererDocument(null)).toBe(false)
  })

  it('开发态传入 devUrl 时按协议/主机/端口/路径严格比较', () => {
    const dev = 'http://localhost:5173'
    expect(isQualifiedRendererDocument(`${dev}/workbench.html`, dev)).toBe(true)
    expect(isQualifiedRendererDocument('http://localhost:5173.evil.com/workbench.html', dev)).toBe(false)
    expect(isQualifiedRendererDocument('http://localhost:9999/workbench.html', dev)).toBe(false)
  })
})
