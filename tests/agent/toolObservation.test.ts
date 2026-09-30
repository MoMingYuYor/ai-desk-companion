import { describe, expect, it } from 'vitest'
import { makeTestDb } from '../helpers'
import { createPersistenceCoordinator, getOperationReceipt, initWorkspaceEpoch } from '../../src/main/db/operations'
import { appendTraceEvent, createApproval, createRun, listTraceEvents } from '../../src/main/runs/repository'
import { appError } from '../../src/shared/operations'
import { ToolGateway } from '../../src/main/tools/gateway'
import { ToolRegistry } from '../../src/main/tools/registry'
import { toolFailure, toolSuccess, type ToolObservationV1 } from '../../src/main/tools/types'
import type { Clock } from '../../src/shared/clock'
import type { SqliteDb } from '../../src/main/db/connection'

// OPS-03:网关单一出口的观测契约(ToolObservationV1)。
// 七场景:成功 / 坏参数 / 审批缺失 / 工具业务错误 / 工具抛错 / 保存失败 / 回执重放。
// 断言真实参数、callIndex、审批引用与数据库一致;durationMs 用脚本化单调钟差值验证。

const NOW = '2026-09-28T01:00:00.000Z'

/** 脚本化时钟:领域时间冻结;单调钟按 50ms 步进,便于断言 durationMs 差值 */
function steppingClock(): Clock {
  let tick = 0
  return {
    now: () => new Date(NOW),
    monotonicMs: () => 100 + 50 * tick++
  }
}

interface Setup {
  db: SqliteDb
  gateway: ToolGateway
  observations: ToolObservationV1[]
  runId: string
  readCalls: () => number
  writeCalls: () => number
}

async function makeObservedGateway(options: { breakFlush?: boolean } = {}): Promise<Setup> {
  const db = await makeTestDb()
  initWorkspaceEpoch()
  const registry = new ToolRegistry()
  let readCount = 0
  let writeCount = 0
  registry.register({
    name: 'fixture.read',
    description: '测试读工具',
    riskLevel: 'read',
    timeoutMs: 1000,
    retryable: false,
    inputSchema: { fields: [{ name: 'query', type: 'string', required: true }] },
    execute: (args) => {
      readCount += 1
      return toolSuccess({ echoed: args.query, call: readCount })
    }
  })
  registry.register({
    name: 'fixture.write',
    description: '测试写工具',
    riskLevel: 'reversible_write',
    timeoutMs: 2000,
    retryable: true,
    inputSchema: { fields: [{ name: 'title', type: 'string', required: true }] },
    resolveTargetVersion: () => 3,
    execute: () => {
      writeCount += 1
      return toolSuccess({ done: true, call: writeCount })
    }
  })
  registry.register({
    name: 'fixture.bizfail',
    description: '业务失败读工具',
    riskLevel: 'read',
    timeoutMs: 1000,
    retryable: false,
    inputSchema: { fields: [] },
    execute: () => toolFailure(appError('VALIDATION', '业务规则不允许', { retryable: false }))
  })
  registry.register({
    name: 'fixture.boom',
    description: '抛错读工具',
    riskLevel: 'read',
    timeoutMs: 1000,
    retryable: false,
    inputSchema: { fields: [] },
    execute: () => {
      throw new Error('内部炸了')
    }
  })

  // 规范接线:观察先落 tool_call 轨迹(写库失败上抛),再交给内存收集
  const observations: ToolObservationV1[] = []
  const gateway = new ToolGateway({
    db,
    registry,
    clock: steppingClock(),
    persistCoordinator: createPersistenceCoordinator(db),
    onObservation: (record) => {
      observations.push(record)
      appendTraceEvent(db, {
        runId: record.runId,
        eventType: 'tool_call',
        payload: { ...record },
        durationMs: record.durationMs
      })
    }
  })
  if (options.breakFlush) {
    db.flush = () => {
      throw new Error('磁盘不可写')
    }
  }
  const run = createRun(db, { mode: 'personal_ops', input: '观测回归', contextClock: NOW })
  return { db, gateway, observations, runId: run.runId, readCalls: () => readCount, writeCalls: () => writeCount }
}

function toolPhase(observations: ToolObservationV1[]): ToolObservationV1 {
  const found = observations.find((o) => o.phase === 'tool')
  expect(found).toBeDefined()
  return found!
}

function persistPhase(observations: ToolObservationV1[]): ToolObservationV1 {
  const found = observations.find((o) => o.phase === 'persistence')
  expect(found).toBeDefined()
  return found!
}

describe('OPS-03 工具观测七场景', () => {
  it('1 成功:tool phase executed=true 在事务内(committed=false),persistence phase committed=true;轨迹与库一致', async () => {
    const { db, gateway, observations, runId } = await makeObservedGateway()
    const result = await gateway.execute({
      runId,
      tool: 'fixture.read',
      arguments: { query: 'x' },
      planVersion: 1,
      callIndex: 0
    })
    expect(result.ok).toBe(true)

    const tool = toolPhase(observations)
    expect(tool).toMatchObject({
      observationVersion: 1,
      runId,
      tool: 'fixture.read',
      callIndex: 0,
      operationId: `${runId}:fixture.read:0`,
      attempt: 1,
      planVersion: 1,
      phase: 'tool',
      riskLevel: 'read',
      attemptedArguments: { query: 'x' },
      arguments: { query: 'x' },
      approvalId: null,
      approvalDecision: null,
      approvalValidated: false,
      targetVersion: null,
      executed: true,
      replayed: false,
      committed: false,
      outcome: 'success',
      result: { echoed: 'x', call: 1 },
      error: null
    })
    const persist = persistPhase(observations)
    expect(persist).toMatchObject({
      operationId: `${runId}:fixture.read:0`,
      attempt: 1,
      phase: 'persistence',
      executed: false,
      replayed: false,
      committed: true,
      outcome: 'success'
    })
    // 单调钟差值:每步 50ms
    expect(tool.durationMs).toBe(50)
    expect(persist.durationMs).toBe(50)

    // 观察与库一致:两条 tool_call 轨迹,durationMs 写入事件列,schemaVersion 不变
    const events = listTraceEvents(db, runId).filter((e) => e.eventType === 'tool_call')
    expect(events).toHaveLength(2)
    expect(events[0]!.payload).toEqual({ ...tool })
    expect(events[0]!.durationMs).toBe(tool.durationMs)
    expect(events[0]!.schemaVersion).toBe(1)
    // 回执已在事务内提交
    expect(getOperationReceipt(db, `${runId}:fixture.read:0`)).toBeDefined()
  })

  it('2 坏参数:验证拒绝 arguments=null、attemptedArguments 保留原始输入;无回执', async () => {
    const { db, gateway, observations, runId } = await makeObservedGateway()
    await expect(
      gateway.execute({
        runId,
        tool: 'fixture.read',
        arguments: { query: 42, extra: true },
        planVersion: 1,
        callIndex: 0
      })
    ).rejects.toThrow(/未知字段|必须是字符串/)

    expect(observations).toHaveLength(1)
    const tool = toolPhase(observations)
    expect(tool).toMatchObject({
      phase: 'tool',
      outcome: 'gateway_error',
      executed: false,
      replayed: false,
      committed: false,
      arguments: null,
      attemptedArguments: { query: 42, extra: true },
      result: null
    })
    expect(tool.error?.code).toBe('VALIDATION')
    expect(tool.durationMs).toBeGreaterThan(0)
    // 验证拒绝不产生回执,不重复广播 persistence phase
    expect(getOperationReceipt(db, `${runId}:fixture.read:0`)).toBeUndefined()
    expect(observations.some((o) => o.phase === 'persistence')).toBe(false)
  })

  it('3 审批缺失:FORBIDDEN 拒绝,审批字段不采信调用方声明;无回执无执行', async () => {
    const { db, gateway, observations, runId } = await makeObservedGateway()
    await expect(
      gateway.execute({
        runId,
        tool: 'fixture.write',
        arguments: { title: 'x' },
        planVersion: 1,
        callIndex: 0
      })
    ).rejects.toThrow(/缺少审批记录/)

    const tool = toolPhase(observations)
    expect(tool).toMatchObject({
      phase: 'tool',
      riskLevel: 'reversible_write',
      outcome: 'gateway_error',
      executed: false,
      committed: false,
      arguments: { title: 'x' },
      approvalId: null,
      approvalDecision: null,
      approvalValidated: false,
      targetVersion: null,
      result: null
    })
    expect(tool.error?.code).toBe('FORBIDDEN')
    expect(getOperationReceipt(db, `${runId}:fixture.write:0`)).toBeUndefined()
  })

  it('4 工具业务错误:business_error 保留完整 AppError,回执已提交;保存 phase 成功', async () => {
    const { db, gateway, observations, runId } = await makeObservedGateway()
    const result = await gateway.execute({
      runId,
      tool: 'fixture.bizfail',
      arguments: {},
      planVersion: 1,
      callIndex: 0
    })
    expect(result.ok).toBe(false)

    const tool = toolPhase(observations)
    expect(tool).toMatchObject({
      phase: 'tool',
      outcome: 'business_error',
      executed: true,
      replayed: false,
      committed: false,
      result: null,
      error: { code: 'VALIDATION', message: '业务规则不允许', retryable: false }
    })
    // 业务失败已完成并写入回执:保存 phase 成功,committed=true
    const persist = persistPhase(observations)
    expect(persist).toMatchObject({ attempt: tool.attempt, committed: true, outcome: 'success', error: null })
    expect(getOperationReceipt(db, `${runId}:fixture.bizfail:0`)).toBeDefined()
  })

  it('5 工具抛错:apply 事务整体回滚,外层记录真实失败;重试分配新 attempt', async () => {
    const { db, gateway, observations, runId } = await makeObservedGateway()
    await expect(
      gateway.execute({ runId, tool: 'fixture.boom', arguments: {}, planVersion: 1, callIndex: 0 })
    ).rejects.toThrow('内部炸了')

    expect(observations).toHaveLength(1)
    const tool = toolPhase(observations)
    expect(tool).toMatchObject({
      phase: 'tool',
      outcome: 'gateway_error',
      executed: false,
      committed: false,
      result: null
    })
    expect(tool.error?.message).toContain('内部炸了')
    // 事务回滚:无回执、无 apply 内残留观察
    expect(getOperationReceipt(db, `${runId}:fixture.boom:0`)).toBeUndefined()
    const traceEvents = listTraceEvents(db, runId).filter((e) => e.eventType === 'tool_call')
    expect(traceEvents).toHaveLength(1)

    // 回滚的观察不占用 attempt:同 operationId 重试从已保存最大值+1
    await expect(
      gateway.execute({ runId, tool: 'fixture.boom', arguments: {}, planVersion: 1, callIndex: 0 })
    ).rejects.toThrow('内部炸了')
    expect(observations).toHaveLength(2)
    expect(observations[1]!.attempt).toBe(2)
    expect(observations[1]!.phase).toBe('tool')
  })

  it('6 保存失败:persistence phase 单列 persist_error 且 committed=true,业务事务不回滚;错误上抛', async () => {
    const { db, gateway, observations, runId } = await makeObservedGateway({ breakFlush: true })
    await expect(
      gateway.execute({ runId, tool: 'fixture.read', arguments: { query: 'x' }, planVersion: 1, callIndex: 0 })
    ).rejects.toThrow(/PERSIST_FAILED|保存未确认/)

    const tool = toolPhase(observations)
    expect(tool).toMatchObject({ executed: true, committed: false, outcome: 'success' })
    const persist = persistPhase(observations)
    expect(persist).toMatchObject({
      phase: 'persistence',
      outcome: 'persist_error',
      committed: true,
      executed: false,
      attempt: tool.attempt
    })
    expect(persist.error?.code).toBe('PERSIST_FAILED')
    expect(persist.error?.operationId).toBe(`${runId}:fixture.read:0`)
    // 不能记成业务回滚:事务内回执与观察都已提交
    expect(getOperationReceipt(db, `${runId}:fixture.read:0`)).toBeDefined()
    const traceEvents = listTraceEvents(db, runId).filter((e) => e.eventType === 'tool_call')
    expect(traceEvents).toHaveLength(2)
  })

  it('7 回执重放:replayed=true、executed=false、committed=true,同 operationId 单列新 attempt', async () => {
    const { db, gateway, observations, runId, readCalls } = await makeObservedGateway()
    const input = { runId, tool: 'fixture.read' as const, arguments: { query: 'x' }, planVersion: 1, callIndex: 0 }
    const first = await gateway.execute(input)
    expect(first.ok).toBe(true)
    expect(observations).toHaveLength(2)

    const second = await gateway.execute(input)
    expect(second.ok).toBe(true)
    // 回执重放:不重复执行业务
    if (second.ok) {
      expect((second.data as { call: number }).call).toBe(1)
    }
    expect(readCalls()).toBe(1)

    const replayTool = observations[2]!
    expect(replayTool).toMatchObject({
      phase: 'tool',
      executed: false,
      replayed: true,
      committed: true,
      outcome: 'success',
      operationId: `${runId}:fixture.read:0`,
      result: { echoed: 'x', call: 1 }
    })
    expect(replayTool.attempt).toBe(2)
    const replayPersist = observations[3]!
    expect(replayPersist).toMatchObject({ phase: 'persistence', replayed: true, committed: true, attempt: 2 })
    // 回执仍只有一条;轨迹按 attempt 分列
    expect(getOperationReceipt(db, `${runId}:fixture.read:0`)).toBeDefined()
    const traceEvents = listTraceEvents(db, runId).filter((e) => e.eventType === 'tool_call')
    expect(traceEvents).toHaveLength(4)
  })

  it('写工具执行:审批字段来自数据库快照,targetVersion 与审批绑定版本一致', async () => {
    const { db, gateway, observations, runId } = await makeObservedGateway()
    const proposal = gateway.propose({
      runId,
      tool: 'fixture.write',
      arguments: { title: '已批准' },
      planVersion: 2
    })
    const approval = createApproval(db, {
      runId,
      toolName: 'fixture.write',
      argumentsHash: proposal.argumentsHash,
      argumentsJson: JSON.stringify(proposal.arguments),
      planVersion: 2,
      targetVersion: 3, // 与 fixture.write.resolveTargetVersion 一致,保证新执行通过目标版本复核
      expiresAt: '2026-09-29T01:00:00.000Z'
    })
    db.run("UPDATE approvals SET decision = 'approved', decided_at = ? WHERE approval_id = ?", [NOW, approval.approvalId])

    const result = await gateway.execute({
      runId,
      tool: 'fixture.write',
      arguments: { title: '已批准' },
      planVersion: 2,
      callIndex: 0,
      approvalId: approval.approvalId
    })
    expect(result.ok).toBe(true)
    const tool = toolPhase(observations)
    expect(tool).toMatchObject({
      approvalId: approval.approvalId,
      approvalDecision: 'approved',
      approvalValidated: true,
      targetVersion: 3,
      riskLevel: 'reversible_write',
      executed: true,
      outcome: 'success'
    })
    expect(tool.durationMs).toBeGreaterThan(0)
  })
})
