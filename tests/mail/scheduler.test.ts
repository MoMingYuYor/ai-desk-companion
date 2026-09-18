import { describe, expect, it } from 'vitest'
import { makeTestDb } from '../helpers'
import { MailAccountStore } from '../../src/main/mail/accounts'
import type { CredentialStorage } from '../../src/main/mail/credentials'
import { MailError } from '../../src/main/mail/errors'
import {
  DEFAULT_BACKOFF_DELAYS,
  DEFAULT_MAX_ATTEMPTS,
  MailScheduler,
  retryDelay,
  todayLocalDay,
  withBackoff
} from '../../src/main/mail/scheduler'
import type { MailSyncWorker } from '../../src/main/mail/sync'
import type { SyncRequestMode, SyncRunResult } from '../../src/main/mail/sync'
import type { MailSyncNotice } from '../../src/shared/mail'

const storage: CredentialStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
  decryptString: (value: Buffer) => Buffer.from(value).toString('utf8').slice(4)
}

/** 假同步工作流:可门控(手动放行)或立即成功/失败 */
class FakeWorker {
  calls: Array<{ id: string; mode: SyncRequestMode; day: string; signal: AbortSignal }> = []
  gated = false
  failFirst = 0
  error: MailError | null = null
  current = 0
  maxConcurrent = 0
  private resolvers = new Map<string, Array<() => void>>()

  run(id: string, mode: SyncRequestMode, day: string, signal: AbortSignal): Promise<SyncRunResult> {
    this.calls.push({ id, mode, day, signal })
    if (signal.aborted) return Promise.reject(new MailError('CANCELLED', '同步已取消'))
    if (this.gated) {
      this.current += 1
      this.maxConcurrent = Math.max(this.maxConcurrent, this.current)
      return new Promise<SyncRunResult>((resolve, reject) => {
        const onAbort = (): void => {
          signal.removeEventListener('abort', onAbort)
          this.current -= 1
          reject(new MailError('CANCELLED', '同步已取消'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        const queue = this.resolvers.get(id) ?? []
        queue.push(() => {
          signal.removeEventListener('abort', onAbort)
          this.current -= 1
          resolve({ added: 1, initial: false })
        })
        this.resolvers.set(id, queue)
      })
    }
    if (this.error && this.failFirst > 0) {
      this.failFirst -= 1
      return Promise.reject(this.error)
    }
    return Promise.resolve({ added: 1, initial: false })
  }

  release(id: string): void {
    const gate = this.resolvers.get(id)?.shift()
    gate?.()
  }
}

async function setup() {
  const db = await makeTestDb()
  const accounts = new MailAccountStore(db, storage)
  const a = accounts.saveVerified({ label: 'A', email: 'a@example.com', provider: 'custom', host: 'a.example.com', port: 993, credential: 'pw-a' })
  const b = accounts.saveVerified({ label: 'B', email: 'b@example.com', provider: 'custom', host: 'b.example.com', port: 993, credential: 'pw-b' })
  const c = accounts.saveVerified({ label: 'C', email: 'c@example.com', provider: 'custom', host: 'c.example.com', port: 993, credential: 'pw-c' })
  const notices: MailSyncNotice[] = []
  return { db, accounts, a, b, c, notices }
}

/** 推进若干个宏任务,让 Promise 链充分结算 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

const noNotice = (): void => undefined

describe('retryDelay', () => {
  it('只对可恢复连接错误退避', () => {
    expect(DEFAULT_BACKOFF_DELAYS).toEqual([30_000, 60_000, 120_000, 300_000])
    expect([0, 1, 2, 3, 4].map((n) => retryDelay(n, 'NETWORK'))).toEqual([30_000, 60_000, 120_000, 300_000, 300_000])
    expect(retryDelay(0, 'AUTH')).toBeNull()
    expect(retryDelay(0, 'TLS')).toBeNull()
    expect(retryDelay(0, 'CRYPTO')).toBeNull()
    expect(retryDelay(0, 'BUSY')).toBeNull()
  })
})

describe('withBackoff', () => {
  it('NETWORK 连续失败达到 maxAttempts 后放弃并抛出最后一次错误', async () => {
    const err = new MailError('NETWORK', '断网')
    let calls = 0
    await expect(
      withBackoff(
        () => {
          calls += 1
          return Promise.reject(err)
        },
        { delays: [0, 0], maxAttempts: 3 }
      )
    ).rejects.toBe(err)
    expect(calls).toBe(3)

    // 默认上限 5 次
    calls = 0
    await expect(
      withBackoff(() => {
        calls += 1
        return Promise.reject(new MailError('NETWORK', '断网'))
      }, { delays: [0, 0] })
    ).rejects.toMatchObject({ code: 'NETWORK' })
    expect(calls).toBe(DEFAULT_MAX_ATTEMPTS)
  })

  it('连续失败达到上限前成功则正常返回', async () => {
    let calls = 0
    const result = await withBackoff(
      () => {
        calls += 1
        if (calls < 3) return Promise.reject(new MailError('NETWORK', '抖动'))
        return Promise.resolve('ok')
      },
      { delays: [0, 0], maxAttempts: 5 }
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })
})

describe('MailScheduler', () => {
  it('同账号互斥:并发第二次抛 BUSY,结束后可再次同步', async () => {
    const { accounts, a, notices } = await setup()
    const fake = new FakeWorker()
    fake.gated = true
    const scheduler = new MailScheduler(fake as unknown as MailSyncWorker, accounts, { onNotice: (n) => notices.push(n) })

    const first = scheduler.syncAccount(a.id, 'refresh', new AbortController().signal)
    await flush()
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].day).toBe(todayLocalDay())

    await expect(scheduler.syncAccount(a.id, 'refresh', new AbortController().signal)).rejects.toMatchObject({
      code: 'BUSY'
    })
    expect(fake.calls).toHaveLength(1)

    fake.release(a.id)
    await expect(first).resolves.toMatchObject({ added: 1 })
    await flush()
    expect(notices.at(-1)).toMatchObject({ accountId: a.id, status: 'idle', loaded: 1 })
    expect(accounts.get(a.id)?.status).toBe('idle')
    expect(accounts.get(a.id)?.lastSuccessAt).toBeTruthy()

    // 完成后可再次同步
    const second = scheduler.syncAccount(a.id, 'refresh', new AbortController().signal)
    await flush()
    fake.release(a.id)
    await expect(second).resolves.toMatchObject({ added: 1 })
    await flush()
    expect(fake.calls).toHaveLength(2)
  })

  it('runDue 最多 2 个账号并发', async () => {
    const { accounts, a, b, c } = await setup()
    const fake = new FakeWorker()
    fake.gated = true
    const scheduler = new MailScheduler(fake as unknown as MailSyncWorker, accounts, { onNotice: noNotice })

    const done = scheduler.runDue([a.id, b.id, c.id], new AbortController().signal)
    await flush()
    expect(fake.current).toBe(2)
    expect(fake.maxConcurrent).toBe(2)

    // a 完成后 c 接替空出的槽位,并发保持 2
    fake.release(a.id)
    await flush()
    expect(fake.current).toBe(2)
    expect(fake.calls.map((call) => call.id)).toContain(c.id)

    fake.release(b.id)
    fake.release(c.id)
    await done
    expect(fake.maxConcurrent).toBe(2)
    expect(fake.calls).toHaveLength(3)
    expect(new Set(fake.calls.map((call) => call.id))).toEqual(new Set([a.id, b.id, c.id]))
  })

  it('NETWORK 失败按注入的退避间隔重试后成功', async () => {
    const { accounts, a, notices } = await setup()
    const fake = new FakeWorker()
    fake.error = new MailError('NETWORK', '连接超时')
    fake.failFirst = 2
    const scheduler = new MailScheduler(fake as unknown as MailSyncWorker, accounts, { onNotice: (n) => notices.push(n) }, {
      backoffDelays: [0, 0]
    })

    const result = await scheduler.syncAccount(a.id, 'refresh', new AbortController().signal)
    expect(result).toMatchObject({ added: 1 })
    expect(fake.calls).toHaveLength(3)
    expect(accounts.get(a.id)?.status).toBe('idle')
    expect(notices.at(-1)).toMatchObject({ status: 'idle', loaded: 1 })
  })

  // 回归背景:NETWORK 曾无限重试,手动同步断网时 IPC 永不返回(2026-09-18)。
  it('NETWORK 连续失败达到 maxAttempts 后放弃,账号标记 error 且互斥释放', async () => {
    const { accounts, a, notices } = await setup()
    const fake = new FakeWorker()
    fake.error = new MailError('NETWORK', '连接超时')
    fake.failFirst = 99
    const scheduler = new MailScheduler(fake as unknown as MailSyncWorker, accounts, { onNotice: (n) => notices.push(n) }, {
      backoffDelays: [0, 0],
      maxAttempts: 3
    })

    await expect(scheduler.syncAccount(a.id, 'refresh', new AbortController().signal)).rejects.toMatchObject({
      code: 'NETWORK'
    })
    expect(fake.calls.filter((call) => call.id === a.id)).toHaveLength(3)
    expect(accounts.get(a.id)).toMatchObject({ status: 'error', error: { code: 'NETWORK', message: '连接超时' } })
    expect(notices.at(-1)).toMatchObject({ accountId: a.id, status: 'error', error: { code: 'NETWORK' } })

    // 放弃后 mutex 已释放:可再次发起同步(此时假件放行成功)
    fake.failFirst = 0
    await expect(scheduler.syncAccount(a.id, 'refresh', new AbortController().signal)).resolves.toMatchObject({
      added: 1
    })
    expect(accounts.get(a.id)?.status).toBe('idle')
  })

  it('AUTH 失败不重试,账号标记 error 并发出通知', async () => {
    const { accounts, b, notices } = await setup()
    const fake = new FakeWorker()
    fake.error = new MailError('AUTH', '认证失败')
    fake.failFirst = 5
    const scheduler = new MailScheduler(fake as unknown as MailSyncWorker, accounts, { onNotice: (n) => notices.push(n) }, {
      backoffDelays: [0, 0]
    })

    await expect(scheduler.syncAccount(b.id, 'refresh', new AbortController().signal)).rejects.toMatchObject({
      code: 'AUTH'
    })
    expect(fake.calls.filter((call) => call.id === b.id)).toHaveLength(1)
    expect(accounts.get(b.id)).toMatchObject({ status: 'error', error: { code: 'AUTH', message: '认证失败' } })
    expect(notices.at(-1)).toMatchObject({ accountId: b.id, status: 'error', error: { code: 'AUTH' } })
  })

  it('stopAll 中止在途同步且不标记账号错误', async () => {
    const { accounts, a } = await setup()
    const fake = new FakeWorker()
    fake.gated = true
    const scheduler = new MailScheduler(fake as unknown as MailSyncWorker, accounts, { onNotice: noNotice })

    const done = scheduler.runDue([a.id], new AbortController().signal)
    await flush()
    expect(fake.current).toBe(1)

    await scheduler.stopAll()
    await done
    expect(fake.current).toBe(0)
    expect(accounts.get(a.id)?.status).toBe('idle')
    expect(accounts.get(a.id)?.error).toBeNull()
  })

  it('停用账号跳过,未知账号抛 NOT_FOUND', async () => {
    const { accounts, a } = await setup()
    const fake = new FakeWorker()
    fake.gated = true
    const scheduler = new MailScheduler(fake as unknown as MailSyncWorker, accounts, { onNotice: noNotice })

    accounts.setEnabled(a.id, false)
    const result = await scheduler.syncAccount(a.id, 'refresh', new AbortController().signal)
    expect(result).toEqual({ added: 0, initial: false })
    expect(fake.calls).toHaveLength(0)

    await expect(scheduler.syncAccount('missing', 'refresh', new AbortController().signal)).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
    fake.release(a.id)
  })
})
