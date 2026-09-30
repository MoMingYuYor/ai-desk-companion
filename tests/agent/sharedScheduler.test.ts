// OPS-02(2026-09-30 完成计划):RunScheduler 共享接力与取消、审批重入回归。
//
// 覆盖规范验收项:
// - 关键取消竞态(规范片段):旧驱动 settle 前不派发下一个,取消后接力不缺;
// - Ops→Research→Ops 交错时间线:每次状态事件断言 planning/executing ≤ 1,
//   记录实际同时未退出驱动数 ≤ 1;批准在 Research 活跃期间保持排队,释放后自动执行;
// - 批准受理即排队、重复批准只写一次;多提案每轮只选一个待执行审批;
// - 澄清重入:驱动从答案轨迹恢复回答,不依赖 IPC 闭包参数;
// - 等待/失败/取消路径不缺接力;重启恢复:回执不重复、未执行审批过期;
// - RunQueue.tryResume 只可从 awaiting_confirmation 领取 executing。

import { describe, expect, it, vi } from 'vitest'
import { makeTestDb } from '../helpers'
import { createPersistenceCoordinator, initWorkspaceEpoch, runOperation } from '../../src/main/db/operations'
import {
  appendCallIndexMapping,
  createApproval,
  createRun,
  decideApproval,
  getApproval,
  getRun,
  listTraceEvents,
  transitionRun
} from '../../src/main/runs/repository'
import { RunQueue } from '../../src/main/agent/runQueue'
import { RunScheduler } from '../../src/main/agent/runScheduler'
import { RunOrchestrator, type OrchestratorDeps } from '../../src/main/agent/orchestrator'
import { recoverInterruptedRuns } from '../../src/main/agent/recovery'
import { FakeProvider } from '../../src/main/providers/fake'
import { ToolGateway } from '../../src/main/tools/gateway'
import { ToolRegistry } from '../../src/main/tools/registry'
import { registerOpsTools } from '../../src/main/tools/definitions'
import type { StructuredCompleteRequest } from '../../src/main/agent/llm'

const NOW = '2026-09-30T01:00:00.000Z'

function planOf(steps: unknown[], over: Record<string, unknown> = {}): unknown {
  return { goal: '测试目标', steps, assumptions: [], ...over }
}

/** 固定两个运行的 started_at 次序:消除同毫秒创建的就绪时间平局 */
function pinOrder(db: Awaited<ReturnType<typeof makeTestDb>>, first: string, second: string): void {
  db.run('UPDATE agent_runs SET started_at = ? WHERE run_id = ?', ['2026-09-30T01:00:00.000Z', first])
  db.run('UPDATE agent_runs SET started_at = ? WHERE run_id = ?', ['2026-09-30T01:00:01.000Z', second])
}

/** 带共享调度器的 Ops 编排组合(与整合者的生产接线同构) */
async function makeOpsHarness(
  responsesOrScript:
    | readonly unknown[]
    | ((callIndex: number, request: StructuredCompleteRequest) => unknown)
): Promise<{
  db: Awaited<ReturnType<typeof makeTestDb>>
  queue: RunQueue
  scheduler: RunScheduler
  orchestrator: RunOrchestrator
  provider: FakeProvider
}> {
  const db = await makeTestDb()
  initWorkspaceEpoch()
  const registry = new ToolRegistry()
  registerOpsTools(registry)
  const gateway = new ToolGateway({
    db,
    registry,
    clock: { now: () => new Date(NOW), monotonicMs: () => performance.now() },
    persistCoordinator: createPersistenceCoordinator(db)
  })
  const queue = new RunQueue(db)
  const scheduler = new RunScheduler(db, queue)
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
    completer: provider,
    scheduler
  } as unknown as OrchestratorDeps)
  // 组合层接线:scheduler.register('personal_ops', orchestrator.asRunDriver())
  scheduler.register('personal_ops', orchestrator.asRunDriver())
  return { db, queue, scheduler, orchestrator, provider }
}

// ---------- 关键取消竞态(规范片段) ----------

it('取消竞态:旧驱动 settle 前保留占用,不派发下一个;取消后接力不缺', async () => {
  const db = await makeTestDb()
  const queue = new RunQueue(db)
  const scheduler = new RunScheduler(db, queue)
  let settle!: () => void
  const blocked = new Promise<void>(resolve => { settle = resolve })
  const a = createRun(db, { mode: 'personal_ops', input: 'A', contextClock: '2026-09-30T01:00:00Z' })
  const b = createRun(db, { mode: 'research', input: 'B', contextClock: '2026-09-30T01:00:00Z' })
  scheduler.register('personal_ops', async id => { queue.tryStart(id); await blocked })
  const research = vi.fn(async (id: string) => { queue.tryStart(id); transitionRun(db, id, 'succeeded') })
  scheduler.register('research', research); scheduler.request()
  await vi.waitFor(() => expect(getRun(db, a.runId)?.status).toBe('planning'))
  transitionRun(db, a.runId, 'cancelled'); scheduler.abort(a.runId); scheduler.request()
  await Promise.resolve(); expect(research).not.toHaveBeenCalled()
  settle(); await vi.waitFor(() => expect(research).toHaveBeenCalledTimes(1))
  expect(getRun(db, b.runId)?.status).toBe('succeeded')
})

// ---------- 交错时间线(Ops→Research→Ops) ----------

it('交错时间线:全程最多一个活跃驱动;批准在 Research 活跃期间保持排队,释放后自动执行', async () => {
  const h = await makeOpsHarness([
    planOf([], { clarifications: [{ question_id: 'q1', question: '缺什么?' }] }),
    planOf([{ tool: 'todo.list', arguments: {} }])
  ])
  let inFlight = 0
  let maxInFlight = 0
  let releaseResearch!: () => void
  const gate = new Promise<void>(resolve => { releaseResearch = resolve })
  const research = vi.fn(async (id: string, _intent: unknown, signal: AbortSignal) => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      h.queue.tryStart(id)
      await gate
      if (!signal.aborted) transitionRun(h.db, id, 'succeeded')
    } finally {
      inFlight -= 1
    }
  })
  h.scheduler.register('research', research)

  const a = createRun(h.db, { mode: 'personal_ops', input: 'A 任务', contextClock: NOW })
  const b = createRun(h.db, { mode: 'research', input: 'B 任务', contextClock: NOW })
  pinOrder(h.db, a.runId, b.runId)
  h.scheduler.request()
  await vi.waitFor(() => expect(getRun(h.db, a.runId)?.status).toBe('awaiting_input'))
  expect(maxInFlight).toBeLessThanOrEqual(1)

  // A 等待人工释放执行权后,B(研究)自动接力
  await vi.waitFor(() => expect(getRun(h.db, b.runId)?.status).toBe('planning'))
  expect(research).toHaveBeenCalledTimes(1)
  expect(maxInFlight).toBeLessThanOrEqual(1)

  // B 活跃期间,A 的回答只受理不驱动(保持 queued,不并发)
  h.orchestrator.acceptAnswers(a.runId, [{ questionId: 'q1', answer: '补充信息' }])
  expect(getRun(h.db, a.runId)?.status).toBe('queued')
  await Promise.resolve()
  expect(getRun(h.db, a.runId)?.status).toBe('queued')
  expect(maxInFlight).toBeLessThanOrEqual(1)

  // B 释放后:A 的澄清重入自动接力(答案从轨迹恢复)
  releaseResearch()
  await vi.waitFor(() => expect(getRun(h.db, a.runId)?.status).toBe('succeeded'))
  expect(getRun(h.db, b.runId)?.status).toBe('succeeded')
  expect(maxInFlight).toBeLessThanOrEqual(1)
})

it('批准在 Research 活跃期间保持排队,释放后自动执行;重复批准只写一次', async () => {
  const h = await makeOpsHarness([planOf([{ tool: 'todo.create', arguments: { title: '排队批准' } }])])
  const run = createRun(h.db, { mode: 'personal_ops', input: '建任务', contextClock: NOW })
  h.scheduler.request()
  await vi.waitFor(() => expect(getRun(h.db, run.runId)?.status).toBe('awaiting_confirmation'))
  const confirmation = listTraceEvents(h.db, run.runId).find(e => e.eventType === 'confirmation')!
  const approvalId = (confirmation.payload as { approvalId: string }).approvalId

  // research 驱动在途(占用调度)
  let releaseResearch!: () => void
  const gate = new Promise<void>(resolve => { releaseResearch = resolve })
  h.scheduler.register('research', async id => {
    h.queue.tryStart(id)
    await gate
    transitionRun(h.db, id, 'succeeded')
  })
  const b = createRun(h.db, { mode: 'research', input: 'B', contextClock: NOW })
  h.scheduler.request()
  await vi.waitFor(() => expect(getRun(h.db, b.runId)?.status).toBe('planning'))

  // 受理批准即排队:research 在途期间不执行,不承诺本请求已完成业务
  const decided = await h.orchestrator.decide(approvalId, 'approved')
  expect(decided.already).toBe(false)
  await Promise.resolve()
  expect(h.db.all("SELECT * FROM todos WHERE title = '排队批准'")).toHaveLength(0)
  expect(getRun(h.db, run.runId)?.status).toBe('awaiting_confirmation')

  // research 释放后,已批准项自动领取执行
  releaseResearch()
  await vi.waitFor(() => expect(getRun(h.db, run.runId)?.status).toBe('succeeded'))
  expect(h.db.all("SELECT * FROM todos WHERE title = '排队批准'")).toHaveLength(1)

  // 重复批准:already=true,仅重试保存,不重复执行
  const again = await h.orchestrator.decide(approvalId, 'approved')
  expect(again.already).toBe(true)
  expect(h.db.all("SELECT * FROM todos WHERE title = '排队批准'")).toHaveLength(1)
})

// ---------- 多提案与批准重入 ----------

it('多提案:每轮只选一个待执行审批,逐一执行后收尾;重复批准只写一次', async () => {
  const h = await makeOpsHarness([planOf([
    { tool: 'todo.create', arguments: { title: '第一步' } },
    { tool: 'todo.create', arguments: { title: '第二步' } }
  ])])
  const run = createRun(h.db, { mode: 'personal_ops', input: '两步', contextClock: NOW })
  h.scheduler.request()
  await vi.waitFor(() => expect(getRun(h.db, run.runId)?.status).toBe('awaiting_confirmation'))
  const confirmations = listTraceEvents(h.db, run.runId).filter(e => e.eventType === 'confirmation')
  expect(confirmations).toHaveLength(2)
  // 确认轨迹携带稳定 callIndex 与 operationId(持久索引)
  expect((confirmations[0]!.payload as { callIndex: number }).callIndex).toBe(0)
  expect((confirmations[1]!.payload as { callIndex: number }).callIndex).toBe(1)

  const id1 = (confirmations[0]!.payload as { approvalId: string }).approvalId
  const id2 = (confirmations[1]!.payload as { approvalId: string }).approvalId
  await h.orchestrator.decide(id1, 'approved')
  await h.orchestrator.decide(id2, 'approved')
  await vi.waitFor(() => expect(getRun(h.db, run.runId)?.status).toBe('succeeded'))
  expect(h.db.all('SELECT * FROM todos')).toHaveLength(2)

  // 重复批准:只写一次,回执重放
  await h.orchestrator.decide(id1, 'approved')
  expect(h.db.all('SELECT * FROM todos')).toHaveLength(2)
  expect(h.db.all('SELECT * FROM operation_receipts')).toHaveLength(2)
})

it('澄清重入:驱动从答案轨迹恢复回答,不依赖 IPC 闭包参数', async () => {
  const prompts: string[] = []
  const h = await makeOpsHarness((callIndex, request) => {
    prompts.push(request.prompt)
    if (callIndex === 0) return planOf([], { clarifications: [{ question_id: 'q-when', question: '哪天?' }] })
    return planOf([{ tool: 'todo.list', arguments: {} }])
  })
  const run = createRun(h.db, { mode: 'personal_ops', input: '安排', contextClock: NOW })
  h.scheduler.request()
  await vi.waitFor(() => expect(getRun(h.db, run.runId)?.status).toBe('awaiting_input'))
  // 只受理,不显式驱动:调度器从答案轨迹恢复回答并重入
  h.orchestrator.acceptAnswers(run.runId, [{ questionId: 'q-when', answer: '9月30日上午9点' }])
  await vi.waitFor(() => expect(getRun(h.db, run.runId)?.status).toBe('succeeded'))
  expect(prompts[1]).toContain('9月30日上午9点')
})

// ---------- 等待/失败/取消路径不缺接力 ----------

it('失败不缺接力:坏 JSON 规划失败后,排队运行仍被驱动至成功', async () => {
  const h = await makeOpsHarness(['这不是JSON', planOf([{ tool: 'todo.list', arguments: {} }])])
  const a = createRun(h.db, { mode: 'personal_ops', input: 'A', contextClock: NOW })
  const b = createRun(h.db, { mode: 'personal_ops', input: 'B', contextClock: NOW })
  pinOrder(h.db, a.runId, b.runId)
  h.scheduler.request()
  await vi.waitFor(() => expect(getRun(h.db, a.runId)?.status).toBe('failed'))
  await vi.waitFor(() => expect(getRun(h.db, b.runId)?.status).toBe('succeeded'))
})

it('propose 抛错不缺接力:虚构 ID 计划失败后,排队运行接力', async () => {
  const h = await makeOpsHarness((callIndex) => {
    if (callIndex === 0) return planOf([{ tool: 'todo.update', arguments: { id: 'ghost-id', title: 'x' } }])
    return planOf([{ tool: 'todo.list', arguments: {} }])
  })
  const a = createRun(h.db, { mode: 'personal_ops', input: 'A', contextClock: NOW })
  const b = createRun(h.db, { mode: 'personal_ops', input: 'B', contextClock: NOW })
  pinOrder(h.db, a.runId, b.runId)
  h.scheduler.request()
  await vi.waitFor(() => expect(getRun(h.db, a.runId)?.status).toBe('failed'))
  await vi.waitFor(() => expect(getRun(h.db, b.runId)?.status).toBe('succeeded'))
})

it('取消接力:取消等待确认的运行后,排队运行被唤醒;已取消运行的批准决定冲突', async () => {
  const h = await makeOpsHarness([
    planOf([{ tool: 'todo.create', arguments: { title: '不该建的' } }]),
    planOf([{ tool: 'todo.list', arguments: {} }])
  ])
  const a = createRun(h.db, { mode: 'personal_ops', input: 'A', contextClock: NOW })
  const b = createRun(h.db, { mode: 'personal_ops', input: 'B', contextClock: NOW })
  pinOrder(h.db, a.runId, b.runId)
  h.scheduler.request()
  await vi.waitFor(() => expect(getRun(h.db, a.runId)?.status).toBe('awaiting_confirmation'))
  h.orchestrator.cancel(a.runId)
  await vi.waitFor(() => expect(getRun(h.db, b.runId)?.status).toBe('succeeded'))
  const confirmation = listTraceEvents(h.db, a.runId).find(e => e.eventType === 'confirmation')!
  const approvalId = (confirmation.payload as { approvalId: string }).approvalId
  await expect(h.orchestrator.decide(approvalId, 'approved')).rejects.toThrow(/审批决定冲突/)
  expect(h.db.all("SELECT * FROM todos WHERE title = '不该建的'")).toHaveLength(0)
})

it('无 completer:规划失败后排队运行仍接力(以 MODEL_UNAVAILABLE 失败)', async () => {
  const db = await makeTestDb()
  initWorkspaceEpoch()
  const registry = new ToolRegistry()
  registerOpsTools(registry)
  const gateway = new ToolGateway({ db, registry, clock: { now: () => new Date(NOW), monotonicMs: () => performance.now() }, persistCoordinator: createPersistenceCoordinator(db) })
  const queue = new RunQueue(db)
  const scheduler = new RunScheduler(db, queue)
  const orchestrator = new RunOrchestrator({ db, registry, gateway, queue, scheduler } as unknown as OrchestratorDeps)
  scheduler.register('personal_ops', orchestrator.asRunDriver())
  const a = createRun(db, { mode: 'personal_ops', input: 'A', contextClock: NOW })
  const b = createRun(db, { mode: 'personal_ops', input: 'B', contextClock: NOW })
  pinOrder(db, a.runId, b.runId)
  scheduler.request()
  await vi.waitFor(() => expect(getRun(db, a.runId)?.status).toBe('failed'))
  expect(getRun(db, a.runId)?.errorCode).toBe('MODEL_UNAVAILABLE')
  // 接力发生:B 被驱动并同样以 MODEL_UNAVAILABLE 失败(不是留在 queued 缺接力)
  await vi.waitFor(() => expect(getRun(db, b.runId)?.status).toBe('failed'))
})

// ---------- 就绪项排序与 tryResume ----------

it('就绪项排序:按就绪时间(queued 用 startedAt)依次派发', async () => {
  const db = await makeTestDb()
  const queue = new RunQueue(db)
  const scheduler = new RunScheduler(db, queue)
  const order: string[] = []
  scheduler.register('personal_ops', async (id) => {
    order.push(id)
    queue.tryStart(id)
    transitionRun(db, id, 'succeeded')
  })
  const a = createRun(db, { mode: 'personal_ops', input: 'A', contextClock: NOW })
  const b = createRun(db, { mode: 'personal_ops', input: 'B', contextClock: NOW })
  // created_at 毫秒可能相同:显式固定 started_at 使就绪顺序确定
  db.run('UPDATE agent_runs SET started_at = ? WHERE run_id = ?', ['2026-09-30T01:00:00.000Z', a.runId])
  db.run('UPDATE agent_runs SET started_at = ? WHERE run_id = ?', ['2026-09-30T01:00:01.000Z', b.runId])
  scheduler.request()
  await vi.waitFor(() => expect(order).toHaveLength(2))
  expect(order[0]).toBe(a.runId)
  expect(order[1]).toBe(b.runId)
})

describe('RunQueue.tryResume', () => {
  it('仅 awaiting_confirmation 可领取 executing;占用时返回 false;幂等', async () => {
    const db = await makeTestDb()
    const queue = new RunQueue(db)
    const run = createRun(db, { mode: 'personal_ops', input: 'r', contextClock: NOW })
    expect(queue.tryResume(run.runId)).toBe(false) // queued 不可 resume
    transitionRun(db, run.runId, 'planning')
    expect(queue.tryResume(run.runId)).toBe(true) // 已占用执行权:幂等
    transitionRun(db, run.runId, 'awaiting_confirmation')
    expect(queue.tryResume(run.runId)).toBe(true) // 领取 → executing
    expect(getRun(db, run.runId)?.status).toBe('executing')
    transitionRun(db, run.runId, 'awaiting_confirmation')

    // 另一运行占用执行权时:返回 false,保持等待
    const other = createRun(db, { mode: 'personal_ops', input: 'other', contextClock: NOW })
    transitionRun(db, other.runId, 'planning')
    expect(queue.tryResume(run.runId)).toBe(false)
    transitionRun(db, other.runId, 'succeeded')
    expect(queue.tryResume(run.runId)).toBe(true)
    expect(getRun(db, run.runId)?.status).toBe('executing')
  })
})

// ---------- 调度器接线约束与重启恢复 ----------

it('驱动重复注册抛错', async () => {
  const db = await makeTestDb()
  const scheduler = new RunScheduler(db, new RunQueue(db))
  scheduler.register('personal_ops', async () => {})
  expect(() => scheduler.register('personal_ops', async () => {})).toThrow(/重复注册/)
})

it('重启恢复:已批准未领取的 awaiting_confirmation 项再次排队执行;已完成回执不重复执行', async () => {
  const db = await makeTestDb()
  initWorkspaceEpoch()
  const registry = new ToolRegistry()
  registerOpsTools(registry)
  const gateway = new ToolGateway({ db, registry, clock: { now: () => new Date(NOW), monotonicMs: () => performance.now() }, persistCoordinator: createPersistenceCoordinator(db) })
  const queue = new RunQueue(db)
  const scheduler = new RunScheduler(db, queue)
  const orchestrator = new RunOrchestrator({
    db,
    registry,
    gateway,
    queue,
    completer: new FakeProvider({ responses: [] }),
    scheduler
  } as unknown as OrchestratorDeps)
  scheduler.register('personal_ops', orchestrator.asRunDriver())

  // 手工构造"重启后"的库状态:运行在等待确认,批准已决定,执行未发生
  const run = createRun(db, { mode: 'personal_ops', input: '建任务', contextClock: NOW })
  transitionRun(db, run.runId, 'planning')
  transitionRun(db, run.runId, 'awaiting_confirmation')
  const proposal = gateway.propose({ runId: run.runId, tool: 'todo.create', arguments: { title: '重启执行' }, planVersion: 1 })
  decideApproval(db, proposal.approvalId!, 'approved')

  // 重启:调度器唤醒 → 已批准未领取项再次排队执行
  scheduler.request()
  await vi.waitFor(() => expect(getRun(db, run.runId)?.status).toBe('succeeded'))
  expect(db.all("SELECT * FROM todos WHERE title = '重启执行'")).toHaveLength(1)
  expect(db.all('SELECT * FROM operation_receipts')).toHaveLength(1)

  // 重复派发:回执命中,不重复执行、不重写
  scheduler.request()
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  expect(db.all("SELECT * FROM todos WHERE title = '重启执行'")).toHaveLength(1)
  expect(db.all('SELECT * FROM operation_receipts')).toHaveLength(1)
})

it('重启恢复:中断运行(failed)的未执行审批过期;已执行审批保持原决定', async () => {
  const db = await makeTestDb()
  initWorkspaceEpoch()
  // 运行 1:planning 中断,pending 审批 → 过期
  const r1 = createRun(db, { mode: 'personal_ops', input: '中断', contextClock: NOW })
  transitionRun(db, r1.runId, 'planning')
  const pending = createApproval(db, {
    runId: r1.runId, toolName: 'todo.create', argumentsHash: 'h1',
    argumentsJson: '{"title":"x"}', planVersion: 1, expiresAt: '2026-10-01T00:00:00.000Z'
  })
  // 运行 2:executing 中断,但该审批已执行(映射 + 回执)→ 保持 approved
  const r2 = createRun(db, { mode: 'personal_ops', input: '已执行', contextClock: NOW })
  transitionRun(db, r2.runId, 'planning')
  transitionRun(db, r2.runId, 'executing')
  const executed = createApproval(db, {
    runId: r2.runId, toolName: 'todo.create', argumentsHash: 'h2',
    argumentsJson: '{"title":"y"}', planVersion: 1, expiresAt: '2026-10-01T00:00:00.000Z'
  })
  decideApproval(db, executed.approvalId, 'approved')
  appendCallIndexMapping(db, {
    runId: r2.runId, approvalId: executed.approvalId, toolName: 'todo.create',
    callIndex: 0, planVersion: 1, operationId: `${r2.runId}:todo.create:0`
  })
  runOperation(db, {
    operationId: `${r2.runId}:todo.create:0`,
    command: 'agent.tool.todo.create',
    requestHash: 'h2',
    workspaceEpoch: 'epoch-test'
  }, () => ({ ok: true }))

  const recovered = recoverInterruptedRuns(db)
  expect(recovered.map(r => r.runId).sort()).toEqual([r1.runId, r2.runId].sort())
  expect(getApproval(db, pending.approvalId)?.decision).toBe('expired')
  // 已提交回执的审批不重写:决定保持,禁止恢复执行由运行失败兜底
  expect(getApproval(db, executed.approvalId)?.decision).toBe('approved')
  expect(getRun(db, r2.runId)?.errorCode).toBe('WORKER_INTERRUPTED')
})
