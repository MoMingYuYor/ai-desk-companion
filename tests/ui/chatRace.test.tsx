// @vitest-environment jsdom
// 缺陷回归:ChatPage 会话切换竞态(旧请求迟到覆盖新会话)与切换时未重置流式状态
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { ChatPage } from '../../src/renderer/workbench/pages/ChatPage'
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

    // A 会话收到流式增量:界面出现流式文本
    act(() => {
      handlers.get('evt:chat-delta')?.({ conversationId: 'conv-a', delta: 'A会话流式文本' })
    })
    expect(await screen.findByText('A会话流式文本')).toBeTruthy()

    // 切到 B:流式状态被重置,A 的流式文本不再显示
    fireEvent.click(screen.getByText('会话B'))
    await vi.waitFor(() => expect(screen.getByText('会话B的最新消息')).toBeTruthy())
    expect(screen.queryByText('A会话流式文本')).toBeNull()
  })
})
