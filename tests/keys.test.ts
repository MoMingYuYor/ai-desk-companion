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

import { decryptApiKey, encryptApiKey } from '../src/main/keys'
import { getProviderApiKey, listProviders, saveProvider } from '../src/main/db/dao'
import { makeTestDb } from './helpers'

// 回归背景:getProviderApiKey 曾自行 slice(6) 返回裸 base64,
// 调用方再走 decryptApiKey 时 'plain:' 前缀已丢失,明文降级链永远解不出(2026-09-18)。
describe('API Key 明文降级链:getProviderApiKey 原样返回 + decryptApiKey 解密', () => {
  it('safeStorage 不可用:plain: 前缀密文经 getProviderApiKey+decryptApiKey 还原明文', async () => {
    safeStorageState.available = false
    const db = await makeTestDb()
    const enc = encryptApiKey('sk-plain-key')
    expect(enc.startsWith('plain:')).toBe(true)

    const id = saveProvider(db, {
      name: '降级',
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
    expect(decryptApiKey(stored!)).toBe('sk-plain-key')
  })

  it('safeStorage 可用:密文路径同样走通', async () => {
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

    const stored = getProviderApiKey(db, id)
    expect(stored).toBe(enc)
    expect(decryptApiKey(stored!)).toBe('sk-secure-key')
  })

  it('未存密钥返回 null', async () => {
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
    safeStorageState.available = false
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
