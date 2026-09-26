import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'

// A-05:Agent 写侧 IPC handler(创建/澄清/取消/审批决定)。
// 规划用 FakeProvider 脚本驱动,验证 202 语义(创建先返回,规划异步)与
// 审批决定到执行的全链路。

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

const REGISTRY_ENTRY = {
  role: 'workbench' as const,
  webContentsId: 1,
  pageUrl: 'file:///D:/app/out/renderer/workbench.html',
  isDestroyed: () => false
}

vi.mock('../../src/main/windows', () => ({
  getWindowRegistry: () => [REGISTRY_ENTRY],
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
import { initWorkspaceEpoch } from '../../src/main/db/operations'
import { getRun, listTraceEvents } from '../../src/main/runs/repository'
import { RunOrchestrator } from '../../src/main/agent/orchestrator'
import { RunQueue } from '../../src/main/agent/runQueue'
import { ToolGateway } from '../../src/main/tools/gateway'
import { ToolRegistry } from '../../src/main/tools/registry'
import { registerOpsTools } from '../../src/main/tools/definitions'
import { FakeProvider } from '../../src/main/providers/fake'
import { makeTestDb } from '../helpers'
import { systemClock } from '../../src/shared/clock'

const NOW = '2026-09-28T01:00:00.000Z'
const fakeEvent = {
  sender: { id: 1 },
  senderFrame: { url: REGISTRY_ENTRY.pageUrl, parent: null }
} as unknown as IpcMainInvokeEvent

async function boot(responses: readonly unknown[]): Promise<{
  db: Awaited<ReturnType<typeof makeTestDb>>
  orchestrator: RunOrchestrator
}> {
  const db = await makeTestDb()
  initWorkspaceEpoch()
  handlers.clear()
  const registry = new ToolRegistry()
  registerOpsTools(registry)
  const gateway = new ToolGateway({ db, registry, clock: systemClock })
  const queue = new RunQueue(db)
  const provider = new FakeProvider({ responses })
  const orchestrator = new RunOrchestrator({
    db,
    registry,
    gateway,
    queue,
    completer: provider
  })
  registerIpcHandlers({ db, engine: {} as never, router: {} as never, reminders: {} as never, mail: {} as never, orchestrator } as never)
  return { db, orchestrator }
}

describe('agent:run-create(202 语义)', () => {
  beforeEach(() => handlers.clear())

  it('创建返回 queued;规划异步完成后 succeeded', async () => {
    const { db } = await boot([
      planOf([{ tool: 'todo.list', arguments: {} }])
    ])
    const created = (await handlers.get(Channels.AgentRunCreate)!(fakeEvent, {
      input: '列出任务'
    })) as { runId: string; status: string }
    expect(created.status).toBe('queued')
    expect(created.runId).toBeTruthy()

    // 规划异步驱动:等待终态
    await vi.waitFor(() => {
      expect(getRun(db, created.runId)?.status).toBe('succeeded')
    })
  })

  it('未接线编排器时明确拒绝(不做静默桩)', async () => {
    const db = await makeTestDb()
    initWorkspaceEpoch()
    handlers.clear()
    registerIpcHandlers({ db, engine: {} as never, router: {} as never, reminders: {} as never, mail: {} as never } as never)
    await expect(
      handlers.get(Channels.AgentRunCreate)!(fakeEvent, { input: '任务' })
    ).rejects.toThrow(/编排器未接线/)
  })

  it('重复创建(同幂等键)返回首次结果', async () => {
    const { db } = await boot([planOf([{ tool: 'todo.list', arguments: {} }])])
    const ctx = { operationId: 'idem-1', workspaceEpoch: (await import('../../src/main/db/operations')).getWorkspaceEpoch() }
    const first = (await handlers.get(Channels.AgentRunCreate)!(fakeEvent, { input: '任务', context: ctx })) as {
      runId: string
    }
    const second = (await handlers.get(Channels.AgentRunCreate)!(fakeEvent, { input: '任务', context: ctx })) as {
      runId: string
    }
    expect(second.runId).toBe(first.runId)
    expect(db.all('SELECT * FROM agent_runs')).toHaveLength(1)
  })
})

describe('agent:run-answers 与 agent:approval-decide 全链路', () => {
  beforeEach(() => handlers.clear())

  it('澄清受理返回 queued;批准后写入完成', async () => {
    const { db } = await boot([
      planOf([], { clarifications: [{ question_id: 'q-time', question: '安排到哪天?' }] }),
      planOf([{ tool: 'todo.create', arguments: { title: '经澄清创建' } }])
    ])
    const created = (await handlers.get(Channels.AgentRunCreate)!(fakeEvent, { input: '安排任务' })) as {
      runId: string
    }
    await vi.waitFor(() => {
      expect(getRun(db, created.runId)?.status).toBe('awaiting_input')
    })

    // 受澄清答案:202 语义返回 queued
    const answered = (await handlers.get(Channels.AgentRunAnswers)!(fakeEvent, created.runId, [
      { questionId: 'q-time', answer: '下周一' }
    ])) as { runId: string; status: string }
    expect(answered.status).toBe('queued')

    // 重新规划产出写提案:等待确认
    await vi.waitFor(() => {
      expect(getRun(db, created.runId)?.status).toBe('awaiting_confirmation')
    })
    const confirmation = listTraceEvents(db, created.runId).find((e) => e.eventType === 'confirmation')!
    const approvalId = (confirmation.payload as { approvalId: string }).approvalId

    const decided = (await handlers.get(Channels.AgentApprovalDecide)!(fakeEvent, approvalId, 'approved')) as {
      already: boolean
    }
    expect(decided.already).toBe(false)

    await vi.waitFor(() => {
      expect(getRun(db, created.runId)?.status).toBe('succeeded')
    })
    expect(db.all("SELECT * FROM todos WHERE title = '经澄清创建'")).toHaveLength(1)
  })

  it('取消后运行 cancelled,待批提案过期', async () => {
    const { db } = await boot([
      planOf([{ tool: 'todo.create', arguments: { title: '将被取消的' } }])
    ])
    const created = (await handlers.get(Channels.AgentRunCreate)!(fakeEvent, { input: '任务' })) as {
      runId: string
    }
    await vi.waitFor(() => {
      expect(getRun(db, created.runId)?.status).toBe('awaiting_confirmation')
    })

    await handlers.get(Channels.AgentRunCancel)!(fakeEvent, created.runId)
    expect(getRun(db, created.runId)?.status).toBe('cancelled')

    const approval = db.get<{ decision: string }>('SELECT decision FROM approvals WHERE run_id = ?', [
      created.runId
    ])
    expect(approval?.decision).toBe('expired')
    expect(db.all("SELECT * FROM todos WHERE title = '将被取消的'")).toHaveLength(0)
  })
})

function planOf(steps: unknown[], over: Record<string, unknown> = {}): unknown {
  return { goal: '测试目标', steps, assumptions: [], ...over }
}
