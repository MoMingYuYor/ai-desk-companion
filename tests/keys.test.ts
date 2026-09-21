import { describe, expect, it, vi } from 'vitest'

// 可控的 safeStorage 假件:用例内切换"系统安全存储是否可用"
const safeStorageState = vi.hoisted(() => ({ available: true }))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => safeStorageState.available),
    encryptString: vi.fn((plain: string) => Buffer.from(`enc:${plain}`, 'utf8')),
    decryptString: vi.fn((enc: Buffer) => Buffer.from(enc).toString('utf8').slice(4))
  }
}))

import { SecretStoreUnavailableError, decryptApiKey, encryptApiKey } from '../src/main/keys'
import { getProviderApiKey, listProviders, saveProvider } from '../src/main/db/dao'
import { makeTestDb } from './helpers'

// R4(Task 6):模型密钥一律走系统安全存储,禁止明文降级。
// 回归背景:getProviderApiKey 曾自行 slice(6) 返回裸 base64(2026-09-18);
// 旧版 encryptApiKey 在安全存储不可用时写 'plain:' 前缀明文,S1 起改为明确拒绝。
describe('R4:模型密钥加密边界(禁止明文降级)', () => {
  it('safeStorage 不可用时 encryptApiKey 抛内部加密异常,不再产生 plain: 密文', () => {
    safeStorageState.available = false
    expect(() => encryptApiKey('sk-plain-key')).toThrow(SecretStoreUnavailableError)
    try {
      encryptApiKey('sk-plain-key')
      expect.unreachable()
    } catch (err) {
      const e = err as SecretStoreUnavailableError
      // 公共层映射契约:AUTH_REQUIRED、不可重试、脱敏(不含密钥内容)
      const appErr = e.toAppError()
      expect(appErr.code).toBe('AUTH_REQUIRED')
      expect(appErr.retryable).toBe(false)
      expect(appErr.message).not.toContain('sk-plain-key')
      expect(e.message).not.toContain('sk-plain-key')
    }
  })

  it('R4:历史 plain: 密文不再产出可用明文(decryptApiKey 拒绝降级)', () => {
    const legacy = 'plain:' + Buffer.from('sk-legacy', 'utf-8').toString('base64')
    expect(decryptApiKey(legacy)).toBeNull()
  })

  it('safeStorage 可用:加密/解密往返,密文无 plain: 前缀', async () => {
    safeStorageState.available = true
    const db = await makeTestDb()
    const enc = encryptApiKey('sk-secure-key')
    expect(enc.startsWith('plain:')).toBe(false)

    const id = saveProvider(db, {
      name: '安全存储',
      baseUrl: 'https://api.example.com/v1',
      protocol: 'chat-completions',
      models: ['m1'],
      defaultModel: 'm1',
      supportsVision: false,
      apiKeyEnc: enc
    })

    // dao 原样返回存储串,不改密文形态
    const stored = getProviderApiKey(db, id)
    expect(stored).toBe(enc)
    expect(decryptApiKey(stored!)).toBe('sk-secure-key')
  })

  it('未存密钥返回 null', async () => {
    safeStorageState.available = true
    const db = await makeTestDb()
    const id = saveProvider(db, {
      name: '无密钥',
      baseUrl: 'https://api.example.com/v1',
      protocol: 'chat-completions',
      models: ['m1'],
      defaultModel: 'm1',
      supportsVision: false
    })
    expect(getProviderApiKey(db, id)).toBeNull()
  })
})

// 缺陷4:用户清空 Key(apiKeyEnc === '')应删除已存密钥,而不是落回旧值。
// 存储实现:providers.api_key_enc 列,'' 即"无密钥"(getProviderApiKey → null / hasApiKey → false)。
describe('saveProvider 清空密钥', () => {
  it("apiKeyEnc === '' 删除已存密钥;undefined 保留旧值", async () => {
    safeStorageState.available = true
    const db = await makeTestDb()
    const enc = encryptApiKey('sk-old-key')
    const id = saveProvider(db, {
      name: 'A',
      baseUrl: 'https://api.example.com/v1',
      protocol: 'chat-completions',
      models: ['m1'],
      defaultModel: 'm1',
      supportsVision: false,
      apiKeyEnc: enc
    })
    expect(getProviderApiKey(db, id)).toBe(enc)

    // 未提供 apiKeyEnc:保留已存密钥
    saveProvider(db, {
      id,
      name: 'A',
      baseUrl: 'https://api.example.com/v1',
      protocol: 'chat-completions',
      models: ['m1'],
      defaultModel: 'm1',
      supportsVision: false
    })
    expect(getProviderApiKey(db, id)).toBe(enc)

    // 显式传 '':删除已存密钥
    saveProvider(db, {
      id,
      name: 'A',
      baseUrl: 'https://api.example.com/v1',
      protocol: 'chat-completions',
      models: ['m1'],
      defaultModel: 'm1',
      supportsVision: false,
      apiKeyEnc: ''
    })
    expect(getProviderApiKey(db, id)).toBeNull()
    expect(listProviders(db).find((p) => p.id === id)?.hasApiKey).toBe(false)
  })
})
