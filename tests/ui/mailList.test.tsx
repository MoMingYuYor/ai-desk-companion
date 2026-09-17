// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MailList } from '../../src/renderer/workbench/mail/MailList'
import type { MailSummary } from '../../src/shared/mail'

afterEach(cleanup)

function item(over: Partial<MailSummary> = {}): MailSummary {
  return {
    id: 'm1',
    accountId: 'a1',
    accountLabel: '学习邮箱',
    subject: '报名通知',
    from: 'teacher@example.com',
    to: 'me@qq.com',
    receivedAt: '2026-09-15T01:00:00Z',
    read: false,
    hasAttachments: false,
    bodyState: 'missing',
    remoteAvailable: true,
    ...over
  }
}

function baseProps(over: Partial<Parameters<typeof MailList>[0]> = {}): Parameters<typeof MailList>[0] {
  return {
    items: [item()],
    activeId: null,
    onSelect: vi.fn(),
    hasMore: false,
    onLoadMore: vi.fn(),
    unreadOnly: false,
    onToggleUnread: vi.fn(),
    search: '',
    onSearch: vi.fn(),
    loading: false,
    ...over
  }
}

describe('MailList', () => {
  it('空列表显示空态', () => {
    render(<MailList {...baseProps({ items: [] })} />)
    expect(screen.getByText('收件箱为空')).toBeTruthy()
  })

  it('搜索无匹配显示对应空态', () => {
    render(<MailList {...baseProps({ items: [], search: '不存在' })} />)
    expect(screen.getByText('没有匹配的邮件')).toBeTruthy()
  })

  it('有数据显示发件人/主题/未读点/附件标记/账号徽标', () => {
    const { container } = render(
      <MailList {...baseProps({ items: [item({ hasAttachments: true })], showAccountLabel: true })} />
    )
    expect(screen.getByText('报名通知')).toBeTruthy()
    expect(screen.getByText('teacher@example.com')).toBeTruthy()
    expect(container.querySelector('.mail-unread-dot')).toBeTruthy()
    expect(screen.getByText('📎')).toBeTruthy()
    expect(screen.getByText('学习邮箱')).toBeTruthy()
  })

  it('已读邮件不显示未读点,不勾选账号徽标时不显示 label', () => {
    const { container } = render(
      <MailList {...baseProps({ items: [item({ read: true, hasAttachments: false })] })} />
    )
    expect(container.querySelector('.mail-unread-dot')).toBeNull()
    expect(screen.queryByText('学习邮箱')).toBeNull()
  })

  it('点击行触发 onSelect', () => {
    const onSelect = vi.fn()
    render(<MailList {...baseProps({ onSelect })} />)
    fireEvent.click(screen.getByRole('button', { name: /报名通知/ }))
    expect(onSelect).toHaveBeenCalledWith('m1')
  })

  it('hasMore 时显示加载更多并触发回调', () => {
    const onLoadMore = vi.fn()
    render(<MailList {...baseProps({ hasMore: true, onLoadMore })} />)
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('无更多时不显示加载更多', () => {
    render(<MailList {...baseProps({ hasMore: false })} />)
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull()
  })

  it('搜索输入触发 onSearch', async () => {
    const user = userEvent.setup()
    const onSearch = vi.fn()
    // 受控输入需要外层同步 state,模拟真实用法
    function Harness(): JSX.Element {
      const [search, setSearch] = useState('')
      return (
        <MailList
          {...baseProps({
            search,
            onSearch: (s) => {
              onSearch(s)
              setSearch(s)
            }
          })}
        />
      )
    }
    render(<Harness />)
    await user.type(screen.getByLabelText('搜索邮件'), '会议')
    expect(onSearch).toHaveBeenLastCalledWith('会议')
  })

  it('未读筛选切换触发 onToggleUnread', () => {
    const onToggleUnread = vi.fn()
    render(<MailList {...baseProps({ onToggleUnread })} />)
    fireEvent.click(screen.getByRole('checkbox', { name: '只看未读' }))
    expect(onToggleUnread).toHaveBeenCalledTimes(1)
  })
})
