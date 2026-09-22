import { describe, expect, it } from 'vitest'
import { makeTestDb } from '../helpers'
import { RUN_STATUSES, type RunStatus } from '../../src/shared/agent'
import { assertTransition, canReach, canTransition, allowedTransitions } from '../../src/main/agent/stateMachine'
import { RunQueue } from '../../src/main/agent/runQueue'
import { WORKER_INTERRUPTED, recoverInterruptedRuns } from '../../src/main/agent/recovery'
import {
  appendTraceEvent,
  createApproval,
  createRun,
  decideApproval,
  expireStaleApprovals,
  getApproval,
  getRun,
  listApprovals,
  listRunsByStatus,
  listTraceEvents,
  pendingApprovals,
  transitionRun
} from '../../src/main/runs/repository'
import type { SqliteDb } from '../../src/main/db/connection'

// C-03:运行状态机、仓库与显式运行队列。
// 三组最要紧的断言:非法转移不写库、seq 从 1 连续、同一时刻只有一个运行在执行。

const CLOCK = '2026-09-28T01:00:00.000Z'
const TERMINAL: readonly RunStatus[] = ['succeeded', 'partial', 'failed', 'cancelled']
const NON_TERMINAL: readonly RunStatus[] = RUN_STATUSES.filter(
  (s) => !(TERMINAL as readonly string[]).includes(s)
)

function makeRun(db: SqliteDb, input = '整理本周未完成的高优先级任务') {
  return createRun(db, { mode: 'personal_ops', input, contextClock: CLOCK })
}

describe('状态机', () => {
  it('终态没有出边', () => {
    for (const state of TERMINAL) {
      expect(allowedTransitions(state)).toEqual([])
    }
  })

  it('任何非终态都可以取消', () => {
    for (const state of NON_TERMINAL) {
      expect(canTransition(state, 'cancelled')).toBe(true)
    }
  })

  it('允许的关键转移', () => {
    expect(canTransition('queued', 'planning')).toBe(true)
    expect(canTransition('planning', 'awaiting_input')).toBe(true)
    expect(canTransition('planning', 'awaiting_confirmation')).toBe(true)
    expect(canTransition('planning', 'executing')).toBe(true)
    expect(canTransition('awaiting_input', 'queued')).toBe(true)
    expect(canTransition('awaiting_confirmation', 'executing')).toBe(true)
    expect(canTransition('executing', 'awaiting_confirmation')).toBe(true)
    expect(canTransition('executing', 'partial')).toBe(true)
  })

  it('拒绝的转移', () => {
    expect(canTransition('queued', 'executing')).toBe(false)
    expect(canTransition('queued', 'succeeded')).toBe(false)
    expect(canTransition('succeeded', 'executing')).toBe(false)
    expect(canTransition('cancelled', 'planning')).toBe(false)
    expect(canTransition('awaiting_confirmation', 'planning')).toBe(false)
  })

  it('同一状态之间的转移不算合法转移', () => {
    for (const state of RUN_STATUSES) {
      expect(canTransition(state, state)).toBe(false)
    }
  })

  it('assertTransition 对非法转移抛错', () => {
    expect(() => assertTransition('queued', 'planning')).not.toThrow()
    expect(() => assertTransition('succeeded', 'executing')).toThrow(/非法状态转移/)
  })

  it('canReach 支持多步可达判断', () => {
    expect(canReach('queued', 'succeeded')).toBe(true)
    expect(canReach('queued', 'partial')).toBe(true)
    expect(canReach('succeeded', 'planning')).toBe(false)
    expect(canReach('failed', 'failed')).toBe(true)
  })
})

describe('运行仓库', () => {
  it('创建运行:初始状态为 queued,生成 runId', async () => {
    const db = await makeTestDb()
    const run = makeRun(db)
    expect(run.status).toBe('queued')
    expect(run.runId.length).toBeGreaterThan(0)
    expect(run.finishedAt).toBeNull()
    expect(getRun(db, run.runId)?.input).toBe('整理本周未完成的高优先级任务')
  })

  it('创建运行拒绝空输入与非法 mode', async () => {
    const db = await makeTestDb()
    expect(() => createRun(db, { mode: 'personal_ops', input: '   ', contextClock: CLOCK })).toThrow(/不能为空/)
    expect(() =>
      createRun(db, { mode: 'ops' as never, input: 'x', contextClock: CLOCK })
    ).toThrow(/mode 非法/)
  })

  it('未知运行返回 null', async () => {
    const db = await makeTestDb()
    expect(getRun(db, 'no-such-run')).toBeNull()
  })

  it('合法转移更新状态;进入终态时写入 finished_at', async () => {
    const db = await makeTestDb()
    const run = makeRun(db)
    const planning = transitionRun(db, run.runId, 'planning')
    expect(planning.status).toBe('planning')
    expect(planning.finishedAt).toBeNull()

    const done = transitionRun(db, run.runId, 'succeeded', { resultRef: 'result-1' })
    expect(done.status).toBe('succeeded')
    expect(done.resultRef).toBe('result-1')
    expect(done.finishedAt).not.toBeNull()
  })

  it('非法转移抛错且不写库', async () => {
    const db = await makeTestDb()
    const run = makeRun(db)
    expect(() => transitionRun(db, run.runId, 'executing')).toThrow(/非法状态转移/)
    expect(getRun(db, run.runId)?.status).toBe('queued')
  })

  it('未知运行转移抛错', async () => {
    const db = await makeTestDb()
    expect(() => transitionRun(db, 'ghost', 'planning')).toThrow(/运行不存在/)
  })

  it('按状态列出运行,按开始时间升序', async () => {
    const db = await makeTestDb()
    const a = makeRun(db, '第一个')
    const b = makeRun(db, '第二个')
    const queued = listRunsByStatus(db, 'queued')
    expect(queued.map((r) => r.runId)).toEqual([a.runId, b.runId])
  })

  it('库层拒绝非法状态值(CHECK 约束)', async () => {
    const db = await makeTestDb()
    const run = makeRun(db)
    expect(() => db.run("UPDATE agent_runs SET status = 'running' WHERE run_id = ?", [run.runId])).toThrow()
  })
})

describe('轨迹事件', () => {
  it('seq 从 1 连续递增', async () => {
    const db = await makeTestDb()
    const run = makeRun(db)
    expect(appendTraceEvent(db, { runId: run.runId, eventType: 'input' }).seq).toBe(1)
    expect(appendTraceEvent(db, { runId: run.runId, eventType: 'plan' }).seq).toBe(2)
    expect(appendTraceEvent(db, { runId: run.runId, eventType: 'output' }).seq).toBe(3)
    expect(listTraceEvents(db, run.runId).map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('不同运行的 seq 各自从 1 开始', async () => {
    const db = await makeTestDb()
    const a = makeRun(db)
    const b = makeRun(db)
    appendTraceEvent(db, { runId: a.runId, eventType: 'input' })
    expect(appendTraceEvent(db, { runId: b.runId, eventType: 'input' }).seq).toBe(1)
  })

  it('afterSeq 用于按 seq 补发缺失事件', async () => {
    const db = await makeTestDb()
    const run = makeRun(db)
    for (const t of ['input', 'retrieval', 'plan', 'output'] as const) {
      appendTraceEvent(db, { runId: run.runId, eventType: t })
    }
    expect(listTraceEvents(db, run.runId, 2).map((e) => e.seq)).toEqual([3, 4])
    expect(listTraceEvents(db, run.runId, 4)).toEqual([])
  })

  it('payload 往返一致,未提供的字段为 null', async () => {
    const db = await makeTestDb()
    const run = makeRun(db)
    const event = appendTraceEvent(db, {
      runId: run.runId,
      eventType: 'tool_call',
      payload: { tool: 'todo.list', count: 3 }
    })
    expect(event.durationMs).toBeNull()
    expect(event.tokenUsage).toBeNull()
    const [read] = listTraceEvents(db, run.runId)
    expect(read?.payload).toEqual({ tool: 'todo.list', count: 3 })
    expect(read?.schemaVersion).toBe(1)
  })

  it('供应商未返回用量时记 null 而非 0', async () => {
    const db = await makeTestDb()
    const run = makeRun(db)
    appendTraceEvent(db, {
      runId: run.runId,
      eventType: 'model',
      tokenUsage: { inputTokens: null, outputTokens: null, totalTokens: null, source: null }
    })
    const [read] = listTraceEvents(db, run.runId)
    expect(read?.tokenUsage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, source: null })
    expect(read?.tokenUsage?.inputTokens).not.toBe(0)
  })

  it('用量与耗时往返一致', async () => {
    const db = await makeTestDb()
    const run = makeRun(db)
    appendTraceEvent(db, {
      runId: run.runId,
      eventType: 'model',
      durationMs: 812,
      tokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, source: 'provider' }
    })
    const [read] = listTraceEvents(db, run.runId)
    expect(read?.durationMs).toBe(812)
    expect(read?.tokenUsage?.totalTokens).toBe(120)
  })

  it('未知运行追加事件抛错', async () => {
    const db = await makeTestDb()
    expect(() => appendTraceEvent(db, { runId: 'ghost', eventType: 'input' })).toThrow(/运行不存在/)
  })

  it('库层拒绝 seq 小于 1 与非法事件类型', async () => {
    const db = await makeTestDb()
    const run = makeRun(db)
    expect(() =>
      db.run(
        "INSERT INTO trace_events (run_id, seq, event_type, schema_version, payload, created_at) VALUES (?, 0, 'input', 1, '{}', 'x')",
        [run.runId]
      )
    ).toThrow()
    expect(() =>
      db.run(
        "INSERT INTO trace_events (run_id, seq, event_type, schema_version, payload, created_at) VALUES (?, 1, 'telemetry', 1, '{}', 'x')",
        [run.runId]
      )
    ).toThrow()
  })

  it('库层拒绝同一运行内重复 seq(复合主键)', async () => {
    const db = await makeTestDb()
    const run = makeRun(db)
    appendTraceEvent(db, { runId: run.runId, eventType: 'input' })
    expect(() =>
      db.run(
        "INSERT INTO trace_events (run_id, seq, event_type, schema_version, payload, created_at) VALUES (?, 1, 'plan', 1, '{}', 'x')",
        [run.runId]
      )
    ).toThrow()
  })
})

describe('审批记录', () => {
  it('创建审批:初始 pending,无决策时间', async () => {
    const db = await makeTestDb()
    const run = makeRun(db)
    const approval = createApproval(db, {
      runId: run.runId,
      toolName: 'calendar.create_event',
      argumentsHash: 'hash-1',
      planVersion: 1,
      targetVersion: null,
      expiresAt: '2026-09-29T01:00:00.000Z'
    })
    expect(approval.decision).toBe('pending')
    expect(approval.decidedAt).toBeNull()
    expect(getApproval(db, approval.approvalId)?.argumentsHash).toBe('hash-1')
    expect(pendingApprovals(db, run.runId)).toHaveLength(1)
  })

  it('planVersion 必须是不小于 1 的整数', async () => {
    const db = await makeTestDb()
    const run = makeRun(db)
    expect(() =>
      createApproval(db, {
        runId: run.runId,
        toolName: 'todo.create',
        argumentsHash: 'h',
        planVersion: 0,
        expiresAt: 'x'
      })
    ).toThrow(/planVersion/)
  })

  it('条件更新:只有仍为 pending 的记录会被改写', async () => {
    const db = await makeTestDb()
    const run = makeRun(db)
    const approval = createApproval(db, {
      runId: run.runId,
      toolName: 'todo.create',
      argumentsHash: 'h',
      planVersion: 1,
      expiresAt: '2026-09-29T01:00:00.000Z'
    })

    expect(decideApproval(db, approval.approvalId, 'approved', '2026-09-28T02:00:00.000Z')).toBe(true)
    // 第二次决策不再生效(记录已不是 pending)
    expect(decideApproval(db, approval.approvalId, 'rejected', '2026-09-28T03:00:00.000Z')).toBe(false)
    const after = getApproval(db, approval.approvalId)
    expect(after?.decision).toBe('approved')
    expect(after?.decidedAt).toBe('2026-09-28T02:00:00.000Z')
  })

  it('未知审批决策抛错', async () => {
    const db = await makeTestDb()
    expect(() => decideApproval(db, 'ghost', 'approved')).toThrow(/审批记录不存在/)
  })

  it('过期扫描只改状态并保留记录', async () => {
    const db = await makeTestDb()
    const run = makeRun(db)
    const stale = createApproval(db, {
      runId: run.runId,
      toolName: 'todo.create',
      argumentsHash: 'h1',
      planVersion: 1,
      expiresAt: '2026-09-28T00:00:00.000Z'
    })
    const fresh = createApproval(db, {
      runId: run.runId,
      toolName: 'todo.update',
      argumentsHash: 'h2',
      planVersion: 1,
      expiresAt: '2026-09-30T00:00:00.000Z'
    })

    const expired = expireStaleApprovals(db, '2026-09-28T01:00:00.000Z')
    expect(expired).toBe(1)
    expect(getApproval(db, stale.approvalId)?.decision).toBe('expired')
    expect(getApproval(db, fresh.approvalId)?.decision).toBe('pending')
    // 记录保留,不删除
    expect(listApprovals(db, run.runId)).toHaveLength(2)
    expect(pendingApprovals(db, run.runId)).toHaveLength(1)
  })

  it('库层拒绝非法决策值(CHECK 约束)', async () => {
    const db = await makeTestDb()
    const run = makeRun(db)
    const approval = createApproval(db, {
      runId: run.runId,
      toolName: 'todo.create',
      argumentsHash: 'h',
      planVersion: 1,
      expiresAt: 'x'
    })
    expect(() =>
      db.run("UPDATE approvals SET decision = 'maybe' WHERE approval_id = ?", [approval.approvalId])
    ).toThrow()
  })
})

describe('显式运行队列', () => {
  it('空队列不忙,可启动第一个运行(queued → planning)', async () => {
    const db = await makeTestDb()
    const queue = new RunQueue(db)
    const run = makeRun(db)
    expect(queue.isBusy()).toBe(false)
    expect(queue.tryStart(run.runId)).toBe(true)
    expect(getRun(db, run.runId)?.status).toBe('planning')
    expect(queue.currentActive()?.runId).toBe(run.runId)
  })

  it('同一时刻只有一个运行占用执行权:第二个运行排队', async () => {
    const db = await makeTestDb()
    const queue = new RunQueue(db)
    const first = makeRun(db, '第一个')
    const second = makeRun(db, '第二个')

    expect(queue.tryStart(first.runId)).toBe(true)
    expect(queue.tryStart(second.runId)).toBe(false)
    expect(getRun(db, second.runId)?.status).toBe('queued')
    expect(queue.depth()).toBe(2)
  })

  it('对已占用执行权的运行重复调用 tryStart 是幂等的', async () => {
    const db = await makeTestDb()
    const queue = new RunQueue(db)
    const run = makeRun(db)
    expect(queue.tryStart(run.runId)).toBe(true)
    expect(queue.tryStart(run.runId)).toBe(true)
    expect(queue.depth()).toBe(1)
  })

  it('等待人工输入或确认时释放执行权,不堵住队列', async () => {
    const db = await makeTestDb()
    const queue = new RunQueue(db)
    const first = makeRun(db, '第一个')
    const second = makeRun(db, '第二个')

    queue.tryStart(first.runId)
    expect(queue.isBusy()).toBe(true)

    // 第一个运行进入等待确认(等人工,不计入 active time)
    transitionRun(db, first.runId, 'awaiting_confirmation')
    expect(queue.isBusy()).toBe(false)
    // 队列因此可以启动第二个
    expect(queue.tryStart(second.runId)).toBe(true)

    // 第一个运行获批后重新占用执行权时,第二个必须先让出
    transitionRun(db, second.runId, 'executing')
    transitionRun(db, first.runId, 'executing')
    expect(() => queue.currentActive()).toThrow(/队列不变量被破坏/)
  })

  it('运行进入终态后执行权自然释放', async () => {
    const db = await makeTestDb()
    const queue = new RunQueue(db)
    const run = makeRun(db)
    queue.tryStart(run.runId)
    transitionRun(db, run.runId, 'succeeded')
    expect(queue.isBusy()).toBe(false)
    expect(queue.depth()).toBe(0)
  })

  it('nextQueued 按入队顺序返回,空队列返回 null', async () => {
    const db = await makeTestDb()
    const queue = new RunQueue(db)
    expect(queue.nextQueued()).toBeNull()

    const first = makeRun(db, '第一个')
    const second = makeRun(db, '第二个')
    expect(queue.nextQueued()?.runId).toBe(first.runId)
    queue.tryStart(first.runId)
    expect(queue.nextQueued()?.runId).toBe(second.runId)
  })

  it('未知运行 tryStart 抛错', async () => {
    const db = await makeTestDb()
    expect(() => new RunQueue(db).tryStart('ghost')).toThrow(/运行不存在/)
  })

  it('同时存在两个占用执行权的运行时暴露不变量破坏', async () => {
    const db = await makeTestDb()
    const queue = new RunQueue(db)
    makeRun(db, 'a')
    makeRun(db, 'b')
    // 绕过队列直接改库,模拟"队列语义被绕过"
    db.run("UPDATE agent_runs SET status = 'executing'")
    expect(() => queue.currentActive()).toThrow(/队列不变量被破坏/)
  })
})

describe('启动恢复', () => {
  it('把失去执行者的运行标记为 failed + WORKER_INTERRUPTED', async () => {
    const db = await makeTestDb()
    const queue = new RunQueue(db)
    const planning = makeRun(db, '规划中')
    const executing = makeRun(db, '执行中')
    const untouched = makeRun(db, '排队中')

    queue.tryStart(planning.runId)
    transitionRun(db, executing.runId, 'planning')
    transitionRun(db, executing.runId, 'executing')

    const recovered = recoverInterruptedRuns(db)
    expect(recovered.map((r) => r.runId).sort()).toEqual([planning.runId, executing.runId].sort())
    for (const run of recovered) {
      expect(run.status).toBe('failed')
      expect(run.errorCode).toBe(WORKER_INTERRUPTED)
      expect(run.finishedAt).not.toBeNull()
    }
    // 排队中的运行不受影响
    expect(getRun(db, untouched.runId)?.status).toBe('queued')
    expect(queue.isBusy()).toBe(false)
  })

  it('等待人工的运行不被当作中断(它们在等用户,不是失去执行者)', async () => {
    const db = await makeTestDb()
    const run = makeRun(db)
    transitionRun(db, run.runId, 'planning')
    transitionRun(db, run.runId, 'awaiting_confirmation')

    expect(recoverInterruptedRuns(db)).toEqual([])
    expect(getRun(db, run.runId)?.status).toBe('awaiting_confirmation')
  })

  it('终态运行不被改动', async () => {
    const db = await makeTestDb()
    const run = makeRun(db)
    transitionRun(db, run.runId, 'planning')
    transitionRun(db, run.runId, 'succeeded')
    expect(recoverInterruptedRuns(db)).toEqual([])
    expect(getRun(db, run.runId)?.status).toBe('succeeded')
  })

  it('无中断运行时返回空数组', async () => {
    const db = await makeTestDb()
    makeRun(db)
    expect(recoverInterruptedRuns(db)).toEqual([])
  })

  it('重复调用是幂等的', async () => {
    const db = await makeTestDb()
    const run = makeRun(db)
    transitionRun(db, run.runId, 'planning')
    expect(recoverInterruptedRuns(db)).toHaveLength(1)
    expect(recoverInterruptedRuns(db)).toEqual([])
  })
})
