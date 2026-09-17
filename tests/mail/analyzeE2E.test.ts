// 端到端复现:真实 DB + 真实 Engine(零模型配置) + 假 IMAP,完整走 MailService.analyze
import { describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { makeTestDb } from '../helpers'
import { MailAccountStore } from '../../src/main/mail/accounts'
import { MailRepository } from '../../src/main/mail/repository'
import { MailSyncWorker } from '../../src/main/mail/sync'
import { MailScheduler } from '../../src/main/mail/scheduler'
import { MailCacheService } from '../../src/main/mail/cache'
import { MailContentService } from '../../src/main/mail/content'
import { MailAnalysisService } from '../../src/main/mail/analysis'
import { MailService } from '../../src/main/mail/service'
import { createConversation, insertMaterial } from '../../src/main/db/dao'
import type { SessionFactory, MailSession, EnvelopeRow } from '../../src/main/mail/adapter'
import type { CredentialStorage } from '../../src/main/mail/credentials'
import { Engine } from '../../src/main/services/engine'
import { ModelRouter } from '../../src/main/services/modelRouter'
import type { Analysis } from '../../src/shared/types'
import { MAIL_LIMITS } from '../../src/shared/mail'

const storage: CredentialStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (v) => Buffer.from('enc:' + v),
  decryptString: (b) => b.toString('utf-8').replace(/^enc:/, '')
}

const envelope: EnvelopeRow = {
  uid: 1,
  messageId: '<t@example.com>',
  subject: '测试通知',
  from: 'a@example.com',
  to: 'me@example.com',
  receivedAt: '2026-09-17T00:00:00.000Z',
  size: 100,
  seen: false,
  textParts: [{ part: '1', name: '', mime: 'text/plain', size: 12, charset: 'utf-8' }],
  htmlParts: [],
  attachments: []
}

function fakeFactory(): SessionFactory {
  return (): MailSession => ({
    open: async () => ({ uidValidity: '111', uidNext: 2 }),
    searchDays: async () => [1],
    searchUids: async () => [],
    envelopes: async () => [envelope],
    part: async () => Readable.from(Buffer.from('周五下午3点开会')),
    close: async () => {},
    cancel: () => {}
  })
}

// 关键:engine 使用真实路径(内部 listProviders 为空 → 分析失败),router 为真实 ModelRouter
function makeEngine(db: Parameters<typeof insertMaterial>[0]): Engine {
  const router = new ModelRouter({ apiKeyOf: () => null })
  return new Engine({
    db: db as never,
    router,
    broadcast: () => {}
  })
}

describe('MailService.analyze 端到端(零模型配置场景)', () => {
  it('不崩溃,失败状态正确回传', async () => {
    const unhandled: unknown[] = []
    process.on('unhandledRejection', (r) => unhandled.push(r))

    const db = await makeTestDb()
    const cacheDir = mkdtempSync(join(tmpdir(), 'mail-e2e-'))
    const broadcast: Array<{ channel: string; payload: unknown }> = []

    const accountStore = new MailAccountStore(db, storage)
    const repository = new MailRepository(db)
    const worker = new MailSyncWorker(accountStore, repository, fakeFactory())
    const scheduler = new MailScheduler(worker, accountStore, { onNotice: () => {} })
    const cache = new MailCacheService(cacheDir)
    const content = new MailContentService({
      repository,
      sessionFactory: fakeFactory(),
      accounts: accountStore,
      cache,
      limits: MAIL_LIMITS
    })
    const engine = makeEngine(db)
    const analysis = new MailAnalysisService({
      db,
      runner: {
        runAnalysis: async (cid) => engine.runAnalysis(cid),
        stop: (cid) => engine.stop(cid)
      },
      materials: {
        addTextMaterial: (cid, name, content2) => ({
          id: insertMaterial(db, { conversationId: cid, name, type: 'text', content: content2 }).id
        })
      },
      analysisBytes: MAIL_LIMITS.analysisBytes
    })

    const service = new MailService({
      db: db as never,
      engine,
      storage,
      cacheDir,
      broadcast: (channel, payload) => broadcast.push({ channel, payload })
    })
    void scheduler
    void analysis

    // 种入账号与邮件(模拟已同步的收件)
    const account = accountStore.saveVerified({
      label: '测试',
      email: 'me@example.com',
      provider: 'custom',
      host: 'imap.example.com',
      port: 993,
      credential: 'secret'
    })
    repository.commitBatch(account.id, '111', [envelope], {
      mailbox: 'INBOX',
      uidValidity: '111',
      lastUid: 1,
      oldestDay: '2026-09-17',
      initialized: true
    })
    const list = repository.list({ page: 0 })
    expect(list.items).toHaveLength(1)
    const mailId = list.items[0].id

    // 预写正文缓存(真实场景中正文来自 IMAP;此处离线化,聚焦分析链路)
    const bodyPath = cache.bodyPath(account.id, mailId)
    await cache.writeAtomic(bodyPath, Buffer.from('周五下午3点在302教室开会', 'utf-8'), MAIL_LIMITS.bodyBytes)
    repository.setBodyCache(mailId, bodyPath)
    db.flush()
    expect(existsSync(bodyPath)).toBe(true)
    expect(repository.record(mailId)?.bodyPath).toBe(bodyPath)

    // 用户点击 AI 分析(未勾选附件 → attachmentIds 为空数组,与 UI 行为一致)
    const result = await service.analyze({ messageId: mailId, attachmentIds: [] })
    if (!result.ok) console.log('ANALYZE FAILED:', result.code, '|', result.message)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.state).toBe('running')

    // 等待在途任务结束(引擎在零模型配置下必然失败,但绝不崩溃)
    await new Promise((r) => setTimeout(r, 300))
    const statusRes = await service.analysisStatus(mailId)
    expect(statusRes.ok).toBe(true)
    if (!statusRes.ok) return
    expect(statusRes.value).not.toBeNull()
    expect(['failed', 'done']).toContain(statusRes.value!.state)

    expect(unhandled).toHaveLength(0)
    process.off('unhandledRejection', () => undefined)
  })
})
