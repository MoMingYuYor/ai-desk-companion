// 手动备份与恢复(R1):导出/导入全部业务数据(不含模型密钥与邮箱账号/缓存)。
// 导入采取"先验校验 + 排他窗口 + 恢复前快照 + 失败回滚"的替换策略:
// 坏文件在任何写入之前拒绝;恢复落盘失败回到前快照,不让 UI 留在半恢复状态。
import { writeFileSync, readFileSync } from 'node:fs'
import type { SqliteDb } from '../db/connection'
import type { BackupFile } from '../../shared/types'
import { SCHEMA_VERSION } from '../db/schema'
import { nowTimestamp } from '../../shared/dateUtils'
import { appError } from '../../shared/operations'
import { bumpWorkspaceEpoch, OperationError } from '../db/operations'
import {
  BACKUP_APP_ID,
  BACKUP_TABLE_ORDER,
  getBackupVersionSpec,
  validateBackup,
  type BackupColumnSpec,
  type ValidatedBackup
} from '../backup/validate'

/** 受支持的备份版本:v3 旧备份受控迁移;v4 必须保留(否则旧备份无法恢复);v5 为当前格式 */
export const SUPPORTED_BACKUP_VERSIONS: readonly number[] = [3, 4, SCHEMA_VERSION]

type Row = Record<string, unknown>

/** 恢复前快照:业务表(含回执)的内存行副本 */
interface BusinessSnapshot {
  tables: Record<string, Row[]>
}

// ---------- 导出 ----------

export function exportBackup(db: SqliteDb, filePath: string): void {
  const spec = getBackupVersionSpec(SCHEMA_VERSION)
  const tables: Record<string, unknown[]> = {}
  for (const table of BACKUP_TABLE_ORDER) {
    if (!spec.tables[table]) continue
    tables[table] = db.all(`SELECT * FROM ${table}`)
  }
  const backup: BackupFile = {
    app: BACKUP_APP_ID,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: nowTimestamp(),
    tables
  }
  writeFileSync(filePath, JSON.stringify(backup, null, 2), 'utf-8')
}

// ---------- 文件读取与先验校验(任何写入之前) ----------

function readBackupFile(filePath: string): ValidatedBackup {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    throw new OperationError(appError('BACKUP_INVALID', '备份文件无法读取或不是有效 JSON', { retryable: false }))
  }
  return validateBackup(raw, SUPPORTED_BACKUP_VERSIONS)
}

// ---------- 替换写入 ----------

/** JSON 值归一为 SQLite 值:布尔按 0/1,缺失按 NULL(可空性已由校验保证) */
function normalizeValue(v: unknown): string | number | null {
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v === undefined || v === null) return null
  return v as string | number
}

function insertRows(db: SqliteDb, table: string, columns: BackupColumnSpec[], rows: Row[]): void {
  if (rows.length === 0) return
  const names = columns.map((c) => c.name)
  const placeholders = columns.map(() => '?').join(', ')
  for (const row of rows) {
    // 校验已保证主键唯一:用普通 INSERT,不用 INSERT OR REPLACE 静默覆盖冲突
    const values = columns.map((c) => normalizeValue(row[c.name]))
    db.run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders})`, values as never)
  }
}

/** 清空全部业务表(含回执):恢复是整体替换,回执随其引用的业务实体一起被替换 */
function clearBusinessTables(db: SqliteDb): void {
  for (const table of [...BACKUP_TABLE_ORDER].reverse()) {
    db.run(`DELETE FROM ${table}`)
  }
}

function replaceBusinessTables(db: SqliteDb, backup: ValidatedBackup): Record<string, number> {
  const spec = getBackupVersionSpec(backup.schemaVersion)
  const imported: Record<string, number> = {}
  db.transaction(() => {
    clearBusinessTables(db)
    for (const table of BACKUP_TABLE_ORDER) {
      const tableSpec = spec.tables[table]
      if (!tableSpec) continue
      const rows = backup.tables[table] ?? []
      insertRows(db, table, tableSpec.columns, rows)
      imported[table] = rows.length
    }
    // 修复引用:备份不包含收件缓存,来源里的 message_id 若已无对应邮件则置空,
    // 保留"账号已移除/缓存不存在"的来源记录(分析快照仍在)
    db.run(
      'UPDATE mail_analysis_links SET message_id = NULL WHERE message_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM mail_messages WHERE id = mail_analysis_links.message_id)'
    )
  })
  return imported
}

// ---------- 恢复前快照与失败回滚 ----------

/**
 * 建立恢复前快照。调用方必须已经建立排他窗口并排空在途写入——
 * 快照必须在门控之后、替换之前取得,才能保证失败回滚时内存/磁盘/原库三方一致。
 */
function captureSnapshot(db: SqliteDb): BusinessSnapshot {
  const tables: Record<string, Row[]> = {}
  for (const table of BACKUP_TABLE_ORDER) {
    tables[table] = db.all(`SELECT * FROM ${table}`) as Row[]
  }
  return { tables }
}

/** 回到恢复前快照:当前库是 v4,快照行按 v4 规格写回 */
function restoreSnapshot(db: SqliteDb, snapshot: BusinessSnapshot): void {
  const spec = getBackupVersionSpec(SCHEMA_VERSION)
  db.transaction(() => {
    clearBusinessTables(db)
    for (const table of BACKUP_TABLE_ORDER) {
      insertRows(db, table, spec.tables[table]!.columns, snapshot.tables[table] ?? [])
    }
  })
}

/**
 * 校验后的整体替换:快照 → 单事务替换 → 落盘确认;
 * 落盘失败回滚到前快照并再次尝试落盘(仍失败交给保存调度器重试),然后以
 * PERSIST_FAILED 拒绝,保证内存、磁盘与"原库"一致,不会停在半恢复状态。
 */
function replaceWithRollback(db: SqliteDb, backup: ValidatedBackup): { imported: Record<string, number> } {
  const snapshot = captureSnapshot(db)
  const imported = replaceBusinessTables(db, backup)
  try {
    db.flush()
  } catch {
    restoreSnapshot(db, snapshot)
    try {
      db.flush()
    } catch {
      // 恢复前快照也暂时无法落盘:保存调度器按 1/5/30/30 秒继续重试,内存已是前快照
    }
    throw new OperationError(
      appError('PERSIST_FAILED', '备份恢复已回滚:替换后的数据未能确认落盘', { retryable: true })
    )
  }
  return { imported }
}

// ---------- 同步导入入口(保持既有调用方与测试签名) ----------

/** 恢复采用"替换"策略:先验校验通过后清空业务表整体写入;密钥与设置不动 */
export function importBackup(db: SqliteDb, filePath: string): { imported: Record<string, number> } {
  const backup = readBackupFile(filePath)
  return replaceWithRollback(db, backup)
}

// ---------- 恢复排他窗口(R1) ----------

let restoreWindowOpen = false

/** 恢复窗口是否打开:打开期间新业务写入与新外部请求应被拒绝(任务 12 接线到 IPC/调度边界) */
export function isRestoreWindowOpen(): boolean {
  return restoreWindowOpen
}

/** 写入边界检查:恢复窗口内以 BUSY(可重试)拒绝新写入 */
export function ensureNotRestoring(): void {
  if (restoreWindowOpen) {
    throw new OperationError(appError('BUSY', '正在恢复备份,请稍后重试', { retryable: true }))
  }
}

export interface RestoreBackupOptions {
  /** 取消外部请求并等待在途任务结束,返回解除暂停函数(生产接线:mail.quiesceForBackup) */
  quiesceExternal?: () => Promise<() => void> | (() => void)
  /** 恢复成功结束后的广播:通知各窗口刷新 revision/workspaceEpoch(任务 12 接线) */
  onRestored?: () => void
}

export interface RestoreBackupResult {
  imported: Record<string, number>
  schemaVersion: number
}

/**
 * 恢复备份的排他窗口流程:
 * 先验(任何写入前) → 开窗阻止新写入 → 取消外部请求并等待在途任务结束 →
 * 提升 workspaceEpoch(旧窗口/旧异步任务随 STALE_PREVIEW 失效) →
 * 等待已接受事务排空并落盘(失败即中止,尚未发生替换) →
 * 门控后建立恢复前快照 → 单事务替换 → 落盘确认(失败回滚到前快照) → 广播刷新。
 */
export async function restoreBackup(
  db: SqliteDb,
  filePath: string,
  opts: RestoreBackupOptions = {}
): Promise<RestoreBackupResult> {
  if (restoreWindowOpen) {
    throw new OperationError(appError('BUSY', '已有备份恢复正在进行', { retryable: true }))
  }
  const backup = readBackupFile(filePath) // 先验:坏文件不值得开窗,也不产生任何写入
  restoreWindowOpen = true
  let resume: (() => void) | undefined
  try {
    resume = await opts.quiesceExternal?.()
    try {
      bumpWorkspaceEpoch()
      try {
        db.flush() // 已接受事务排空并落盘
      } catch {
        throw new OperationError(
          appError('PERSIST_FAILED', '恢复中止:当前数据未能确认落盘,未发生替换', { retryable: true })
        )
      }
      const { imported } = replaceWithRollback(db, backup)
      opts.onRestored?.()
      return { imported, schemaVersion: backup.schemaVersion }
    } finally {
      resume?.()
    }
  } finally {
    restoreWindowOpen = false
  }
}
