import { describe, expect, it } from 'vitest'
import {
  createConversation,
  insertAnalysis,
  insertMessage,
  latestAnalysis,
  listConversations,
  listMessages,
  getConversation
} from '../../src/main/db/dao'
import { makeTestDb } from '../helpers'

// 数据库行是蛇形列名(SELECT *)，dao 必须映射为 shared/types 的驼峰接口。
// 回归背景:渲染层 c.updatedAt.replace 因行未映射而崩溃(2026-09-17)。
describe('dao 行映射:蛇形列名 → 驼峰接口', () => {
  it('listConversations/getConversation 返回驼峰 createdAt/updatedAt', async () => {
    const db = await makeTestDb()
    const conv = createConversation(db, 'analysis', '新分析')
    const list = listConversations(db)
    expect(list).toHaveLength(1)
    expect(list[0].updatedAt).toBe(conv.updatedAt)
    expect(list[0].createdAt).toBe(conv.createdAt)
    expect(list[0].id).toBe(conv.id)
    expect(getConversation(db, conv.id)?.updatedAt).toBe(conv.updatedAt)
  })

  it('listMessages 返回驼峰 conversationId/modelLabel/createdAt', async () => {
    const db = await makeTestDb()
    const conv = createConversation(db, 'chat', '会话')
    insertMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content: '你好',
      modelLabel: 'doubao-pro',
      createdAt: '2026-09-17T12:00:00.000Z'
    })
    const messages = listMessages(db, conv.id)
    expect(messages).toHaveLength(1)
    expect(messages[0].conversationId).toBe(conv.id)
    expect(messages[0].modelLabel).toBe('doubao-pro')
    expect(messages[0].createdAt).toBe('2026-09-17T12:00:00.000Z')
  })

  it('latestAnalysis 返回驼峰 modelLabel/conversationId/createdAt 且解析 payload', async () => {
    const db = await makeTestDb()
    const conv = createConversation(db, 'analysis', '分析')
    insertAnalysis(db, conv.id, { summary: '摘要' }, { modelLabel: 'doubao-pro', status: 'done' })
    const analysis = latestAnalysis(db, conv.id)
    expect(analysis).toBeDefined()
    expect(analysis!.conversationId).toBe(conv.id)
    expect(analysis!.modelLabel).toBe('doubao-pro')
    expect(analysis!.createdAt).toBeTruthy()
    expect(analysis!.payload).toEqual({ summary: '摘要' })
  })
})
