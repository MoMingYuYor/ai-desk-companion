// 版本化迁移注册表(C-03)。
//
// 背景:原实现是 meta.schema_version + if 链(见 dao.ts 的 initSchema),
// 无回滚、无迁移历史、无单步执行。作品集要求"迁移必须可回滚",
// 本模块把它升级为注册表,每个迁移带 up/down。
//
// 两条必须遵守的约束(架构决策记录第 4.1 节):
// 1. 既有 DDL 内容不变:v2/v3/v4 只是把原有迁移函数包成注册表条目,不改其 SQL。
// 2. 兼容既有库:meta.schema_version 存在而 schema_migrations 为空时,
//    按版本回填历史记录,不重跑 DDL。
//
// 一处需要说明的既有事实:v1.up 施加的 SCHEMA_SQL 本身已是 v4 形态
// (已含邮件表、revision 列、operation_receipts),因为 schema.ts 描述的是当前库形状。
// v2~v4 的存在是为了把更老的库升上来,在新建库上幂等(全部 IF NOT EXISTS / 防重复加列)。
// 因此各版本的 down 都写成自足且幂等的(IF EXISTS),逆序执行即可回到空库。

import type { SqliteDb } from '../connection'
import { SCHEMA_SQL } from '../schema'
import { migrateMailV2 } from '../../mail/schema'
import { migrateM1, OPERATION_RECEIPTS_SQL } from './m1'
import { migrateM2, rollbackM2 } from './m2'
import { nowTimestamp } from '../../../shared/dateUtils'

export interface Migration {
  version: number
  name: string
  up(db: SqliteDb): void
  down(db: SqliteDb): void
}

/** v1 拥有的基础业务表(邮件表属 v2,operation_receipts 属 v4) */
const BASE_TABLES: readonly string[] = [
  'meta',
  'providers',
  'conversations',
  'messages',
  'materials',
  'analyses',
  'events',
  'todos',
  'pending_items',
  'semesters',
  'courses',
  'course_overrides',
  'school_events',
  'profile_facts',
  'fired_reminders'
]

/** v2 拥有的邮件表(含外键,须先于基础表删除) */
const MAIL_TABLES: readonly string[] = [
  'mail_confirmations',
  'mail_analysis_versions',
  'mail_analysis_links',
  'mail_attachments',
  'mail_messages',
  'mail_sync_state',
  'mail_accounts'
]

/** v4 拥有 revision 列的三张实体表 */
const REVISION_TABLES: readonly string[] = ['events', 'todos', 'pending_items']

function tableExists(db: SqliteDb, table: string): boolean {
  const row = db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [table]
  )
  return row !== undefined
}

function columnNames(db: SqliteDb, table: string): string[] {
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name)
}

/** 仅在表存在且列存在时删列;SQLite 3.35+ 支持 ALTER TABLE ... DROP COLUMN */
function dropColumnIfExists(db: SqliteDb, table: string, column: string): void {
  if (!tableExists(db, table)) return
  if (!columnNames(db, table).includes(column)) return
  db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`)
}

function dropTables(db: SqliteDb, tables: readonly string[]): void {
  for (const table of tables) db.run(`DROP TABLE IF EXISTS ${table}`)
}

/** v1:基础 schema。up 施加的是当前完整形状,见文件头说明 */
const V1_BASE: Migration = {
  version: 1,
  name: 'base_schema',
  up: (db) => {
    db.run(SCHEMA_SQL)
  },
  down: (db) => {
    dropTables(db, [...MAIL_TABLES, ...BASE_TABLES, 'operation_receipts'])
  }
}

/** v2:邮件表(v1 之前的历史库没有它们) */
const V2_MAIL: Migration = {
  version: 2,
  name: 'mail_tables',
  up: (db) => {
    migrateMailV2(db)
  },
  down: (db) => {
    dropTables(db, MAIL_TABLES)
  }
}

/** v3:providers 增加 JSON 结构化输出能力开关 */
const V3_PROVIDER_JSON_MODE: Migration = {
  version: 3,
  name: 'provider_json_mode',
  up: (db) => {
    if (!tableExists(db, 'providers')) return
    if (columnNames(db, 'providers').includes('supports_json_mode')) return
    db.run('ALTER TABLE providers ADD COLUMN supports_json_mode INTEGER NOT NULL DEFAULT 0')
  },
  down: (db) => {
    dropColumnIfExists(db, 'providers', 'supports_json_mode')
  }
}

/** v4(M1 写入基础):实体 revision、操作回执 */
const V4_WRITE_BASICS: Migration = {
  version: 4,
  name: 'write_basics',
  up: (db) => {
    migrateM1(db)
  },
  down: (db) => {
    for (const table of REVISION_TABLES) dropColumnIfExists(db, table, 'revision')
    db.run('DROP TABLE IF EXISTS operation_receipts')
  }
}

/** v5(C-03):Agent 运行、轨迹事件与审批记录 */
const V5_AGENT_RUNS: Migration = {
  version: 5,
  name: 'agent_runs',
  up: (db) => {
    migrateM2(db)
  },
  down: (db) => {
    rollbackM2(db)
  }
}

/** 注册表:按 version 升序执行;新增迁移只允许追加,不回改已发布条目 */
export const MIGRATIONS: readonly Migration[] = [
  V1_BASE,
  V2_MAIL,
  V3_PROVIDER_JSON_MODE,
  V4_WRITE_BASICS,
  V5_AGENT_RUNS
]

/** 注册表支持的最高版本 */
export const REGISTRY_VERSION = MIGRATIONS.reduce((max, m) => (m.version > max ? m.version : max), 0)

const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`

/**
 * 建注册表自身的历史表。这张表是注册表的基础设施,
 * 不参与 down(回滚到空库后它仍在,但内容为空,因此 up 可重建全部业务表)。
 */
export function ensureMigrationsTable(db: SqliteDb): void {
  db.run(MIGRATIONS_TABLE_SQL)
}

export interface AppliedMigration {
  version: number
  name: string
  appliedAt: string
}

export function readApplied(db: SqliteDb): AppliedMigration[] {
  return db
    .all<{ version: number; name: string; applied_at: string }>(
      'SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC'
    )
    .map((r) => ({ version: r.version, name: r.name, appliedAt: r.applied_at }))
}

function metaSchemaVersion(db: SqliteDb): number | null {
  if (!tableExists(db, 'meta')) return null
  const row = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")
  if (!row) return null
  const parsed = parseInt(row.value, 10)
  return Number.isInteger(parsed) ? parsed : null
}

/**
 * 兼容既有库:meta.schema_version 存在而 schema_migrations 为空时,
 * 按版本回填历史记录(不重跑 DDL)。返回回填的条数。
 */
export function backfillFromMeta(db: SqliteDb): number {
  if (readApplied(db).length > 0) return 0
  const current = metaSchemaVersion(db)
  if (current === null) return 0
  const toBackfill = MIGRATIONS.filter((m) => m.version <= current)
  const stamp = nowTimestamp()
  for (const m of toBackfill) {
    db.run('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
      m.version,
      m.name,
      stamp
    ])
  }
  return toBackfill.length
}

/** 尚未应用的迁移,按 version 升序 */
export function pendingMigrations(db: SqliteDb): Migration[] {
  const applied = new Set(readApplied(db).map((a) => a.version))
  return MIGRATIONS.filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version)
}

/**
 * 既有库版本高于注册表时拒绝启动(与升级前的行为一致:不静默降级)。
 * 返回既有版本;无记录时返回 null。
 */
export function assertRegistryCanHandle(db: SqliteDb): number | null {
  const existing = metaSchemaVersion(db)
  if (existing !== null && existing > REGISTRY_VERSION) {
    throw new Error(`数据库版本 (${existing}) 高于当前支持的版本 (${REGISTRY_VERSION})`)
  }
  return existing
}

function recordApplied(db: SqliteDb, migration: Migration): void {
  db.run('INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
    migration.version,
    migration.name,
    nowTimestamp()
  ])
}

function syncMetaVersion(db: SqliteDb, version: number): void {
  if (!tableExists(db, 'meta')) return
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [String(version)])
}

/**
 * 应用全部待执行迁移。调用方负责事务边界(initSchema 用单事务包裹,
 * 与既有行为一致:失败整体回滚,不留半迁移状态)。
 * 返回最终版本。
 */
export function applyPending(db: SqliteDb): number {
  ensureMigrationsTable(db)
  const pending = pendingMigrations(db)
  for (const migration of pending) {
    migration.up(db)
    recordApplied(db, migration)
  }
  const finalVersion = readApplied(db).reduce((max, a) => (a.version > max ? a.version : max), 0)
  syncMetaVersion(db, finalVersion)
  return finalVersion
}

/**
 * 回滚到 target 版本(不含)。target=0 表示回滚到空库(仅保留 schema_migrations 空表)。
 * 逆序执行 down;返回回滚后的版本。
 */
export function rollbackTo(db: SqliteDb, target: number): number {
  ensureMigrationsTable(db)
  const applied = readApplied(db).sort((a, b) => b.version - a.version)
  for (const record of applied) {
    if (record.version <= target) continue
    const migration = MIGRATIONS.find((m) => m.version === record.version)
    if (!migration) {
      throw new Error(`无法回滚:注册表中不存在版本 ${record.version}(${record.name})`)
    }
    migration.down(db)
    db.run('DELETE FROM schema_migrations WHERE version = ?', [record.version])
  }
  const finalVersion = readApplied(db).reduce((max, a) => (a.version > max ? a.version : max), 0)
  syncMetaVersion(db, finalVersion)
  return finalVersion
}

export { OPERATION_RECEIPTS_SQL }
