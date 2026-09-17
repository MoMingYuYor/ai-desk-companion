// @vitest-environment jsdom
// useMailbox + MailPage 导航链路:事件驱动重载、账号筛选、分析状态与会话跳转
// 全部注入替身 api,不等待真实 IPC/IMAP
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MailPage } from '../../src/renderer/workbench/mail/MailPage'
import type {
  MailAccountInfo,
  MailAnalysisStatus,
  MailApi,
  MailDetail,
  MailEventMap,
  MailListQuery,
  MailResult,
  MailSubscribe,
  MailSummary
} from '../../src/shared/mail'

afterEach(cleanup)

function ok<T>(value: T): MailResult<T> {
  return { ok: true, value }
}

const accounts: MailAccountInfo[] = [
  {
    id: 'a1',
    label: '学习邮箱',
    email: 'study@qq.com',
    provider: 'qq',
    host: 'imap.qq.com',
    port: 993,
    enabled: true,
    hasCredential: true,
    status: 'idle',
    lastSuccessAt: '2026-09-15T01:00:00Z',
    error: null
  },
  {
    id: 'a2',
    label: '工作邮箱',
    email: 'work@163.com',
    provider: '163',
    host: 'imap.163.com',
    port: 993,
    enabled: true,
    hasCredential: true,
    status: 'idle',
    lastSuccessAt: null,
    error: null
  }
]

function summary(id: string, over: Partial<MailSummary> = {}): MailSummary {
  return {
    id,
    accountId: 'a1',
    accountLabel: '学习邮箱',
    subject: `通知 ${id}`,
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

function detailFor(id: string): MailDetail {
  return {
    message: summary(id),
    text: `正文内容 ${id}`,
    safeHtml: '',
    links: [],
    attachments: []
  }
}

function makeEnv(opts: { accounts?: MailAccountInfo[] } = {}) {
  const accountList = [...(opts.accounts ?? accounts)]
  let items: MailSummary[] = [
    summary('m1'),
    summary('m2', { accountId: 'a2', accountLabel: '工作邮箱', from: 'boss@example.com' })
  ]
  let analysis: MailAnalysisStatus | null = {
    conversationId: 'conv-1',
    state: 'running',
    analysisId: null,
    error: null
  }
  const accountsFn = vi.fn(async () => ok(accountList))
  const preparingStatus: MailAnalysisStatus = {
    conversationId: 'conv-x',
    state: 'preparing',
    analysisId: null,
    error: null
  }
  const listFn = vi.fn(async (query: MailListQuery) => {
    const filtered = query.accountId ? items.filter((m) => m.accountId === query.accountId) : items
    return ok({ items: filtered, hasMore: false })
  })
  const detailFn = vi.fn(async (id: string) => ok(detailFor(id)))
  const analysisStatusFn = vi.fn(async (_id: string) => ok(analysis))
  const cancelAnalysisFn = vi.fn(async () => ok(undefined))
  const api: MailApi = {
    accounts: accountsFn,
    test: vi.fn(async () => ok(undefined)),
    save: vi.fn(async () => ok(accounts[0])),
    setEnabled: vi.fn(async () => ok(undefined)),
    remove: vi.fn(async () => ok(undefined)),
    sync: vi.fn(async () => ok(undefined)),
    earlier: vi.fn(async () => ok(undefined)),
    list: listFn,
    detail: detailFn,
    markRead: vi.fn(async () => ok(undefined)),
    download: vi.fn(async () =>
      ok({ id: 'att-1', messageId: 'm1', name: 'a.pdf', mime: 'application/pdf', size: 1, downloaded: false, analyzable: true })
    ),
    saveAttachment: vi.fn(async () => ok({ saved: true })),
    openLink: vi.fn(async () => ok(undefined)),
    openWebmail: vi.fn(async () => ok(undefined)),
    analyze: vi.fn(async () => ok(preparingStatus)),
    analysisStatus: analysisStatusFn,
    cancelAnalysis: cancelAnalysisFn,
    source: vi.fn(async () => ok(null))
  }
  const handlers = new Map<string, Array<(payload: unknown) => void>>()
  const subscribe: MailSubscribe = (channel, listener) => {
    const list = handlers.get(channel) ?? []
    list.push(listener as (payload: unknown) => void)
    handlers.set(channel, list)
    return () => {
      handlers.set(channel, (handlers.get(channel) ?? []).filter((l) => l !== listener))
    }
  }
  const emit = (channel: keyof MailEventMap, payload: MailEventMap[typeof channel]): void => {
    for (const listener of [...(handlers.get(channel) ?? [])]) listener(payload)
  }
  return {
    api,
    subscribe,
    emit,
    addAccount: (a: MailAccountInfo) => {
      accountList.push(a)
    },
    listFn,
    detailFn,
    analysisStatusFn,
    cancelAnalysisFn,
    setAnalysis: (next: MailAnalysisStatus | null) => {
      analysis = next
    }
  }
}

describe('邮箱导航(useMailbox + MailPage)', () => {
  // 让挂载/点击后的异步加载(账号、列表、详情、分析状态)在 act 作用域内完成,避免告警
  const flush = (): Promise<void> => act(async () => {})

  it('收到 evt:mail-changed 后重载列表', async () => {
    const env = makeEnv()
    render(<MailPage api={env.api} subscribe={env.subscribe} />)
    await flush()
    await screen.findByText('通知 m1')
    expect(env.listFn).toHaveBeenCalledTimes(1)
    env.emit('evt:mail-changed', { accountId: 'a1' })
    await waitFor(() => expect(env.listFn).toHaveBeenCalledTimes(2))
    expect(env.listFn.mock.calls[1][0]).toEqual(expect.objectContaining({ page: 0 }))
  })

  it('evt:mail-analysis 更新当前邮件的分析状态', async () => {
    const env = makeEnv()
    render(<MailPage api={env.api} subscribe={env.subscribe} />)
    await flush()
    fireEvent.click(await screen.findByRole('button', { name: /通知 m1/ }))
    await flush()
    expect(await screen.findByText('正文内容 m1')).toBeTruthy()
    // detail 加载后 hook 调 analysisStatus,得到 running 状态
    expect(await screen.findByText('正在分析附件…')).toBeTruthy()
    act(() => {
      env.emit('evt:mail-analysis', { conversationId: 'conv-1', state: 'done', analysisId: 'an-9', error: null })
    })
    expect(await screen.findByText('分析完成')).toBeTruthy()
  })

  it('evt:mail-sync 更新对应账号状态徽标', async () => {
    const env = makeEnv()
    render(<MailPage api={env.api} subscribe={env.subscribe} />)
    await flush()
    await screen.findByText('通知 m1')
    // 账号状态徽标在管理视图
    fireEvent.click(screen.getByRole('button', { name: '管理邮箱' }))
    await screen.findByText('已有账号')
    act(() => {
      env.emit('evt:mail-sync', {
        accountId: 'a1',
        status: 'syncing',
        loaded: 3,
        lastSuccessAt: null,
        error: null
      })
    })
    expect(await screen.findByText('同步中')).toBeTruthy()
  })

  it('选择账号筛选后 api.list 以 accountId 参数调用并过滤列表', async () => {
    const env = makeEnv()
    render(<MailPage api={env.api} subscribe={env.subscribe} />)
    await flush()
    await screen.findByText('通知 m1')
    // 账号筛选现在是顶部工具行的下拉
    fireEvent.change(screen.getByRole('combobox', { name: '账号筛选' }), { target: { value: 'a2' } })
    await waitFor(() =>
      expect(env.listFn.mock.calls[env.listFn.mock.calls.length - 1][0]).toEqual(
        expect.objectContaining({ accountId: 'a2' })
      )
    )
    expect(screen.queryByText('通知 m1')).toBeNull()
    expect(screen.getByText('通知 m2')).toBeTruthy()
  })

  it('点击"管理邮箱"切换到管理视图,返回收件箱可切回', async () => {
    const env = makeEnv()
    render(<MailPage api={env.api} subscribe={env.subscribe} />)
    await flush()
    await screen.findByText('通知 m1')
    fireEvent.click(screen.getByRole('button', { name: '管理邮箱' }))
    expect(await screen.findByText('邮箱管理')).toBeTruthy()
    // 授权码说明与管理表单都在管理视图内
    expect(screen.getByText('授权码是什么?')).toBeTruthy()
    expect(screen.getByLabelText('邮箱地址')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /返回收件箱/ }))
    expect(await screen.findByText('通知 m1')).toBeTruthy()
    expect(screen.queryByText('邮箱管理')).toBeNull()
  })

  it('没有账号时默认落在管理视图', async () => {
    const env = makeEnv({ accounts: [] })
    render(<MailPage api={env.api} subscribe={env.subscribe} />)
    await flush()
    expect(await screen.findByText('邮箱管理')).toBeTruthy()
    expect(screen.queryByText('收件箱为空')).toBeNull()
  })

  it('保存成功后自动回到收件箱', async () => {
    const env = makeEnv({ accounts: [] })
    render(<MailPage api={env.api} subscribe={env.subscribe} />)
    await flush()
    await screen.findByText('邮箱管理')
    const savedAccount: MailAccountInfo = {
      id: 'a-new',
      label: '新邮箱',
      email: 'new@qq.com',
      provider: 'qq',
      host: 'imap.qq.com',
      port: 993,
      enabled: true,
      hasCredential: true,
      status: 'idle',
      lastSuccessAt: null,
      error: null
    }
    env.api.save = vi.fn(async () => {
      env.addAccount(savedAccount)
      return ok(savedAccount)
    })
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新邮箱' } })
    fireEvent.change(screen.getByLabelText('邮箱地址'), { target: { value: 'new@qq.com' } })
    fireEvent.change(screen.getByLabelText('授权码'), { target: { value: 'authcode16' } })
    fireEvent.click(screen.getByRole('button', { name: '测试并保存' }))
    await waitFor(() => expect(env.api.save).toHaveBeenCalled())
    // 回到收件箱:工具行可见,列表渲染桩数据中的邮件
    expect(await screen.findByText('通知 m1')).toBeTruthy()
    expect(screen.queryByText('邮箱管理')).toBeNull()
  })

  it('网页版按钮跟随当前账号;全部账号时禁用', async () => {
    const env = makeEnv()
    render(<MailPage api={env.api} subscribe={env.subscribe} />)
    await flush()
    await screen.findByText('通知 m1')
    const btn = screen.getByRole('button', { name: /网页版邮箱/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.change(screen.getByRole('combobox', { name: '账号筛选' }), { target: { value: 'a1' } })
    await waitFor(() => expect(btn.disabled).toBe(false))
    fireEvent.click(btn)
    await waitFor(() => expect(env.api.openWebmail).toHaveBeenCalledWith('study@qq.com'))
  })

  it('点击"查看分析会话"触发 onOpenConversation 回调', async () => {
    const env = makeEnv()
    const onOpenConversation = vi.fn()
    render(<MailPage api={env.api} subscribe={env.subscribe} onOpenConversation={onOpenConversation} />)
    await flush()
    fireEvent.click(await screen.findByRole('button', { name: /通知 m1/ }))
    await flush()
    await screen.findByText('正文内容 m1')
    fireEvent.click(await screen.findByRole('button', { name: '查看分析会话' }))
    expect(onOpenConversation).toHaveBeenCalledWith('conv-1')
  })
})
