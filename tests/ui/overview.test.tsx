// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { OverviewPage } from '../../src/renderer/workbench/pages/OverviewPage'
import { toDateStr } from '../../src/shared/dateUtils'

afterEach(cleanup)

const today = toDateStr(new Date())

function installApi(over: Record<string, unknown> = {}): { updateTodo: ReturnType<typeof vi.fn> } {
  const updateTodo = vi.fn(async () => {})
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    getDayAgenda: vi.fn(async () => ({
      date: today,
      courses: [
        {
          course: { name: '软件工程' },
          date: today,
          startTime: '09:00',
          endTime: '10:35',
          location: '教学楼 A-302',
          cancelled: false
        }
      ],
      events: [
        {
          id: 'e1',
          title: '课程项目小组讨论',
          startAt: `${today}T14:00:00`,
          endAt: `${today}T15:00:00`,
          allDay: false,
          location: '图书馆·研讨室 2',
          source: 'manual',
          status: 'active'
        }
      ],
      todos: [],
      schoolEvents: []
    })),
    listTodos: vi.fn(async () => [
      {
        id: 't1',
        title: '整理课程项目的汇报材料',
        dueAt: `${today}T18:00:00`,
        priority: 'normal',
        source: 'manual',
        createdAt: `${today}T08:00:00`,
        updatedAt: `${today}T08:00:00`
      },
      {
        id: 't2',
        title: '提交本周的阅读笔记',
        priority: 'normal',
        source: 'manual',
        completedAt: `${today}T10:26:00`,
        createdAt: `${today}T08:00:00`,
        updatedAt: `${today}T10:26:00`
      }
    ]),
    listPending: vi.fn(async () => [
      { id: 'p1', title: '确认周五小组讨论的时间', status: 'open', createdAt: `${today}T09:00:00`, updatedAt: `${today}T09:00:00` }
    ]),
    listEvents: vi.fn(async () => []),
    updateTodo,
    mail: {
      accounts: vi.fn(async () => ({
        ok: true,
        value: [
          { id: 'a1', label: 'QQ 邮箱', email: 'a@qq.com', provider: 'qq', host: 'imap.qq.com', port: 993, enabled: true, hasCredential: true, status: 'idle', lastSuccessAt: null, error: null },
          { id: 'a2', label: 'Gmail', email: 'b@gmail.com', provider: 'gmail', host: 'imap.gmail.com', port: 993, enabled: true, hasCredential: true, status: 'idle', lastSuccessAt: null, error: null }
        ]
      })),
      list: vi.fn(async (query: { unreadOnly?: boolean }) => ({
        ok: true,
        value: query.unreadOnly
          ? { items: [{}, {}], hasMore: false }
          : {
              items: [
                {
                  id: 'm1',
                  accountId: 'a1',
                  accountLabel: 'QQ 邮箱',
                  subject: '关于课程项目中期汇报的安排',
                  from: '课程通知',
                  to: 'me',
                  receivedAt: `${today}T13:42:00`,
                  read: false,
                  hasAttachments: false,
                  bodyState: 'cached',
                  remoteAvailable: true
                }
              ],
              hasMore: false
            }
      }))
    },
    on: vi.fn(() => () => {}),
    ...over
  }
  return { updateTodo }
}

describe('今日概览(深色主题)', () => {
  beforeEach(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  afterEach(() => {
    delete document.documentElement.dataset.theme
  })

  it('渲染问候、统计与真实数据映射', async () => {
    installApi()
    const { container } = render(<OverviewPage refreshKey={0} onNavigate={() => {}} />)

    // 问候语(时段相关,只断言稳定部分)
    expect((await screen.findByText(/今天也从容一点。/)).textContent).toContain('今天也从容一点。')

    // 统计卡:2 项今日安排、1 项待完成、2 封未读
    await waitFor(() => expect(container.querySelectorAll('.ov-stat').length).toBe(3))
    const stats = Array.from(container.querySelectorAll('.ov-stat')).map((el) => el.textContent ?? '')
    expect(stats[0]).toContain('今日安排')
    expect(stats[0]).toContain('2')
    expect(stats[1]).toContain('待完成事项')
    expect(stats[1]).toContain('1')
    expect(stats[2]).toContain('未读邮件')
    expect(stats[2]).toContain('2')
    expect(stats[2]).toContain('来自 2 个邮箱')

    // 待办与待确认
    expect(await screen.findByText('整理课程项目的汇报材料')).toBeTruthy()
    expect(await screen.findByText('确认周五小组讨论的时间')).toBeTruthy()
    expect(await screen.findByText('待确认')).toBeTruthy()
    // 已完成项划线展示
    expect((await screen.findByText('提交本周的阅读笔记')).className).toContain('ov-todo-title')

    // 时间线:课程与日程都在
    expect(await screen.findByText('软件工程')).toBeTruthy()
    expect(await screen.findByText('课程项目小组讨论')).toBeTruthy()
    expect(await screen.findByText('09:00 – 10:35')).toBeTruthy()

    // 邮件
    expect(await screen.findByText('关于课程项目中期汇报的安排')).toBeTruthy()
    expect(await screen.findByText(/QQ 邮箱/)).toBeTruthy()
  })

  it('勾选待办调用 updateTodo 完成该项', async () => {
    const { updateTodo } = installApi()
    render(<OverviewPage refreshKey={0} onNavigate={() => {}} />)
    const title = await screen.findByText('整理课程项目的汇报材料')
    const checkbox = title.closest('.ov-todo')!.querySelector('input[type=checkbox]')!
    fireEvent.click(checkbox)
    await waitFor(() => expect(updateTodo).toHaveBeenCalledWith('t1', expect.objectContaining({ completedAt: expect.any(String) })))
  })

  it('邮箱未配置时显示空态而非虚假数字', async () => {
    installApi({
      mail: {
        accounts: vi.fn(async () => ({ ok: true, value: [] })),
        list: vi.fn(async () => ({ ok: true, value: { items: [], hasMore: false } }))
      }
    })
    render(<OverviewPage refreshKey={0} onNavigate={() => {}} />)
    expect(await screen.findByText(/还没有配置邮箱/)).toBeTruthy()
    expect((await screen.findByText(/未读邮件/)).parentElement?.textContent).toContain('来自 0 个邮箱')
  })

  it('统计卡与邮件点击触发页面导航', async () => {
    installApi()
    const navigations: string[] = []
    render(<OverviewPage refreshKey={0} onNavigate={(p) => navigations.push(p)} />)

    fireEvent.click(await screen.findByText(/未读邮件/))
    expect(navigations).toContain('mail')

    fireEvent.click(await screen.findByText('关于课程项目中期汇报的安排'))
    expect(navigations.filter((n) => n === 'mail').length).toBeGreaterThanOrEqual(2)

    fireEvent.click(await screen.findByText('全部待办 ›'))
    expect(navigations).toContain('todos')

    fireEvent.click(await screen.findByText('+ 新建安排'))
    expect(navigations).toContain('calendar')
  })
})
