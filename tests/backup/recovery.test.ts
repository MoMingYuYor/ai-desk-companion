// R1(Task 4 Step 3):恢复失败回滚与排他窗口。
// - 替换后的落盘失败 → 回滚到恢复前快照,原库/内存/磁盘重开三方一致;
// - 恢复中断(替换事务中止) → 不留半恢复状态,排他窗口关闭,外部请求恢复函数被调用;
// - 旧异步写入被门控排空之后才建立恢复前快照(回滚时迟到写入不丢);
// - 成功路径:窗口开/关、epoch 提升、onRestored 广播、迟到写入被替换。
import * as realFs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openDatabase, type FileOps, type SqliteDb } from '../../src/main/db/connection'
import { createEvent, createTodo, initSchema, listTodos } from '../../src/main/db/dao'
import { getWorkspaceEpoch, initWorkspaceEpoch } from '../../src/main/db/operations'
import { createApproval, createRun } from '../../src/main/runs/repository'
import { argumentsHash } from '../../src/main/tools/schema'
import {
  ensureNotRestoring,
  exportBackup,
  importBackup,
  isRestoreWindowOpen,
  restoreBackup
} from '../../src/main/services/backup'
import { SCHEMA_VERSION } from '../../src/main/db/schema'

const SQLJS_DIST = join(process.cwd(), 'node_modules', 'sql.js', 'dist')
const TS = '2026-09-30T01:00:00.000Z'

interface TestDb {
  db: SqliteDb
  dbPath: string
  dir: string
  /** 注入一次性写入故障:接下来的第 skip 次写入放行,其后第一次写入抛错并解除注入 */
  armWriteFailure: (skip?: number) => void
  /** 注入一次性替换故障:放行 skip 次 renameSync,其后第一次抛错并解除注入 */
  armRenameFailure: (skip?: number) => void
}

/** 可注入文件故障的测试库:仅在 writeFileSync/renameSync 上叠加一次性故障,其余走真实 fs */
async function makeDb(): Promise<TestDb> {
  const dir = mkdtempSync(join(tmpdir(), 'backup-recovery-'))
  const dbPath = join(dir, 'data.sqlite')
  let armed: { skip: number } | null = null
  let renameArmed: { skip: number } | null = null
  const fsOverride: Partial<FileOps> = {
    writeFileSync: (path, data) => {
      if (armed) {
        if (armed.skip > 0) {
          armed.skip -= 1
          realFs.writeFileSync(path, data)
          return
        }
        armed = null
        throw new Error('注入的写入故障')
      }
      realFs.writeFileSync(path, data)
    },
    renameSync: (from, to) => {
      if (renameArmed) {
        if (renameArmed.skip > 0) {
          renameArmed.skip -= 1
          realFs.renameSync(from, to)
          return
        }
        renameArmed = null
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
    armWriteFailure: (skip = 1) => {
      armed = { skip }
    },
    armRenameFailure: (skip = 1) => {
      renameArmed = { skip }
    }
  }
}

/** 从磁盘重开数据库(不重复建 schema),验证磁盘状态 */
async function reopen(dbPath: string): Promise<SqliteDb> {
  const { db } = await openDatabase(dbPath, SQLJS_DIST)
  return db
}

/** 供恢复用的备份文件:含一条待办与一条日程 */
async function makeBackupFile(): Promise<string> {
  const donor = await makeDb()
  createTodo(donor.db, { title: '备份待办' })
  createEvent(donor.db, { title: '备份日程', startAt: '2026-09-16T14:00', endAt: '2026-09-16T15:00' })
  const file = join(donor.dir, 'backup.json')
  exportBackup(donor.db, file)
  return file
}

it('R1: 替换后落盘失败 → 回滚到前快照,原库/内存/磁盘重开三方一致', async () => {
  const t = await makeDb()
  const original = createTodo(t.db, { title: '原待办' })
  t.db.flush() // 恢复前状态已落盘
  const file = await makeBackupFile()

  // 排空落盘(第 1 次注入后写入)放行,替换后的落盘(第 2 次)失败
  t.armWriteFailure(1)
  await expect(restoreBackup(t.db, file)).rejects.toMatchObject({
    appError: { code: 'PERSIST_FAILED', retryable: true }
  })
  // 内存回到前快照
  expect(listTodos(t.db).map((x) => x.id)).toEqual([original.id])
  expect(isRestoreWindowOpen()).toBe(false)

  // 磁盘重开与内存一致(回滚后已重新落盘)
  const reopened = await reopen(t.dbPath)
  expect(listTodos(reopened).map((x) => x.id)).toEqual([original.id])
})

it('R1: 恢复中断(替换事务中止) → 原数据不变、窗口关闭、恢复函数被调用', async () => {
  const t = await makeDb()
  const original = createTodo(t.db, { title: '原待办' })
  t.db.flush()
  const file = await makeBackupFile()

  // 备份含日程:注入触发器让 events 插入中途失败,模拟恢复进行中被中断
  t.db.run("CREATE TRIGGER reject_restore BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'forced restore failure'); END")
  let resumeCalled = false
  await expect(
    restoreBackup(t.db, file, {
      quiesceExternal: () => () => {
        resumeCalled = true
      }
    })
  ).rejects.toThrow()
  t.db.run('DROP TRIGGER reject_restore')

  expect(resumeCalled).toBe(true)
  expect(isRestoreWindowOpen()).toBe(false)
  expect(listTodos(t.db).map((x) => x.id)).toEqual([original.id])
  expect(t.db.all('SELECT * FROM events')).toHaveLength(0)

  // 磁盘重开:仍是恢复前状态,没有半恢复数据
  const reopened = await reopen(t.dbPath)
  expect(listTodos(reopened).map((x) => x.id)).toEqual([original.id])
  expect(reopened.all('SELECT * FROM events')).toHaveLength(0)
})

it('R1: 旧异步写入被门控排空后才取恢复前快照 → 回滚时迟到写入不丢,三方一致', async () => {
  const t = await makeDb()
  const original = createTodo(t.db, { title: '原待办' })
  t.db.flush()
  const file = await makeBackupFile()

  // 模拟恢复窗口内才落地的旧异步写入:在排他窗口打开后执行,等待其排空后才走后续流程
  let lateTodoId = ''
  const quiesceExternal = async (): Promise<() => void> => {
    expect(isRestoreWindowOpen()).toBe(true)
    lateTodoId = createTodo(t.db, { title: '迟到写入' }).id
    return () => {}
  }

  t.armWriteFailure(1) // 排空落盘放行,替换后落盘失败 → 走回滚
  await expect(restoreBackup(t.db, file, { quiesceExternal })).rejects.toMatchObject({
    appError: { code: 'PERSIST_FAILED' }
  })

  // 关键断言:快照在迟到写入排空之后建立,回滚保住的是"旧数据 + 迟到写入",
  // 若快照在门控/排空之前取得,回滚会丢掉迟到写入
  expect(listTodos(t.db).map((x) => x.id)).toEqual([original.id, lateTodoId])

  const reopened = await reopen(t.dbPath)
  expect(listTodos(reopened).map((x) => x.id)).toEqual([original.id, lateTodoId])
})

it('R1: 成功恢复 → 窗口期间写入被拒、epoch 提升、广播触发、迟到写入被替换、磁盘一致', async () => {
  initWorkspaceEpoch()
  const t = await makeDb()
  createTodo(t.db, { title: '原待办' })
  t.db.flush()
  const file = await makeBackupFile()

  const epochBefore = getWorkspaceEpoch()
  let windowOpenDuringQuiesce = false
  let gateRejectedWrite = false
  let restoredBroadcast = 0
  const quiesceExternal = async (): Promise<() => void> => {
    windowOpenDuringQuiesce = isRestoreWindowOpen()
    try {
      ensureNotRestoring()
    } catch {
      gateRejectedWrite = true
    }
    // 在途旧写入在窗口内完成,随后被恢复内容整体替换
    createTodo(t.db, { title: '迟到写入' })
    return () => {}
  }

  const result = await restoreBackup(t.db, file, {
    quiesceExternal,
    onRestored: () => {
      restoredBroadcast += 1
    }
  })

  expect(result.schemaVersion).toBe(SCHEMA_VERSION)
  expect(result.imported.todos).toBe(1)
  expect(windowOpenDuringQuiesce).toBe(true)
  expect(gateRejectedWrite).toBe(true)
  expect(restoredBroadcast).toBe(1)
  expect(isRestoreWindowOpen()).toBe(false)
  expect(getWorkspaceEpoch()).not.toBe(epochBefore)
  // 替换语义:恢复后只剩备份内容(迟到写入是门控后排空的前状态,不残留)
  expect(listTodos(t.db).map((x) => x.title)).toEqual(['备份待办'])

  const reopened = await reopen(t.dbPath)
  expect(listTodos(reopened).map((x) => x.title)).toEqual(['备份待办'])
  expect(reopened.all('SELECT * FROM events')).toHaveLength(1)
})

// ---------- OPS-01(2026-09-30 完成计划):审批参数随导出/恢复/回滚保持一致 ----------

/** 在库上创建一条带冻结参数的审批(todo.create) */
function makeApproval(db: SqliteDb, runId: string, args: Record<string, unknown>): void {
  createApproval(db, {
    runId,
    toolName: 'todo.create',
    argumentsHash: argumentsHash({ tool: 'todo.create', arguments: args }),
    argumentsJson: JSON.stringify(args),
    planVersion: 1,
    expiresAt: '2026-10-01T00:00:00.000Z'
  })
}

it('OPS-01: 恢复前确认目标是随机临时库;导出→恢复→重开全程参数/hash、业务行与回执一致', async () => {
  const donor = await makeDb()
  const donorRun = createRun(donor.db, { mode: 'personal_ops', input: 'donor 运行', contextClock: TS })
  makeApproval(donor.db, donorRun.runId, { title: '恢复参数' })
  createTodo(donor.db, { title: '备份待办' })
  // 回执:用 runOperation 写一条可重放的关键命令回执
  const { runOperation } = await import('../../src/main/db/operations')
  initWorkspaceEpoch()
  runOperation(donor.db, { operationId: 'op-1', command: 'test.echo', requestHash: 'hash-op-1', workspaceEpoch: getWorkspaceEpoch() }, () => ({ v: 1 }))
  const file = join(donor.dir, 'backup-with-approval.json')
  exportBackup(donor.db, file)

  // 目标为随机临时库(makeDb 基于 mkdtempSync),先有旧内容
  const t = await makeDb()
  createTodo(t.db, { title: '将被替换' })
  t.db.flush()

  const result = await restoreBackup(t.db, file)
  expect(result.imported.approvals).toBe(1)
  expect(result.imported.operation_receipts).toBe(1)
  expect(t.db.get<{ arguments_json: string | null }>('SELECT arguments_json FROM approvals')?.arguments_json).toBe(
    JSON.stringify({ title: '恢复参数' })
  )
  expect(t.db.get<{ request_hash: string }>('SELECT request_hash FROM operation_receipts')?.request_hash).toBe('hash-op-1')

  // 关闭后从磁盘重开:三方一致
  const reopened = await reopen(t.dbPath)
  expect(listTodos(reopened).map((x) => x.title)).toEqual(['备份待办'])
  expect(reopened.get<{ arguments_json: string | null }>('SELECT arguments_json FROM approvals')?.arguments_json).toBe(
    JSON.stringify({ title: '恢复参数' })
  )
  expect(reopened.all('SELECT * FROM operation_receipts')).toHaveLength(1)
  reopened.close()
})

it('OPS-01: 恢复替换后落盘失败(writeFileSync)→ 回滚快照保留原审批参数,旧磁盘内容一致', async () => {
  const t = await makeDb()
  const run = createRun(t.db, { mode: 'personal_ops', input: '原运行', contextClock: TS })
  makeApproval(t.db, run.runId, { title: '原冻结参数' })
  const original = createTodo(t.db, { title: '原待办' })
  t.db.flush()
  const file = await makeBackupFile()

  t.armWriteFailure(1) // 排空落盘放行,替换后落盘失败 → 走回滚
  await expect(restoreBackup(t.db, file)).rejects.toMatchObject({
    appError: { code: 'PERSIST_FAILED', retryable: true }
  })
  // 回滚快照同样包含参数:内存回到恢复前,冻结参数未丢
  expect(t.db.get<{ arguments_json: string | null }>('SELECT arguments_json FROM approvals')?.arguments_json).toBe(
    JSON.stringify({ title: '原冻结参数' })
  )
  expect(listTodos(t.db).map((x) => x.id)).toEqual([original.id])

  const reopened = await reopen(t.dbPath)
  expect(reopened.get<{ arguments_json: string | null }>('SELECT arguments_json FROM approvals')?.arguments_json).toBe(
    JSON.stringify({ title: '原冻结参数' })
  )
  expect(listTodos(reopened).map((x) => x.id)).toEqual([original.id])
  reopened.close()
})

it('OPS-01: 恢复替换失败(renameSync)→ 回滚快照,旧磁盘内容与审批一致', async () => {
  const t = await makeDb()
  const run = createRun(t.db, { mode: 'personal_ops', input: '原运行', contextClock: TS })
  makeApproval(t.db, run.runId, { title: '原冻结参数' })
  const original = createTodo(t.db, { title: '原待办' })
  t.db.flush()
  const file = await makeBackupFile()

  t.armRenameFailure()
  await expect(restoreBackup(t.db, file)).rejects.toMatchObject({
    appError: { code: 'PERSIST_FAILED', retryable: true }
  })
  expect(listTodos(t.db).map((x) => x.id)).toEqual([original.id])
  expect(t.db.get<{ arguments_json: string | null }>('SELECT arguments_json FROM approvals')?.arguments_json).toBe(
    JSON.stringify({ title: '原冻结参数' })
  )

  const reopened = await reopen(t.dbPath)
  expect(listTodos(reopened).map((x) => x.id)).toEqual([original.id])
  expect(reopened.get<{ arguments_json: string | null }>('SELECT arguments_json FROM approvals')?.arguments_json).toBe(
    JSON.stringify({ title: '原冻结参数' })
  )
  reopened.close()
})

it('OPS-01: 导出 writeFileSync 失败时以错误结束,不产出半截文件', async () => {
  const t = await makeDb()
  createTodo(t.db, { title: '导出失败' })
  // 目标目录不存在:真实 fs 写入直接失败
  expect(() => exportBackup(t.db, join(t.dir, 'no-such-dir', 'backup.json'))).toThrow()
})
