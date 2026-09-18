import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hardenWebContents } from '../../src/main/windows'

// windows.ts 顶层 import 了 electron(BrowserWindow/screen)与依赖 screen 的 geometry,
// 这里只需 hardenWebContents 纯函数,给最小假 electron 即可。
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  screen: {
    getAllDisplays: vi.fn(() => []),
    getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }))
  }
}))

type FakeWebContents = {
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}

function makeFakeWebContents(): FakeWebContents {
  return {
    setWindowOpenHandler: vi.fn(),
    on: vi.fn()
  }
}

function willNavigateListenerOf(wc: FakeWebContents): (event: { preventDefault: () => void }, url: string) => void {
  const call = wc.on.mock.calls.find(([event]) => event === 'will-navigate')
  if (!call) throw new Error('未注册 will-navigate 监听')
  return call[1] as (event: { preventDefault: () => void }, url: string) => void
}

const DEV_URL = 'http://localhost:5173'

describe('hardenWebContents 窗口导航加固', () => {
  const originalDevUrl = process.env.ELECTRON_RENDERER_URL

  beforeEach(() => {
    delete process.env.ELECTRON_RENDERER_URL
  })
  afterEach(() => {
    if (originalDevUrl === undefined) delete process.env.ELECTRON_RENDERER_URL
    else process.env.ELECTRON_RENDERER_URL = originalDevUrl
  })

  it('window.open 一律返回 deny,不弹出任何新窗口', () => {
    const wc = makeFakeWebContents()
    hardenWebContents(wc)
    expect(wc.setWindowOpenHandler).toHaveBeenCalledTimes(1)
    const handler = wc.setWindowOpenHandler.mock.calls[0][0] as (details: unknown) => { action: string }
    expect(handler({ url: 'https://evil.example.com' })).toEqual({ action: 'deny' })
  })

  it('注册了 will-navigate 监听', () => {
    const wc = makeFakeWebContents()
    hardenWebContents(wc)
    expect(wc.on).toHaveBeenCalledWith('will-navigate', expect.any(Function))
  })

  it('生产态(file:):放行本应用页面,外源 http(s) 导航被 preventDefault', () => {
    const wc = makeFakeWebContents()
    hardenWebContents(wc)
    const listener = willNavigateListenerOf(wc)

    const sameOrigin = { preventDefault: vi.fn() }
    listener(sameOrigin, 'file:///D:/app/out/renderer/workbench.html')
    expect(sameOrigin.preventDefault).not.toHaveBeenCalled()

    const foreign = { preventDefault: vi.fn() }
    listener(foreign, 'https://evil.example.com/phish')
    expect(foreign.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('开发态:放行 ELECTRON_RENDERER_URL 前缀,外源与其他端口被拦截', () => {
    process.env.ELECTRON_RENDERER_URL = DEV_URL
    const wc = makeFakeWebContents()
    hardenWebContents(wc)
    const listener = willNavigateListenerOf(wc)

    const sameOrigin = { preventDefault: vi.fn() }
    listener(sameOrigin, `${DEV_URL}/workbench.html`)
    expect(sameOrigin.preventDefault).not.toHaveBeenCalled()

    const foreign = { preventDefault: vi.fn() }
    listener(foreign, 'https://evil.example.com')
    expect(foreign.preventDefault).toHaveBeenCalledTimes(1)

    const otherPort = { preventDefault: vi.fn() }
    listener(otherPort, 'http://localhost:9999/workbench.html')
    expect(otherPort.preventDefault).toHaveBeenCalledTimes(1)
  })
})
