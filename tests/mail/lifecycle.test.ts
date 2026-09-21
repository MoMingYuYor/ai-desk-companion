// Task 12 / R10(AC11):邮箱账号级取消的生命周期测试。
// A 账号任务悬挂在 envelopes()/part() 时执行停用/移除/退出,
// 断言旧任务不产生任何迟到写入,其他账号与退出流程不受影响。
// 会话门控复用 FakeSession 的思想:悬挂不响应 abort,模拟真实网络迟滞,
// 由注册表(代数 + 信号)+ 仓储写守卫共同阻断迟到提交。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTestDb } from '../helpers'
import type { SqliteDb } from '../../src/main/db/connection'
import type { EnvelopeRow, MailSession, SessionFactory } from '../../src/main/mail/adapter'
import type { CredentialStorage } from '../../src/main/mail/credentials'
import { MailService } from '../../src/main/mail/service'
import type { Engine } from '../../src/main/services/engine'
import { makeEnvelope } from './fakeSession'

const storage: CredentialStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
  decryptString: (value: Buffer) => Buffer.from(value).toString('utf8').slice(4)
}

/** 挂起式假会话:envelopes/part 悬挂直到测试释放;释放不检查 abort,模拟网络迟滞 */
class GatedSession implements MailSession {
  calls: string[] = []
  openCount = 0
  closeCount = 0
  uidValidity = '111'
  rows: EnvelopeRow[] = []
  private envelopeGates: Array<(rows: EnvelopeRow[]) => void> = []
  private partGates: Array<(stream: Readable) => void> = []

  get hungEnvelopes(): boolean {
    return this.envelopeGates.length > 0
  }

  get hungParts(): boolean {
    return this.partGates.length > 0
  }

  async open(): Promise<{ uidValidity: string; uidNext: number }> {
    this.openCount += 1
    const top = this.rows.reduce((max, row) => Math.max(max, row.uid), 0)
    return { uidValidity: this.uidValidity, uidNext: top + 1 }
  }

  async searchDays(since: string, before: string): Promise<number[]> {
    this.calls.push(`searchDays:${since}:${before}`)
    return this.rows
      .filter((row) => {
        const day = row.receivedAt.slice(0, 10)
        return day >= since && day < before
      })
      .map((row) => row.uid)
      .sort((a, b) => a - b)
  }

  async searchUids(after: number, through: number): Promise<number[]> {
    this.calls.push(`searchUids:${after}:${through}`)
    return this.rows.map((row) => row.uid).filter((uid) => uid > after && uid <= through).sort((a, b) => a - b)
  }

  envelopes(_uids: number[]): Promise<EnvelopeRow[]> {
    this.calls.push('envelopes')
    return new Promise((resolve) => {
      this.envelopeGates.push(resolve)
    })
  }

  async part(_uid: number, _part: string): Promise<Readable> {
    return new Promise((resolve) => {
      this.partGates.push(resolve)
    })
  }

  async close(): Promise<void> {
    this.closeCount += 1
  }

  cancel(): void {
    /* 挂起由测试释放,不依赖会话取消 */
  }

  /** 释放悬挂的 envelopes:返回全部预置行(即使账号已被取消,模拟迟到结果) */
  releaseEnvelopes(): void {
    const gate = this.envelopeGates.shift()
    gate?.(this.rows)
  }

  /** 释放悬挂的正文下载 */
  releasePart(): void {
    const gate = this.partGates.shift()
    gate?.(Readable.from([Buffer.from('迟到正文', 'utf8')]))
  }
}

function makeSessionFactory(): { factory: SessionFactory; sessionOf(email: string): GatedSession } {
  const map = new Map<string, GatedSession>()
  const factory: SessionFactory = (connection) => {
    let session = map.get(connection.email)
    if (!session) {
      session = new GatedSession()
      map.set(connection.email, session)
    }
    return session
  }
  return {
    factory,
    sessionOf: (email: string) => {
      let session = map.get(email)
      if (!session) {
        session = new GatedSession()
        map.set(email, session)
      }
      return session
    }
  }
}

function makeEngineStub(): Engine {
  return {
    runAnalysis: async () => {
      throw new Error('测试未使用 runAnalysis')
    },
    stop: () => undefined,
    insertMailMaterial: () => ({ id: 'mat-1' }),
    confirmItem: () => ({}),
    invalidateAllRuns: () => undefined
  } as unknown as Engine
}

async function setup() {
  const db = await makeTestDb()
  const cacheDir = mkdtempSync(join(tmpdir(), 'mail-lifecycle-'))
  const broadcasts: Array<{ channel: string; payload: unknown }> = []
  const { factory, sessionOf } = makeSessionFactory()
  const service = new MailService({
    db,
    engine: makeEngineStub(),
    storage,
    cacheDir,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    sessionFactory: factory
  })
  const a = service.accountStore.saveVerified({
    label: 'A', email: 'a@example.com', provider: 'custom', host: 'a.example.com', port: 993, credential: 'pw-a'
  })
  const b = service.accountStore.saveVerified({
    label: 'B', email: 'b@example.com', provider: 'custom', host: 'b.example.com', port: 993, credential: 'pw-b'
  })
  cleanupDirs.push(cacheDir)
  return { db, service, a, b, sessionOf, broadcasts, cacheDir }
}

const rowsOf = (db: SqliteDb, accountId: string): unknown[] =>
  db.all('SELECT id FROM mail_messages WHERE account_id = ?', [accountId])

const stateRow = (db: SqliteDb, accountId: string): Record<string, unknown> | undefined =>
  db.get('SELECT * FROM mail_sync_state WHERE account_id = ?', [accountId])

/** 推进宏任务,让 Promise 链充分结算 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

const cleanupDirs: string[] = []

afterEach(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true })
  cleanupDirs.length = 0
})

describe('R10 账号级取消(AC11)', () => {
  it('停用账号:在途手动同步被取消,迟到结果不落库且停用状态不被回写覆盖', async () => {
    const { service, db, a, b, sessionOf } = await setup()
    const sessionA = sessionOf('a@example.com')
    sessionA.rows = [makeEnvelope(1), makeEnvelope(2)]
    const sessionB = sessionOf('b@example.com')
    sessionB.rows = [makeEnvelope(11), makeEnvelope(12)]

    const syncA = service.sync(a.id)
    await vi.waitFor(() => expect(sessionA.hungEnvelopes).toBe(true))

    // 停用:注册表需先取消并等待 A 的任务;停用进行中释放旧结果(迟到结果)
    const disabling = service.setEnabled(a.id, false)
    sessionA.releaseEnvelopes()
    await disabling

    await expect(syncA).resolves.toMatchObject({ ok: false, code: 'CANCELLED' })
    // 迟到批次未提交:mail_messages / mail_sync_state 均无 A 的写入
    expect(rowsOf(db, a.id)).toHaveLength(0)
    expect(stateRow(db, a.id)).toBeUndefined()
    // 停用状态不被任务收尾的 idle 回写覆盖
    expect(service.accountStore.get(a.id)).toMatchObject({ enabled: false, status: 'paused' })

    // 其他账号不受影响:B 同步成功
    const syncB = service.sync(b.id)
    await vi.waitFor(() => expect(sessionB.hungEnvelopes).toBe(true))
    sessionB.releaseEnvelopes()
    await expect(syncB).resolves.toMatchObject({ ok: true })
    expect(rowsOf(db, b.id)).toHaveLength(2)
  })

  it('移除账号:先取消在途任务再删除账号与数据,其他账号不受影响', async () => {
    const { service, db, a, b, sessionOf } = await setup()
    const sessionA = sessionOf('a@example.com')
    sessionA.rows = [makeEnvelope(1), makeEnvelope(2)]
    const sessionB = sessionOf('b@example.com')
    sessionB.rows = [makeEnvelope(11)]

    const first = service.sync(a.id)
    await vi.waitFor(() => expect(sessionA.hungEnvelopes).toBe(true))
    sessionA.releaseEnvelopes()
    await expect(first).resolves.toMatchObject({ ok: true })
    expect(rowsOf(db, a.id)).toHaveLength(2)

    // 发起第二次同步(增量:注入新信后 envelopes 悬挂),移除进行中释放旧结果
    sessionA.rows.push(makeEnvelope(3))
    const second = service.sync(a.id)
    await vi.waitFor(() => expect(sessionA.hungEnvelopes).toBe(true))

    const removing = service.remove(a.id)
    sessionA.releaseEnvelopes()
    await removing

    await expect(second).resolves.toMatchObject({ ok: false, code: 'CANCELLED' })
    // 先阻断后删除:账号、消息、游标全部清除,迟到批次未落库
    expect(service.accountStore.get(a.id)).toBeNull()
    expect(rowsOf(db, a.id)).toHaveLength(0)
    expect(stateRow(db, a.id)).toBeUndefined()

    // 其他账号不受影响
    const syncB2 = service.sync(b.id)
    await vi.waitFor(() => expect(sessionB.hungEnvelopes).toBe(true))
    sessionB.releaseEnvelopes()
    await expect(syncB2).resolves.toMatchObject({ ok: true })
    expect(rowsOf(db, b.id)).toHaveLength(1)
  })
})

describe('R10 退出安全', () => {
  it('读取与下载悬挂时 stop() 取消任务并等待安全退出', async () => {
    const { service, db, a, sessionOf } = await setup()
    const sessionA = sessionOf('a@example.com')
    sessionA.rows = [makeEnvelope(1), makeEnvelope(2)]

    const sync = service.sync(a.id)
    await vi.waitFor(() => expect(sessionA.hungEnvelopes).toBe(true))
    sessionA.releaseEnvelopes()
    await expect(sync).resolves.toMatchObject({ ok: true })

    // 正文读取(下载)悬挂在 part()
    const target = service.repository.list({ accountId: a.id }).items[0]
    expect(target).toBeTruthy()
    const reading = service.detail(target.id)
    await vi.waitFor(() => expect(sessionA.hungParts).toBe(true))

    const stopping = service.stop(5000)
    let settled = false
    void stopping.then(() => {
      settled = true
    })
    await flush()
    // 悬挂任务未结束前 stop() 不返回
    expect(settled).toBe(false)

    sessionA.releasePart()
    await stopping
    expect(settled).toBe(true)
    await expect(reading).resolves.toMatchObject({ ok: false, code: 'CANCELLED' })
    // 正文缓存未落:迟到下载不写 body_path/body_state
    expect(service.repository.get(target.id)?.bodyState).toBe('missing')
    expect(sessionA.closeCount).toBeGreaterThan(0)
    void db
  })

  it('退出等待超时:记录未完成任务后返回,不永久阻塞退出', async () => {
    const { service, a, sessionOf } = await setup()
    const sessionA = sessionOf('a@example.com')
    sessionA.rows = [makeEnvelope(1)]

    const syncA = service.sync(a.id)
    await vi.waitFor(() => expect(sessionA.hungEnvelopes).toBe(true))

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await service.stop(30)
      // 超时被记录(含未完成任务的账号/类别,不含任何邮件内容);先断言再 restore(restore 会清空记录)
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('未完成'))
    } finally {
      errSpy.mockRestore()
    }

    sessionA.releaseEnvelopes()
    await flush()
  })
})
