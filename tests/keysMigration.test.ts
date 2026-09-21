import { beforeEach, describe, expect, it, vi } from 'vitest'

// 可控的 safeStorage 假件:切换"系统安全存储是否可用"与"加密调用是否失败"
const safeStorageState = vi.hoisted(() => ({ available: true, failEncrypt: false }))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => safeStorageState.available),
    encryptString: vi.fn((plain: string) => {
      if (safeStorageState.failEncrypt) throw new Error('dpapi failure')
      return Buffer.from(`enc:${plain}`, 'utf8')
    }),
    decryptString: vi.fn((enc: Buffer) => {
      const text = Buffer.from(enc).toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('not a protected value')
      return text.slice(4)
    })
  }
}))

import { safeStorage } from 'electron'
import { decryptApiKey, migrateLegacyProviderKeys } from '../src/main/keys'
import { getProviderApiKey, saveProvider } from '../src/main/db/dao'
import { makeTestDb } from './helpers'

/** 与生产一致的存储适配:直接桥接被 mock 的 electron safeStorage */
const storage = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (value: string) => safeStorage.encryptString(value)
}

function legacyEnc(plain: string): string {
  return 'plain:' + Buffer.from(plain, 'utf-8').toString('base64')
}

async function seedLegacy(plain: string) {
  const db = await makeTestDb()
  const id = saveProvider(db, {
    name: '旧配置',
    baseUrl: 'https://api.example.com/v1',
    protocol: 'chat-completions',
    models: ['m1'],
    defaultModel: 'm1',
    supportsVision: false,
    apiKeyEnc: legacyEnc(plain)
  })
  return { db, id }
}

async function countLegacyRows(db: Awaited<ReturnType<typeof makeTestDb>>): Promise<number> {
  return db.all<{ id: string }>("SELECT id FROM providers WHERE api_key_enc LIKE 'plain:%'").length
}

// R4(Task 6):migrateLegacyProviderKeys 只在加密可用时事务化替换历史 plain:;
// 不可用时历史记录标为待处理且不能产出可用明文(模型路由不可用)。
describe('migrateLegacyProviderKeys 历史明文密钥迁移', () => {
  beforeEach(() => {
    safeStorageState.available = true
    safeStorageState.failEncrypt = false
  })

  it('加密可用:迁移 plain: 为密文,库中不再含明文标记,迁移后密钥仍可用', async () => {
    const { db, id } = await seedLegacy('sk-legacy-1')
    const result = migrateLegacyProviderKeys(db, storage)
    expect(result).toEqual({ migrated: 1, pending: 0 })

    const stored = getProviderApiKey(db, id)!
    expect(stored.startsWith('plain:')).toBe(false)
    // 不再含历史明文/明文 base64
    expect(stored).not.toContain('sk-legacy-1')
    expect(stored).not.toContain(Buffer.from('sk-legacy-1', 'utf-8').toString('base64'))
    expect(await countLegacyRows(db)).toBe(0)
    expect(decryptApiKey(stored)).toBe('sk-legacy-1')
  })

  it('多条历史记录一次性全部迁移', async () => {
    const db = await makeTestDb()
    const id1 = saveProvider(db, { name: 'A', baseUrl: 'https://a.example.com', protocol: 'chat-completions', models: ['m'], defaultModel: 'm', supportsVision: false, apiKeyEnc: legacyEnc('sk-a') })
    const id2 = saveProvider(db, { name: 'B', baseUrl: 'https://b.example.com', protocol: 'chat-completions', models: ['m'], defaultModel: 'm', supportsVision: false, apiKeyEnc: legacyEnc('sk-b') })
    const result = migrateLegacyProviderKeys(db, storage)
    expect(result).toEqual({ migrated: 2, pending: 0 })
    expect(decryptApiKey(getProviderApiKey(db, id1)!)).toBe('sk-a')
    expect(decryptApiKey(getProviderApiKey(db, id2)!)).toBe('sk-b')
  })

  it('加密不可用:标为待处理(migrated=0),原始记录不动,且不产出可用明文', async () => {
    safeStorageState.available = false
    const { db, id } = await seedLegacy('sk-legacy-2')
    const result = migrateLegacyProviderKeys(db, storage)
    expect(result).toEqual({ migrated: 0, pending: 1 })
    // 原始值保留:历史数据无静默丢失
    expect(getProviderApiKey(db, id)).toBe(legacyEnc('sk-legacy-2'))
    // 不能经模型路由继续使用:decryptApiKey 拒绝 plain:
    expect(decryptApiKey(getProviderApiKey(db, id)!)).toBeNull()
    expect(await countLegacyRows(db)).toBe(1)
  })

  it('plain: 载荷损坏(非法 base64)计入 pending 且保留原值', async () => {
    const { db, id } = await seedLegacy('x')
    // 直接写入损坏载荷
    db.run('UPDATE providers SET api_key_enc = ? WHERE id = ?', ['plain:!!!not-base64!!!', id])
    const result = migrateLegacyProviderKeys(db, storage)
    expect(result).toEqual({ migrated: 0, pending: 1 })
    expect(getProviderApiKey(db, id)).toBe('plain:!!!not-base64!!!')
  })

  it('加密调用失败:不替换任何行,全部计 pending,可重试', async () => {
    safeStorageState.failEncrypt = true
    const { db, id } = await seedLegacy('sk-legacy-3')
    const result = migrateLegacyProviderKeys(db, storage)
    expect(result).toEqual({ migrated: 0, pending: 1 })
    expect(getProviderApiKey(db, id)).toBe(legacyEnc('sk-legacy-3'))
  })

  it('无历史明文时 migrated/pending 均为 0', async () => {
    const db = await makeTestDb()
    saveProvider(db, { name: 'C', baseUrl: 'https://c.example.com', protocol: 'chat-completions', models: ['m'], defaultModel: 'm', supportsVision: false, apiKeyEnc: 'ZW5jOnNlY3VyZQ==' })
    const result = migrateLegacyProviderKeys(db, storage)
    expect(result).toEqual({ migrated: 0, pending: 0 })
  })

  it('待处理计数写入 meta 供启动诊断,迁移完成后归零', async () => {
    const { db } = await seedLegacy('sk-legacy-4')
    safeStorageState.available = false
    expect(migrateLegacyProviderKeys(db, storage).pending).toBe(1)
    expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'keys:legacy-pending'")?.value).toBe('1')

    safeStorageState.available = true
    expect(migrateLegacyProviderKeys(db, storage)).toEqual({ migrated: 1, pending: 0 })
    expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'keys:legacy-pending'")?.value).toBe('0')
  })
})
