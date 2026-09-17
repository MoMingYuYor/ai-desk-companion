import { describe, expect, it } from 'vitest'
import { makeTestDb } from '../helpers'
import { MailAccountStore } from '../../src/main/mail/accounts'
import { MailRepository } from '../../src/main/mail/repository'
import type { CredentialStorage } from '../../src/main/mail/credentials'
import type { SyncState } from '../../src/main/mail/ports'
import { MailSyncWorker, syncMode } from '../../src/main/mail/sync'
import { FakeSession, makeEnvelope } from './fakeSession'

const storage: CredentialStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
  decryptString: (value: Buffer) => Buffer.from(value).toString('utf8').slice(4)
}

const DAY = '2026-09-15'
const INITIAL_WINDOW = { since: '2026-08-17', before: '2026-09-16' }

function initState(overrides: Partial<SyncState> = {}): SyncState {
  return {
    mailbox: 'INBOX',
    uidValidity: null,
    lastUid: 0,
    oldestDay: null,
    initialized: false,
    ...overrides
  }
}

async function setup() {
  const db = await makeTestDb()
  const accounts = new MailAccountStore(db, storage)
  const repository = new MailRepository(db)
  const info = accounts.saveVerified({
    label: '测试账号',
    email: 'user@example.com',
    provider: 'custom',
    host: 'imap.example.com',
    port: 993,
    credential: 'pw'
  })
  const fake = new FakeSession()
  const worker = new MailSyncWorker(accounts, repository, () => fake)
  return { db, accounts, repository, info, fake, worker }
}

const freshSignal = (): AbortSignal => new AbortController().signal

describe('syncMode 分支', () => {
  it('尚未初始化时先扫描初始窗口', () => {
    expect(syncMode(initState(), 'earlier')).toBe('initial')
    expect(syncMode(initState(), 'refresh')).toBe('initial')
  })
  it('已初始化按请求走增量或历史', () => {
    const initialized = initState({ uidValidity: '111', lastUid: 5, oldestDay: '2026-08-17', initialized: true })
    expect(syncMode(initialized, 'refresh')).toBe('incremental')
    expect(syncMode(initialized, 'earlier')).toBe('history')
  })
})

describe('MailSyncWorker', () => {
  it('初次同步写入初始窗口并推进游标', async () => {
    const { fake, repository, info, worker } = await setup()
    fake.uidNext = 4
    fake.envelopesByUid.set(1, makeEnvelope(1))
    fake.envelopesByUid.set(2, makeEnvelope(2, { receivedAt: '2026-09-11T09:30:00.000Z' }))
    fake.envelopesByUid.set(3, makeEnvelope(3))

    const result = await worker.run(info.id, 'refresh', DAY, freshSignal())
    expect(result).toEqual({ added: 3, initial: true })
    expect(fake.calls).toContain(`searchDays:${INITIAL_WINDOW.since}:${INITIAL_WINDOW.before}`)
    // 首次 open + 补收阶段重新 open 获取最新 uidNext
    expect(fake.openCount).toBe(2)
    expect(fake.closeCount).toBe(1)
    expect(repository.state(info.id)).toMatchObject({
      uidValidity: '111',
      lastUid: 3,
      oldestDay: INITIAL_WINDOW.since,
      initialized: true
    })
    expect(repository.list({ accountId: info.id }).items).toHaveLength(3)
  })

  it('空收件箱初次同步直接完成', async () => {
    const { fake, repository, info, worker } = await setup()
    fake.uidNext = 1
    const result = await worker.run(info.id, 'refresh', DAY, freshSignal())
    expect(result).toEqual({ added: 0, initial: true })
    expect(repository.state(info.id).initialized).toBe(true)
    expect(repository.list({ accountId: info.id }).items).toHaveLength(0)
  })

  it('增量只取新 UID,无新邮件时零开销结束', async () => {
    const { fake, repository, info, worker } = await setup()
    fake.uidNext = 4
    for (const uid of [1, 2, 3]) fake.envelopesByUid.set(uid, makeEnvelope(uid))
    await worker.run(info.id, 'refresh', DAY, freshSignal())

    fake.uidNext = 6
    fake.envelopesByUid.set(5, makeEnvelope(5, { receivedAt: '2026-09-14T09:00:00.000Z' }))
    const result = await worker.run(info.id, 'refresh', DAY, freshSignal())
    expect(result).toEqual({ added: 1, initial: false })
    expect(fake.calls).toContain('searchUids:3:5')
    expect(repository.state(info.id).lastUid).toBe(5)

    const again = await worker.run(info.id, 'refresh', DAY, freshSignal())
    expect(again).toEqual({ added: 0, initial: false })
    expect(repository.list({ accountId: info.id }).items).toHaveLength(4)
  })

  it('被远端删除的 UID 跳过,游标推进到请求上界', async () => {
    const { fake, repository, info, worker } = await setup()
    fake.uidNext = 4
    for (const uid of [1, 2, 3]) fake.envelopesByUid.set(uid, makeEnvelope(uid))
    await worker.run(info.id, 'refresh', DAY, freshSignal())

    // uid 5 已被远端删除(不存在于会话),uid 6 是新邮件
    fake.uidNext = 7
    fake.envelopesByUid.set(6, makeEnvelope(6, { receivedAt: '2026-09-14T10:00:00.000Z' }))
    const result = await worker.run(info.id, 'refresh', DAY, freshSignal())
    expect(result).toEqual({ added: 1, initial: false })
    expect(repository.state(info.id).lastUid).toBe(6)
  })

  it('历史扫描前移 oldestDay,空窗口前移不误报', async () => {
    const { fake, repository, info, worker } = await setup()
    fake.uidNext = 4
    for (const uid of [1, 2, 3]) fake.envelopesByUid.set(uid, makeEnvelope(uid))
    await worker.run(info.id, 'refresh', DAY, freshSignal())

    fake.uidNext = 31
    fake.envelopesByUid.set(
      30,
      makeEnvelope(30, { receivedAt: '2026-07-20T08:00:00.000Z', subject: '更早的邮件' })
    )
    const result = await worker.run(info.id, 'earlier', DAY, freshSignal())
    expect(result).toEqual({ added: 1, initial: false })
    expect(fake.calls).toContain('searchDays:2026-07-18:2026-08-17')
    expect(repository.state(info.id).oldestDay).toBe('2026-07-18')
    expect(repository.list({ accountId: info.id }).items).toHaveLength(4)

    // 空历史窗口:正常返回 0 且窗口继续前移
    const empty = await worker.run(info.id, 'earlier', DAY, freshSignal())
    expect(empty).toEqual({ added: 0, initial: false })
    expect(fake.calls).toContain('searchDays:2026-06-18:2026-07-18')
    expect(repository.state(info.id).oldestDay).toBe('2026-06-18')
    expect(repository.list({ accountId: info.id }).items).toHaveLength(4)
  })

  it('UIDVALIDITY 重置后失效旧映射并按指纹重建', async () => {
    const { fake, repository, info, worker } = await setup()
    fake.uidNext = 3
    fake.envelopesByUid.set(1, makeEnvelope(1))
    fake.envelopesByUid.set(2, makeEnvelope(2))
    await worker.run(info.id, 'refresh', DAY, freshSignal())
    const readTarget = repository
      .list({ accountId: info.id })
      .items.find((m) => m.subject === '测试邮件 1')
    expect(readTarget).toBeTruthy()
    repository.markRead(readTarget!.id, true)

    // 服务器邮箱重建:UIDVALIDITY 变化,同样内容以新 UID 重新出现(指纹与旧行一致)
    fake.uidValidity = '999'
    fake.uidNext = 23
    fake.envelopesByUid.clear()
    fake.envelopesByUid.set(21, makeEnvelope(21, { messageId: '<msg-1@example.com>', subject: '测试邮件 1' }))
    fake.envelopesByUid.set(22, makeEnvelope(22, { messageId: '<msg-2@example.com>', subject: '测试邮件 2' }))

    const result = await worker.run(info.id, 'refresh', DAY, freshSignal())
    expect(result.added).toBe(2)
    const st = repository.state(info.id)
    expect(st).toMatchObject({ uidValidity: '999', lastUid: 22, initialized: true })
    const items = repository.list({ accountId: info.id }).items
    expect(items).toHaveLength(2)
    expect(items.every((m) => m.remoteAvailable)).toBe(true)
    // 复用旧本地 ID,read 状态不丢
    expect(items.find((m) => m.subject === '测试邮件 1')?.read).toBe(true)
  })

  it('信号已中止时不建立会话', async () => {
    const { fake, info, worker } = await setup()
    const controller = new AbortController()
    controller.abort()
    await expect(worker.run(info.id, 'refresh', DAY, controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED'
    })
    expect(fake.openCount).toBe(0)
    expect(fake.closeCount).toBe(0)
  })

  it('批次途中中止:已完成批次保留,后续批次停止并关闭会话', async () => {
    const { fake, repository, info, worker } = await setup()
    fake.uidNext = 61
    for (let uid = 1; uid <= 60; uid += 1) {
      fake.envelopesByUid.set(
        uid,
        makeEnvelope(uid, { receivedAt: `2026-09-01T00:${String(uid % 60).padStart(2, '0')}:00.000Z` })
      )
    }
    const controller = new AbortController()
    fake.onEnvelopes = () => controller.abort()

    await expect(worker.run(info.id, 'refresh', DAY, controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED'
    })
    // 第一批(50)已提交但未完成,initialized 仍为 false
    expect(repository.list({ accountId: info.id }).items).toHaveLength(50)
    expect(repository.state(info.id).initialized).toBe(false)
    expect(fake.closeCount).toBe(1)
  })
})
