// OPS-01(2026-09-30 完成计划):关键落盘与审批参数的生产组合回归。
// 与 toolGateway.test.ts 的替身单测不同,本文件使用生产组合
// (createAgentGateway 工厂 + createPersistenceCoordinator + 真实 fs 故障注入):
// 1. 磁盘可见性:成功返回前业务行/回执/冻结参数已在磁盘;重开后重放不重复执行;
// 2. 保存故障:flush 失败以 PERSIST_FAILED(携带原 operationId)拒绝,不谎报成功;
//    解除故障后同 operationId 重试只确认保存并重放回执,不再次运行业务;
// 3. todo.update 首次执行后 revision 增长:保存重试不得被原目标版本拒绝;
// 4. 工厂对缺失关键依赖显式拒绝;workspaceEpoch 可注入(EVAL-02 隔离评测)。

import * as realFs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { openDatabase, type FileOps, type SqliteDb } from '../../src/main/db/connection'
import { initSchema } from '../../src/main/db/dao'
import { createPersistenceCoordinator, initWorkspaceEpoch } from '../../src/main/db/operations'
import { createRun, decideApproval, getApproval } from '../../src/main/runs/repository'
import { createAgentGateway } from '../../src/main/agent/runtime'
import { ToolRegistry } from '../../src/main/tools/registry'
import { registerOpsTools } from '../../src/main/tools/definitions'
import { createTodo } from '../../src/main/db/dao'
import { fixedClock } from '../../src/shared/clock'

const SQLJS_DIST = join(process.cwd(), 'node_modules', 'sql.js', 'dist')
const NOW = '2026-09-30T01:00:00.000Z'

interface FaultyDb {
  db: SqliteDb
  dbPath: string
  dir: string
  /** 注入一次性落盘故障:放行 skip 次 writeFileSync 后第一次抛错并解除;null=未武装 */
  armWriteFailure: (skip?: number) => void
  /** 注入一次性 renameSync 故障(writeFileSync 成功、替换失败) */
  armRenameFailure: () => void
}

/** 带真实 fs 故障注入的临时库:仅叠加一次性故障,其余走真实 fs */
async function makeFaultyDb(): Promise<FaultyDb> {
  const dir = mkdtempSync(join(tmpdir(), 'ops-critical-'))
  const dbPath = join(dir, 'data.sqlite')
  let writeFailLeft: number | null = null
  let renameFailArmed = false
  const fsOverride: Partial<FileOps> = {
    writeFileSync: (path, data) => {
      if (writeFailLeft !== null) {
        if (writeFailLeft > 0) {
          writeFailLeft -= 1
          realFs.writeFileSync(path, data)
          return
        }
        writeFailLeft = null
        throw new Error('注入的写入故障')
      }
      realFs.writeFileSync(path, data)
    },
    renameSync: (from, to) => {
      if (renameFailArmed) {
        renameFailArmed = false
        throw new Error('注入的替换故障')
      }
      realFs.renameSync(from, to)
    }
  }
  const { db } = await openDatabase(dbPath, SQLJS_DIST, { fs: fsOverride })
  initSchema(db)
  return {
    db,
    dbPath,
    dir,
    armWriteFailure: (skip = 0) => {
      writeFailLeft = skip
    },
    armRenameFailure: () => {
      renameFailArmed = true
    }
  }
}

/** 从磁盘重开(不重复建 schema):验证磁盘真实内容 */
async function reopen(dbPath: string): Promise<SqliteDb> {
  const { db } = await openDatabase(dbPath, SQLJS_DIST)
  return db
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registerOpsTools(registry)
  return registry
}

/** 生产组合:工厂 + 持久化协调器 + 真实 Ops 工具 */
function makeGateway(db: SqliteDb, registry = makeRegistry()) {
  return createAgentGateway({
    db,
    registry,
    clock: fixedClock(NOW),
    persistCoordinator: createPersistenceCoordinator(db)
  })
}

// ---------- 1. 磁盘可见性(规范关键片段) ----------

it('成功返回时业务、回执和冻结参数已经存在于磁盘', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ops-critical-')), 'data.sqlite')
  const wasm = join(process.cwd(), 'node_modules/sql.js/dist')
  const { db } = await openDatabase(file, wasm)
  initSchema(db)
  initWorkspaceEpoch()
  const clock = fixedClock('2026-09-30T01:00:00.000Z')
  const registry = new ToolRegistry()
  registerOpsTools(registry)
  const gateway = createAgentGateway({ db, registry, clock, persistCoordinator: createPersistenceCoordinator(db) })
  const run = createRun(db, { mode: 'personal_ops', input: '创建待办', contextClock: clock.now().toISOString() })
  const args = { title: '磁盘可见' }
  const p = gateway.propose({ runId: run.runId, tool: 'todo.create', arguments: args, planVersion: 1 })
  decideApproval(db, p.approvalId!, 'approved')
  const call = { runId: run.runId, tool: 'todo.create', arguments: args, planVersion: 1, callIndex: 0, approvalId: p.approvalId }
  expect((await gateway.execute(call)).ok).toBe(true)

  // 关键:先从磁盘重开检查(close 自带 flush 会掩盖缺陷)
  const disk = (await openDatabase(file, wasm)).db
  expect(disk.all('SELECT * FROM todos')).toHaveLength(1)
  expect(disk.all('SELECT * FROM operation_receipts')).toHaveLength(1)
  expect(JSON.parse(getApproval(disk, p.approvalId!)!.argumentsJson!)).toEqual(args)
  disk.close()
  db.close()

  const reopened = (await openDatabase(file, wasm)).db
  const again = createAgentGateway({ db: reopened, registry, clock, persistCoordinator: createPersistenceCoordinator(reopened) })
  await again.execute(call)
  expect(reopened.all('SELECT * FROM todos')).toHaveLength(1)
  reopened.close()
})

// ---------- 2. 保存故障:PERSIST_FAILED 与回执重放 ----------

it('落盘失败:PERSIST_FAILED 携带原 operationId,不谎报成功;解除后重试只保存并重放', async () => {
  const t = await makeFaultyDb()
  initWorkspaceEpoch()
  const gateway = makeGateway(t.db)
  const run = createRun(t.db, { mode: 'personal_ops', input: '保存故障', contextClock: NOW })
  const args = { title: '保存未确认' }
  const p = gateway.propose({ runId: run.runId, tool: 'todo.create', arguments: args, planVersion: 1 })
  decideApproval(t.db, p.approvalId!, 'approved')
  const call = { runId: run.runId, tool: 'todo.create', arguments: args, planVersion: 1, callIndex: 0, approvalId: p.approvalId }

  // 第一次 writeFileSync(临时文件)即失败:业务事务已在内存提交,但保存未确认
  t.armWriteFailure(0)
  await expect(gateway.execute(call)).rejects.toMatchObject({
    appError: { code: 'PERSIST_FAILED', retryable: true, operationId: `${run.runId}:todo.create:0` }
  })
  // 内存已提交(回执已写):不丢失,但绝不向调用方返回成功
  expect(t.db.all('SELECT * FROM todos')).toHaveLength(1)

  // 解除故障后同 operationId 重试:命中回执重放,不重复执行业务
  const retried = await gateway.execute(call)
  expect(retried.ok).toBe(true)
  expect(t.db.all('SELECT * FROM todos')).toHaveLength(1)

  // 落盘后磁盘可见:业务行 + 同键回执 + 冻结参数
  t.db.flush()
  const disk = await reopen(t.dbPath)
  expect(disk.all('SELECT * FROM todos')).toHaveLength(1)
  expect(disk.all('SELECT * FROM operation_receipts')).toHaveLength(1)
  expect(JSON.parse(getApproval(disk, p.approvalId!)!.argumentsJson!)).toEqual(args)
  disk.close()
})

it('renameSync 失败同样以 PERSIST_FAILED 拒绝,旧磁盘内容保持不变', async () => {
  const t = await makeFaultyDb()
  initWorkspaceEpoch()
  // 先产生一次成功落盘的旧内容
  createTodo(t.db, { title: '旧内容' })
  t.db.flush()

  const gateway = makeGateway(t.db)
  const run = createRun(t.db, { mode: 'personal_ops', input: '替换故障', contextClock: NOW })
  const args = { title: '替换失败' }
  const p = gateway.propose({ runId: run.runId, tool: 'todo.create', arguments: args, planVersion: 1 })
  decideApproval(t.db, p.approvalId!, 'approved')

  t.armRenameFailure()
  await expect(
    gateway.execute({ runId: run.runId, tool: 'todo.create', arguments: args, planVersion: 1, callIndex: 0, approvalId: p.approvalId })
  ).rejects.toMatchObject({ appError: { code: 'PERSIST_FAILED', retryable: true } })

  // 旧磁盘内容未被破坏
  const disk = await reopen(t.dbPath)
  expect(disk.all("SELECT title FROM todos WHERE title = '替换失败'")).toHaveLength(0)
  expect(disk.all("SELECT title FROM todos WHERE title = '旧内容'")).toHaveLength(1)
  disk.close()
})

// ---------- 3. todo.update:保存重试不被原目标版本拒绝 ----------

it('todo.update 首次执行后 revision 增长,保存重试仍重放回执成功', async () => {
  const t = await makeFaultyDb()
  initWorkspaceEpoch()
  const todo = createTodo(t.db, { title: '原名' })
  const gateway = makeGateway(t.db)
  const run = createRun(t.db, { mode: 'personal_ops', input: '改名', contextClock: NOW })
  const args = { id: todo.id, title: '改名' }
  // 批准绑定目标版本 1
  const p = gateway.propose({ runId: run.runId, tool: 'todo.update', arguments: args, planVersion: 1 })
  expect(p.targetVersion).toBe(1)
  decideApproval(t.db, p.approvalId!, 'approved')
  const call = { runId: run.runId, tool: 'todo.update', arguments: args, planVersion: 1, callIndex: 0, approvalId: p.approvalId }

  // 首次执行:apply 内校验目标版本 1 通过、业务更新(revision → 2)、回执已写,但落盘失败
  t.armWriteFailure(0)
  await expect(gateway.execute(call)).rejects.toMatchObject({ appError: { code: 'PERSIST_FAILED' } })
  expect(t.db.get<{ revision: number }>('SELECT revision FROM todos WHERE id = ?', [todo.id])?.revision).toBe(2)

  // 保存重试:回执重放不再次校验已被本次更新改变的目标 revision
  const retried = await gateway.execute(call)
  expect(retried.ok).toBe(true)
  expect(t.db.all('SELECT * FROM todos')).toHaveLength(1)
  expect(t.db.get<{ title: string }>('SELECT title FROM todos WHERE id = ?', [todo.id])?.title).toBe('改名')
})

// ---------- 4. 工厂依赖显式拒绝 与 workspaceEpoch 注入 ----------

it('createAgentGateway 对缺失关键依赖显式拒绝', async () => {
  const t = await makeFaultyDb()
  const registry = makeRegistry()
  expect(() =>
    createAgentGateway({ db: t.db, registry, clock: fixedClock(NOW) } as never)
  ).toThrow(/persistCoordinator/)
  expect(() =>
    createAgentGateway({ registry, clock: fixedClock(NOW), persistCoordinator: createPersistenceCoordinator(t.db) } as never)
  ).toThrow(/db/)
})

it('workspaceEpoch 依赖可注入:注入的来源被使用,缺省仍走全局', async () => {
  const t = await makeFaultyDb()
  initWorkspaceEpoch()
  const registry = makeRegistry()
  const localEpoch = vi.fn(() => 'epoch-local-test')
  const gateway = createAgentGateway({
    db: t.db,
    registry,
    clock: fixedClock(NOW),
    persistCoordinator: createPersistenceCoordinator(t.db),
    workspaceEpoch: localEpoch
  })
  const run = createRun(t.db, { mode: 'personal_ops', input: '读任务', contextClock: NOW })
  // 读工具执行一次:注入的 epoch 来源被调用(替代全局 getWorkspaceEpoch)
  const result = await gateway.execute({ runId: run.runId, tool: 'todo.list', arguments: {}, planVersion: 1, callIndex: 0 })
  expect(result.ok).toBe(true)
  expect(localEpoch).toHaveBeenCalledTimes(1)

  // 注入来源抛错时执行随之失败:证明执行路径使用的是注入来源而非全局
  const broken = createAgentGateway({
    db: t.db,
    registry,
    clock: fixedClock(NOW),
    persistCoordinator: createPersistenceCoordinator(t.db),
    workspaceEpoch: () => {
      throw new Error('注入 epoch 故障')
    }
  })
  await expect(
    broken.execute({ runId: run.runId, tool: 'todo.list', arguments: {}, planVersion: 1, callIndex: 1 })
  ).rejects.toThrow('注入 epoch 故障')
})
