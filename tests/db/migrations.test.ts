// M1 迁移测试:v3 冻结夹具 → 当前 schema 的版本迁移。
// 红灯依据计划 Task 2 Step 1:夹具显式建库写 schema_version=3,不得用 makeTestDb() 伪装旧库。
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { Database, SqlJsStatic } from 'sql.js'
import { openDatabase, type SqliteDb } from '../../src/main/db/connection'
import { initSchema } from '../../src/main/db/dao'
import { SCHEMA_VERSION } from '../../src/main/db/schema'

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/schema-v3.sql', import.meta.url))
const SQL_JS_DIST = join(process.cwd(), 'node_modules', 'sql.js', 'dist')

/** 用冻结夹具显式建一个真实 v3 库文件,再按生产路径 openDatabase 打开(不运行 initSchema) */
async function openFixtureDb(withData: boolean): Promise<SqliteDb> {
  const sqlText = readFileSync(FIXTURE_PATH, 'utf8')
  const [schemaPart, dataPart] = sqlText.split('-- >>> v3 DATA <<<')
  const initSqlJs = (await import('sql.js')).default as unknown as (cfg?: object) => Promise<SqlJsStatic>
  const wasmBinary = readFileSync(join(SQL_JS_DIST, 'sql-wasm.wasm'))
  const SQL = await initSqlJs({ wasmBinary })
  const raw: Database = new SQL.Database()
  raw.run(schemaPart)
  if (withData && dataPart) raw.run(dataPart)
  const dir = mkdtempSync(join(tmpdir(), 'migr-test-'))
  const dbPath = join(dir, 'data.sqlite')
  writeFileSync(dbPath, Buffer.from(raw.export()))
  const { db } = await openDatabase(dbPath, SQL_JS_DIST)
  return db
}

function schemaVersionOf(db: SqliteDb): string | undefined {
  return db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value
}

function columnNames(db: SqliteDb, table: string): string[] {
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name)
}

describe('v3 冻结夹具自检', () => {
  it('夹具显式建库写 schema_version=3,且没有 M1 的任何新结构', async () => {
    const db = await openFixtureDb(true)
    expect(schemaVersionOf(db)).toBe('3')
    expect(columnNames(db, 'events')).not.toContain('revision')
    expect(columnNames(db, 'todos')).not.toContain('revision')
    expect(columnNames(db, 'pending_items')).not.toContain('revision')
    expect(() => db.all('SELECT * FROM operation_receipts')).toThrow()
  })
})

describe('M1 迁移:v3 → v' + SCHEMA_VERSION, () => {
  it('有数据 v3 库:单次迁移新增 revision 列与 operation_receipts,旧 ID/行数/关系不变', async () => {
    const db = await openFixtureDb(true)
    initSchema(db)

    expect(schemaVersionOf(db)).toBe(String(SCHEMA_VERSION))
    // PRAGMA table_info 断言 revision 列存在
    for (const table of ['events', 'todos', 'pending_items']) {
      const cols = db.all<{ name: string; type: string }>(`PRAGMA table_info(${table})`)
      expect(cols.filter((c) => c.name === 'revision')).toHaveLength(1)
      expect(cols.find((c) => c.name === 'revision')?.type.toUpperCase()).toBe('INTEGER')
    }
    expect(db.all('SELECT * FROM operation_receipts')).toHaveLength(0)

    // 旧 ID 与行数不变
    expect(db.all("SELECT id FROM events WHERE id = 'ev-1'")).toHaveLength(1)
    expect(db.all('SELECT id FROM todos')).toHaveLength(3)
    expect(db.all('SELECT id FROM mail_messages')).toHaveLength(1)
    // 旧关系未丢:两个待办仍共用 ev-1
    expect(db.all("SELECT id FROM todos WHERE linked_event_id = 'ev-1'")).toHaveLength(2)
    // 损坏引用原样保留,不被静默修复或删除
    expect(db.all("SELECT id FROM todos WHERE id = 'td-3' AND linked_event_id = 'ev-missing'")).toHaveLength(1)
    // 已确认邮件映射与旧提醒保留
    expect(db.all('SELECT * FROM mail_confirmations')).toHaveLength(1)
    expect(db.all('SELECT * FROM fired_reminders')).toHaveLength(1)
    // 旧数据补齐 revision=1
    expect(db.get<{ revision: number }>("SELECT revision FROM events WHERE id = 'ev-1'")?.revision).toBe(1)
  })

  it('空库 v3:迁移后版本升级且业务表为空', async () => {
    const db = await openFixtureDb(false)
    initSchema(db)
    expect(schemaVersionOf(db)).toBe(String(SCHEMA_VERSION))
    expect(db.all('SELECT id FROM events')).toHaveLength(0)
    expect(db.all('SELECT id FROM todos')).toHaveLength(0)
    expect(db.all('SELECT * FROM operation_receipts')).toHaveLength(0)
  })

  it('重复初始化(重复启动):revision 列不重复,数据不变', async () => {
    const db = await openFixtureDb(true)
    initSchema(db)
    const todosBefore = db.all('SELECT id FROM todos').length

    initSchema(db) // 二次启动
    expect(schemaVersionOf(db)).toBe(String(SCHEMA_VERSION))
    for (const table of ['events', 'todos', 'pending_items']) {
      expect(db.all<{ name: string }>(`PRAGMA table_info(${table})`).filter((c) => c.name === 'revision')).toHaveLength(1)
    }
    expect(db.all('SELECT id FROM todos')).toHaveLength(todosBefore)
  })

  it('迁移中途异常:整体回滚到 v3,不产生半迁移状态,且库仍可再次迁移', async () => {
    const db = await openFixtureDb(true)
    // 注入:迁移语句碰到 operation_receipts 建表时失败(此时 revision 列已加)
    const originalRun = db.run.bind(db)
    const spy = vi.spyOn(db, 'run').mockImplementation(((sql: string, params?: unknown) => {
      if (String(sql).includes('operation_receipts')) throw new Error('注入的迁移失败')
      return originalRun(sql as never, params as never)
    }) as never)

    expect(() => initSchema(db)).toThrow('注入的迁移失败')
    spy.mockRestore()

    // 回滚完整:版本仍 3、无 revision 列、无回执表
    expect(schemaVersionOf(db)).toBe('3')
    expect(columnNames(db, 'events')).not.toContain('revision')
    expect(columnNames(db, 'todos')).not.toContain('revision')
    expect(() => db.all('SELECT * FROM operation_receipts')).toThrow()
    // 回滚后可以再次成功迁移
    initSchema(db)
    expect(schemaVersionOf(db)).toBe(String(SCHEMA_VERSION))
    expect(db.all("SELECT id FROM todos WHERE linked_event_id = 'ev-1'")).toHaveLength(2)
  })

  it('未来 schema 版本拒绝', async () => {
    const db = await openFixtureDb(true)
    db.run("UPDATE meta SET value = '99' WHERE key = 'schema_version'")
    expect(() => initSchema(db)).toThrow(/高于当前支持的版本/)
    expect(schemaVersionOf(db)).toBe('99')
  })
})
