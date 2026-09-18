// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { TopBar } from '../../src/renderer/workbench/TopBar'
import type { MailSummary } from '../../src/shared/mail'
import type { CalendarEvent, Conversation, PendingItem, Todo } from '../../src/shared/types'

afterEach(cleanup)

function summary(over: Partial<MailSummary> = {}): MailSummary {
  return {
    id: 'm1',
    accountId: 'a1',
    accountLabel: '学习邮箱',
    from: 'teacher@example.com',
    to: 'me@qq.com',
    receivedAt: '2026-09-17T05:00:00Z',
    read: false,
    hasAttachments: false,
    bodyState: 'ready',
    remoteAvailable: true,
    subject: '关于课程项目中期汇报的安排',
    ...over
  } as MailSummary
}

function todo(over: Partial<Todo> = {}): Todo {
  return {
    id: 't1',
    title: '整理课程项目汇报材料',
    priority: 'normal',
    completedAt: null,
    source: 'manual',
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:00Z',
    ...over
  } as Todo
}

function makeApi() {
  return {
    mail: { list: vi.fn(async (_q?: unknown) => ({ ok: true, value: { items: [summary()], hasMore: false } })) },
    listTodos: vi.fn(async () => [todo()]),
    listEvents: vi.fn(async () => [] as CalendarEvent[]),
    listConversations: vi.fn(async () => [] as Conversation[]),
    listPending: vi.fn(async () => [] as PendingItem[])
  }
}

type Api = ReturnType<typeof makeApi>

function renderBar(api: Api, onNavigate = vi.fn()): { onNavigate: ReturnType<typeof vi.fn> } {
  render(
    <TopBar
      group="我的空间"
      pageLabel="今日概览"
      pendingCount={0}
      onNavigate={onNavigate}
      searchSources={{
        mails: () => api.mail.list({ search: '', page: 0 }).then(() => [summary()]),
        todos: api.listTodos as unknown as () => Promise<Todo[]>,
        events: api.listEvents as unknown as () => Promise<CalendarEvent[]>,
        conversations: api.listConversations as unknown as () => Promise<Conversation[]>,
        pendings: api.listPending as unknown as () => Promise<PendingItem[]>
      }}
    />
  )
  return { onNavigate }
}

describe('TopBar', () => {
  it('渲染面包屑与搜索框', () => {
    renderBar(makeApi())
    expect(screen.getByText('我的空间')).toBeTruthy()
    expect(screen.getByText('/')).toBeTruthy()
    expect(screen.getByText('今日概览')).toBeTruthy()
    expect(screen.getByRole('searchbox', { name: '全局搜索' })).toBeTruthy()
  })

  it('输入关键词回车后展示分组结果,点击命中跳转对应页面', async () => {
    const { onNavigate } = renderBar(makeApi())
    const user = userEvent.setup()
    const input = screen.getByRole('searchbox', { name: '全局搜索' })
    await user.type(input, '课程{Enter}')
    expect(await screen.findByText('邮件')).toBeTruthy()
    expect(screen.getByText('待办')).toBeTruthy()
    fireEvent.click(screen.getByText('关于课程项目中期汇报的安排'))
    expect(onNavigate).toHaveBeenCalledWith('mail')
  })

  it('Ctrl+K 聚焦搜索框', async () => {
    renderBar(makeApi())
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: '全局搜索' })))
  })

  it('铃铛跳待处理,头像跳个人资料', () => {
    const { onNavigate } = renderBar(makeApi())
    fireEvent.click(screen.getByRole('button', { name: '通知与待处理' }))
    expect(onNavigate).toHaveBeenCalledWith('pending')
    fireEvent.click(screen.getByRole('button', { name: '个人资料' }))
    expect(onNavigate).toHaveBeenCalledWith('profile')
  })
})
