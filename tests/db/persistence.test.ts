// 可确认落盘与可重试错误测试(计划 Task 3,R2/O4)。
// 红灯依据:openDatabase 尚无文件操作注入参数、SqliteDb 无保存状态原语,
// 落盘失败不拒绝 commitCritical(错误未上抛)。
// 测试一律使用临时目录与注入故障,不读真实 userData。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openDatabase, type FileOps, type SqliteDb } from '../../src/main/db/connection'
import { createTodo, initSchema, listTodos } from '../../src/main/db/dao'
import { createPersistenceCoordinator, getOperationReceipt, runOperation } from '../../src/main/db/operations'
import type { Todo } from '../../src/shared/types'

const SQL_JS_DIST = join(process.cwd(), 'node_modules', 'sql.js', 'dist')

interface Harness {
  db: SqliteDb
  dbPath: string
  /** 故障开关:仅注入到本实例的文件操作 */
  fault: { write: boolean; rename: boolean; count: number }
  /** 重新 openDatabase(默认=真实文件操作),模拟进程重启 */
  reopen(): Promise<SqliteDb>
}

async function makeDb(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'persist-test-'))
  const dbPath = join(dir, 'data.sqlite')
  const fault = { write: false, rename: false, count: 0 }
  const injected: FileOps = {
    readFileSync: (p) => readFileSync(p) as Buffer,
    writeFileSync: (p, d) => {
      if (fault.write) {
        fault.count += 1
        throw new Error('注入的临时文件写入故障')
      }
      writeFileSync(p, d)
    },
    renameSync: (f, t) => {
      if (fault.rename) {
        fault.count += 1
        throw new Error('注入的替换故障')
      }
      renameSync(f, t)
    },
    existsSync: (p) => existsSync(p),
    mkdirSync: (p, opts) => {
      mkdirSync(p, opts)
    },
    unlinkSync: (p) => unlinkSync(p)
  }

  const { db } = await openDatabase(dbPath, SQL_JS_DIST, { fs: injected })
  initSchema(db)
  db.flush() // 先把初始 schema 落盘,隔离迁移期持久化与被测故障
  return {
    db,
    dbPath,
    fault,
    reopen: async () => (await openDatabase(dbPath, SQL_JS_DIST)).db
  }
}

function runCreateTodo(db: SqliteDb, operationId: string, title: string): Todo {
  return runOperation<Todo>(db, {
    operationId,
    command: 'todos:create',
    requestHash: `hash:${operationId}`,
    workspaceEpoch: 'epoch-1'
  }, () => createTodo(db, { title })).value
}

describe('commitCritical:关键命令可确认落盘', () => {
  it('R2: 事务提交后落盘失败,commitCritical 以 PERSIST_FAILED 携带原 operationId 拒绝', async () => {
    const h = await makeDb()
    vi.useFakeTimers()
    try {
      const coordinator = createPersistenceCoordinator(h.db)
      const todo = runCreateTodo(h.db, 'op-1', '关键待办')
      h.fault.write = true

      await expect(coordinator.commitCritical('op-1', todo)).rejects.toMatchObject({
        appError: { code: 'PERSIST_FAILED', retryable: true, operationId: 'op-1' }
      })
      expect(coordinator.getPersistState().status).toBe('failed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('R2: 恢复写入后同 ID 重试成功,只产生一行,重新 openDatabase 能读回', async () => {
    const h = await makeDb()
    vi.useFakeTimers()
    try {
      const coordinator = createPersistenceCoordinator(h.db)
      const todo = runCreateTodo(h.db, 'op-1', '关键待办')
      h.fault.write = true
      await expect(coordinator.commitCritical('op-1', todo)).rejects.toMatchObject({
        appError: { code: 'PERSIST_FAILED', operationId: 'op-1' }
      })

      // 恢复写入后同 ID 重试:runOperation 幂等重放(业务写入不再执行)+ 重新落盘
      h.fault.write = false
      const replay = runOperation<Todo>(h.db, {
        operationId: 'op-1',
        command: 'todos:create',
        requestHash: 'hash:op-1',
        workspaceEpoch: 'epoch-1'
      }, () => {
        throw new Error('重试时不应再次执行业务写入')
      })
      expect(replay.replayed).toBe(true)
      const saved = await coordinator.commitCritical('op-1', replay.value)
      expect(saved.id).toBe(todo.id)
      expect(h.db.all('SELECT id FROM todos')).toHaveLength(1)
      expect(coordinator.getPersistState().status).toBe('saved')
    } finally {
      vi.useRealTimers()
    }

    const reopened = await h.reopen()
    expect(reopened.all('SELECT id, title FROM todos')).toHaveLength(1)
    expect(getOperationReceipt(reopened, 'op-1')).toMatchObject({
      operationId: 'op-1',
      command: 'todos:create',
      requestHash: 'hash:op-1'
    })
  })

  it('R2: 重启后磁盘无回执,绝不把原内存回执当已成功', async () => {
    const h = await makeDb()
    vi.useFakeTimers()
    try {
      const coordinator = createPersistenceCoordinator(h.db)
      const todo = runCreateTodo(h.db, 'op-lost', '未落盘待办')
      h.fault.write = true
      await expect(coordinator.commitCritical('op-lost', todo)).rejects.toMatchObject({
        appError: { code: 'PERSIST_FAILED', operationId: 'op-lost' }
      })
    } finally {
      vi.useRealTimers()
    }

    // 模拟重启:从磁盘内容打开全新实例;内存回执不能越过进程边界
    const restarted = await h.reopen()
    expect(getOperationReceipt(restarted, 'op-lost')).toBeUndefined()
    expect(restarted.all('SELECT id FROM todos WHERE title = ?', ['未落盘待办'])).toHaveLength(0)
  })

  it('R2: 落盘成功后重启,凭磁盘回执返回已落盘结果', async () => {
    const h = await makeDb()
    const coordinator = createPersistenceCoordinator(h.db)
    const todo = runCreateTodo(h.db, 'op-ok', '已落盘待办')
    await expect(coordinator.commitCritical('op-ok', todo)).resolves.toMatchObject({ id: todo.id })

    const restarted = await h.reopen()
    const receipt = getOperationReceipt(restarted, 'op-ok')
    expect(receipt).toBeDefined()
    expect(JSON.parse(receipt!.resultRef).value).toMatchObject({ id: todo.id, title: '已落盘待办' })
    expect(listTodos(restarted).map((t) => t.id)).toContain(todo.id)
  })
})

describe('保存状态机:dirty/saving/saved/failed 与重试节奏', () => {
  it('普通写入 400ms 合并落盘', async () => {
    const h = await makeDb()
    vi.useFakeTimers()
    try {
      createTodo(h.db, { title: '普通写入' })
      expect(h.db.getPersistState().status).toBe('dirty')
      vi.advanceTimersByTime(399)
      expect(h.db.getPersistState().status).toBe('dirty')
      vi.advanceTimersByTime(1)
      expect(h.db.getPersistState().status).toBe('saved')
    } finally {
      vi.useRealTimers()
    }
  })

  it('持续写入时距首批不超过 2 秒强制尝试落盘', async () => {
    const h = await makeDb()
    vi.useFakeTimers()
    try {
      createTodo(h.db, { title: 'w0' })
      for (let i = 1; i <= 6; i++) {
        vi.advanceTimersByTime(300)
        createTodo(h.db, { title: `w${i}` })
      }
      // 距首批 1800ms,仍未落盘
      expect(h.db.getPersistState().status).toBe('dirty')
      vi.advanceTimersByTime(200) // 距首批 2000ms
      expect(h.db.getPersistState().status).toBe('saved')
    } finally {
      vi.useRealTimers()
    }
  })

  it('失败后按 1/5/30 秒重试,其后每 30 秒;恢复后自动落盘成功', async () => {
    const h = await makeDb()
    vi.useFakeTimers()
    try {
      h.fault.write = true
      createTodo(h.db, { title: '故障写入' })
      vi.advanceTimersByTime(400) // 首次尝试落盘失败
      expect(h.db.getPersistState().status).toBe('failed')
      const attemptsAfterFirst = h.fault.count

      vi.advanceTimersByTime(999)
      expect(h.fault.count).toBe(attemptsAfterFirst) // 1 秒未到不重试
      vi.advanceTimersByTime(1)
      expect(h.fault.count).toBe(attemptsAfterFirst + 1) // 1 秒重试
      vi.advanceTimersByTime(4999)
      expect(h.fault.count).toBe(attemptsAfterFirst + 1)
      vi.advanceTimersByTime(1)
      expect(h.fault.count).toBe(attemptsAfterFirst + 2) // 5 秒重试
      vi.advanceTimersByTime(29999)
      expect(h.fault.count).toBe(attemptsAfterFirst + 2)
      vi.advanceTimersByTime(1)
      expect(h.fault.count).toBe(attemptsAfterFirst + 3) // 30 秒重试
      vi.advanceTimersByTime(30000)
      expect(h.fault.count).toBe(attemptsAfterFirst + 4) // 之后每 30 秒

      // 恢复写入能力后,下一次 30 秒重试自动落盘成功
      h.fault.write = false
      vi.advanceTimersByTime(30000)
      expect(h.db.getPersistState().status).toBe('saved')
    } finally {
      vi.useRealTimers()
    }

    const reopened = await h.reopen()
    expect(reopened.all("SELECT id FROM todos WHERE title = '故障写入'")).toHaveLength(1)
  })
})

describe('打开时的文件恢复规则', () => {
  it('主文件缺失但残留临时文件:采用临时文件内容恢复', async () => {
    const h = await makeDb()
    const todo = runCreateTodo(h.db, 'op-tmp', '临时文件里的待办')
    h.db.flush()
    const bytes = readFileSync(h.dbPath)
    unlinkSync(h.dbPath)
    writeFileSync(h.dbPath + '.tmp', bytes)

    const recovered = await h.reopen()
    expect(recovered.all('SELECT id FROM todos WHERE id = ?', [todo.id])).toHaveLength(1)
    // 恢复后主文件被还原
    expect(existsSync(h.dbPath)).toBe(true)
  })

  it('主文件存在但残留临时文件:以主文件为准并清理残留', async () => {
    const h = await makeDb()
    const todo = runCreateTodo(h.db, 'op-main', '主文件里的待办')
    h.db.flush()
    writeFileSync(h.dbPath + '.tmp', Buffer.from('stale-leftover'))

    const reopened = await h.reopen()
    expect(reopened.all('SELECT id FROM todos WHERE id = ?', [todo.id])).toHaveLength(1)
    expect(existsSync(h.dbPath + '.tmp')).toBe(false)
  })

  it('损坏主文件:明确拒绝打开,不静默回退为空库', async () => {
    const h = await makeDb()
    h.db.flush()
    writeFileSync(h.dbPath, Buffer.from('this is not a sqlite database file'))
    await expect(openDatabase(h.dbPath, SQL_JS_DIST)).rejects.toThrow(/损坏/)
  })
})
