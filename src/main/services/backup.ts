// 手动备份与恢复:导出/导入全部业务数据(不含模型密钥)
import { writeFileSync, readFileSync } from 'node:fs'
import type { SqliteDb } from '../db/connection'
import type { BackupFile } from '../../shared/types'
import { SCHEMA_VERSION } from '../db/schema'
import { nowTimestamp } from '../../shared/dateUtils'

const BACKUP_TABLES = [
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
  'profile_facts'
] as const

const TABLE_COLUMNS: Record<string, string[]> = {
  conversations: ['id', 'title', 'kind', 'status', 'created_at', 'updated_at'],
  messages: ['id', 'conversation_id', 'role', 'content', 'model_label', 'meta', 'created_at'],
  materials: ['id', 'conversation_id', 'name', 'type', 'mime', 'size', 'content', 'path', 'parse_error', 'created_at'],
  analyses: ['id', 'conversation_id', 'version', 'payload', 'raw_response', 'model_label', 'status', 'error', 'created_at'],
  events: [
    'id', 'title', 'start_at', 'end_at', 'all_day', 'color', 'location', 'notes',
    'source', 'source_ref', 'reminder_minutes', 'status', 'fingerprint', 'created_at', 'updated_at'
  ],
  todos: [
    'id', 'title', 'notes', 'due_at', 'priority', 'completed_at', 'linked_event_id',
    'source', 'source_ref', 'fingerprint', 'created_at', 'updated_at'
  ],
  pending_items: ['id', 'conversation_id', 'title', 'notes', 'status', 'created_at', 'updated_at'],
  semesters: ['id', 'name', 'start_date', 'weeks', 'created_at'],
  courses: ['id', 'semester_id', 'name', 'weekday', 'start_time', 'end_time', 'weeks', 'location', 'teacher', 'created_at'],
  course_overrides: ['id', 'course_id', 'date', 'kind', 'new_start_time', 'new_end_time', 'new_location', 'note', 'created_at'],
  school_events: ['id', 'semester_id', 'type', 'title', 'start_date', 'end_date', 'note', 'created_at'],
  profile_facts: ['id', 'category', 'key', 'value', 'source', 'status', 'created_at', 'updated_at']
}

export function exportBackup(db: SqliteDb, filePath: string): void {
  const tables: Record<string, unknown[]> = {}
  for (const table of BACKUP_TABLES) {
    tables[table] = db.all(`SELECT * FROM ${table}`)
  }
  const backup: BackupFile = {
    app: 'ai-desk-companion',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: nowTimestamp(),
    tables
  }
  writeFileSync(filePath, JSON.stringify(backup, null, 2), 'utf-8')
}

/** 恢复采用"替换"策略:清空业务表后整体写入;密钥与设置不动 */
export function importBackup(db: SqliteDb, filePath: string): { imported: Record<string, number> } {
  const raw = readFileSync(filePath, 'utf-8')
  const backup = JSON.parse(raw) as BackupFile
  if (!backup || !backup.tables) throw new Error('不是有效的备份文件')
  const imported: Record<string, number> = {}
  db.transaction(() => {
    for (const table of [...BACKUP_TABLES].reverse()) {
      db.run(`DELETE FROM ${table}`)
    }
    for (const table of BACKUP_TABLES) {
      const rows = backup.tables[table]
      if (!Array.isArray(rows)) continue
      const cols = TABLE_COLUMNS[table]
      for (const row of rows as Array<Record<string, unknown>>) {
        const values = cols.map((c) => row[c] ?? null)
        db.run(
          `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          values as never
        )
      }
      imported[table] = rows.length
    }
  })
  return { imported }
}
