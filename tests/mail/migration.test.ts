import { describe, expect, it } from 'vitest'
import { makeTestDb } from '../helpers'
import { initSchema, createTodo } from '../../src/main/db/dao'

describe('数据库迁移与初始化', () => {
  it('全新初始化将版本置为 2 并创建邮箱表', async () => {
    const db = await makeTestDb()
    const ver = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")
    expect(ver?.value).toBe('2')
    expect(db.all('SELECT * FROM mail_accounts')).toHaveLength(0)
    expect(db.all('SELECT * FROM mail_messages')).toHaveLength(0)
    expect(db.all('SELECT * FROM mail_sync_state')).toHaveLength(0)
    expect(db.all('SELECT * FROM mail_attachments')).toHaveLength(0)
    expect(db.all('SELECT * FROM mail_analysis_links')).toHaveLength(0)
    expect(db.all('SELECT * FROM mail_analysis_versions')).toHaveLength(0)
    expect(db.all('SELECT * FROM mail_confirmations')).toHaveLength(0)
  })

  it('保留旧事项并将版本 1 升为 2', async () => {
    const db = await makeTestDb()
    createTodo(db, { title: '原有待办事项' })
    expect(db.all('SELECT * FROM todos')).toHaveLength(1)

    // 模拟版本 1 的旧库
    db.run("DROP TABLE mail_accounts")
    db.run("DROP TABLE mail_sync_state")
    db.run("DROP TABLE mail_messages")
    db.run("DROP TABLE mail_attachments")
    db.run("DROP TABLE mail_analysis_links")
    db.run("DROP TABLE mail_analysis_versions")
    db.run("DROP TABLE mail_confirmations")
    db.run("UPDATE meta SET value = '1' WHERE key = 'schema_version'")

    // 重新运行 initSchema 执行迁移
    initSchema(db)
    expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value).toBe('2')
    expect(db.all('SELECT * FROM todos')).toHaveLength(1)
    expect(db.all('SELECT * FROM mail_accounts')).toHaveLength(0)
  })

  it('重复初始化保持幂等', async () => {
    const db = await makeTestDb()
    initSchema(db)
    initSchema(db)
    expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value).toBe('2')
  })

  it('版本高于当前支持的版本时抛出错误', async () => {
    const db = await makeTestDb()
    db.run("UPDATE meta SET value = '99' WHERE key = 'schema_version'")
    expect(() => initSchema(db)).toThrow(/高于当前支持的版本/)
  })
})
