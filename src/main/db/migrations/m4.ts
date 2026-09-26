import type { SqliteDb } from '../connection'

// M4(A-01/A-04):邮件草稿表与审批参数持久化。
//
// - mail_drafts:草稿永远没有发送状态字段(模块规格第 6 节"草稿不能出现发送状态")。
// - approvals.arguments_json:批准记录必须持久化"已校验的完整参数",
//   否则进程重启后无法执行已批准的写操作(OPS-10 窗口关闭后恢复)。
//   该列对旧库用 addColumnIfMissing 追加,与 m1 的 revision 列同一模式;
//   新库的 SCHEMA_SQL(m2)已直接包含该列。

export const MAIL_DRAFTS_SQL = `
CREATE TABLE IF NOT EXISTS mail_drafts (
  draft_id TEXT PRIMARY KEY,
  recipients TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  source_ref TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

function columnExists(db: SqliteDb, table: string, column: string): boolean {
  const cols = db.all<{ name: string }>(`PRAGMA table_info(${table})`)
  return cols.some((c) => c.name === column)
}

/** v6 → v7:邮件草稿表 + 审批参数持久化列 */
export function migrateM4(db: SqliteDb): void {
  db.run(MAIL_DRAFTS_SQL)
  if (!columnExists(db, 'approvals', 'arguments_json')) {
    db.run('ALTER TABLE approvals ADD COLUMN arguments_json TEXT')
  }
}

/** 回滚 v7:删草稿表;arguments_json 一并删除(SQLite 3.35+ 支持 DROP COLUMN) */
export function rollbackM4(db: SqliteDb): void {
  db.run('DROP TABLE IF EXISTS mail_drafts')
  const cols = db.all<{ name: string }>('PRAGMA table_info(approvals)')
  if (cols.some((c) => c.name === 'arguments_json')) {
    db.run('ALTER TABLE approvals DROP COLUMN arguments_json')
  }
}
