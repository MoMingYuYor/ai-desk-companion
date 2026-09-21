// R8 引擎层契约:runId 生成与失效、started 先于一切流事件、停止对应活动 runId、
// 活动运行快照(getActiveChatRun)与迟到清理
import { describe, expect, it, vi } from 'vitest'
import { createConversation, insertMaterial } from '../src/main/db/dao'
import { Engine } from '../src/main/services/engine'
import type { ModelRouter } from '../src/main/services/modelRouter'
import { makeTestDb } from './helpers'

interface BroadcastEvent {
  channel: string
  payload: Record<string, unknown>
}

interface FakeCallOptions {
  signal?: AbortSignal
  onDelta?: (delta: string) => void
  onNotice?: (n: unknown) => void
}

type FakeCall = (providers: unknown, options: FakeCallOptions) => Promise<{ text: string; used: { providerId: string; providerName: string; model: string } }>

function ok(text: string): { text: string; used: { providerId: string; providerName: string; model: string } } {
  return { text, used: { providerId: 'p1', providerName: '测试服务', model: 'm1' } }
}

function events(list: BroadcastEvent[], channel: string): Array<Record<string, unknown>> {
  return list.filter((e) => e.channel === channel).map((e) => e.payload)
}

async function setup(routerCall: FakeCall): Promise<{
  engine: Engine
  convId: string
  broadcast: BroadcastEvent[]
}> {
  const db = await makeTestDb()
  const conv = createConversation(db, 'chat', '测试对话')
  const broadcast: BroadcastEvent[] = []
  const router = { call: routerCall } as unknown as ModelRouter
  const engine = new Engine({
    db,
    router,
    broadcast: (channel, payload) => broadcast.push({ channel, payload: payload as Record<string, unknown> })
  })
  return { engine, convId: conv.id, broadcast }
}

describe('R8: 引擎运行标识', () => {
  it('started 先于一切流事件;delta/done 携带同一 runId;结束时活动运行清空', async () => {
    let release!: (t: string) => void
    const gate = new Promise<string>((resolve) => {
      release = resolve
    })
    const { engine, convId, broadcast } = await setup((_providers, options) => {
      options.onDelta?.('第一段')
      return gate.then((t) => ok(t))
    })

    const pending = engine.sendChat(convId, '你好')
    await vi.waitFor(() => expect(engine.getActiveChatRun(convId)).not.toBeNull())

    const started = events(broadcast, 'evt:chat-started')
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ conversationId: convId, runGeneration: 1 })
    const runId = started[0]!.runId as string
    expect(runId).toBeTruthy()

    // started 先于本运行的任何流事件(delta/done)
    const streamOrder = broadcast
      .filter((e) => ['evt:chat-started', 'evt:chat-delta', 'evt:chat-done'].includes(e.channel))
      .map((e) => e.channel)
    expect(streamOrder[0]).toBe('evt:chat-started')

    // 增量绑定当前运行并累计文本
    expect(events(broadcast, 'evt:chat-delta')[0]).toMatchObject({ conversationId: convId, runId, delta: '第一段' })
    expect(engine.getActiveChatRun(convId)).toMatchObject({ runId, runGeneration: 1, text: '第一段' })

    release('最终回复')
    await pending
    expect(events(broadcast, 'evt:chat-done')[0]).toMatchObject({
      conversationId: convId, runId, messageId: expect.any(String)
    })
    expect(engine.getActiveChatRun(convId)).toBeNull()
  })

  it('新运行使旧运行失效:各带各的 runId,旧运行的迟到结束不清掉新运行', async () => {
    let release1!: (t: string) => void
    const gate1 = new Promise<string>((resolve) => {
      release1 = resolve
    })
    let callCount = 0
    const { engine, convId, broadcast } = await setup((_providers, options) => {
      callCount += 1
      if (callCount === 1) {
        options.onDelta?.('旧运行增量')
        return gate1.then((t) => ok(t))
      }
      return Promise.resolve(ok('新运行完成'))
    })

    const p1 = engine.sendChat(convId, '第一条')
    await vi.waitFor(() => expect(engine.getActiveChatRun(convId)).not.toBeNull())
    const runId1 = events(broadcast, 'evt:chat-started')[0]!.runId as string

    const p2 = engine.sendChat(convId, '第二条')
    await vi.waitFor(() => expect(events(broadcast, 'evt:chat-started')).toHaveLength(2))
    const runId2 = events(broadcast, 'evt:chat-started')[1]!.runId as string
    expect(runId2).not.toBe(runId1)
    // 运行代数单会话递增
    expect(events(broadcast, 'evt:chat-started')[1]).toMatchObject({ runGeneration: 2 })
    expect(engine.getActiveChatRun(convId)?.runId).toBe(runId2)

    await p2
    // run2 结束清空;run1 的清理不得复活或误删
    expect(engine.getActiveChatRun(convId)).toBeNull()
    release1('旧运行终于完成')
    await p1
    // 迟到的旧 done 仍带旧 runId(页面据此过滤),活动运行保持为空
    expect(events(broadcast, 'evt:chat-done').map((e) => e.runId)).toEqual([runId2, runId1])
    expect(engine.getActiveChatRun(convId)).toBeNull()
  })

  it('停止命令对应活动 runId:错误 runId 不中止,匹配 runId 中止并广播 done', async () => {
    const { engine, convId, broadcast } = await setup((_providers, options) => {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })

    const pending = engine.sendChat(convId, '写长文')
    await vi.waitFor(() => expect(engine.getActiveChatRun(convId)).not.toBeNull())
    const runId = events(broadcast, 'evt:chat-started')[0]!.runId as string

    engine.stop(convId, '不是当前运行')
    await new Promise((r) => setTimeout(r, 20))
    expect(engine.getActiveChatRun(convId)).not.toBeNull()

    engine.stop(convId, runId)
    await pending
    expect(events(broadcast, 'evt:chat-done')[0]).toMatchObject({ conversationId: convId, runId })
    expect(engine.getActiveChatRun(convId)).toBeNull()
  })

  it('分析运行同样生成 runId:失败路径 chat-error 与 analysis-updated 携带 started 的 runId', async () => {
    const db = await makeTestDb()
    const conv = createConversation(db, 'analysis', '通知分析')
    insertMaterial(db, { conversationId: conv.id, name: '通知.txt', type: 'text', content: '周三开会' })
    const broadcast: BroadcastEvent[] = []
    // 空返回即可触发"没有可用模型"的失败路径,不依赖网络
    const router = { call: () => Promise.reject(new Error('网络失败')) } as unknown as ModelRouter
    const engine = new Engine({
      db,
      router,
      broadcast: (channel, payload) => broadcast.push({ channel, payload: payload as Record<string, unknown> })
    })
    await engine.sendChat(conv.id, '帮我分析')

    const started = events(broadcast, 'evt:chat-started')[0]!
    expect(started).toMatchObject({ conversationId: conv.id, runGeneration: 1 })
    expect(events(broadcast, 'evt:chat-error')[0]).toMatchObject({
      conversationId: conv.id, runId: started.runId, error: expect.any(String)
    })
    expect(events(broadcast, 'evt:analysis-updated')[0]).toMatchObject({
      conversationId: conv.id, runId: started.runId
    })
  })

  it('invalidateAllRuns 中止并清空全部活动运行(恢复 workspaceEpoch 后旧活动快照失效)', async () => {
    const { engine, convId, broadcast } = await setup((_providers, options) => {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })
    const pending = engine.sendChat(convId, '长任务')
    await vi.waitFor(() => expect(engine.getActiveChatRun(convId)).not.toBeNull())
    const runId = events(broadcast, 'evt:chat-started')[0]!.runId as string

    engine.invalidateAllRuns()
    expect(engine.getActiveChatRun(convId)).toBeNull()
    await pending
    expect(events(broadcast, 'evt:chat-done')[0]).toMatchObject({ conversationId: convId, runId })
  })
})
