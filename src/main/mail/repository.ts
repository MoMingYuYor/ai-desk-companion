import { randomUUID } from 'node:crypto'
import type { SqlValue } from 'sql.js'
import type {
  MailAttachmentInfo,
  MailListQuery,
  MailSummary
} from '../../shared/mail'
import type { EnvelopeRow, PartInfo } from './adapter'
import type { SqliteDb } from '../db/connection'
import type { MailRepositoryPort, SyncState } from './ports'
import { MailError } from './errors'

interface MessageRow {
  id: string
  account_id: string
  mailbox: string
  uid_validity: string | null
  uid: number | null
  remote_message_id: string | null
  subject: string
  sender: string
  recipients: string
  received_at: string
  size: number
  read_local: number
  body_state: MailSummary['bodyState']
  body_path: string | null
  body_structure: string
  remote_available: number
}

interface AttachmentRow {
  id: string
  message_id: string
  part: string
  name: string
  mime: string
  size: number | null
  cache_path: string | null
}

const LIST_COLUMNS = `
  m.id AS id,
  m.account_id AS accountId,
  a.label AS accountLabel,
  m.subject AS subject,
  m.sender AS "from",
  m.recipients AS "to",
  m.received_at AS receivedAt,
  m.read_local AS read,
  EXISTS(SELECT 1 FROM mail_attachments at WHERE at.message_id = m.id) AS hasAttachments,
  m.body_state AS bodyState,
  m.remote_available AS remoteAvailable
`

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

function toBoolean(value: number | boolean | null | undefined): boolean {
  return value === 1 || value === true
}

function storageError(err: unknown): MailError {
  if (err instanceof MailError) return err
  return new MailError('STORAGE', `邮件存储操作失败: ${err instanceof Error ? err.message : String(err)}`)
}

export class MailRepository implements MailRepositoryPort {
  constructor(private readonly db: SqliteDb) {}

  /** 读取同步游标;无记录时返回初始值 */
  state(accountId: string): SyncState {
    const row = this.db.get<{
      mailbox: string
      uid_validity: string | null
      last_uid: number
      oldest_day: string | null
      initialized: number
    }>('SELECT mailbox, uid_validity, last_uid, oldest_day, initialized FROM mail_sync_state WHERE account_id = ?', [
      accountId
    ])
    if (!row) {
      return { mailbox: 'INBOX', uidValidity: null, lastUid: 0, oldestDay: null, initialized: false }
    }
    return {
      mailbox: row.mailbox || 'INBOX',
      uidValidity: row.uid_validity ?? null,
      lastUid: row.last_uid ?? 0,
      oldestDay: row.oldest_day ?? null,
      initialized: row.initialized === 1
    }
  }

  private findExisting(accountId: string, mailbox: string, validity: string, uid: number): MessageRow | undefined {
    return this.db.get<MessageRow>(
      'SELECT * FROM mail_messages WHERE account_id = ? AND mailbox = ? AND uid_validity = ? AND uid = ?',
      [accountId, mailbox, validity, uid]
    )
  }

  /**
   * UIDVALIDITY 重建时按 Message-ID+接收时间+发件人+主题+大小 匹配
   * 已失效(remote_available=0)的旧行,唯一匹配才复用旧本地 ID,歧义不合并。
   */
  private findReusableRow(accountId: string, row: EnvelopeRow): MessageRow | undefined {
    const matches = this.db.all<MessageRow>(
      `SELECT * FROM mail_messages
       WHERE account_id = ? AND remote_available = 0
         AND remote_message_id IS ? AND received_at = ? AND sender = ? AND subject = ? AND size = ?`,
      [accountId, row.messageId, row.receivedAt, row.from, row.subject, row.size]
    )
    return matches.length === 1 ? matches[0] : undefined
  }

  private insertAttachments(messageId: string, row: EnvelopeRow, ignoreExisting: boolean): void {
    for (const part of row.attachments) {
      const verb = ignoreExisting ? 'INSERT OR IGNORE' : 'INSERT'
      this.db.run(
        `${verb} INTO mail_attachments (id, message_id, part, name, mime, size, cache_path)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        [randomUUID(), messageId, part.part, part.name, part.mime, part.size]
      )
    }
  }

  private insertMessage(accountId: string, mailbox: string, validity: string, row: EnvelopeRow): string {
    const id = randomUUID()
    this.db.run(
      `INSERT INTO mail_messages
        (id, account_id, mailbox, uid_validity, uid, remote_message_id, subject, sender, recipients,
         received_at, size, read_local, body_state, body_path, body_structure, remote_available)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'missing', NULL, ?, 1)`,
      [
        id,
        accountId,
        mailbox,
        validity,
        row.uid,
        row.messageId,
        row.subject,
        row.from,
        row.to,
        row.receivedAt,
        row.size,
        row.seen ? 1 : 0,
        JSON.stringify(row)
      ]
    )
    this.insertAttachments(id, row, false)
    return id
  }

  private updateCursor(accountId: string, next: SyncState): void {
    this.db.run(
      `INSERT INTO mail_sync_state (account_id, mailbox, uid_validity, last_uid, oldest_day, initialized)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         mailbox = excluded.mailbox,
         uid_validity = excluded.uid_validity,
         last_uid = excluded.last_uid,
         oldest_day = excluded.oldest_day,
         initialized = excluded.initialized`,
      [
        accountId,
        next.mailbox || 'INBOX',
        next.uidValidity,
        next.lastUid,
        next.oldestDay,
        next.initialized ? 1 : 0
      ]
    )
  }

  /**
   * 事务内写入一批邮件与附件并推进游标;已存在的行不覆盖 read_local/body_state/body_path;
   * UIDVALIDITY 重建时按指纹复用旧本地 ID。事务成功后 flush 落盘,返回本次新增数。
   */
  commitBatch(accountId: string, validity: string, rows: EnvelopeRow[], next: SyncState): number {
    try {
      let added = 0
      this.db.transaction(() => {
        const mailbox = next.mailbox || 'INBOX'
        for (const row of rows) {
          const existing = this.findExisting(accountId, mailbox, validity, row.uid)
          if (existing) continue
          const reusable = this.findReusableRow(accountId, row)
          if (reusable) {
            this.db.run(
              'UPDATE mail_messages SET mailbox = ?, uid_validity = ?, uid = ?, remote_available = 1, body_structure = ? WHERE id = ?',
              [mailbox, validity, row.uid, JSON.stringify(row), reusable.id]
            )
            this.insertAttachments(reusable.id, row, true)
          } else {
            this.insertMessage(accountId, mailbox, validity, row)
          }
          added += 1
        }
        this.updateCursor(accountId, next)
      })
      this.db.flush()
      return added
    } catch (err) {
      throw storageError(err)
    }
  }

  private listSql(where: string, params: SqlValue[], page: number): { items: MailSummary[]; hasMore: boolean } {
    const rows = this.db.all<{
      id: string
      accountId: string
      accountLabel: string
      subject: string
      from: string
      to: string
      receivedAt: string
      read: number
      hasAttachments: number
      bodyState: MailSummary['bodyState']
      remoteAvailable: number
    }>(
      `SELECT ${LIST_COLUMNS}
       FROM mail_messages m
       JOIN mail_accounts a ON a.id = m.account_id
       ${where}
       ORDER BY m.received_at DESC, m.id DESC
       LIMIT 51 OFFSET ?`,
      [...params, page * 50]
    )
    const hasMore = rows.length > 50
    return {
      items: rows.slice(0, 50).map((row) => this.toSummary(row)),
      hasMore
    }
  }

  private toSummary(row: {
    id: string
    accountId: string
    accountLabel: string
    subject: string
    from: string
    to: string
    receivedAt: string
    read: number
    hasAttachments: number
    bodyState: MailSummary['bodyState']
    remoteAvailable: number
  }): MailSummary {
    return {
      id: row.id,
      accountId: row.accountId,
      accountLabel: row.accountLabel,
      subject: row.subject,
      from: row.from,
      to: row.to,
      receivedAt: row.receivedAt,
      read: toBoolean(row.read),
      hasAttachments: toBoolean(row.hasAttachments),
      bodyState: row.bodyState,
      remoteAvailable: toBoolean(row.remoteAvailable)
    }
  }

  list(query: MailListQuery): { items: MailSummary[]; hasMore: boolean } {
    const clauses: string[] = []
    const params: SqlValue[] = []

    if (query.accountId != null && query.accountId !== '') {
      clauses.push('m.account_id = ?')
      params.push(query.accountId)
    }
    if (query.unreadOnly) {
      clauses.push('m.read_local = 0')
    }
    const search = (query.search ?? '').trim().slice(0, 200)
    if (search !== '') {
      const pattern = `%${escapeLike(search)}%`
      clauses.push(`(m.subject LIKE ? ESCAPE '\\' OR m.sender LIKE ? ESCAPE '\\' OR m.recipients LIKE ? ESCAPE '\\')`)
      params.push(pattern, pattern, pattern)
    }
    const page = Number.isFinite(query.page) ? Math.max(0, Math.floor(query.page as number)) : 0
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    return this.listSql(where, params, page)
  }

  get(id: string): MailSummary | null {
    const row = this.db.get<{
      id: string
      accountId: string
      accountLabel: string
      subject: string
      from: string
      to: string
      receivedAt: string
      read: number
      hasAttachments: number
      bodyState: MailSummary['bodyState']
      remoteAvailable: number
    }>(
      `SELECT ${LIST_COLUMNS}
       FROM mail_messages m
       JOIN mail_accounts a ON a.id = m.account_id
       WHERE m.id = ?`,
      [id]
    )
    return row ? this.toSummary(row) : null
  }

  markRead(id: string, read: boolean): void {
    this.db.run('UPDATE mail_messages SET read_local = ? WHERE id = ?', [read ? 1 : 0, id])
    this.db.flush()
  }

  setBodyCache(id: string, path: string): void {
    this.db.run("UPDATE mail_messages SET body_state = 'cached', body_path = ? WHERE id = ?", [path, id])
    this.db.flush()
  }

  setAttachmentCache(id: string, path: string): void {
    this.db.run('UPDATE mail_attachments SET cache_path = ? WHERE id = ?', [path, id])
    this.db.flush()
  }

  attachment(id: string): (MailAttachmentInfo & { part: string; cachePath: string | null }) | null {
    const row = this.db.get<AttachmentRow>(
      'SELECT id, message_id, part, name, mime, size, cache_path FROM mail_attachments WHERE id = ?',
      [id]
    )
    if (!row) return null
    return {
      id: row.id,
      messageId: row.message_id,
      name: row.name,
      mime: row.mime,
      size: row.size,
      downloaded: row.cache_path != null,
      analyzable: isAnalyzable(row.mime),
      part: row.part,
      cachePath: row.cache_path ?? null
    }
  }

  /** 内容服务内部读取:不直接跨 IPC,包含 UID、结构与正文路径 */
  record(id: string): {
    message: MailSummary
    uid: number | null
    uidValidity: string | null
    structure: EnvelopeRow
    bodyPath: string | null
  } | null {
    const row = this.db.get<MessageRow & { account_label: string }>(
      'SELECT m.*, a.label AS account_label FROM mail_messages m JOIN mail_accounts a ON a.id = m.account_id WHERE m.id = ?',
      [id]
    )
    if (!row) return null
    return {
      message: {
        id: row.id,
        accountId: row.account_id,
        accountLabel: row.account_label,
        subject: row.subject,
        from: row.sender,
        to: row.recipients,
        receivedAt: row.received_at,
        read: row.read_local === 1,
        hasAttachments: false,
        bodyState: row.body_state,
        remoteAvailable: row.remote_available === 1
      },
      uid: row.uid,
      uidValidity: row.uid_validity ?? null,
      structure: parseStructure(row.body_structure, row),
      bodyPath: row.body_path ?? null
    }
  }

  /** 远端失效(如 UIDVALIDITY 变化):禁止再对旧行取远端 part */
  invalidateRemote(accountId: string): void {
    this.db.run('UPDATE mail_messages SET remote_available = 0 WHERE account_id = ?', [accountId])
  }

  /** 移除账号收件缓存:附件随消息一起删除 */
  removeAccountCache(accountId: string): void {
    this.db.transaction(() => {
      this.db.run(
        'DELETE FROM mail_attachments WHERE message_id IN (SELECT id FROM mail_messages WHERE account_id = ?)',
        [accountId]
      )
      this.db.run('DELETE FROM mail_messages WHERE account_id = ?', [accountId])
    })
    this.db.flush()
  }
}

function isAnalyzable(mime: string): boolean {
  return mime.startsWith('text/') || mime === 'application/pdf' || mime === 'application/json'
}

function parseStructure(json: string, row: MessageRow): EnvelopeRow {
  let parts: { textParts?: PartInfo[]; htmlParts?: PartInfo[]; attachments?: PartInfo[] } = {}
  try {
    const parsed = JSON.parse(json) as {
      textParts?: PartInfo[]
      htmlParts?: PartInfo[]
      attachments?: PartInfo[]
    }
    parts = parsed ?? {}
  } catch {
    parts = {}
  }
  return {
    uid: row.uid ?? 0,
    messageId: row.remote_message_id,
    subject: row.subject,
    from: row.sender,
    to: row.recipients,
    receivedAt: row.received_at,
    size: row.size,
    seen: row.read_local === 1,
    textParts: parts.textParts ?? [],
    htmlParts: parts.htmlParts ?? [],
    attachments: parts.attachments ?? []
  }
}
