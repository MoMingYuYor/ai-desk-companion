import { describe, expect, it } from 'vitest'
import { makeTestDb } from '../helpers'
import { initSchema } from '../../src/main/db/dao'
import { SCHEMA_VERSION } from '../../src/main/db/schema'
import {
  MIGRATIONS,
  REGISTRY_VERSION,
  applyPending,
  assertRegistryCanHandle,
  backfillFromMeta,
  ensureMigrationsTable,
  pendingMigrations,
  readApplied,
  rollbackTo
} from '../../src/main/db/migrations/registry'
import type { SqliteDb } from '../../src/main/db/connection'

// C-03:版本化迁移注册表。原实现是 meta.schema_version + if 链,无回滚、无迁移历史。
// 本文件覆盖:注册表与 schema.ts 的不变量、回填兼容、单步与全量回滚、未来版本拒绝。

function tableNames(db: SqliteDb): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((r) => r.name)
}

function columnNames(db: SqliteDb, table: string): string[] {
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name)
}

function metaVersion(db: SqliteDb): string | undefined {
  return db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value
}

const MAIL_TABLES = [
  'mail_accounts',
  'mail_sync_state',
  'mail_messages',
  'mail_attachments',
  'mail_analysis_links',
  'mail_analysis_versions',
  'mail_confirmations'
]

describe('注册表不变量', () => {
  it('注册表最高版本与 schema.ts 的 SCHEMA_VERSION 一致', () => {
    expect(REGISTRY_VERSION).toBe(SCHEMA_VERSION)
  })

  it('版本号唯一且升序,无重复', () => {
    const versions = MIGRATIONS.map((m) => m.version)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('每个迁移都有非空名称与 up/down', () => {
    for (const m of MIGRATIONS) {
      expect(m.name.length).toBeGreaterThan(0)
      expect(typeof m.up).toBe('function')
      expect(typeof m.down).toBe('function')
    }
  })
})

describe('全新库', () => {
  it('应用全部迁移并写入迁移历史', async () => {
    const db = await makeTestDb()
    const applied = readApplied(db)
    expect(applied.map((a) => a.version)).toEqual([1, 2, 3, 4])
    expect(metaVersion(db)).toBe(String(SCHEMA_VERSION))
    for (const t of MAIL_TABLES) expect(tableNames(db)).toContain(t)
    expect(columnNames(db, 'providers')).toContain('supports_json_mode')
    expect(columnNames(db, 'events')).toContain('revision')
    expect(tableNames(db)).toContain('operation_receipts')
  })

  it('重复初始化幂等:历史不重复写入', async () => {
    const db = await makeTestDb()
    const before = readApplied(db).length
    initSchema(db)
    initSchema(db)
    expect(readApplied(db).length).toBe(before)
    expect(pendingMigrations(db)).toHaveLength(0)
  })

  it('无待执行迁移时 pendingMigrations 为空', async () => {
    const db = await makeTestDb()
    expect(pendingMigrations(db)).toEqual([])
  })
})

describe('兼容既有库:按 meta.schema_version 回填', () => {
  it('meta 有版本而注册表为空时回填,且不重跑 DDL', async () => {
    const db = await makeTestDb()
    // 模拟注册表之前的既有库:表结构完好,但没有 schema_migrations
    db.run('DELETE FROM schema_migrations')
    expect(readApplied(db)).toEqual([])

    const backfilled = backfillFromMeta(db)
    expect(backfilled).toBe(4)
    expect(readApplied(db).map((a) => a.version)).toEqual([1, 2, 3, 4])
    expect(pendingMigrations(db)).toHaveLength(0)
  })

  it('meta 为 v1 时只回填 v1,其余版本仍待应用', async () => {
    const db = await makeTestDb()
    db.run('DELETE FROM schema_migrations')
    db.run("UPDATE meta SET value = '1' WHERE key = 'schema_version'")

    expect(backfillFromMeta(db)).toBe(1)
    expect(readApplied(db).map((a) => a.version)).toEqual([1])
    expect(pendingMigrations(db).map((m) => m.version)).toEqual([2, 3, 4])
  })

  it('注册表已有记录时不回填(返回 0)', async () => {
    const db = await makeTestDb()
    expect(backfillFromMeta(db)).toBe(0)
  })

  it('完全没有版本记录时不回填(视为全新库)', async () => {
    const db = await makeTestDb()
    db.run('DELETE FROM schema_migrations')
    db.run("DELETE FROM meta WHERE key = 'schema_version'")
    expect(backfillFromMeta(db)).toBe(0)
    expect(pendingMigrations(db)).toHaveLength(4)
  })
})

describe('回滚', () => {
  it('回滚到空库:业务表全部移除,历史清空,注册表自身保留', async () => {
    const db = await makeTestDb()
    let finalVersion = -1
    db.transaction(() => {
      finalVersion = rollbackTo(db, 0)
    })

    expect(finalVersion).toBe(0)
    expect(readApplied(db)).toEqual([])
    const remaining = tableNames(db)
    expect(remaining).toEqual(['schema_migrations'])
    expect(remaining).not.toContain('meta')
  })

  it('回滚到空库后可重新 up 重建全部结构', async () => {
    const db = await makeTestDb()
    db.transaction(() => rollbackTo(db, 0))
    expect(tableNames(db)).toEqual(['schema_migrations'])

    let rebuilt = -1
    db.transaction(() => {
      rebuilt = applyPending(db)
    })
    expect(rebuilt).toBe(SCHEMA_VERSION)
    for (const t of MAIL_TABLES) expect(tableNames(db)).toContain(t)
    expect(columnNames(db, 'providers')).toContain('supports_json_mode')
    expect(columnNames(db, 'events')).toContain('revision')
    expect(tableNames(db)).toContain('operation_receipts')
    expect(metaVersion(db)).toBe(String(SCHEMA_VERSION))
  })

  it('单步回滚 v4 只移除该版本的结构,保留其余版本', async () => {
    const db = await makeTestDb()
    let finalVersion = -1
    db.transaction(() => {
      finalVersion = rollbackTo(db, 3)
    })

    expect(finalVersion).toBe(3)
    expect(metaVersion(db)).toBe('3')
    // v4 的结构移除
    expect(tableNames(db)).not.toContain('operation_receipts')
    expect(columnNames(db, 'events')).not.toContain('revision')
    expect(columnNames(db, 'todos')).not.toContain('revision')
    expect(columnNames(db, 'pending_items')).not.toContain('revision')
    // 更低版本的结构保留
    expect(columnNames(db, 'providers')).toContain('supports_json_mode')
    for (const t of MAIL_TABLES) expect(tableNames(db)).toContain(t)
  })

  it('回滚是幂等的:重复回滚同一目标不抛错', async () => {
    const db = await makeTestDb()
    db.transaction(() => rollbackTo(db, 3))
    expect(() => db.transaction(() => rollbackTo(db, 3))).not.toThrow()
    expect(() => db.transaction(() => rollbackTo(db, 0))).not.toThrow()
    expect(() => db.transaction(() => rollbackTo(db, 0))).not.toThrow()
  })

  it('回滚后可再次升级到最新版本', async () => {
    const db = await makeTestDb()
    db.transaction(() => rollbackTo(db, 3))
    let finalVersion = -1
    db.transaction(() => {
      finalVersion = applyPending(db)
    })
    expect(finalVersion).toBe(SCHEMA_VERSION)
    expect(columnNames(db, 'events')).toContain('revision')
    expect(tableNames(db)).toContain('operation_receipts')
  })
})

describe('未来版本拒绝启动', () => {
  it('meta 高于注册表时 assertRegistryCanHandle 抛错', async () => {
    const db = await makeTestDb()
    db.run("UPDATE meta SET value = '99' WHERE key = 'schema_version'")
    expect(() => assertRegistryCanHandle(db)).toThrow(/高于当前支持的版本/)
  })

  it('版本一致时不抛错并返回既有版本', async () => {
    const db = await makeTestDb()
    expect(assertRegistryCanHandle(db)).toBe(SCHEMA_VERSION)
  })

  it('无 meta 表时返回 null(全新库)', async () => {
    const db = await makeTestDb()
    db.transaction(() => rollbackTo(db, 0))
    expect(assertRegistryCanHandle(db)).toBeNull()
  })
})

describe('ensureMigrationsTable', () => {
  it('可重复调用,不破坏既有历史', async () => {
    const db = await makeTestDb()
    const before = readApplied(db)
    ensureMigrationsTable(db)
    ensureMigrationsTable(db)
    expect(readApplied(db)).toEqual(before)
  })
})
