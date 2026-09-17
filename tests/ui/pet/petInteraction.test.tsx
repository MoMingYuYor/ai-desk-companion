// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import PetApp from '../../../src/renderer/pet/pet'

// jsdom 26 没有 PointerEvent 构造器,fireEvent.pointer* 会退化为 Event 并丢失
// screenX/isPrimary/pointerId;这里补一个最小实现让 init 属性生效。
type PointerEventInitLike = {
  pointerId?: number
  pointerType?: string
  isPrimary?: boolean
} & Record<string, unknown>

class JsdomPointerEvent extends MouseEvent {
  pointerId: number
  pointerType: string
  isPrimary: boolean

  constructor(type: string, init: PointerEventInitLike = {}) {
    super(type, init as unknown as MouseEventInit)
    this.pointerId = init.pointerId ?? 0
    this.pointerType = init.pointerType ?? ''
    this.isPrimary = init.isPrimary ?? false
  }
}

if (typeof window.PointerEvent === 'undefined') {
  ;(window as unknown as { PointerEvent?: unknown }).PointerEvent = JsdomPointerEvent
}

type Handler = (...args: unknown[]) => void

function makeApiStub() {
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    on: vi.fn((channel: string, listener: Handler) => {
      handlers.set(channel, listener)
      return () => {
        handlers.delete(channel)
      }
    }),
    getDayAgenda: vi.fn(async () => ({
      date: '2026-09-17',
      courses: [],
      events: [],
      todos: [],
      schoolEvents: []
    })),
    addMaterials: vi.fn(async () => ({ conversationId: 'conv-test', materials: [] })),
    pathForFile: vi.fn((file: unknown) => `/tmp/${(file as { name?: string }).name ?? 'file'}`),
    petDragStart: vi.fn(async () => {}),
    petDragEnd: vi.fn(async () => {}),
    petOpenMenu: vi.fn(async () => {}),
    getPetActivitySnapshot: vi.fn(async () => ({ revision: 0, activeIds: [] }))
  }
}

type ApiStub = ReturnType<typeof makeApiStub>

let apiStub: ApiStub

const originalApi = (window as unknown as { api?: unknown }).api
const originalSetPointerCapture = Element.prototype.setPointerCapture
const originalReleasePointerCapture = Element.prototype.releasePointerCapture

beforeEach(() => {
  apiStub = makeApiStub()
  ;(window as unknown as { api: unknown }).api = apiStub
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
})

afterEach(() => {
  cleanup()
  ;(window as unknown as { api?: unknown }).api = originalApi
  const proto = Element.prototype as unknown as Record<string, unknown>
  if (originalSetPointerCapture) proto.setPointerCapture = originalSetPointerCapture
  else delete proto.setPointerCapture
  if (originalReleasePointerCapture) proto.releasePointerCapture = originalReleasePointerCapture
  else delete proto.releasePointerCapture
})

type PointerInit = {
  button?: number
  isPrimary?: boolean
  pointerId?: number
  screenX?: number
  screenY?: number
}

function pointerInit(extra: PointerInit = {}): PointerInit {
  return { button: 0, isPrimary: true, pointerId: 1, ...extra }
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderPetApp(): Promise<RenderResult> {
  const view = render(<PetApp />)
  await flushAsync()
  return view
}

function getCharacterButton(): HTMLElement {
  return screen.getByRole('button', { name: '坐姿桌宠' })
}

describe('桌宠交互区组装', () => {
  it('按下微移释放:不启动原生拖动,弹出今日要点', async () => {
    await renderPetApp()
    const button = getCharacterButton()
    fireEvent.pointerDown(button, pointerInit({ screenX: 100, screenY: 100 }))
    fireEvent.pointerMove(button, pointerInit({ screenX: 103, screenY: 102 }))
    expect(apiStub.petDragStart).not.toHaveBeenCalled()
    fireEvent.pointerUp(button, pointerInit({ screenX: 103, screenY: 102 }))
    expect(apiStub.petDragStart).not.toHaveBeenCalled()
    expect(await screen.findByText('今天没有安排,好好休息~')).toBeTruthy()
    expect(apiStub.getDayAgenda).toHaveBeenCalledTimes(1)
  })

  it('位移达到阈值:原生拖动只 start 一次,释放 end 一次且不触发点击', async () => {
    await renderPetApp()
    const button = getCharacterButton()
    fireEvent.pointerDown(button, pointerInit({ screenX: 100, screenY: 100 }))
    fireEvent.pointerMove(button, pointerInit({ screenX: 109, screenY: 100 }))
    fireEvent.pointerMove(button, pointerInit({ screenX: 115, screenY: 104 }))
    expect(apiStub.petDragStart).toHaveBeenCalledTimes(1)
    fireEvent.pointerUp(button, pointerInit({ screenX: 115, screenY: 104 }))
    expect(apiStub.petDragEnd).toHaveBeenCalledTimes(1)
    await flushAsync()
    expect(apiStub.getDayAgenda).not.toHaveBeenCalled()
    expect(screen.queryByText('今天没有安排,好好休息~')).toBeNull()
  })

  it('键盘 Enter 触发一次今日要点', async () => {
    await renderPetApp()
    const button = getCharacterButton()
    fireEvent.keyDown(button, { key: 'Enter' })
    expect(apiStub.getDayAgenda).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('今天没有安排,好好休息~')).toBeTruthy()
  })

  it('拖入文件与文本 drop:以 files/texts 调用 addMaterials', async () => {
    const view = await renderPetApp()
    const root = view.container.firstElementChild as HTMLElement
    fireEvent.drop(root, {
      dataTransfer: {
        files: [{ name: 'notice.pdf' }],
        getData: () => '请帮我分析这份通知'
      }
    })
    await flushAsync()
    await waitFor(() => expect(apiStub.addMaterials).toHaveBeenCalledTimes(1))
    expect(apiStub.pathForFile).toHaveBeenCalledTimes(1)
    expect(apiStub.addMaterials).toHaveBeenCalledWith({
      files: ['/tmp/notice.pdf'],
      texts: [{ name: '拖入的通知文本', content: '请帮我分析这份通知' }]
    })
  })
})
