import { describe, expect, it } from 'vitest'
import { makeTestDb } from '../helpers'
import { MailAccountStore } from '../../src/main/mail/accounts'
import { MailRepository } from '../../src/main/mail/repository'
import type { CredentialStorage } from '../../src/main/mail/credentials'
import type { EnvelopeRow } from '../../src/main/mail/adapter'
import type { SyncState } from '../../src/main/mail/ports'

const storage: CredentialStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
  decryptString: (value: Buffer) => Buffer.from(value).toString('utf8').slice(4)
}

function envelope(uid: number, overrides: Partial<EnvelopeRow> = {}): EnvelopeRow {
  return {
    uid,
    messageId: `<msg-${uid}@example.com>`,
    subject: `通知 ${uid}`,
    from: 'sender@example.com',
    to: 'me@example.com',
    receivedAt: '2026-09-10T08:00:00.000Z',
    size: 1024,
    seen: false,
    textParts: [{ part: '1', name: '', mime: 'text/plain', size: 100, charset: 'utf-8' }],
    htmlParts: [],
    attachments: [],
    ...overrides
  }
}

function state(overrides: Partial<SyncState> = {}): SyncState {
  return {
    mailbox: 'INBOX',
    uidValidity: '111',
    lastUid: 0,
    oldestDay: '2026-08-17',
    initialized: true,
    ...overrides
  }
}

async function setup() {
  const db = await makeTestDb()
  const accounts = new MailAccountStore(db, storage)
  const repository = new MailRepository(db)
  const a1 = accounts.saveVerified({
    label: '一号',
    email: 'one@example.com',
    provider: 'custom',
    host: 'imap1.example.com',
    port: 993,
    credential: 'pw-1'
  })
  const a2 = accounts.saveVerified({
    label: '二号',
    email: 'two@example.com',
    provider: 'custom',
    host: 'imap2.example.com',
    port: 993,
    credential: 'pw-2'
  })
  return { db, accounts, repository, a1, a2 }
}

describe('MailRepository', () => {
  it('state 无记录时返回初始值', async () => {
    const { repository } = await setup()
    expect(repository.state('unknown')).toEqual({
      mailbox: 'INBOX',
      uidValidity: null,
      lastUid: 0,
      oldestDay: null,
      initialized: false
    })
  })

  it('commitBatch 写入邮件与附件并推进游标', async () => {
    const { db, repository, a1 } = await setup()
    const rows = [
      envelope(1, { attachments: [{ part: '2', name: '报告.pdf', mime: 'application/pdf', size: 500 }] }),
      envelope(2, { receivedAt: '2026-09-11T09:30:00.000Z' })
    ]
    const added = repository.commitBatch(a1.id, '111', rows, state({ lastUid: 2 }))
    expect(added).toBe(2)
    expect(db.all('SELECT * FROM mail_messages')).toHaveLength(2)
    expect(db.all('SELECT * FROM mail_attachments')).toHaveLength(1)
    expect(repository.state(a1.id)).toMatchObject({
      mailbox: 'INBOX',
      uidValidity: '111',
      lastUid: 2,
      oldestDay: '2026-08-17',
      initialized: true
    })
    const item = repository.list({ accountId: a1.id }).items.find((m) => m.subject === '通知 1')
    expect(item).toMatchObject({
      accountId: a1.id,
      accountLabel: '一号',
      from: 'sender@example.com',
      to: 'me@example.com',
      receivedAt: '2026-09-10T08:00:00.000Z',
      read: false,
      hasAttachments: true,
      bodyState: 'missing',
      remoteAvailable: true
    })
  })

  it('重复批次不产生重复行,返回 0', async () => {
    const { db, repository, a1 } = await setup()
    const rows = [envelope(1), envelope(2)]
    expect(repository.commitBatch(a1.id, '111', rows, state({ lastUid: 2 }))).toBe(2)
    expect(repository.commitBatch(a1.id, '111', rows, state({ lastUid: 2 }))).toBe(0)
    expect(db.all('SELECT * FROM mail_messages')).toHaveLength(2)
  })

  it('跨账号相同 UID 与 validity 不冲突', async () => {
    const { db, repository, a1, a2 } = await setup()
    const rows = [envelope(1), envelope(2)]
    repository.commitBatch(a1.id, '111', rows, state({ lastUid: 2 }))
    repository.commitBatch(a2.id, '111', rows, state({ lastUid: 2 }))
    expect(db.all('SELECT * FROM mail_messages')).toHaveLength(4)
    expect(repository.list({ accountId: a1.id }).items.every((m) => m.accountId === a1.id)).toBe(true)
    expect(repository.list({ accountId: a2.id })).toMatchObject({ hasMore: false })
    expect(repository.list({ accountId: a2.id }).items).toHaveLength(2)
  })

  it('相同 Message-ID 不合并(不同 UID 各自成行)', async () => {
    const { db, repository, a1 } = await setup()
    const rows = [
      envelope(1, { messageId: '<same@example.com>' }),
      envelope(2, { messageId: '<same@example.com>' })
    ]
    repository.commitBatch(a1.id, '111', rows, state({ lastUid: 2 }))
    expect(db.all('SELECT * FROM mail_messages')).toHaveLength(2)
  })

  it('刷新覆盖不回退 read_local 与正文缓存', async () => {
    const { repository, a1 } = await setup()
    repository.commitBatch(a1.id, '111', [envelope(1)], state({ lastUid: 1 }))
    const item = repository.list({ accountId: a1.id }).items[0]
    repository.markRead(item.id, true)
    repository.setBodyCache(item.id, '/cache/body-1.html')

    repository.commitBatch(a1.id, '111', [envelope(1, { seen: true })], state({ lastUid: 1 }))
    const refreshed = repository.get(item.id)
    expect(refreshed).toMatchObject({ read: true, bodyState: 'cached' })
    const record = repository.record(item.id)
    expect(record?.bodyPath).toBe('/cache/body-1.html')
  })

  it('分页返回 50 条并用 LIMIT 51 推断 hasMore', async () => {
    const { repository, a1 } = await setup()
    const rows: EnvelopeRow[] = []
    for (let i = 1; i <= 55; i += 1) {
      rows.push(
        envelope(i, {
          receivedAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString()
        })
      )
    }
    repository.commitBatch(a1.id, '111', rows, state({ lastUid: 55 }))
    const page0 = repository.list({ accountId: a1.id, page: 0 })
    expect(page0.items).toHaveLength(50)
    expect(page0.hasMore).toBe(true)
    const page1 = repository.list({ accountId: a1.id, page: 1 })
    expect(page1.items).toHaveLength(5)
    expect(page1.hasMore).toBe(false)
    // 固定按 received_at 倒序
    expect(page0.items[0].subject).toBe('通知 55')
    const page2 = repository.list({ accountId: a1.id, page: 2 })
    expect(page2.items).toHaveLength(0)
  })

  it('unreadOnly 与 search 过滤', async () => {
    const { repository, a1 } = await setup()
    repository.commitBatch(
      a1.id,
      '111',
      [envelope(1, { subject: '会议通知' }), envelope(2, { subject: '账单提醒' })],
      state({ lastUid: 2 })
    )
    const target = repository
      .list({ accountId: a1.id })
      .items.find((m) => m.subject === '会议通知')
    expect(target).toBeTruthy()
    repository.markRead(target!.id, true)
    expect(repository.list({ accountId: a1.id, unreadOnly: true }).items.map((m) => m.subject)).toEqual(['账单提醒'])

    const hit = repository.list({ accountId: a1.id, search: '会议' })
    expect(hit.items.map((m) => m.subject)).toEqual(['会议通知'])
  })

  it('LIKE 搜索转义 % _ 与反斜杠', async () => {
    const { repository, a1 } = await setup()
    repository.commitBatch(
      a1.id,
      '111',
      [
        envelope(1, { subject: '奖励 100% 达成' }),
        envelope(2, { subject: '纯文本提醒' }),
        envelope(3, { subject: 'a_b 命名规则' }),
        envelope(4, { subject: 'axb 混合串' })
      ],
      state({ lastUid: 4 })
    )
    // % 只匹配字面百分号,不作为通配符
    expect(repository.list({ accountId: a1.id, search: '100%' }).items.map((m) => m.subject)).toEqual([
      '奖励 100% 达成'
    ])
    expect(repository.list({ accountId: a1.id, search: '%' }).items).toHaveLength(1)
    // _ 只匹配字面下划线
    expect(repository.list({ accountId: a1.id, search: 'a_b' }).items.map((m) => m.subject)).toEqual([
      'a_b 命名规则'
    ])
    expect(repository.list({ accountId: a1.id, search: 'a_c' }).items).toHaveLength(0)
  })

  it('超长 search 被截断到 200 字且不抛错', async () => {
    const { repository, a1 } = await setup()
    repository.commitBatch(a1.id, '111', [envelope(1)], state({ lastUid: 1 }))
    const result = repository.list({ accountId: a1.id, search: 'x'.repeat(500) })
    expect(result.items).toHaveLength(0)
  })

  it('invalidateRemote 将账号邮件标记为远端失效', async () => {
    const { repository, a1, a2 } = await setup()
    repository.commitBatch(a1.id, '111', [envelope(1)], state({ lastUid: 1 }))
    repository.commitBatch(a2.id, '111', [envelope(1)], state({ lastUid: 1 }))
    repository.invalidateRemote(a1.id)
    expect(repository.list({ accountId: a1.id }).items.every((m) => !m.remoteAvailable)).toBe(true)
    expect(repository.list({ accountId: a2.id }).items.every((m) => m.remoteAvailable)).toBe(true)
  })

  it('removeAccountCache 清空账号消息与附件,不影响其他账号', async () => {
    const { db, repository, a1, a2 } = await setup()
    repository.commitBatch(
      a1.id,
      '111',
      [envelope(1, { attachments: [{ part: '2', name: 'a.zip', mime: 'application/zip', size: 10 }] })],
      state({ lastUid: 1 })
    )
    repository.commitBatch(a2.id, '111', [envelope(1)], state({ lastUid: 1 }))
    repository.removeAccountCache(a1.id)
    expect(db.all('SELECT * FROM mail_messages WHERE account_id = ?', [a1.id])).toHaveLength(0)
    expect(db.all('SELECT * FROM mail_attachments')).toHaveLength(0)
    expect(repository.list({ accountId: a2.id }).items).toHaveLength(1)
    // 游标保留,便于重扫
    expect(repository.state(a1.id).initialized).toBe(true)
  })

  it('record 返回结构化正文部件信息', async () => {
    const { repository, a1 } = await setup()
    repository.commitBatch(
      a1.id,
      '111',
      [envelope(1, { attachments: [{ part: '2', name: 'a.pdf', mime: 'application/pdf', size: 500 }] })],
      state({ lastUid: 1 })
    )
    const item = repository.list({ accountId: a1.id }).items[0]
    const record = repository.record(item.id)
    expect(record).not.toBeNull()
    expect(record?.uid).toBe(1)
    expect(record?.uidValidity).toBe('111')
    expect(record?.message.subject).toBe('通知 1')
    expect(record?.structure.textParts).toHaveLength(1)
    expect(record?.structure.attachments[0]).toMatchObject({ part: '2', name: 'a.pdf' })
    expect(record?.bodyPath).toBeNull()
    expect(repository.record('missing')).toBeNull()
  })

  it('attachment 与 setAttachmentCache 记录下载状态', async () => {
    const { db, repository, a1 } = await setup()
    repository.commitBatch(
      a1.id,
      '111',
      [envelope(1, { attachments: [{ part: '2', name: 'a.pdf', mime: 'application/pdf', size: 500 }] })],
      state({ lastUid: 1 })
    )
    const attRow = db.get<{ id: string }>('SELECT id FROM mail_attachments')
    expect(attRow).toBeTruthy()
    const att = repository.attachment(attRow!.id)
    expect(att).toMatchObject({
      messageId: expect.any(String),
      name: 'a.pdf',
      mime: 'application/pdf',
      size: 500,
      downloaded: false,
      analyzable: true,
      part: '2',
      cachePath: null
    })
    repository.setAttachmentCache(attRow!.id, '/cache/att-1')
    expect(repository.attachment(attRow!.id)).toMatchObject({ downloaded: true, cachePath: '/cache/att-1' })
    expect(repository.attachment('missing')).toBeNull()
  })

  it('UIDVALIDITY 重置时按指纹唯一匹配复用旧 ID 并恢复远端可用', async () => {
    const { db, repository, a1 } = await setup()
    repository.commitBatch(a1.id, '111', [envelope(1), envelope(2)], state({ lastUid: 2 }))
    const original = repository.list({ accountId: a1.id }).items.map((m) => m.id)
    repository.markRead(original[0], true)
    repository.invalidateRemote(a1.id)
    expect(db.all('SELECT * FROM mail_messages WHERE remote_available = 1')).toHaveLength(0)

    // 新 validity 下同样内容以新 UID 出现(fingerprint:Message-ID+时间+发件人+主题+大小)
    const rows = [
      envelope(21, { uid: 21, messageId: '<msg-1@example.com>', subject: '通知 1' }),
      envelope(22, { uid: 22, messageId: '<msg-2@example.com>', subject: '通知 2' })
    ]
    const added = repository.commitBatch(a1.id, '222', rows, state({ uidValidity: '222', lastUid: 22 }))
    expect(added).toBe(2)
    const items = repository.list({ accountId: a1.id }).items
    expect(items).toHaveLength(2)
    expect(items.every((m) => m.remoteAvailable)).toBe(true)
    // 复用旧本地 ID,read 状态保留
    expect(items.map((m) => m.id).sort()).toEqual([...original].sort())
    expect(items.find((m) => m.id === original[0])?.read).toBe(true)
    expect(repository.state(a1.id)).toMatchObject({ uidValidity: '222', lastUid: 22 })
  })

  it('指纹歧义(多条相同内容)不合并,插入新行', async () => {
    const { db, repository, a1 } = await setup()
    // 两条旧行除 UID 外指纹完全相同
    const duplicated = [envelope(1), envelope(2, { uid: 2, messageId: '<msg-1@example.com>', subject: '通知 1' })]
    repository.commitBatch(a1.id, '111', duplicated, state({ lastUid: 2 }))
    repository.invalidateRemote(a1.id)
    // 指纹匹配到两条旧行,唯一匹配失败 → 新插入
    const added = repository.commitBatch(
      a1.id,
      '222',
      [envelope(21, { uid: 21, messageId: '<msg-1@example.com>', subject: '通知 1' })],
      state({ uidValidity: '222', lastUid: 21 })
    )
    expect(added).toBe(1)
    expect(db.all('SELECT * FROM mail_messages')).toHaveLength(3)
    expect(db.all('SELECT * FROM mail_messages WHERE remote_available = 0')).toHaveLength(2)
  })

  it('空批次仍推进游标', async () => {
    const { repository, a1 } = await setup()
    const added = repository.commitBatch(
      a1.id,
      '111',
      [],
      state({ lastUid: 0, oldestDay: '2026-06-18', initialized: true })
    )
    expect(added).toBe(0)
    expect(repository.state(a1.id)).toMatchObject({ oldestDay: '2026-06-18', initialized: true, lastUid: 0 })
  })
})
