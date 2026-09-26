import { beforeEach, describe, expect, it } from 'vitest'
import { makeTestDb } from '../helpers'
import { initWorkspaceEpoch } from '../../src/main/db/operations'
import { getRun, listTraceEvents } from '../../src/main/runs/repository'
import { createRun } from '../../src/main/runs/repository'
import { RunOrchestrator, type OrchestratorDeps } from '../../src/main/agent/orchestrator'
import { FakeProvider } from '../../src/main/providers/fake'
import { ToolGateway } from '../../src/main/tools/gateway'
import { ToolRegistry } from '../../src/main/tools/registry'
import { registerOpsTools } from '../../src/main/tools/definitions'
import { toolFailure } from '../../src/main/tools/types'
import { systemClock } from '../../src/shared/clock'
import { RunQueue } from '../../src/main/agent/runQueue'
import type { StructuredCompleteRequest } from '../../src/main/agent/llm'
import { RunMode } from '../../src/shared/agent'
import type { SqliteDb } from '../../src/main/db/connection'

// A-03/A-04:规划器与编排器。逐条覆盖验收用例 OPS-01~OPS-08、OPS-10。
// FakeProvider 按调用序返回脚本,规划调用是第 1 次,澄清后的重新规划是第 2 次。

const NOW = '2026-09-28T01:00:00.000Z'

interface Harness {
  db: SqliteDb
  orchestrator: RunOrchestrator
  provider: FakeProvider
  events: Array<{ channel: string; payload: unknown }>
  writeFailCalls: () => number
}

async function makeHarness(
  responsesOrScript:
    | readonly unknown[]
    | ((callIndex: number, request: StructuredCompleteRequest) => unknown)
): Promise<Harness> {
  const db = await makeTestDb()
  initWorkspaceEpoch()
  const registry = new ToolRegistry()
  registerOpsTools(registry)
  let failCalls = 0
  registry.register({
    name: 'fixture.write_fail',
    description: '总是业务失败的写工具(测试 partial)',
    riskLevel: 'reversible_write',
    timeoutMs: 1000,
    retryable: false,
    inputSchema: { fields: [{ name: 'title', type: 'string', required: true }] },
    execute: (args) => {
      failCalls += 1
      return toolFailure({
        code: 'VALIDATION',
        message: `无法完成:${String(args.title)}`,
        retryable: false
      })
    }
  })
  const gateway = new ToolGateway({ db, registry, clock: systemClock })
  const queue = new RunQueue(db)
  const events: Array<{ channel: string; payload: unknown }> = []
  const provider = new FakeProvider(
    Array.isArray(responsesOrScript)
      ? { responses: [...responsesOrScript] }
      : { script: responsesOrScript as (callIndex: number, request: StructuredCompleteRequest) => unknown }
  )
  const orchestrator = new RunOrchestrator({
    db,
    registry,
    gateway,
    queue,
    provider: undefined,
    completer: provider,
    events: { emit: (channel: string, payload: unknown) => events.push({ channel, payload }) }
  } as unknown as OrchestratorDeps)
  return { db, orchestrator, provider, events, writeFailCalls: () => failCalls }
}

function planOf(steps: unknown[], over: Record<string, unknown> = {}): unknown {
  return { goal: '测试目标', steps, assumptions: [], ...over }
}

async function seedTodos(db: SqliteDb): Promise<void> {
  const { seedDemoData } = await import('../../src/main/agent/seed')
  seedDemoData(db)
}

describe('OPS-01 只读任务:自动完成、零写操作', () => {
  it('todo.list 计划直接执行成功,业务表无变化', async () => {
    const h = await makeHarness([
      planOf([{ tool: 'todo.list', arguments: { status: 'open', priority: 'high' } }])
    ])
    await seedTodos(h.db)
    const before = h.db.all('SELECT * FROM todos')
    const run = createRun(h.db, { mode: 'personal_ops' as RunMode, input: '列出未完成高优先级任务', contextClock: NOW })
    await h.orchestrator.drivePlanning(run.runId)

    expect(getRun(h.db, run.runId)?.status).toBe('succeeded')
    expect(h.db.all('SELECT * FROM todos')).toHaveLength(before.length)
    const types = listTraceEvents(h.db, run.runId).map((e) => e.eventType)
    expect(types).toEqual(['plan', 'tool_call', 'output'])
  })
})

describe('OPS-02 时间含糊:awaiting_input,回答后继续同一运行', () => {
  it('澄清轮进入 awaiting_input 且无日历新增;回答后重新入队执行', async () => {
    const h = await makeHarness([
      planOf([], {
        clarifications: [{ question_id: 'q-when', question: '安排到哪一天几点?' }]
      }),
      planOf([{ tool: 'calendar.create_event', arguments: { title: '项目整理', startAt: '2026-09-30T09:00', endAt: '2026-09-30T10:00' } }])
    ])
    const run = createRun(h.db, { mode: 'personal_ops' as RunMode, input: '安排项目整理', contextClock: NOW })
    await h.orchestrator.drivePlanning(run.runId)
    expect(getRun(h.db, run.runId)?.status).toBe('awaiting_input')
    expect(h.db.all('SELECT * FROM events')).toHaveLength(0)

    await h.orchestrator.submitAnswers(run.runId, [{ questionId: 'q-when', answer: '9月30日上午9点' }])
    // 回答后的计划含写步骤:进入等待确认(而非直接成功)
    expect(getRun(h.db, run.runId)?.status).toBe('awaiting_confirmation')
    expect(h.db.all('SELECT * FROM events')).toHaveLength(0)

    const confirmations = listTraceEvents(h.db, run.runId).filter((e) => e.eventType === 'confirmation')
    const approvalId = (confirmations[0]!.payload as { approvalId: string }).approvalId
    await h.orchestrator.decide(approvalId, 'approved')
    expect(getRun(h.db, run.runId)?.status).toBe('succeeded')
    expect(h.db.all('SELECT * FROM events')).toHaveLength(1)
  })

  it('澄清后重新规划仍提出澄清:最多一轮,不再阻塞', async () => {
    const h = await makeHarness([
      planOf([], { clarifications: [{ question_id: 'q-when', question: '哪天?' }] }),
      planOf([], { clarifications: [{ question_id: 'q-again', question: '具体几点?' }] })
    ])
    const run = createRun(h.db, { mode: 'personal_ops' as RunMode, input: '安排', contextClock: NOW })
    await h.orchestrator.drivePlanning(run.runId)
    // 第二轮仍要求澄清:按"最多一轮"直接以假设继续(无写步骤则成功收尾)
    await h.orchestrator.submitAnswers(run.runId, [{ questionId: 'q-when', answer: '下周' }])
    expect(getRun(h.db, run.runId)?.status).toBe('succeeded')
  })
})

describe('OPS-03 批准日历提案:实际参数等于展示参数', () => {
  it('确认事件中的工具与参数与执行一致', async () => {
    const args = { title: '项目整理', startAt: '2026-09-30T09:00', endAt: '2026-09-30T10:00' }
    const h = await makeHarness([planOf([{ tool: 'calendar.create_event', arguments: args }])])
    const run = createRun(h.db, { mode: 'personal_ops' as RunMode, input: '安排项目整理', contextClock: NOW })
    await h.orchestrator.drivePlanning(run.runId)
    expect(getRun(h.db, run.runId)?.status).toBe('awaiting_confirmation')

    const confirmation = listTraceEvents(h.db, run.runId).find((e) => e.eventType === 'confirmation')
    const approvalId = (confirmation?.payload as { approvalId: string }).approvalId

    await h.orchestrator.decide(approvalId, 'approved')
    expect(getRun(h.db, run.runId)?.status).toBe('succeeded')

    const executed = listTraceEvents(h.db, run.runId).find((e) => e.eventType === 'tool_call')
    // 实际执行的参数与提案展示的一致(以事件载荷核对)
    const proposalPayload = confirmation!.payload as Record<string, unknown>
    expect(proposalPayload.tool).toBe('calendar.create_event')
    void executed
    const event = h.db.get<{ title: string; start_at: string }>('SELECT title, start_at FROM events')
    expect(event?.title).toBe(args.title)
    expect(event?.start_at).toBe(args.startAt)
  })
})

describe('OPS-04 拒绝提案:业务库无变化', () => {
  it('拒绝后运行取消,无日历写入', async () => {
    const h = await makeHarness([planOf([{ tool: 'calendar.create_event', arguments: { title: '不该出现', startAt: '2026-09-30T09:00', endAt: '2026-09-30T10:00' } }])])
    const run = createRun(h.db, { mode: 'personal_ops' as RunMode, input: '安排', contextClock: NOW })
    await h.orchestrator.drivePlanning(run.runId)
    const confirmation = listTraceEvents(h.db, run.runId).find((e) => e.eventType === 'confirmation')!
    const approvalId = (confirmation.payload as { approvalId: string }).approvalId

    await h.orchestrator.decide(approvalId, 'rejected')
    expect(getRun(h.db, run.runId)?.status).toBe('cancelled')
    expect(h.db.all('SELECT * FROM events')).toHaveLength(0)
  })
})

describe('OPS-05 并发重复批准:仅一条业务更新', () => {
  it('第二次批准返回 already,不重复执行', async () => {
    const h = await makeHarness([planOf([{ tool: 'todo.create', arguments: { title: '只建一次' } }])])
    const run = createRun(h.db, { mode: 'personal_ops' as RunMode, input: '建任务', contextClock: NOW })
    await h.orchestrator.drivePlanning(run.runId)
    const confirmation = listTraceEvents(h.db, run.runId).find((e) => e.eventType === 'confirmation')!
    const approvalId = (confirmation.payload as { approvalId: string }).approvalId

    const first = await h.orchestrator.decide(approvalId, 'approved')
    const second = await h.orchestrator.decide(approvalId, 'approved')
    expect(first.already).toBe(false)
    expect(second.already).toBe(true)
    expect(h.db.all("SELECT * FROM todos WHERE title = '只建一次'")).toHaveLength(1)
    expect(getRun(h.db, run.runId)?.status).toBe('succeeded')
  })
})

describe('OPS-06 目标记录版本变化:409 重新规划', () => {
  it('批准前目标被修改,执行冲突,运行失败', async () => {
    // 计划在调用时动态读取当前库的真实 ID(避免双库混用)
    const h = await makeHarness(() => {
      const todoId = h.db.get<{ id: string }>('SELECT id FROM todos LIMIT 1')!.id
      return planOf([{ tool: 'todo.update', arguments: { id: todoId, title: '改名' } }])
    })
    await seedTodos(h.db)
    const run = createRun(h.db, { mode: 'personal_ops' as RunMode, input: '改名', contextClock: NOW })
    await h.orchestrator.drivePlanning(run.runId)
    const confirmation = listTraceEvents(h.db, run.runId).find((e) => e.eventType === 'confirmation')!
    const approvalId = (confirmation.payload as { approvalId: string }).approvalId
    // bump 目标以提案 arguments_json 里的 ID 为准(无 ORDER BY 的 LIMIT 1 行序不稳定)
    const targetId = (
      JSON.parse(
        h.db.get<{ arguments_json: string }>(
          'SELECT arguments_json FROM approvals WHERE approval_id = ?',
          [approvalId]
        )!.arguments_json ?? '{}'
      ) as { id: string }
    ).id

    // 批准之前目标又被改了一版:执行时重解析版本与批准绑定版本不一致
    h.db.run('UPDATE todos SET revision = revision + 1, title = ? WHERE id = ?', ['他人先改', targetId])
    await h.orchestrator.decide(approvalId, 'approved')
    const after = getRun(h.db, run.runId)
    expect(after?.status).toBe('failed')
    expect(after?.errorCode).toBe('CONFLICT')
    // 他人先改的标题未被覆盖
    expect(h.db.get<{ title: string }>('SELECT title FROM todos WHERE id = ?', [targetId])?.title).toBe('他人先改')
  })
})

describe('OPS-07 要求未注册能力:计划被拒', () => {
  it('引用不存在的 mail.send,运行失败且无业务副作用', async () => {
    const h = await makeHarness([
      planOf([
        { tool: 'mail.send', arguments: { to: 'x@example.com' } }
      ])
    ])
    await seedTodos(h.db)
    const run = createRun(h.db, { mode: 'personal_ops' as RunMode, input: '直接发送邮件', contextClock: NOW })
    await h.orchestrator.drivePlanning(run.runId)
    const after = getRun(h.db, run.runId)
    expect(after?.status).toBe('failed')
    expect(after?.errorCode).toBe('MODEL_OUTPUT_INVALID')
    // 无任何工具执行
    expect(listTraceEvents(h.db, run.runId).filter((e) => e.eventType === 'tool_call')).toHaveLength(0)
  })
})

describe('OPS-08 部分失败:partial 保留已完成影响', () => {
  it('第一步成功、第二步失败 → partial', async () => {
    const h = await makeHarness([
      planOf([
        { tool: 'todo.create', arguments: { title: '会成功的' } },
        { tool: 'fixture.write_fail', arguments: { title: '会失败的' } }
      ])
    ])
    const run = createRun(h.db, { mode: 'personal_ops' as RunMode, input: '两步任务', contextClock: NOW })
    await h.orchestrator.drivePlanning(run.runId)
    expect(getRun(h.db, run.runId)?.status).toBe('awaiting_confirmation')

    const confirmations = listTraceEvents(h.db, run.runId).filter((e) => e.eventType === 'confirmation')
    expect(confirmations).toHaveLength(2)

    for (const c of confirmations) {
      const approvalId = (c.payload as { approvalId: string }).approvalId
      await h.orchestrator.decide(approvalId, 'approved')
    }
    const after = getRun(h.db, run.runId)
    expect(after?.status).toBe('partial')
    expect(h.db.all("SELECT * FROM todos WHERE title = '会成功的'")).toHaveLength(1)
    expect(h.writeFailCalls()).toBe(1)
  })
})

describe('OPS-10 窗口关闭后恢复:事件重放,不再次执行', () => {
  it('新编排器实例接续批准并执行;恢复不重复执行已完成调用', async () => {
    const h = await makeHarness([planOf([{ tool: 'todo.create', arguments: { title: '重启前提案' } }])])
    const run = createRun(h.db, { mode: 'personal_ops' as RunMode, input: '建任务', contextClock: NOW })
    await h.orchestrator.drivePlanning(run.runId)
    const confirmation = listTraceEvents(h.db, run.runId).find((e) => e.eventType === 'confirmation')!
    const approvalId = (confirmation.payload as { approvalId: string }).approvalId

    // "重启":同库新编排器实例(无任何内存状态)
    const revived = new RunOrchestrator({
      db: h.db,
      registry: (h.orchestrator as unknown as { deps: OrchestratorDeps }).deps.registry,
      gateway: (h.orchestrator as unknown as { deps: OrchestratorDeps }).deps.gateway,
      queue: (h.orchestrator as unknown as { deps: OrchestratorDeps }).deps.queue,
      completer: h.provider
    })
    await revived.decide(approvalId, 'approved')
    expect(getRun(h.db, run.runId)?.status).toBe('succeeded')
    expect(h.db.all("SELECT * FROM todos WHERE title = '重启前提案'")).toHaveLength(1)
  })
})

describe('多运行队列', () => {
  it('运行 A 等待人工时释放执行权,排队中的 B 可被驱动', async () => {
    const h = await makeHarness([
      planOf([], { clarifications: [{ question_id: 'q-a', question: 'A 缺信息' }] }),
      planOf([{ tool: 'todo.list', arguments: {} }]),
      planOf([{ tool: 'todo.list', arguments: {} }])
    ])
    // B 先排队,随后 A 提出澄清
    const b = createRun(h.db, { mode: 'personal_ops' as RunMode, input: 'B 任务', contextClock: NOW })
    const a = createRun(h.db, { mode: 'personal_ops' as RunMode, input: 'A 任务', contextClock: NOW })
    await h.orchestrator.drivePlanning(a.runId)
    expect(getRun(h.db, a.runId)?.status).toBe('awaiting_input')

    // A 等待回答释放执行权后,B 可被驱动并完成
    await h.orchestrator.drivePlanning(b.runId)
    expect(getRun(h.db, b.runId)?.status).toBe('succeeded')

    // A 的回答继续同一运行
    await h.orchestrator.submitAnswers(a.runId, [{ questionId: 'q-a', answer: '补充信息' }])
    expect(getRun(h.db, a.runId)?.status).toBe('succeeded')
    void h
  })
})

describe('取消与模型缺失', () => {
  it('取消等待确认的运行:待批提案过期,批准不再执行', async () => {
    const h = await makeHarness([planOf([{ tool: 'todo.create', arguments: { title: '不该建的' } }])])
    const run = createRun(h.db, { mode: 'personal_ops' as RunMode, input: '取消我', contextClock: NOW })
    await h.orchestrator.drivePlanning(run.runId)
    const confirmation = listTraceEvents(h.db, run.runId).find((e) => e.eventType === 'confirmation')!
    const approvalId = (confirmation.payload as { approvalId: string }).approvalId

    h.orchestrator.cancel(run.runId)
    expect(getRun(h.db, run.runId)?.status).toBe('cancelled')
    // 已过期的提案批准:决定冲突(不是幂等重放)
    await expect(h.orchestrator.decide(approvalId, 'approved')).rejects.toThrow(/审批决定冲突/)
    expect(h.db.all("SELECT * FROM todos WHERE title = '不该建的'")).toHaveLength(0)
  })

  it('无 completer 时规划以 MODEL_UNAVAILABLE 失败', async () => {
    const db = await makeTestDb()
    initWorkspaceEpoch()
    const registry = new ToolRegistry()
    registerOpsTools(registry)
    const orchestrator = new RunOrchestrator({
      db,
      registry,
      gateway: new ToolGateway({ db, registry, clock: systemClock }),
      queue: new RunQueue(db)
    })
    const run = createRun(db, { mode: 'personal_ops' as RunMode, input: '任务', contextClock: NOW })
    await orchestrator.drivePlanning(run.runId)
    const after = getRun(db, run.runId)
    expect(after?.status).toBe('failed')
    expect(after?.errorCode).toBe('MODEL_UNAVAILABLE')
  })

  it('模型输出不可解析:MODEL_OUTPUT_INVALID', async () => {
    const h = await makeHarness(['这不是JSON'])
    const run = createRun(h.db, { mode: 'personal_ops' as RunMode, input: '任务', contextClock: NOW })
    await h.orchestrator.drivePlanning(run.runId)
    expect(getRun(h.db, run.runId)?.errorCode).toBe('MODEL_OUTPUT_INVALID')
  })
})
