import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'

// REL-02:chat:stop handler 透传运行身份(runId)。
// 「迟到旧 run 停止误伤新运行」的防线:RendererApi.stopChat(id, runId?) → preload 通用
// invoke → 主进程 handler → engine.stop(id, runId)。中间 handler 旧实现只传 conversationId,
// 丢弃 runId,导致同会话新运行被迟到的旧 run 停止误伤。本文件从实际 IPC 边界出发证明:
// 两参透传、迟到旧 run 停止不影响新运行、缺省 runId 按既有契约、授权不扩大。
// 仿 tests/agent/ipcAgentRun.test.ts 的 handlers Map 模式,实际 registerIpcHandlers 后直调 handler。

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    })
  },
  BrowserWindow: class {},
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0') },
  clipboard: { writeText: vi.fn(), readText: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() }
}))

const REGISTRY = [
  {
    role: 'workbench' as const,
    webContentsId: 1,
    pageUrl: 'file:///D:/app/out/renderer/workbench.html',
    isDestroyed: () => false
  },
  {
    role: 'pet' as const,
    webContentsId: 2,
    pageUrl: 'file:///D:/app/out/renderer/pet.html',
    isDestroyed: () => false
  },
  {
    role: 'panel' as const,
    webContentsId: 3,
    pageUrl: 'file:///D:/app/out/renderer/panel.html',
    isDestroyed: () => false
  }
]

vi.mock('../src/main/windows', () => ({
  getWindowRegistry: () => REGISTRY,
  broadcastToAll: vi.fn(),
  broadcastToWorkbench: vi.fn(),
  getWorkbenchWindow: vi.fn(() => null),
  getPetWindow: vi.fn(() => null),
  getPanelWindow: vi.fn(() => null),
  createWorkbenchWindow: vi.fn(),
  createPanelWindow: vi.fn(),
  markQuitting: vi.fn(),
  petScaleOf: vi.fn(() => 1),
  savePetPosition: vi.fn(),
  setPanelPinnedMeta: vi.fn(),
  setPetScale: vi.fn(),
  togglePet: vi.fn(),
  isQuitting: vi.fn(() => false)
}))

import { Channels } from '../src/shared/api'
import { Engine } from '../src/main/services/engine'
import type { ModelRouter } from '../src/main/services/modelRouter'
import { registerIpcHandlers } from '../src/main/ipc'
import { createConversation } from '../src/main/db/dao'
import { makeTestDb } from './helpers'

interface BroadcastEvent {
  channel: string
  payload: Record<string, unknown>
}

function eventAs(role: 'workbench' | 'pet' | 'panel'): IpcMainInvokeEvent {
  const entry = REGISTRY.find((r) => r.role === role)!
  return {
    sender: { id: entry.webContentsId },
    senderFrame: { url: entry.pageUrl, parent: null }
  } as unknown as IpcMainInvokeEvent
}

function events(list: BroadcastEvent[], channel: string): Array<Record<string, unknown>> {
  return list.filter((e) => e.channel === channel).map((e) => e.payload)
}

function ok(text: string): { text: string; used: { providerId: string; providerName: string; model: string } } {
  return { text, used: { providerId: 'p1', providerName: '测试服务', model: 'm1' } }
}

/** 假 router:按调用序返回脚本结果;挂起步骤等待 signal abort(模拟进行中的运行) */
function scriptedRouter(script: Array<(options: { signal?: AbortSignal }) => Promise<unknown>>): ModelRouter {
  let callCount = 0
  return {
    call: (_providers: unknown, options: { signal?: AbortSignal }) => {
      const step = script[Math.min(callCount, script.length - 1)]!
      callCount += 1
      return step(options) as Promise<unknown>
    }
  } as unknown as ModelRouter
}

describe('chat:stop 两参透传(假 engine 契约)', () => {
  beforeEach(() => handlers.clear())

  it('runId 透传给 engine.stop:旧实现缺第二参即失败', async () => {
    const db = await makeTestDb()
    const stop = vi.fn()
    registerIpcHandlers({ db, engine: { stop } as unknown as Engine, router: {}, reminders: {}, mail: {} } as never)
    const handler = handlers.get(Channels.ChatStop)
    expect(handler).toBeTruthy()
    await handler!(eventAs('workbench'), 'conv-1', 'run-1')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop.mock.calls[0]![0]).toBe('conv-1')
    expect(stop.mock.calls[0]![1]).toBe('run-1')
  })

  it('缺省 runId:engine.stop 收到 undefined,按既有契约停止当前运行', async () => {
    const db = await makeTestDb()
    const stop = vi.fn()
    registerIpcHandlers({ db, engine: { stop } as unknown as Engine, router: {}, reminders: {}, mail: {} } as never)
    await handlers.get(Channels.ChatStop)!(eventAs('workbench'), 'conv-1')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop.mock.calls[0]![0]).toBe('conv-1')
    expect(stop.mock.calls[0]![1]).toBeUndefined()
  })
})

describe('chat:stop 迟到停止不误伤新运行(真实 engine + 假 router)', () => {
  beforeEach(() => handlers.clear())

  async function bootReal(): Promise<{ engine: Engine; convId: string; broadcast: BroadcastEvent[] }> {
    const db = await makeTestDb()
    const conv = createConversation(db, 'chat', '竞态对话')
    const broadcast: BroadcastEvent[] = []
    // 第 1 次调用(A)立即完成;第 2 次调用(B)挂起直到 signal abort
    const router = scriptedRouter([
      () => Promise.resolve(ok('A 完成')),
      (options) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    ])
    const engine = new Engine({
      db,
      router,
      broadcast: (channel, payload) => broadcast.push({ channel, payload: payload as Record<string, unknown> })
    })
    registerIpcHandlers({ db, engine, router, reminders: {}, mail: {} } as never)
    return { engine, convId: conv.id, broadcast }
  }

  it('A 完成后 B 运行中:迟到 A 的停止被忽略,B 携带自身 runId 停止正确中止', async () => {
    const { engine, convId, broadcast } = await bootReal()

    // 运行 A:立即完成
    const p1 = engine.sendChat(convId, '第一条')
    await vi.waitFor(() => expect(events(broadcast, 'evt:chat-started')).toHaveLength(1))
    const runIdA = events(broadcast, 'evt:chat-started')[0]!.runId as string
    await p1
    expect(engine.getActiveChatRun(convId)).toBeNull()

    // 运行 B:进行中
    const p2 = engine.sendChat(convId, '第二条')
    await vi.waitFor(() => expect(events(broadcast, 'evt:chat-started')).toHaveLength(2))
    const runIdB = events(broadcast, 'evt:chat-started')[1]!.runId as string
    expect(runIdB).not.toBe(runIdA)
    expect(engine.getActiveChatRun(convId)?.runId).toBe(runIdB)

    // 迟到的 A 停止:不得中止 B(旧实现丢弃 runId,此处会误停 B)
    await handlers.get(Channels.ChatStop)!(eventAs('workbench'), convId, runIdA)
    await new Promise((r) => setTimeout(r, 20))
    expect(engine.getActiveChatRun(convId)?.runId).toBe(runIdB)
    expect(events(broadcast, 'evt:chat-done')).toHaveLength(1)

    // B 携带自身 runId 停止:正确中止并广播对应 done
    await handlers.get(Channels.ChatStop)!(eventAs('workbench'), convId, runIdB)
    await p2
    expect(engine.getActiveChatRun(convId)).toBeNull()
    const dones = events(broadcast, 'evt:chat-done')
    expect(dones).toHaveLength(2)
    expect(dones[1]).toMatchObject({ conversationId: convId, runId: runIdB })
  })

  it('缺省 runId:停止当前运行(既有契约)', async () => {
    const { engine, convId, broadcast } = await bootReal()
    const p = engine.sendChat(convId, '长任务')
    await vi.waitFor(() => expect(engine.getActiveChatRun(convId)).not.toBeNull())
    await handlers.get(Channels.ChatStop)!(eventAs('workbench'), convId)
    await p
    expect(engine.getActiveChatRun(convId)).toBeNull()
    expect(events(broadcast, 'evt:chat-done')[0]).toMatchObject({ conversationId: convId })
  })

  it('无活动运行时停止不抛异常', async () => {
    const { engine, convId } = await bootReal()
    const withRunId = await handlers.get(Channels.ChatStop)!(eventAs('workbench'), convId, 'run-ghost')
    expect(withRunId).toBeUndefined()
    const withoutRunId = await handlers.get(Channels.ChatStop)!(eventAs('workbench'), convId)
    expect(withoutRunId).toBeUndefined()
    expect(engine.getActiveChatRun(convId)).toBeNull()
  })

  it('桌宠与面板角色调用仍被拒绝(授权不扩大)', async () => {
    await bootReal()
    for (const role of ['pet', 'panel'] as const) {
      await expect(
        handlers.get(Channels.ChatStop)!(eventAs(role), 'conv-1', 'run-1')
      ).rejects.toThrow(/来源未授权/)
    }
  })
})
