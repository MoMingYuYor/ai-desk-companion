// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MailDetailView } from '../../src/renderer/workbench/mail/MailDetailView'
import type { MailAttachmentInfo, MailDetail } from '../../src/shared/mail'
import type { Analysis } from '../../src/shared/types'

afterEach(cleanup)

function attachment(over: Partial<MailAttachmentInfo> = {}): MailAttachmentInfo {
  return {
    id: 'att-1',
    messageId: 'm1',
    name: '通知.pdf',
    mime: 'application/pdf',
    size: 2048,
    downloaded: false,
    analyzable: true,
    ...over
  }
}

function detail(over: Partial<MailDetail> = {}): MailDetail {
  return {
    message: {
      id: 'm1',
      accountId: 'a1',
      accountLabel: '学习邮箱',
      subject: '报名通知',
      from: 'teacher@example.com',
      to: 'me@qq.com',
      receivedAt: '2026-09-15T01:00:00Z',
      read: false,
      hasAttachments: true,
      bodyState: 'cached',
      remoteAvailable: true
    },
    text: '',
    safeHtml: '<p>会议改到<b>周五</b>举行</p>',
    links: [{ label: '报名入口', url: 'https://example.com/signup' }],
    attachments: [attachment()],
    ...over
  }
}

function baseProps(over: Partial<Parameters<typeof MailDetailView>[0]> = {}): Parameters<typeof MailDetailView>[0] {
  return {
    detail: detail(),
    loading: false,
    conversationId: 'conv-1',
    analysisStatus: null,
    analysisHistory: [],
    onAnalyze: vi.fn(),
    onCancelAnalysis: vi.fn(),
    onMarkRead: vi.fn(),
    onOpenLink: vi.fn(),
    onDownload: vi.fn(),
    onSaveAttachment: vi.fn(),
    onOpenConversation: vi.fn(),
    onOpenSource: vi.fn(),
    ...over
  }
}

describe('MailDetailView', () => {
  it('用 safeHtml 渲染正文,链接点击走 onOpenLink', () => {
    const props = baseProps()
    const { container } = render(<MailDetailView {...props} />)
    expect(container.querySelector('.mail-body-html')?.innerHTML).toContain('会议改到')
    expect(screen.getByText('周五')).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: '报名入口' }))
    expect(props.onOpenLink).toHaveBeenCalledWith('https://example.com/signup')
  })

  it('纯文本正文渲染,无正文显示空态提示', () => {
    const props = baseProps({ detail: detail({ safeHtml: '', text: '纯文本正文' }) })
    render(<MailDetailView {...props} />)
    expect(screen.getByText('纯文本正文')).toBeTruthy()
    cleanup()
    render(<MailDetailView {...baseProps({ detail: detail({ safeHtml: '', text: '' }) })} />)
    expect(screen.getByText('(此邮件没有正文内容)')).toBeTruthy()
  })

  it('无详情时显示空态,加载中显示加载文案', () => {
    render(<MailDetailView {...baseProps({ detail: null })} />)
    expect(screen.getByText('选择一封邮件查看详情')).toBeTruthy()
    cleanup()
    render(<MailDetailView {...baseProps({ detail: null, loading: true })} />)
    expect(screen.getByText('正在加载邮件…')).toBeTruthy()
  })

  it('勾选附件后点击 AI 分析,以选中 id 列表回调;不可分析附件被禁用', () => {
    const props = baseProps({
      detail: detail({
        attachments: [
          attachment({ id: 'att-1', name: '通知.pdf' }),
          attachment({ id: 'att-2', name: '表格.xlsx', mime: 'application/vnd.ms-excel' }),
          attachment({ id: 'att-3', name: 'logo.png', mime: 'image/png', analyzable: false })
        ]
      })
    })
    render(<MailDetailView {...props} />)
    const notAnalyzable = screen.getByRole('checkbox', { name: /logo\.png/ }) as HTMLInputElement
    expect(notAnalyzable.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: /通知\.pdf/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /表格\.xlsx/ }))
    fireEvent.click(screen.getByRole('button', { name: 'AI 分析' }))
    expect(props.onAnalyze).toHaveBeenCalledTimes(1)
    expect(props.onAnalyze).toHaveBeenCalledWith(['att-1', 'att-2'])
  })

  it('未勾选附件时 AI 分析按钮禁用;附件可下载/保存', () => {
    const props = baseProps()
    render(<MailDetailView {...props} />)
    expect((screen.getByRole('button', { name: 'AI 分析' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: /通知\.pdf/ }))
    expect((screen.getByRole('button', { name: 'AI 分析' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '下载' }))
    expect(props.onDownload).toHaveBeenCalledWith('att-1')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(props.onSaveAttachment).toHaveBeenCalledWith('att-1')
  })

  it('分析进行中显示进行中文案与取消按钮,取消触发回调', () => {
    const props = baseProps({
      analysisStatus: { conversationId: 'conv-1', state: 'running', analysisId: null, error: null }
    })
    render(<MailDetailView {...props} />)
    expect(screen.getByText('正在分析附件…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消分析' }))
    expect(props.onCancelAnalysis).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: 'AI 分析' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('分析失败显示错误信息;完成显示完成', () => {
    const props = baseProps({
      analysisStatus: { conversationId: 'conv-1', state: 'failed', analysisId: null, error: '模型超时' }
    })
    render(<MailDetailView {...props} />)
    expect(screen.getByText('分析失败')).toBeTruthy()
    expect(screen.getByText('模型超时')).toBeTruthy()
    cleanup()
    render(
      <MailDetailView
        {...baseProps({
          analysisStatus: { conversationId: 'conv-1', state: 'done', analysisId: 'an-1', error: null }
        })}
      />
    )
    expect(screen.getByText('分析完成')).toBeTruthy()
  })

  it('未读切换回调 onMarkRead', () => {
    const props = baseProps()
    render(<MailDetailView {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '标记为已读' }))
    expect(props.onMarkRead).toHaveBeenCalledWith(true)
    cleanup()
    const props2 = baseProps({ detail: detail({ message: { ...detail().message, read: true } }) })
    render(<MailDetailView {...props2} />)
    fireEvent.click(screen.getByRole('button', { name: '标记为未读' }))
    expect(props2.onMarkRead).toHaveBeenCalledWith(false)
  })

  it('分析历史版本下拉选择后展示说明,并可打开分析会话', () => {
    const history: Analysis[] = [
      {
        id: 'an-1',
        conversationId: 'conv-1',
        version: 1,
        payload: { summary: '第 1 版说明' },
        status: 'done',
        createdAt: '2026-09-15T02:00:00Z'
      }
    ]
    const props = baseProps({ analysisHistory: history })
    render(<MailDetailView {...props} />)
    expect(screen.queryByText('第 1 版说明')).toBeNull()
    fireEvent.change(screen.getByLabelText('分析历史版本'), { target: { value: '0' } })
    expect(screen.getByText('第 1 版说明')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看分析会话' }))
    expect(props.onOpenConversation).toHaveBeenCalledWith('conv-1')
  })
})
