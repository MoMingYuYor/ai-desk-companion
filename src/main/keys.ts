// 模型密钥边界(R4):一律由系统安全存储(safeStorage)加密;禁止明文降级持久化,
// 历史 plain: 记录由 migrateLegacyProviderKeys 迁移,迁移前不可产出可用明文(模型路由不可用)。
import { safeStorage } from 'electron'
import { appError, type AppError } from '../shared/operations'
import type { SqliteDb } from './db/connection'

/**
 * 安全存储不可用的内部加密异常。
 * 公共层(IPC 边界)捕获后映射为 AppError{code:'AUTH_REQUIRED',retryable:false},
 * 脱敏 detail 说明内部原因,不携带密钥内容,也不新增公开细码。
 */
export class SecretStoreUnavailableError extends Error {
  readonly detail: string

  constructor(detail: string) {
    super('系统安全存储不可用,已拒绝保存密钥')
    this.name = 'SecretStoreUnavailableError'
    this.detail = detail
  }

  toAppError(): AppError {
    return appError('AUTH_REQUIRED', this.message, { retryable: false })
  }
}

/** 加密模型密钥;安全存储不可用或加密失败时抛 SecretStoreUnavailableError,绝不返回明文形态 */
export function encryptApiKey(plain: string): string {
  if (!plain) return ''
  if (!safeStorage.isEncryptionAvailable()) {
    throw new SecretStoreUnavailableError('safeStorage.isEncryptionAvailable() === false')
  }
  try {
    return safeStorage.encryptString(plain).toString('base64')
  } catch (err) {
    throw new SecretStoreUnavailableError(
      `safeStorage.encryptString 失败:${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * 解密模型密钥。仅接受 safeStorage 密文;
 * 历史 'plain:' 前缀一律返回 null——迁移前不得经模型路由继续使用,迁移成功后不应再存在。
 */
export function decryptApiKey(enc: string): string | null {
  if (!enc) return null
  if (enc.startsWith('plain:')) return null
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    }
  } catch {
    return null
  }
  return null
}

// ---------- 历史 plain: 密钥迁移 ----------

/** 迁移所需的安全存储最小接口(生产传 safeStorage 适配,测试注入替身) */
export interface LegacyKeyStorage {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
}

export interface LegacyKeyMigrationResult {
  /** 本次成功由 plain: 替换为安全密文的记录数 */
  migrated: number
  /** 仍是 plain:(不可用/损坏/加密失败)的待处理记录数 */
  pending: number
}

const LEGACY_PREFIX = 'plain:'
/** 启动诊断标记:meta 中记录当前待迁移的 plain: 数量,归零表示历史明文已清空 */
export const LEGACY_KEYS_PENDING_META = 'keys:legacy-pending'

function markPending(db: SqliteDb, pending: number): void {
  db.run(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [LEGACY_KEYS_PENDING_META, String(pending)]
  )
}

/** 校验 legacy 载荷是否为规范 base64(Node 对非法字符宽松,需回编码比对) */
function decodeLegacyPayload(payload: string): string | null {
  try {
    const decoded = Buffer.from(payload, 'base64').toString('utf-8')
    if (!decoded) return null
    const stripPad = (s: string): string => s.replace(/=+$/, '')
    if (stripPad(Buffer.from(decoded, 'utf-8').toString('base64')) !== stripPad(payload)) return null
    return decoded
  } catch {
    return null
  }
}

/**
 * 迁移历史 plain: 模型密钥。
 * - 加密可用:先把全部记录加密成功,再在独立事务中替换(任何一行失败都不落任何写入,可整体重试);
 * - 加密不可用:保留原始值(不静默丢数据),标为待处理;decryptApiKey 拒绝 plain:,
 *   因此这些记录不能经模型路由继续使用,直到迁移完成。
 */
export function migrateLegacyProviderKeys(db: SqliteDb, storage: LegacyKeyStorage): LegacyKeyMigrationResult {
  const rows = db.all<{ id: string; api_key_enc: string }>(
    "SELECT id, api_key_enc FROM providers WHERE api_key_enc LIKE 'plain:%'"
  )
  if (rows.length === 0) {
    markPending(db, 0)
    return { migrated: 0, pending: 0 }
  }
  if (!storage.isEncryptionAvailable()) {
    markPending(db, rows.length)
    return { migrated: 0, pending: rows.length }
  }

  const updates: Array<{ id: string; enc: string }> = []
  let pending = 0
  for (const row of rows) {
    const plain = decodeLegacyPayload(row.api_key_enc.slice(LEGACY_PREFIX.length))
    if (!plain) {
      // 载荷损坏:保留原值供人工排查,计入待处理
      pending += 1
      continue
    }
    try {
      updates.push({ id: row.id, enc: Buffer.from(storage.encryptString(plain)).toString('base64') })
    } catch {
      // 任一行加密失败:全部保留原值,下次启动可整体重试
      markPending(db, rows.length)
      return { migrated: 0, pending: rows.length }
    }
  }

  db.transaction(() => {
    for (const u of updates) {
      db.run('UPDATE providers SET api_key_enc = ? WHERE id = ?', [u.enc, u.id])
    }
  })
  markPending(db, pending)
  return { migrated: updates.length, pending }
}
