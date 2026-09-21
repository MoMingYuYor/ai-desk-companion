import type { SqliteDb } from '../connection'

// M1(写入基础,S1 分配的实际 schema 版本为 4):
// 实体 revision、操作回执。升级只在迁移事务成功提交后发生(initSchema 统一包装),
// 旧 ID 与行数不变;重复启动通过 PRAGMA table_info 防重复加列保持幂等。

export const OPERATION_RECEIPTS_SQL = `
CREATE TABLE IF NOT EXISTS operation_receipts (
  operation_id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_ref TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`

function addColumnIfMissing(db: SqliteDb, table: string, columnDdl: string, column: string): void {
  const cols = db.all<{ name: string }>(`PRAGMA table_info(${table})`)
  if (cols.some((c) => c.name === column)) return
  db.run(`ALTER TABLE ${table} ADD COLUMN ${columnDdl}`)
}

/** v3 → v4:events/todos/pending_items 增加 revision,新增 operation_receipts */
export function migrateM1(db: SqliteDb): void {
  addColumnIfMissing(db, 'events', 'revision INTEGER NOT NULL DEFAULT 1', 'revision')
  addColumnIfMissing(db, 'todos', 'revision INTEGER NOT NULL DEFAULT 1', 'revision')
  addColumnIfMissing(db, 'pending_items', 'revision INTEGER NOT NULL DEFAULT 1', 'revision')
  db.run(OPERATION_RECEIPTS_SQL)
}
