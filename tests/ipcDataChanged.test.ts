import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'

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

// Task 12 集成:ipc.ts 统一经 authorizeIpc 授权(登记窗口能力表),
// 测试注册一个工作台窗口并构造其主 frame 的合法事件
vi.mock('../src/main/windows', () => ({
  getWindowRegistry: () => [
    {
      role: 'workbench' as const,
      webContentsId: 1,
      pageUrl: 'http://localhost:5173/workbench.html',
      isDestroyed: () => false
    }
  ],
  broadcastToAll: vi.fn(),
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
import { registerIpcHandlers, setDataChangedListener } from '../src/main/ipc'
import { initWorkspaceEpoch } from '../src/main/db/operations'
import { createTodo, createEvent } from '../src/main/db/dao'
import { makeTestDb } from './helpers'

const fakeEvent = {
  sender: { id: 1 },
  senderFrame: { url: 'http://localhost:5173/workbench.html', parent: null }
} as unknown as IpcMainInvokeEvent

async function boot() {
  const db = await makeTestDb()
  handlers.clear()
  const fired = vi.fn()
  setDataChangedListener(fired)
  // 写命令边界依赖 workspaceEpoch 单例
  initWorkspaceEpoch()
  registerIpcHandlers({
    db,
    engine: {},
    router: {},
    reminders: {},
    mail: {}
  } as never)
  return { db, fired }
}

describe('数据变更 IPC 广播 evt:data-changed', () => {
  beforeEach(() => {
    setDataChangedListener(null)
  })

  it('待办删除/更新/创建后广播', async () => {
    const { db, fired } = await boot()
    const todo = createTodo(db, { title: '交作业' })
    fired.mockClear()

    await handlers.get(Channels.TodosDelete)!(fakeEvent, todo.id)
    expect(fired).toHaveBeenCalledTimes(1)

    const todo2 = await handlers.get(Channels.TodosCreate)!(fakeEvent, { title: '新待办' })
    expect(fired).toHaveBeenCalledTimes(2)

    // 更新现存条目(删除后的旧 id 按契约返回 TARGET_UNAVAILABLE)
    await handlers.get(Channels.TodosUpdate)!(fakeEvent, (todo2 as { id: string }).id, { title: '改名' })
    expect(fired).toHaveBeenCalledTimes(3)
  })

  it('日程创建/更新/删除后广播', async () => {
    const { db, fired } = await boot()
    const ev = createEvent(db, { title: '讨论', startAt: '2026-09-18T14:00', endAt: '2026-09-18T15:00', allDay: false })
    fired.mockClear()

    await handlers.get(Channels.EventsUpdate)!(fakeEvent, ev.id, { title: '讨论改期' })
    expect(fired).toHaveBeenCalledTimes(1)

    await handlers.get(Channels.EventsDelete)!(fakeEvent, ev.id)
    expect(fired).toHaveBeenCalledTimes(2)
  })

  it('待处理办结/删除后广播', async () => {
    const { db, fired } = await boot()
    db.run(
      "INSERT INTO pending_items (id, title, status, created_at, updated_at) VALUES ('p1', '确认安排', 'open', '2026-09-17T00:00', '2026-09-17T00:00')"
    )
    fired.mockClear()

    await handlers.get(Channels.PendingUpdate)!(fakeEvent, 'p1', { status: 'handled' })
    expect(fired).toHaveBeenCalledTimes(1)

    await handlers.get(Channels.PendingDelete)!(fakeEvent, 'p1')
    expect(fired).toHaveBeenCalledTimes(2)
  })
})
