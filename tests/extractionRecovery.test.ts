import { describe, expect, it, vi } from 'vitest'
import { Engine } from '../src/main/services/engine'
import { createConversation, insertMaterial, saveProvider } from '../src/main/db/dao'
import { makeTestDb } from './helpers'
import type { ProviderInfo } from '../src/shared/types'
import type { ModelRouter } from '../src/main/services/modelRouter'

function provider(id: string, name: string): ProviderInfo {
  return {
    id,
    name,
    baseUrl: `https://${id}.example.com/v1`,
    protocol: 'chat-completions',
    models: ['m1'],
    defaultModel: 'm1',
    supportsVision: true,
    supportsJsonMode: false,
    isDefault: false,
    sortOrder: 0,
    hasApiKey: true,
    createdAt: '',
    updatedAt: ''
  }
}

interface Call {
  messages: Array<{ role: string; content: unknown }>
  providerIds: string[]
}

const GOOD = JSON.stringify({
  title: '班会',
  summary: 's',
  actionItems: [{ title: '参加班会', type: 'event', start: '2026-09-18T14:00' }],
  questions: [],
  conflicts: [],
  changes: []
})

function makeRouterStub(
  providers: ProviderInfo[],
  script: Array<(call: Call) => string>
): ModelRouter {
  let i = 0
  return {
    call: async (
      slice: ProviderInfo[],
      opts: { messages: Array<{ role: string; content: unknown }> }
    ) => {
      const step = script[Math.min(i, script.length - 1)]
      i++
      const used = slice[0]
      return {
        text: step({
          messages: opts.messages,
          providerIds: slice.map((p) => p.id)
        }),
        used: { providerId: used.id, providerName: used.name, model: used.defaultModel }
      }
    }
  } as unknown as ModelRouter
}

async function makeEngineWith(
  providers: ProviderInfo[],
  script: Array<(call: Call) => string>
): Promise<{ engine: Engine; conversationId: string; notices: unknown[]; saved: ProviderInfo[] }> {
  const db = await makeTestDb()
  // 先入库取得真实 id,再构造同 id 的内存对象供替身路由使用
  const saved: ProviderInfo[] = providers.map((p) => {
    const id = saveProvider(db, {
      name: p.name,
      baseUrl: p.baseUrl,
      protocol: 'chat-completions',
      models: ['m1'],
      defaultModel: 'm1',
      supportsVision: true
    })
    return { ...p, id }
  })
  const notices: unknown[] = []
  const engine = new Engine({
    db,
    router: makeRouterStub(saved, script),
    broadcast: (channel, payload) => notices.push({ channel, payload })
  })
  const conv = createConversation(db, 'analysis', 't')
  insertMaterial(db, { conversationId: conv.id, name: 'n', type: 'text', content: '材料内容' })
  return { engine, conversationId: conv.id, notices, saved }
}

describe('提取三级自愈管线', () => {
  it('首次输出合格:不产生修复调用', async () => {
    const calls: Call[] = []
    const { engine, conversationId } = await makeEngineWith([provider('a', '甲')], [
      (c) => {
        calls.push(c)
        return GOOD
      }
    ])
    const analysis = await engine.runAnalysis(conversationId)
    expect(analysis?.status).toBe('done')
    expect(calls).toHaveLength(1)
    // 系统提示词包含 schema 与 few-shot
    const system = String(calls[0].messages.find((m) => m.role === 'system')?.content ?? '')
    expect(system).toContain('participants')
    expect(system).toContain('示例')
  })

  it('首次不合格→同模型修复成功;修复消息含原始输出与错误反馈', async () => {
    const calls: Call[] = []
    const { engine, conversationId } = await makeEngineWith([provider('a', '甲')], [
      (c) => {
        calls.push(c)
        // 带 JSON 括号但整体无法解析 → 触发修复
        return '好的,结果是 {"title": }'
      },
      (c) => {
        calls.push(c)
        return GOOD
      }
    ])
    const analysis = await engine.runAnalysis(conversationId)
    expect(analysis?.status).toBe('done')
    expect(calls).toHaveLength(2)
    // 修复消息=基础2条+assistant原始输出+user错误反馈
    expect(calls[1].messages).toHaveLength(4)
    expect(calls[1].messages[2].role).toBe('assistant')
    expect(calls[1].messages[3].role).toBe('user')
    expect(String(calls[1].messages[3].content)).toContain('只输出')
  })

  it('修复仍失败→切换下一个模型(游标排除失败者)并广播通知', async () => {
    const calls: Call[] = []
    const { engine, conversationId, notices, saved } = await makeEngineWith(
      [provider('a', '甲'), provider('b', '乙')],
      [
        (c) => {
          calls.push(c)
          return '完全不是JSON'
        },
        (c) => {
          calls.push(c)
          return '还是不是JSON'
        },
        (c) => {
          calls.push(c)
          return GOOD
        }
      ]
    )
    const analysis = await engine.runAnalysis(conversationId)
    expect(analysis?.status).toBe('done')
    // 第三次调用应只发给乙(排除失败的甲)
    expect(calls[2].providerIds).toEqual([saved[1].id])
    const switched = notices.find((n) => (n as { channel: string }).channel === 'evt:model-switched')
    expect(switched).toBeTruthy()
  })

  it('全部模型耗尽→failed 并保留失败摘要', async () => {
    const { engine, conversationId } = await makeEngineWith([provider('a', '甲'), provider('b', '乙')], [
      () => '坏输出A',
      () => '坏输出B',
      () => '坏输出C',
      () => '坏输出D'
    ])
    const analysis = await engine.runAnalysis(conversationId)
    expect(analysis?.status).toBe('failed')
    expect(analysis?.error).toContain('所有模型输出均不合格')
    expect(analysis?.error).toContain('甲')
  })
})
