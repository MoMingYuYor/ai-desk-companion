import { describe, expect, it } from 'vitest'
import {
  createConversation,
  deleteMessagesFrom,
  insertAnalysis,
  insertMessage,
  lastAssistantMessage,
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

  // 回归背景:重试时 engine 依赖 last.createdAt 调 deleteMessagesFrom,
  // lastAssistantMessage 未走 mapMessage 导致 createdAt 为 undefined,旧回复删不掉(2026-09-18)。
  it('lastAssistantMessage 返回驼峰行,createdAt 可用于 deleteMessagesFrom 删除旧回复', async () => {
    const db = await makeTestDb()
    const conv = createConversation(db, 'chat', '重试会话')
    insertMessage(db, {
      conversationId: conv.id,
      role: 'user',
      content: '问题',
      createdAt: '2026-09-18T10:00:00.000Z'
    })
    insertMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content: '旧回复',
      modelLabel: 'doubao-pro',
      createdAt: '2026-09-18T10:00:05.000Z'
    })

    const last = lastAssistantMessage(db, conv.id)
    expect(last).toBeDefined()
    expect(last!.id).toBeTruthy()
    expect(last!.conversationId).toBe(conv.id)
    expect(last!.role).toBe('assistant')
    expect(last!.modelLabel).toBe('doubao-pro')
    expect(last!.createdAt).toBe('2026-09-18T10:00:05.000Z')

    // engine.retry:deleteMessagesFrom(conv, last.createdAt, 'assistant') 应删掉助手消息
    deleteMessagesFrom(db, conv.id, last!.createdAt, 'assistant')
    const rest = listMessages(db, conv.id)
    expect(rest).toHaveLength(1)
    expect(rest[0].role).toBe('user')
    expect(rest[0].createdAt).toBe('2026-09-18T10:00:00.000Z')
  })
})
