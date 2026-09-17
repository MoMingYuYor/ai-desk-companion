import { describe, expect, it } from 'vitest'
import { makeTestDb } from '../helpers'
import { initSchema, createTodo, saveProvider, listProviders } from '../../src/main/db/dao'
import { SCHEMA_VERSION } from '../../src/main/db/schema'

describe('数据库迁移与初始化', () => {
  it(`全新初始化将版本置为 ${SCHEMA_VERSION} 并创建邮箱表与 JSON 能力列`, async () => {
    const db = await makeTestDb()
    const ver = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")
    expect(ver?.value).toBe(String(SCHEMA_VERSION))
    expect(db.all('SELECT * FROM mail_accounts')).toHaveLength(0)
    expect(db.all('SELECT * FROM mail_messages')).toHaveLength(0)
    expect(db.all('SELECT * FROM mail_sync_state')).toHaveLength(0)
    expect(db.all('SELECT * FROM mail_attachments')).toHaveLength(0)
    expect(db.all('SELECT * FROM mail_analysis_links')).toHaveLength(0)
    expect(db.all('SELECT * FROM mail_analysis_versions')).toHaveLength(0)
    expect(db.all('SELECT * FROM mail_confirmations')).toHaveLength(0)
    // v3:providers 含 supports_json_mode 列
    const cols = db.all<{ name: string }>("PRAGMA table_info(providers)").map((c) => c.name)
    expect(cols).toContain('supports_json_mode')
  })

  it('保留旧事项并从版本 1 完整升级到当前版本', async () => {
    const db = await makeTestDb()
    createTodo(db, { title: '原有待办事项' })
    expect(db.all('SELECT * FROM todos')).toHaveLength(1)

    // 完整模拟 v1 旧库:无邮箱表,providers 无 supports_json_mode 列
    for (const t of ['mail_accounts', 'mail_sync_state', 'mail_messages', 'mail_attachments', 'mail_analysis_links', 'mail_analysis_versions', 'mail_confirmations']) {
      db.run(`DROP TABLE ${t}`)
    }
    db.run(
      `CREATE TABLE providers_v1 AS SELECT id, name, base_url, api_key_enc, protocol, models,
        default_model, supports_vision, is_default, sort_order, created_at, updated_at FROM providers`
    )
    db.run('DROP TABLE providers')
    db.run(
      `CREATE TABLE providers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL DEFAULT '',
        api_key_enc TEXT NOT NULL DEFAULT '', protocol TEXT NOT NULL DEFAULT 'chat-completions',
        models TEXT NOT NULL DEFAULT '[]', default_model TEXT NOT NULL DEFAULT '',
        supports_vision INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`
    )
    db.run(
      `INSERT INTO providers (id, name, base_url, api_key_enc, protocol, models, default_model, supports_vision, is_default, sort_order, created_at, updated_at)
       SELECT id, name, base_url, api_key_enc, protocol, models, default_model, supports_vision, is_default, sort_order, created_at, updated_at FROM providers_v1`
    )
    db.run('DROP TABLE providers_v1')
    db.run("UPDATE meta SET value = '1' WHERE key = 'schema_version'")

    initSchema(db)
    expect(
      db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value
    ).toBe(String(SCHEMA_VERSION))
    expect(db.all('SELECT * FROM todos')).toHaveLength(1)
    expect(db.all('SELECT * FROM mail_accounts')).toHaveLength(0)
    const cols = db.all<{ name: string }>('PRAGMA table_info(providers)').map((c) => c.name)
    expect(cols).toContain('supports_json_mode')
  })

  it('v2 库(无 JSON 能力列)升级到 v3 成功且能力默认关闭', async () => {
    const db = await makeTestDb()
    // 模拟 v2:先记 id,再重建 providers 表为 v2 结构
    db.run("UPDATE meta SET value = '2' WHERE key = 'schema_version'")
    db.run(
      `CREATE TABLE providers_v2 AS SELECT id, name, base_url, api_key_enc, protocol, models,
        default_model, supports_vision, is_default, sort_order, created_at, updated_at FROM providers`
    )
    db.run('DROP TABLE providers')
    db.run(
      `CREATE TABLE providers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL DEFAULT '',
        api_key_enc TEXT NOT NULL DEFAULT '', protocol TEXT NOT NULL DEFAULT 'chat-completions',
        models TEXT NOT NULL DEFAULT '[]', default_model TEXT NOT NULL DEFAULT '',
        supports_vision INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`
    )
    db.run(
      `INSERT INTO providers (id, name, base_url, api_key_enc, protocol, models, default_model, supports_vision, is_default, sort_order, created_at, updated_at)
       SELECT id, name, base_url, api_key_enc, protocol, models, default_model, supports_vision, is_default, sort_order, created_at, updated_at FROM providers_v2`
    )
    db.run('DROP TABLE providers_v2')

    initSchema(db)
    const infos = listProviders(db)
    expect(infos.every((p) => p.supportsJsonMode === false)).toBe(true)
    saveProvider(db, {
      name: '测试',
      baseUrl: 'https://api.example.com',
      protocol: 'chat-completions',
      models: ['m'],
      defaultModel: 'm',
      supportsVision: true,
      supportsJsonMode: true
    })
    expect(listProviders(db).find((p) => p.name === '测试')?.supportsJsonMode).toBe(true)
  })

  it('重复初始化保持幂等', async () => {
    const db = await makeTestDb()
    initSchema(db)
    initSchema(db)
    expect(
      db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value
    ).toBe(String(SCHEMA_VERSION))
  })

  it('版本高于当前支持的版本时抛出错误', async () => {
    const db = await makeTestDb()
    db.run("UPDATE meta SET value = '99' WHERE key = 'schema_version'")
    expect(() => initSchema(db)).toThrow(/高于当前支持的版本/)
  })
})
