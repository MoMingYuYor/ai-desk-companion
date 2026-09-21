// @vitest-environment jsdom
// 缺陷回归:ChatPage 会话切换竞态(旧请求迟到覆盖新会话)与切换时未重置流式状态;
// R8:事件携带运行标识,旧运行的迟到 done/error 不得清空当前运行
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { ChatPage } from '../../src/renderer/workbench/pages/ChatPage'
import type { ActiveChatRun } from '../../src/shared/api'
import type { ChatMessage, Conversation } from '../../src/shared/types'

afterEach(cleanup)

function conversation(id: string, title: string): Conversation {
  return { id, title, kind: 'analysis', status: 'active', createdAt: '2026-09-18T08:00:00', updatedAt: '2026-09-18T08:00:00' }
}

function message(id: string, conversationId: string, content: string): ChatMessage {
  return { id, conversationId, role: 'user', content, createdAt: '2026-09-18T08:01:00' }
}

function installApi(over: Record<string, unknown> = {}): {
  listMessages: ReturnType<typeof vi.fn>
  handlers: Map<string, (payload: unknown) => void>
  resolveConvA: () => void
} {
  let resolveA!: (ms: ChatMessage[]) => void
  // 会话 A 的消息请求挂起,由测试手动放行;会话 B 立即返回
  const listMessages = vi.fn((id: string): Promise<ChatMessage[]> => {
    if (id === 'conv-a') {
      return new Promise((resolve) => {
        resolveA = resolve
      })
    }
    return Promise.resolve([message('mb1', 'conv-b', '会话B的最新消息')])
  })
  const handlers = new Map<string, (payload: unknown) => void>()
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    listConversations: vi.fn(async () => [conversation('conv-a', '会话A'), conversation('conv-b', '会话B')]),
    listMessages,
    getLatestAnalysis: vi.fn(async () => null),
    // R8:视图切回快照;默认无活动运行
    getActiveChatRun: vi.fn(async () => null),
    createConversation: vi.fn(),
    on: vi.fn((channel: string, handler: (payload: unknown) => void) => {
      handlers.set(channel, handler)
      return () => {
        handlers.delete(channel)
      }
    }),
    ...over
  }
  return { listMessages, handlers, resolveConvA: () => resolveA([message('ma1', 'conv-a', '会话A的迟到消息')]) }
}

describe('ChatPage 会话切换', () => {
  it('旧会话迟到的 listMessages 响应不覆盖新会话内容', async () => {
    const { listMessages, resolveConvA } = installApi()
    render(<ChatPage refreshKey={0} petAction={null} locateConversationId={null} />)

    // 挂载后自动选中第一个会话 A,其消息请求挂起
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledWith('conv-a'))

    // 切到会话 B:B 的消息立即返回并渲染
    fireEvent.click(await screen.findByText('会话B'))
    await vi.waitFor(() => expect(screen.getByText('会话B的最新消息')).toBeTruthy())

    // A 的迟到响应此刻才 resolve:不得覆盖 B 的消息
    resolveConvA()
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getByText('会话B的最新消息')).toBeTruthy()
    expect(screen.queryByText('会话A的迟到消息')).toBeNull()
  })

  it('切换会话时重置流式状态,上一会话的流式文本不再显示', async () => {
    const { listMessages, handlers } = installApi()
    render(<ChatPage refreshKey={0} petAction={null} locateConversationId={null} />)
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledWith('conv-a'))

    // A 会话先绑定运行再收增量(R8:先 started 后 delta)
    act(() => {
      handlers.get('evt:chat-started')?.({ conversationId: 'conv-a', runId: 'run-1', runGeneration: 1 })
      handlers.get('evt:chat-delta')?.({ conversationId: 'conv-a', runId: 'run-1', delta: 'A会话流式文本' })
    })
    expect(await screen.findByText('A会话流式文本')).toBeTruthy()

    // 切到 B:流式状态被重置,A 的流式文本不再显示
    fireEvent.click(screen.getByText('会话B'))
    await vi.waitFor(() => expect(screen.getByText('会话B的最新消息')).toBeTruthy())
    expect(screen.queryByText('A会话流式文本')).toBeNull()
  })
})

describe('R8: 运行标识与迟到事件隔离', () => {
  it('R8: 旧运行完成事件不清空同会话新运行', async () => {
    const { listMessages, handlers } = installApi()
    render(<ChatPage refreshKey={0} petAction={null} locateConversationId={null} />)
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledWith('conv-a'))
    act(() => {
      handlers.get('evt:chat-started')?.({ conversationId: 'conv-a', runId: 'run-new', runGeneration: 2 })
      handlers.get('evt:chat-delta')?.({ conversationId: 'conv-a', runId: 'run-new', delta: '新运行文本' })
    })
    expect(await screen.findByText('新运行文本')).toBeTruthy()
    act(() => {
      handlers.get('evt:chat-done')?.({ conversationId: 'conv-a', runId: 'run-old' })
      handlers.get('evt:chat-error')?.({ conversationId: 'conv-b', runId: 'run-other', error: '迟到' })
    })
    expect(screen.getByText('新运行文本')).toBeTruthy()
    expect(screen.queryByText('分析失败:迟到')).toBeNull()
  })

  it('R8: 订阅先建立再取快照;切回活动会话恢复累计文本,旧快照不回退、不覆盖新运行', async () => {
    let activeRun: ActiveChatRun | null = {
      conversationId: 'conv-a', runId: 'run-active', runGeneration: 3, text: '后台累计文本'
    }
    const getActiveChatRun = vi.fn(async (): Promise<ActiveChatRun | null> => activeRun)
    const { listMessages, handlers } = installApi({ getActiveChatRun })
    render(<ChatPage refreshKey={0} petAction={null} locateConversationId={null} />)
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledWith('conv-a'))

    // 快照恢复当前运行与累计文本
    expect(await screen.findByText('后台累计文本')).toBeTruthy()

    // 后到的增量精确匹配 runId,继续追加
    act(() => {
      handlers.get('evt:chat-delta')?.({ conversationId: 'conv-a', runId: 'run-active', delta: '+新增' })
    })
    expect(await screen.findByText('后台累计文本+新增')).toBeTruthy()

    // conversation-changed 触发重取快照:同运行的旧快照(更短)不得回退已累计文本
    activeRun = { conversationId: 'conv-a', runId: 'run-active', runGeneration: 3, text: '后台' }
    act(() => {
      handlers.get('evt:conversation-changed')?.({ conversationId: 'conv-a' })
    })
    expect(screen.getByText('后台累计文本+新增')).toBeTruthy()

    // 更新代数的新运行快照可以接管(旧运行已结束、新运行进行中)
    activeRun = { conversationId: 'conv-a', runId: 'run-next', runGeneration: 4, text: '新运行快照' }
    act(() => {
      handlers.get('evt:conversation-changed')?.({ conversationId: 'conv-a' })
    })
    expect(await screen.findByText('新运行快照')).toBeTruthy()
  })

  it('R8: 非当前运行的分析更新事件不清流状态', async () => {
    const { listMessages, handlers } = installApi()
    render(<ChatPage refreshKey={0} petAction={null} locateConversationId={null} />)
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledWith('conv-a'))
    act(() => {
      handlers.get('evt:chat-started')?.({ conversationId: 'conv-a', runId: 'run-cur', runGeneration: 1 })
      handlers.get('evt:chat-delta')?.({ conversationId: 'conv-a', runId: 'run-cur', delta: '正在输出' })
    })
    expect(await screen.findByText('正在输出')).toBeTruthy()
    act(() => {
      // 同会话旧运行的分析更新:不清当前流
      handlers.get('evt:analysis-updated')?.({ conversationId: 'conv-a', runId: 'run-stale', analysisId: 'a1' })
    })
    expect(screen.getByText('正在输出')).toBeTruthy()
    // 当前运行的分析更新:清流并刷新
    act(() => {
      handlers.get('evt:analysis-updated')?.({ conversationId: 'conv-a', runId: 'run-cur', analysisId: 'a2' })
    })
    await vi.waitFor(() => expect(screen.queryByText('正在输出')).toBeNull())
  })
})
