import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'

// C-03:Agent 运行事件流 IPC handler。
// 仿 tests/ipcDataChanged.test.ts 的 handlers Map 模式,直调 handler 验证
// 读侧契约(全量/按游标补发/未知运行)与授权包装(桌宠与面板被拒)。

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

vi.mock('../../src/main/windows', () => ({
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

import { Channels } from '../../src/shared/api'
import { registerIpcHandlers } from '../../src/main/ipc'
import { appendTraceEvent, createRun } from '../../src/main/runs/repository'
import { makeTestDb } from '../helpers'

const CLOCK = '2026-09-28T01:00:00.000Z'

function eventAs(role: 'workbench' | 'pet' | 'panel'): IpcMainInvokeEvent {
  const entry = REGISTRY.find((r) => r.role === role)!
  return {
    sender: { id: entry.webContentsId },
    senderFrame: { url: entry.pageUrl, parent: null }
  } as unknown as IpcMainInvokeEvent
}

async function boot() {
  const db = await makeTestDb()
  handlers.clear()
  registerIpcHandlers({ db, engine: {}, router: {}, reminders: {}, mail: {} } as never)
  return db
}

describe('agent:run-get', () => {
  beforeEach(() => handlers.clear())

  it('已存在运行返回完整记录', async () => {
    const db = await boot()
    const run = createRun(db, { mode: 'personal_ops', input: '整理任务', contextClock: CLOCK })
    const got = (await handlers.get(Channels.AgentRunGet)!(eventAs('workbench'), run.runId)) as Record<string, unknown>
    expect(got.runId).toBe(run.runId)
    expect(got.status).toBe('queued')
    expect(got.mode).toBe('personal_ops')
  })

  it('未知 runId 返回 null 而非抛错(避免泄漏运行存在性)', async () => {
    await boot()
    const got = await handlers.get(Channels.AgentRunGet)!(eventAs('workbench'), 'ghost')
    expect(got).toBeNull()
  })

  it('桌宠与面板角色被授权包装拒绝', async () => {
    await boot()
    for (const role of ['pet', 'panel'] as const) {
      await expect(handlers.get(Channels.AgentRunGet)!(eventAs(role), 'x')).rejects.toThrow(/来源未授权/)
    }
  })
})

describe('agent:run-events', () => {
  beforeEach(() => handlers.clear())

  it('无游标时返回全部事件(按 seq 升序)', async () => {
    const db = await boot()
    const run = createRun(db, { mode: 'research', input: '研究问题', contextClock: CLOCK })
    for (const t of ['input', 'retrieval', 'plan'] as const) {
      appendTraceEvent(db, { runId: run.runId, eventType: t })
    }
    const result = (await handlers.get(Channels.AgentRunEvents)!(eventAs('workbench'), run.runId)) as {
      run: { runId: string; status: string } | null
      events: Array<{ seq: number }>
    }
    expect(result.run?.runId).toBe(run.runId)
    expect(result.events.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('afterSeq 补发:只返回严格大于游标的事件', async () => {
    const db = await boot()
    const run = createRun(db, { mode: 'personal_ops', input: '任务', contextClock: CLOCK })
    for (let i = 0; i < 5; i += 1) {
      appendTraceEvent(db, { runId: run.runId, eventType: 'tool_call' })
    }
    const result = (await handlers.get(Channels.AgentRunEvents)!(eventAs('workbench'), run.runId, 3)) as {
      events: Array<{ seq: number }>
    }
    expect(result.events.map((e) => e.seq)).toEqual([4, 5])
  })

  it('未知 runId 返回 { run: null, events: [] },不抛错', async () => {
    await boot()
    const result = (await handlers.get(Channels.AgentRunEvents)!(eventAs('workbench'), 'ghost')) as {
      run: unknown
      events: unknown[]
    }
    expect(result.run).toBeNull()
    expect(result.events).toEqual([])
  })

  it('非法游标按 0 处理(全量补发)', async () => {
    const db = await boot()
    const run = createRun(db, { mode: 'personal_ops', input: '任务', contextClock: CLOCK })
    appendTraceEvent(db, { runId: run.runId, eventType: 'input' })
    for (const bad of [-1, 1.5, 'x' as unknown as number]) {
      const result = (await handlers.get(Channels.AgentRunEvents)!(eventAs('workbench'), run.runId, bad)) as {
        events: Array<{ seq: number }>
      }
      expect(result.events.map((e) => e.seq)).toEqual([1])
    }
  })

  it('桌宠与面板角色被授权包装拒绝', async () => {
    await boot()
    for (const role of ['pet', 'panel'] as const) {
      await expect(handlers.get(Channels.AgentRunEvents)!(eventAs(role), 'x')).rejects.toThrow(/来源未授权/)
    }
  })
})
