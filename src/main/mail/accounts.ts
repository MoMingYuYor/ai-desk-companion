import { randomUUID } from 'node:crypto'
import type { MailAccountInfo, MailAccountInput, MailErrorCode } from '../../shared/mail'
import type { SqliteDb } from '../db/connection'
import type { CredentialStorage } from './credentials'
import { decryptCredential, encryptCredential } from './credentials'
import { MailError } from './errors'
import { resolvePreset, validateAccountInput } from './presets'

interface AccountRow {
  id: string
  label: string
  email: string
  provider: MailAccountInfo['provider']
  host: string
  port: number
  credential_enc: string
  enabled: number
  status: MailAccountInfo['status']
  last_success_at: string | null
  error_code: string | null
  error_message: string | null
}

/** 账号配置存储:校验、加密凭据与状态维护。凭据明文绝不进入返回值。 */
export class MailAccountStore {
  constructor(
    private readonly db: SqliteDb,
    private readonly storage: CredentialStorage
  ) {}

  private rowToInfo(row: AccountRow): MailAccountInfo {
    return {
      id: row.id,
      label: row.label,
      email: row.email,
      provider: row.provider,
      host: row.host,
      port: row.port,
      enabled: row.enabled === 1,
      hasCredential: row.credential_enc != null && row.credential_enc !== '',
      status: row.status,
      lastSuccessAt: row.last_success_at ?? null,
      error:
        row.error_code != null
          ? { code: row.error_code as MailErrorCode, message: row.error_message ?? '' }
          : null
    }
  }

  private getRow(id: string): AccountRow | undefined {
    return this.db.get<AccountRow>('SELECT * FROM mail_accounts WHERE id = ?', [id])
  }

  list(): MailAccountInfo[] {
    const rows = this.db.all<AccountRow>('SELECT * FROM mail_accounts ORDER BY created_at ASC, id ASC')
    return rows.map((row) => this.rowToInfo(row))
  }

  get(id: string): MailAccountInfo | null {
    const row = this.getRow(id)
    return row ? this.rowToInfo(row) : null
  }

  /**
   * 保存已通过测试连接的账号。
   * 新账号必须带 credential;编辑省略 credential 保留旧值;
   * email/host/port 身份变化拒绝(提示移除后重新添加,避免复用旧 UID);
   * 同 host+port+email 的重复账号拒绝。
   */
  saveVerified(input: MailAccountInput): MailAccountInfo {
    const clean = validateAccountInput(input)
    const { host, port } = resolvePreset(clean.provider, clean.host, clean.port)
    const email = clean.email

    const duplicate = this.db.get<{ id: string }>(
      'SELECT id FROM mail_accounts WHERE host = ? AND port = ? AND email = ?',
      [host, port, email]
    )
    if (duplicate && duplicate.id !== input.id) {
      throw new MailError('INVALID_CONFIG', '相同服务器与地址的账号已存在')
    }

    if (input.id != null && input.id !== '') {
      const existing = this.getRow(input.id)
      if (!existing) throw new MailError('NOT_FOUND', '要编辑的账号不存在')
      if (existing.email !== email || existing.host !== host || existing.port !== port) {
        throw new MailError('INVALID_CONFIG', '邮箱地址与服务器信息不能修改,请移除后重新添加')
      }
      const credentialEnc = input.credential
        ? encryptCredential(input.credential, this.storage)
        : existing.credential_enc
      this.db.run(
        'UPDATE mail_accounts SET label = ?, provider = ?, credential_enc = ? WHERE id = ?',
        [clean.label, clean.provider, credentialEnc, input.id]
      )
      return this.get(input.id) as MailAccountInfo
    }

    if (!input.credential) {
      throw new MailError('INVALID_CONFIG', '新账号必须提供凭据')
    }
    // 加密在插入之前执行:系统加密不可用时数据库不会出现新行
    const credentialEnc = encryptCredential(input.credential, this.storage)
    const id = randomUUID()
    this.db.run(
      `INSERT INTO mail_accounts (id, label, email, provider, host, port, credential_enc, enabled, status, last_success_at, error_code, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'idle', NULL, NULL, NULL, ?)`,
      [id, clean.label, email, clean.provider, host, port, credentialEnc, new Date().toISOString()]
    )
    return this.get(id) as MailAccountInfo
  }

  /** 取出解密后的连接信息;账号不存在抛 NOT_FOUND,解密失败抛 CRYPTO */
  connection(id: string): { host: string; port: number; email: string; password: string } {
    const row = this.getRow(id)
    if (!row) throw new MailError('NOT_FOUND', '账号不存在')
    let password: string
    try {
      password = decryptCredential(row.credential_enc, this.storage)
    } catch (err) {
      if (err instanceof MailError) throw err
      throw new MailError('CRYPTO', '凭据解密失败')
    }
    return { host: row.host, port: row.port, email: row.email, password }
  }

  setEnabled(id: string, enabled: boolean): void {
    const row = this.getRow(id)
    if (!row) throw new MailError('NOT_FOUND', '账号不存在')
    // 停用即暂停同步;重新启用仅把 paused 拨回 idle,不打断真实 error 展示
    const nextStatus = enabled ? (row.status === 'paused' ? 'idle' : row.status) : 'paused'
    this.db.run('UPDATE mail_accounts SET enabled = ?, status = ? WHERE id = ?', [
      enabled ? 1 : 0,
      nextStatus,
      id
    ])
  }

  setStatus(id: string, status: MailAccountInfo['status'], error?: { code: MailErrorCode; message: string }): void {
    this.db.run('UPDATE mail_accounts SET status = ?, error_code = ?, error_message = ? WHERE id = ?', [
      status,
      error ? error.code : null,
      error ? error.message : null,
      id
    ])
  }

  /** 删除账号并清空其同步游标与收件缓存(附件随消息级联删除) */
  remove(id: string): void {
    this.db.transaction(() => {
      this.db.run(
        'DELETE FROM mail_attachments WHERE message_id IN (SELECT id FROM mail_messages WHERE account_id = ?)',
        [id]
      )
      this.db.run('DELETE FROM mail_messages WHERE account_id = ?', [id])
      this.db.run('DELETE FROM mail_sync_state WHERE account_id = ?', [id])
      this.db.run('DELETE FROM mail_accounts WHERE id = ?', [id])
    })
    this.db.flush()
  }

  /** 完整同步成功后刷新成功时间并清除错误状态 */
  updateSuccess(id: string): void {
    this.db.run(
      "UPDATE mail_accounts SET last_success_at = ?, status = 'idle', error_code = NULL, error_message = NULL WHERE id = ?",
      [new Date().toISOString(), id]
    )
  }
}
