import { describe, expect, it } from 'vitest'
import { makeTestDb } from '../helpers'
import { initWorkspaceEpoch } from '../../src/main/db/operations'
import { getApproval } from '../../src/main/runs/repository'
import { fixedClock, systemClock } from '../../src/shared/clock'
import { ToolGateway } from '../../src/main/tools/gateway'
import { ToolRegistry } from '../../src/main/tools/registry'
import type { ToolDefinition, ToolResult } from '../../src/main/tools/types'
import type { SqliteDb } from '../../src/main/db/connection'

// C-04:ToolGateway。核心安全断言:
// 1. 写工具必须先 propose 并批准;未批准/拒绝/过期/参数或版本变化全部拒绝;
// 2. 信封出现 approved 键(无论值)一律拒绝;
// 3. 风险等级由注册表决定,schema 层拒绝任何风险声明字段;
// 4. 幂等:同 runId:tool:callIndex 重复执行命中回执,副作用只发生一次。

const NOW = '2026-09-28T01:00:00.000Z'

function makeTools(): { registry: ToolRegistry; readCalls: () => number; writeCalls: () => number } {
  let readCount = 0
  let writeCount = 0
  const registry = new ToolRegistry()
  registry.register({
    name: 'fixture.read',
    description: '测试读工具',
    riskLevel: 'read',
    timeoutMs: 1000,
    retryable: false,
    inputSchema: { fields: [{ name: 'query', type: 'string', required: true }] },
    execute: (args) => {
      readCount += 1
      return { ok: true, data: { echoed: args.query, call: readCount } }
    }
  })
  registry.register({
    name: 'fixture.write',
    description: '测试写工具',
    riskLevel: 'reversible_write',
    timeoutMs: 2000,
    retryable: true,
    inputSchema: { fields: [{ name: 'title', type: 'string', required: true }] },
    execute: (args) => {
      writeCount += 1
      return { ok: true, data: { created: args.title, call: writeCount } }
    }
  })
  return {
    registry,
    readCalls: () => readCount,
    writeCalls: () => writeCount
  }
}

async function makeGateway(clock = systemClock): Promise<{
  db: SqliteDb
  gateway: ToolGateway
  tools: ReturnType<typeof makeTools>
}> {
  const db = await makeTestDb()
  initWorkspaceEpoch()
  const tools = makeTools()
  const gateway = new ToolGateway({ db, registry: tools.registry, clock })
  return { db, gateway, tools }
}

async function proposeWrite(
  gateway: ToolGateway,
  runId: string,
  over: Record<string, unknown> = {}
): Promise<{ approvalId: string; expiresAt: string }> {
  const proposal = gateway.propose({
    runId,
    tool: 'fixture.write',
    arguments: { title: '项目整理' },
    planVersion: 1,
    ...over
  })
  return { approvalId: proposal.approvalId!, expiresAt: proposal.expiresAt! }
}

describe('propose', () => {
  it('读工具:直接可执行,不创建审批', async () => {
    const { db, gateway } = await makeGateway()
    const run = (await import('../../src/main/runs/repository')).createRun(db, {
      mode: 'personal_ops',
      input: '读任务',
      contextClock: NOW
    })
    const proposal = gateway.propose({
      runId: run.runId,
      tool: 'fixture.read',
      arguments: { query: '机器学习' },
      planVersion: 1
    })
    expect(proposal.requiresConfirmation).toBe(false)
    expect(proposal.riskLevel).toBe('read')
    expect(proposal.approvalId).toBeNull()
    expect(proposal.argumentsHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('写工具:创建 pending 审批,有效期按配置(默认 24 小时)', async () => {
    const { db, gateway } = await makeGateway(fixedClock(NOW))
    const run = (await import('../../src/main/runs/repository')).createRun(db, {
      mode: 'personal_ops',
      input: '写任务',
      contextClock: NOW
    })
    const proposal = gateway.propose({
      runId: run.runId,
      tool: 'fixture.write',
      arguments: { title: '项目整理' },
      planVersion: 2,
      targetVersion: 3
    })
    expect(proposal.requiresConfirmation).toBe(true)
    expect(proposal.riskLevel).toBe('reversible_write')
    const approval = getApproval(db, proposal.approvalId!)
    expect(approval?.decision).toBe('pending')
    expect(approval?.planVersion).toBe(2)
    expect(approval?.targetVersion).toBe(3)
    // 2026-09-28T01:00Z + 24h
    expect(proposal.expiresAt).toBe('2026-09-29T01:00:00.000Z')
  })

  it('信封出现 approved 键一律拒绝,显式 false 也不例外', async () => {
    const { gateway } = await makeGateway()
    const base = { runId: 'r', tool: 'fixture.write', arguments: { title: 'x' }, planVersion: 1 }
    expect(() => gateway.propose({ ...base, approved: true })).toThrow(/不允许调用方声明批准状态/)
    expect(() => gateway.propose({ ...base, approved: false })).toThrow(/不允许调用方声明批准状态/)
  })

  it('参数不满足 schema 在 propose 阶段即拒绝', async () => {
    const { gateway } = await makeGateway()
    expect(() =>
      gateway.propose({ runId: 'r', tool: 'fixture.write', arguments: { title: 1 }, planVersion: 1 })
    ).toThrow(/必须是字符串/)
    expect(() =>
      gateway.propose({ runId: 'r', tool: 'fixture.write', arguments: { title: 'x', riskLevel: 'read' }, planVersion: 1 })
    ).toThrow(/未知字段:riskLevel/)
  })

  it('未注册工具在 propose 阶段拒绝', async () => {
    const { gateway } = await makeGateway()
    expect(() => gateway.propose({ runId: 'r', tool: 'ghost', arguments: {}, planVersion: 1 })).toThrow(
      /未注册的工具/
    )
  })
})

describe('execute 幂等与副作用', () => {
  it('读工具执行一次;同 runId:tool:callIndex 重复执行命中回执,副作用只发生一次', async () => {
    const { gateway, tools } = await makeGateway()
    const input = { runId: 'r1', tool: 'fixture.read', arguments: { query: 'x' }, planVersion: 1, callIndex: 0 }
    const first = (await gateway.execute(input)) as Extract<ToolResult, { ok: true }>
    expect(first.ok).toBe(true)
    expect(tools.readCalls()).toBe(1)

    const second = (await gateway.execute(input)) as Extract<ToolResult, { ok: true }>
    expect(second.ok).toBe(true)
    // 回执重放:返回首次结果,不重复执行
    expect(second.data).toEqual(first.data)
    expect(tools.readCalls()).toBe(1)
  })

  it('同键不同参:runOperation 回执哈希冲突向上传播', async () => {
    const { gateway } = await makeGateway()
    const base = { runId: 'r1', tool: 'fixture.read', arguments: { query: 'x' }, planVersion: 1, callIndex: 0 }
    await gateway.execute(base)
    await expect(gateway.execute({ ...base, arguments: { query: 'y' } })).rejects.toThrow(/不同/)
  })

  it('工具意外异常向上传播、不写回执,同 callIndex 可重试', async () => {
    const db = await makeTestDb()
    initWorkspaceEpoch()
    const registry = new ToolRegistry()
    let attempts = 0
    registry.register({
      name: 'fixture.boom',
      description: '抛错工具',
      riskLevel: 'read',
      timeoutMs: 100,
      retryable: false,
      inputSchema: { fields: [] },
      execute: () => {
        attempts += 1
        throw new Error('内部炸了')
      }
    })
    const gateway = new ToolGateway({ db, registry, clock: systemClock })
    const input = { runId: 'r', tool: 'fixture.boom', arguments: {}, planVersion: 1, callIndex: 0 }
    // 两次同 callIndex 调用都真正重新执行(无回执挡路)
    await expect(gateway.execute(input)).rejects.toThrow('内部炸了')
    await expect(gateway.execute(input)).rejects.toThrow('内部炸了')
    expect(attempts).toBe(2)
    expect(
      db.get<{ operation_id: string }>('SELECT operation_id FROM operation_receipts WHERE operation_id = ?', [
        'r:fixture.boom:0'
      ])
    ).toBeUndefined()
  })
})

describe('execute 写工具的批准校验', () => {
  /** 各用例独立建库:创建真实运行 + propose + 批准,返回执行所需上下文 */
  async function setupWithApprovedProposal(over: {
    clock?: typeof systemClock
    title?: string
  } = {}): Promise<{
    db: SqliteDb
    gateway: ToolGateway
    tools: ReturnType<typeof makeTools>
    runId: string
    approvalId: string
    approve: () => void
  }> {
    const db = await makeTestDb()
    initWorkspaceEpoch()
    const tools = makeTools()
    const gateway = new ToolGateway({ db, registry: tools.registry, clock: over.clock ?? systemClock })
    const run = (await import('../../src/main/runs/repository')).createRun(db, {
      mode: 'personal_ops',
      input: '写任务',
      contextClock: NOW
    })
    const proposal = gateway.propose({
      runId: run.runId,
      tool: 'fixture.write',
      arguments: { title: over.title ?? '项目整理' },
      planVersion: 1
    })
    const approve = (): void => {
      db.run("UPDATE approvals SET decision = 'approved', decided_at = ? WHERE approval_id = ?", [
        NOW,
        proposal.approvalId!
      ])
    }
    return { db, gateway, tools, runId: run.runId, approvalId: proposal.approvalId!, approve }
  }

  it('无审批记录直接执行:拒绝', async () => {
    const { gateway, tools } = await makeGateway()
    await expect(
      gateway.execute({ runId: 'r', tool: 'fixture.write', arguments: { title: 'x' }, planVersion: 1, callIndex: 0 })
    ).rejects.toThrow(/缺少审批记录/)
    expect(tools.writeCalls()).toBe(0)
  })

  it('pending 审批:拒绝;批准后:执行一次;重复批准执行:回执防重', async () => {
    const { db, gateway, tools, runId, approvalId, approve } = await setupWithApprovedProposal()
    const input = {
      runId,
      tool: 'fixture.write',
      arguments: { title: '项目整理' },
      planVersion: 1,
      callIndex: 0,
      approvalId
    }

    await expect(gateway.execute(input)).rejects.toThrow(/尚未批准/)

    approve()
    const first = (await gateway.execute(input)) as Extract<ToolResult, { ok: true }>
    expect(first.ok).toBe(true)
    expect(tools.writeCalls()).toBe(1)

    // 同一 callIndex 重放:回执命中,不再执行
    const second = (await gateway.execute(input)) as Extract<ToolResult, { ok: true }>
    expect(second.data).toEqual(first.data)
    expect(tools.writeCalls()).toBe(1)
  })

  it('被拒绝的提案:拒绝执行', async () => {
    const { db, gateway, tools, approvalId } = await setupWithApprovedProposal()
    db.run("UPDATE approvals SET decision = 'rejected', decided_at = ? WHERE approval_id = ?", [NOW, approvalId])
    await expect(
      gateway.execute({
        runId: 'ghost-r',
        tool: 'fixture.write',
        arguments: { title: '项目整理' },
        planVersion: 1,
        callIndex: 0,
        approvalId
      })
    ).rejects.toThrow(/已被拒绝/)
    expect(tools.writeCalls()).toBe(0)
  })

  it('参数与批准时不一致:CONFLICT', async () => {
    const { gateway, approvalId, approve } = await setupWithApprovedProposal()
    approve()
    await expect(
      gateway.execute({
        runId: 'ghost-r',
        tool: 'fixture.write',
        arguments: { title: '被篡改' },
        planVersion: 1,
        callIndex: 0,
        approvalId
      })
    ).rejects.toThrow(/参数与批准时不一致|重新生成提案/)
  })

  it('计划版本变化:CONFLICT', async () => {
    const { gateway, approvalId, approve } = await setupWithApprovedProposal()
    approve()
    await expect(
      gateway.execute({
        runId: 'ghost-r',
        tool: 'fixture.write',
        arguments: { title: '项目整理' },
        planVersion: 2,
        callIndex: 0,
        approvalId
      })
    ).rejects.toThrow(/计划版本/)
  })

  it('超过有效期:CONFLICT(用固定时钟推进 25 小时)', async () => {
    let now = new Date(NOW).getTime()
    const advancingClock = {
      now: () => new Date(now),
      monotonicMs: systemClock.monotonicMs
    }
    const { gateway, approvalId, approve } = await setupWithApprovedProposal({ clock: advancingClock })
    approve()
    now += 25 * 3600_000
    await expect(
      gateway.execute({
        runId: 'ghost-r',
        tool: 'fixture.write',
        arguments: { title: '项目整理' },
        planVersion: 1,
        callIndex: 0,
        approvalId
      })
    ).rejects.toThrow(/已过有效期/)
  })

  it('信封带 approved=true 的执行请求同样拒绝', async () => {
    const { gateway, approvalId, approve } = await setupWithApprovedProposal()
    approve()
    await expect(
      gateway.execute({
        runId: 'ghost-r',
        tool: 'fixture.write',
        arguments: { title: '项目整理' },
        planVersion: 1,
        callIndex: 0,
        approvalId,
        approved: true
      })
    ).rejects.toThrow(/不允许调用方声明批准状态/)
  })
})
