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
import {
  ensureNotRestoring,
  exportBackup,
  isRestoreWindowOpen,
  restoreBackup
} from '../../src/main/services/backup'
import { SCHEMA_VERSION } from '../../src/main/db/schema'

const SQLJS_DIST = join(process.cwd(), 'node_modules', 'sql.js', 'dist')

interface TestDb {
  db: SqliteDb
  dbPath: string
  dir: string
  /** 注入一次性写入故障:接下来的第 skip 次写入放行,其后第一次写入抛错并解除注入 */
  armWriteFailure: (skip?: number) => void
}

/** 可注入文件故障的测试库:仅在 writeFileSync 上叠加一次性故障,其余走真实 fs */
async function makeDb(): Promise<TestDb> {
  const dir = mkdtempSync(join(tmpdir(), 'backup-recovery-'))
  const dbPath = join(dir, 'data.sqlite')
  let armed: { skip: number } | null = null
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
