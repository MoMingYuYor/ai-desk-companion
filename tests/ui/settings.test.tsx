// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { SettingsPage } from '../../src/renderer/workbench/pages/SettingsPage'
import type { ProviderInfo } from '../../src/shared/types'

afterEach(cleanup)

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

function installApi(over: Record<string, unknown> = {}): { fetchModels: ReturnType<typeof vi.fn> } {
  const fetchModels = vi.fn(async () => ['model-a', 'model-b'])
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    listProviders: vi.fn(async () => [provider()]),
    getAppInfo: vi.fn(async () => ({ dataDir: 'D:\\data', version: '0.1.0', electron: '31' })),
    deleteProvider: vi.fn(async () => {}),
    setDefaultProvider: vi.fn(async () => {}),
    saveProvider: vi.fn(async () => null),
    exportBackup: vi.fn(async () => ''),
    importBackup: vi.fn(async () => true),
    on: vi.fn(() => () => {}),
    fetchModels,
    ...over
  }
  return { fetchModels }
}

describe('设置页:模型服务编辑器', () => {
  it('自动获取模型列表后,默认模型下拉立即可选(无需保存重进)', async () => {
    installApi()
    const user = userEvent.setup()
    const { container } = render(<SettingsPage refreshKey={0} />)

    // 打开编辑器
    fireEvent.click(await screen.findByText('编辑'))

    // 点击"自动获取模型列表"(baseUrl 已填,按钮可用)
    fireEvent.click(await screen.findByText('自动获取模型列表'))

    // 默认模型下拉是表单中的第二个 select(第一个是接口协议)
    const select = (await waitFor(() => {
      const selects = container.querySelectorAll<HTMLSelectElement>('.form-grid select')
      expect(selects.length).toBe(2)
      const options = Array.from(selects[1].options).map((o) => o.value)
      expect(options).toContain('model-a')
      expect(options).toContain('model-b')
      return selects[1]
    })) as HTMLSelectElement

    // 可以直接选择,无需保存重进
    await user.selectOptions(select, 'model-b')
    expect(select.value).toBe('model-b')
  })
})
