// @vitest-environment jsdom
// 缺陷回归:裸 await 导致的错误不可达 —— 设置页测试连接/保存模型、邮箱管理添加账号、加载更早邮件
// 期望:mock reject 后错误文案出现,忙态按钮恢复可用
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { SettingsPage } from '../../src/renderer/workbench/pages/SettingsPage'
import { MailPage } from '../../src/renderer/workbench/mail/MailPage'
import { MailManagerView } from '../../src/renderer/workbench/mail/MailManagerView'
import type { ProviderInfo } from '../../src/shared/types'
import type { MailAccountInfo, MailAnalysisStatus, MailApi, MailResult, MailSubscribe, MailSummary } from '../../src/shared/mail'

afterEach(cleanup)

// ---------- 设置页 ----------

function provider(over: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: 'p1',
    name: '测试服务',
    baseUrl: 'https://api.example.com/v1',
    protocol: 'chat-completions',
    models: [],
    defaultModel: '',
    supportsVision: false,
    supportsJsonMode: false,
    isDefault: true,
    sortOrder: 0,
    hasApiKey: true,
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
    ...over
  }
}

function installSettingsApi(over: Record<string, unknown> = {}): { saveProvider: ReturnType<typeof vi.fn> } {
  const saveProvider = vi.fn(async () => null)
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    listProviders: vi.fn(async () => [provider()]),
    getAppInfo: vi.fn(async () => ({ dataDir: 'D:\\data', version: '0.1.0', electron: '31' })),
    deleteProvider: vi.fn(async () => {}),
    setDefaultProvider: vi.fn(async () => {}),
    saveProvider,
    exportBackup: vi.fn(async () => ''),
    importBackup: vi.fn(async () => true),
    on: vi.fn(() => () => {}),
    fetchModels: vi.fn(async () => []),
    ...over
  }
  return { saveProvider }
}

describe('设置页错误处理', () => {
  it('测试连接接口抛异常时显示错误文案且按钮恢复可用', async () => {
    installSettingsApi({
      testProvider: vi.fn(async () => {
        throw new Error('网络超时')
      })
    })
    render(<SettingsPage refreshKey={0} />)

    fireEvent.click(await screen.findByText('编辑'))
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))

    expect(await screen.findByText('网络超时')).toBeTruthy()
    // finally 恢复:不再是"测试中…",按钮可再次点击
    expect(screen.queryByText('测试中…')).toBeNull()
    expect((screen.getByRole('button', { name: '测试连接' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('保存模型服务失败时弹出错误提示,编辑器保持打开', async () => {
    const saveProvider = vi.fn(async () => {
      throw new Error('保存被拒绝')
    })
    installSettingsApi({ saveProvider })
    render(<SettingsPage refreshKey={0} />)

    fireEvent.click(await screen.findByText('+ 添加模型服务'))
    fireEvent.change(screen.getByPlaceholderText('如 DeepSeek / 通义 / 自建网关'), { target: { value: '新服务' } })
    fireEvent.change(screen.getByPlaceholderText('如 https://api.deepseek.com/v1'), {
      target: { value: 'https://api.example.com/v1' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('保存失败:保存被拒绝')).toBeTruthy()
    expect(saveProvider).toHaveBeenCalledTimes(1)
    // onSaved 未调用:编辑器仍在,可修改后重试
    expect(screen.getByPlaceholderText('如 DeepSeek / 通义 / 自建网关')).toBeTruthy()
  })
})

// ---------- 邮箱:管理视图与加载更早 ----------

function ok<T>(value: T): MailResult<T> {
  return { ok: true, value }
}

function account(): MailAccountInfo {
  return {
    id: 'a1',
    label: '学习邮箱',
    email: 'study@qq.com',
    provider: 'qq',
    host: 'imap.qq.com',
    port: 993,
    enabled: true,
    hasCredential: true,
    status: 'idle',
    lastSuccessAt: null,
    error: null
  }
}

function summary(id: string): MailSummary {
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
    remoteAvailable: true
  }
}

function makeMailApi(over: Partial<MailApi> = {}): MailApi {
  const preparingStatus: MailAnalysisStatus = { conversationId: 'conv-x', state: 'preparing', analysisId: null, error: null }
  return {
    accounts: vi.fn(async () => ok([account()])),
    test: vi.fn(async () => ok(undefined)),
    save: vi.fn(async () => ok(account())),
    setEnabled: vi.fn(async () => ok(undefined)),
    remove: vi.fn(async () => ok(undefined)),
    sync: vi.fn(async () => ok(undefined)),
    earlier: vi.fn(async () => ok(undefined)),
    list: vi.fn(async () => ok({ items: [summary('m1')], hasMore: false })),
    detail: vi.fn(async () => ok({ message: summary('m1'), text: '', safeHtml: '', links: [], attachments: [] })),
    markRead: vi.fn(async () => ok(undefined)),
    download: vi.fn(async () =>
      ok({ id: 'att-1', messageId: 'm1', name: 'a.pdf', mime: 'application/pdf', size: 1, downloaded: false, analyzable: true })
    ),
    saveAttachment: vi.fn(async () => ok({ saved: true })),
    openLink: vi.fn(async () => ok(undefined)),
    openWebmail: vi.fn(async () => ok(undefined)),
    analyze: vi.fn(async () => ok(preparingStatus)),
    analysisStatus: vi.fn(async () => ok(null)),
    cancelAnalysis: vi.fn(async () => ok(undefined)),
    source: vi.fn(async () => ok(null)),
    ...over
  }
}

const subscribe: MailSubscribe = () => () => {}

describe('邮箱错误处理', () => {
  it('添加账号时 IPC 抛异常:提示错误且提交按钮恢复可用', async () => {
    const api = makeMailApi({
      test: vi.fn(async () => {
        throw new Error('IPC 调用失败')
      })
    })
    const onSaved = vi.fn()
    render(<MailManagerView api={api} accounts={[]} loading={false} onAccountsChanged={() => {}} onSaved={onSaved} />)

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '学习邮箱' } })
    fireEvent.change(screen.getByLabelText('邮箱地址'), { target: { value: 'study@qq.com' } })
    fireEvent.change(screen.getByLabelText('授权码'), { target: { value: 'cred' } })

    const submit = screen.getByRole('button', { name: '测试并保存' }) as HTMLButtonElement
    fireEvent.click(submit)

    expect(await screen.findByText('添加失败:IPC 调用失败')).toBeTruthy()
    expect(submit.disabled).toBe(false)
    expect(submit.textContent).toBe('测试并保存')
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('加载更早邮件失败时显示提示', async () => {
    const api = makeMailApi({
      earlier: vi.fn(async () => {
        throw new Error('连接中断')
      })
    })
    render(<MailPage api={api} subscribe={subscribe} />)
    await screen.findByText('通知 m1')

    // 选择具体账号后"加载更早邮件"按钮才可用
    fireEvent.change(screen.getByLabelText('账号筛选'), { target: { value: 'a1' } })
    fireEvent.click(await screen.findByRole('button', { name: '加载更早邮件' }))

    expect(await screen.findByText('加载更早邮件失败:连接中断')).toBeTruthy()
  })
})
