import { describe, expect, it, vi } from 'vitest'
import { makeTestDb } from '../helpers'
import { MailAccountStore } from '../../src/main/mail/accounts'
import { MailRepository } from '../../src/main/mail/repository'
import { decryptCredential, encryptCredential, type CredentialStorage } from '../../src/main/mail/credentials'
import { MailError } from '../../src/main/mail/errors'
import { MAIL_PRESETS, resolvePreset, validateAccountInput } from '../../src/main/mail/presets'
import type { MailAccountInput } from '../../src/shared/mail'
import { makeEnvelope } from './fakeSession'

/** 内存凭据存储替身:对称加解密,可控制可用性 */
function makeStorage(available = true): CredentialStorage {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value: Buffer) => {
      const text = Buffer.from(value).toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('not a protected value')
      return text.slice(4)
    }
  }
}

function accountInput(overrides: Partial<MailAccountInput> = {}): MailAccountInput {
  return {
    label: '工作邮箱',
    email: 'Alice@Example.COM',
    provider: 'custom',
    host: 'imap.example.com',
    port: 993,
    credential: 'app-password-1',
    ...overrides
  }
}

async function makeStore(available = true) {
  const db = await makeTestDb()
  const store = new MailAccountStore(db, makeStorage(available))
  return { db, store }
}

function expectMailError(err: unknown, code: string): void {
  expect(err).toBeInstanceOf(MailError)
  expect((err as MailError).code).toBe(code)
}

describe('凭据加密', () => {
  it('系统加密不可用时拒绝加密', () => {
    const storage = {
      isEncryptionAvailable: () => false,
      encryptString: vi.fn(),
      decryptString: vi.fn()
    }
    expect(() => encryptCredential('test-secret', storage)).toThrow('系统加密不可用')
    expect(storage.encryptString).not.toHaveBeenCalled()
  })

  it('加密结果为 base64(salt|iv|cipher) 且可往返解密', () => {
    const storage = makeStorage()
    const sealed = encryptCredential('app-password-1', storage)
    const raw = Buffer.from(sealed, 'base64')
    // 16 字节 salt + 12 字节 iv + 至少 16 字节认证标签 + 密文
    expect(raw.length).toBeGreaterThanOrEqual(44)
    expect(decryptCredential(sealed, storage)).toBe('app-password-1')
    // 随机 salt/iv:两次加密结果不同
    expect(encryptCredential('app-password-1', storage)).not.toBe(sealed)
  })

  it('拒绝解密旧明文与未知前缀格式', () => {
    const storage = makeStorage()
    expectMailError(catchCode(() => decryptCredential('plain-secret', storage)), 'CRYPTO')
    expectMailError(catchCode(() => decryptCredential('mail:v1:AAAA', storage)), 'CRYPTO')
    expectMailError(catchCode(() => decryptCredential('', storage)), 'CRYPTO')
  })

  it('密文被篡改时解密失败抛 CRYPTO', () => {
    const storage = makeStorage()
    const sealed = encryptCredential('app-password-1', storage)
    const raw = Buffer.from(sealed, 'base64')
    raw[raw.length - 1] ^= 0xff
    expectMailError(catchCode(() => decryptCredential(raw.toString('base64'), storage)), 'CRYPTO')
  })
})

function catchCode(fn: () => unknown): unknown {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error('预期抛出错误')
}

describe('服务商预设与输入校验', () => {
  it('三家预设指向各自 IMAP 服务器 993 端口', () => {
    expect(MAIL_PRESETS.qq).toEqual({ host: 'imap.qq.com', port: 993 })
    expect(MAIL_PRESETS['163']).toEqual({ host: 'imap.163.com', port: 993 })
    expect(MAIL_PRESETS.gmail).toEqual({ host: 'imap.gmail.com', port: 993 })
    expect(resolvePreset('qq')).toEqual({ host: 'imap.qq.com', port: 993 })
    expect(resolvePreset('gmail', 'imap.other.com', 1993)).toEqual({ host: 'imap.other.com', port: 1993 })
  })

  it('custom 必须提供 host', () => {
    expect(() => resolvePreset('custom')).toThrow('自定义服务商必须填写服务器地址')
  })

  it('归一化邮箱域名,保留本地部分大小写', () => {
    const clean = validateAccountInput(accountInput())
    expect(clean.email).toBe('Alice@example.com')
    expect(clean.label).toBe('工作邮箱')
  })

  it('拒绝非法邮箱、协议前缀 host、路径与越界端口', () => {
    expect(() => validateAccountInput(accountInput({ email: 'not-an-email' }))).toThrow()
    expect(() => validateAccountInput(accountInput({ email: 'a@b' }))).toThrow()
    expect(() => validateAccountInput(accountInput({ host: 'imap://imap.example.com' }))).toThrow(/主机名/)
    expect(() => validateAccountInput(accountInput({ host: 'https://imap.example.com' }))).toThrow()
    expect(() => validateAccountInput(accountInput({ host: 'imap.example.com/inbox' }))).toThrow()
    expect(() => validateAccountInput(accountInput({ host: 'user@imap.example.com' }))).toThrow()
    expect(() => validateAccountInput(accountInput({ port: 0 }))).toThrow()
    expect(() => validateAccountInput(accountInput({ port: 65536 }))).toThrow()
    expect(() => validateAccountInput(accountInput({ port: 993.5 }))).toThrow()
    expect(() => validateAccountInput(accountInput({ label: '' }))).toThrow()
    expect(() => validateAccountInput(accountInput({ label: 'x'.repeat(81) }))).toThrow()
    expect(() => validateAccountInput(accountInput({ provider: 'unknown' as never }))).toThrow()
  })

  it('80 字显示名与 1-65535 端口可用', () => {
    expect(validateAccountInput(accountInput({ label: 'y'.repeat(80) })).label).toHaveLength(80)
    expect(validateAccountInput(accountInput({ port: 1 })).port).toBe(1)
    expect(validateAccountInput(accountInput({ port: 65535 })).port).toBe(65535)
  })
})

describe('MailAccountStore', () => {
  it('同服务商不同地址共存,重复账号拒绝', async () => {
    const { store } = await makeStore()
    store.saveVerified(accountInput({ provider: 'qq', email: 'alice@qq.com', label: 'A' }))
    store.saveVerified(accountInput({ provider: 'qq', email: 'bob@qq.com', label: 'B' }))
    expect(store.list()).toHaveLength(2)

    expectMailError(
      catchCode(() => store.saveVerified(accountInput({ provider: 'qq', email: 'alice@qq.com', label: 'A2' }))),
      'INVALID_CONFIG'
    )
    // 不同端口不算重复
    store.saveVerified(accountInput({ provider: 'custom', host: 'imap.example.com', port: 1993, email: 'alice@example.com', label: 'C' }))
    expect(store.list()).toHaveLength(3)
  })

  it('凭据不出现在 list/get 序列化结果中', async () => {
    const { store } = await makeStore()
    store.saveVerified(accountInput())
    const json = JSON.stringify(store.list())
    expect(json).not.toContain('app-password-1')
    expect(json).not.toContain('credential')
    const info = store.get(store.list()[0].id)
    expect(info?.hasCredential).toBe(true)
  })

  it('编辑省略凭据保留旧值,提供新凭据则更新', async () => {
    const { store } = await makeStore()
    const saved = store.saveVerified(accountInput())
    expect(saved.id).toBeTruthy()
    store.saveVerified({ ...accountInput(), id: saved.id })
    expect(store.connection(saved.id).password).toBe('app-password-1')

    store.saveVerified({ ...accountInput(), id: saved.id, credential: 'app-password-2' })
    expect(store.connection(saved.id).password).toBe('app-password-2')
    // 编辑同步显示名
    store.saveVerified({ ...accountInput(), id: saved.id, label: '新名字' })
    expect(store.get(saved.id)?.label).toBe('新名字')
  })

  it('email/host/port 身份变化拒绝', async () => {
    const { store } = await makeStore()
    const saved = store.saveVerified(accountInput())
    expect(() =>
      store.saveVerified({ ...accountInput(), id: saved.id, host: 'imap2.example.com' })
    ).toThrow(/移除后重新添加/)
    expect(() => store.saveVerified({ ...accountInput(), id: saved.id, email: 'other@example.com' })).toThrow()
    expect(() => store.saveVerified({ ...accountInput(), id: saved.id, port: 1993 })).toThrow()
  })

  it('新账号缺少凭据拒绝', async () => {
    const { store } = await makeStore()
    const { credential: _ignored, ...withoutCredential } = accountInput()
    expectMailError(catchCode(() => store.saveVerified(withoutCredential)), 'INVALID_CONFIG')
  })

  it('系统加密不可用时数据库无新增行', async () => {
    const { db, store } = await makeStore(false)
    expectMailError(catchCode(() => store.saveVerified(accountInput())), 'CRYPTO')
    expect(db.all('SELECT * FROM mail_accounts')).toHaveLength(0)
  })

  it('旧明文凭据在 connection 时抛 CRYPTO', async () => {
    const { db, store } = await makeStore()
    const saved = store.saveVerified(accountInput())
    db.run('UPDATE mail_accounts SET credential_enc = ? WHERE id = ?', ['plain-secret', saved.id])
    expectMailError(catchCode(() => store.connection(saved.id)), 'CRYPTO')
  })

  it('connection 返回解密后的连接信息,未知账号抛 NOT_FOUND', async () => {
    const { store } = await makeStore()
    const saved = store.saveVerified(accountInput())
    const conn = store.connection(saved.id)
    expect(conn).toEqual({
      host: 'imap.example.com',
      port: 993,
      email: 'Alice@example.com',
      password: 'app-password-1'
    })
    expectMailError(catchCode(() => store.connection('missing')), 'NOT_FOUND')
  })

  it('setEnabled 在 paused 与原状态间切换', async () => {
    const { store } = await makeStore()
    const saved = store.saveVerified(accountInput())
    store.setEnabled(saved.id, false)
    expect(store.get(saved.id)).toMatchObject({ enabled: false, status: 'paused' })
    store.setEnabled(saved.id, true)
    expect(store.get(saved.id)).toMatchObject({ enabled: true, status: 'idle' })
  })

  it('setStatus 记录错误,updateSuccess 清除错误并刷新成功时间', async () => {
    const { store } = await makeStore()
    const saved = store.saveVerified(accountInput())
    store.setStatus(saved.id, 'error', { code: 'NETWORK', message: '连接超时' })
    expect(store.get(saved.id)).toMatchObject({
      status: 'error',
      error: { code: 'NETWORK', message: '连接超时' }
    })
    store.updateSuccess(saved.id)
    const info = store.get(saved.id)
    expect(info?.status).toBe('idle')
    expect(info?.error).toBeNull()
    expect(info?.lastSuccessAt).toBeTruthy()
  })

  it('remove 级联清空游标与收件缓存', async () => {
    const { db, store } = await makeStore()
    const saved = store.saveVerified(accountInput())
    const repository = new MailRepository(db)
    repository.commitBatch(saved.id, '111', [makeEnvelope(1, { attachments: [{ part: '2', name: 'a.pdf', mime: 'application/pdf', size: 10 }] })], {
      mailbox: 'INBOX',
      uidValidity: '111',
      lastUid: 1,
      oldestDay: '2026-08-17',
      initialized: true
    })
    expect(db.all('SELECT * FROM mail_messages')).toHaveLength(1)
    expect(db.all('SELECT * FROM mail_attachments')).toHaveLength(1)

    store.remove(saved.id)
    expect(db.all('SELECT * FROM mail_accounts')).toHaveLength(0)
    expect(db.all('SELECT * FROM mail_messages')).toHaveLength(0)
    expect(db.all('SELECT * FROM mail_attachments')).toHaveLength(0)
    expect(db.all('SELECT * FROM mail_sync_state')).toHaveLength(0)
  })
})
