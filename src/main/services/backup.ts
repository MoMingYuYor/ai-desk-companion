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
  'profile_facts',
  // 邮箱业务数据:保留已分析来源/版本/确认映射;
  // 账号、凭据、游标、收件缓存(mail_accounts/mail_sync_state/mail_messages/mail_attachments)不导出
  'mail_analysis_links',
  'mail_analysis_versions',
  'mail_confirmations'
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
  profile_facts: ['id', 'category', 'key', 'value', 'source', 'status', 'created_at', 'updated_at'],
  mail_analysis_links: ['source_key', 'message_id', 'conversation_id', 'snapshot', 'last_material_ids', 'status', 'last_error'],
  mail_analysis_versions: ['analysis_id', 'source_key', 'material_ids'],
  mail_confirmations: ['analysis_id', 'candidate_index', 'source_key', 'ref_type', 'ref_id']
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
    // 修复引用:备份不包含收件缓存,来源里的 message_id 若已无对应邮件则置空,
    // 保留"账号已移除/缓存不存在"的来源记录(分析快照仍在)
    db.run(
      'UPDATE mail_analysis_links SET message_id = NULL WHERE message_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM mail_messages WHERE id = mail_analysis_links.message_id)'
    )
  })
  return { imported }
}
