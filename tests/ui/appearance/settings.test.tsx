// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { AppearanceSettings } from '../../../src/renderer/shared/theme/AppearanceSettings'
import type { AppearanceClientPort } from '../../../src/renderer/shared/theme/controller'
import type { AppearanceResult, AppearanceSnapshot, ThemeMode } from '../../../src/shared/appearance'

afterEach(cleanup)

function fakeApi(over: Partial<AppearanceClientPort> = {}): AppearanceClientPort & {
  setCalls: ThemeMode[]
  listenerCount(): number
} {
  const listeners = new Set<(s: AppearanceSnapshot) => void>()
  const setCalls: ThemeMode[] = []
  return {
    setCalls,
    listenerCount: () => listeners.size,
    get: async () => ({ revision: 1, mode: 'dark', resolved: 'dark' }),
    set: async (mode): Promise<AppearanceResult> => {
      setCalls.push(mode)
      return { ok: true, value: { revision: 2, mode, resolved: mode === 'light' ? 'light' : 'dark' } }
    },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    ...over
  }
}

describe('外观设置控件', () => {
  it('深色下设置仍有明确控件语义,不依赖装饰色', async () => {
    document.documentElement.dataset.theme = 'dark'
    render(
      <AppearanceSettings
        api={{
          get: async () => ({ revision: 1, mode: 'dark', resolved: 'dark' }),
          set: async (mode) => ({
            ok: true,
            value: { revision: 2, mode, resolved: mode === 'light' ? 'light' : 'dark' }
          }),
          subscribe: () => () => {}
        }}
      />
    )
    expect(await screen.findByRole('radio', { name: '深色' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: '浅色' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: '跟随系统' })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: '外观' })).toBeTruthy()
    delete document.documentElement.dataset.theme
  })

  it('点击切换成功:调用 set 并更新选中态', async () => {
    const api = fakeApi()
    render(<AppearanceSettings api={api} />)
    const dark = await screen.findByRole('radio', { name: '深色' })
    await waitFor(() => expect((dark as HTMLInputElement).checked).toBe(true))

    await userEvent.click(screen.getByRole('radio', { name: '浅色' }))
    await waitFor(() => expect((screen.getByRole('radio', { name: '浅色' }) as HTMLInputElement).checked).toBe(true))
    expect(api.setCalls).toEqual(['light'])
  })

  it('键盘操作:聚焦后空格选中', async () => {
    const api = fakeApi()
    render(<AppearanceSettings api={api} />)
    const light = (await screen.findByRole('radio', { name: '浅色' })) as HTMLInputElement
    light.focus()
    await userEvent.keyboard(' ')
    await waitFor(() => expect(light.checked).toBe(true))
    expect(api.setCalls).toEqual(['light'])
  })

  it('写盘失败:恢复已确认选项并用 role=alert 展示可重试错误', async () => {
    const api = fakeApi({
      set: async () => ({ ok: false, code: 'STORAGE', message: '外观设置未保存: disk full' })
    })
    render(<AppearanceSettings api={api} />)
    const dark = (await screen.findByRole('radio', { name: '深色' })) as HTMLInputElement
    await waitFor(() => expect(dark.checked).toBe(true))

    await userEvent.click(screen.getByRole('radio', { name: '浅色' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('外观设置未保存')
    // 已确认选项不变,控件恢复可重试
    expect(dark.checked).toBe(true)
    expect(dark.disabled).toBe(false)
  })

  it('跟随系统时显示当前实际模式', async () => {
    const api = fakeApi({ get: async () => ({ revision: 1, mode: 'system', resolved: 'dark' }) })
    render(<AppearanceSettings api={api} />)
    await screen.findByRole('radio', { name: '跟随系统' })
    expect(await screen.findByText(/当前实际:深色/)).toBeTruthy()
  })

  it('卸载后退订,不再接收快照', async () => {
    const api = fakeApi()
    const { unmount } = render(<AppearanceSettings api={api} />)
    await screen.findByRole('radio', { name: '深色' })
    expect(api.listenerCount()).toBe(1)
    unmount()
    expect(api.listenerCount()).toBe(0)
  })

  it('StrictMode 重复挂载:状态一致且无泄漏订阅', async () => {
    const api = fakeApi()
    const { unmount } = render(
      <React.StrictMode>
        <AppearanceSettings api={api} />
      </React.StrictMode>
    )
    const dark = (await screen.findByRole('radio', { name: '深色' })) as HTMLInputElement
    await waitFor(() => expect(dark.checked).toBe(true))
    expect(api.listenerCount()).toBe(1)
    unmount()
    expect(api.listenerCount()).toBe(0)
  })

  it('保存期间禁用重复提交', async () => {
    let resolveSet!: (r: AppearanceResult) => void
    const api = fakeApi({
      set: (mode) =>
        new Promise<AppearanceResult>((r) => {
          resolveSet = r
          api.setCalls.push(mode)
        })
    })
    render(<AppearanceSettings api={api} />)
    await screen.findByRole('radio', { name: '深色' })

    fireEvent.click(screen.getByRole('radio', { name: '浅色' }))
    await screen.findByText('正在保存外观设置…')
    // 保存中再次点击深色:被禁用,不产生第二次 set
    fireEvent.click(screen.getByRole('radio', { name: '深色' }))
    expect(api.setCalls).toEqual(['light'])

    resolveSet({ ok: true, value: { revision: 2, mode: 'light', resolved: 'light' } })
    await waitFor(() =>
      expect((screen.getByRole('radio', { name: '浅色' }) as HTMLInputElement).checked).toBe(true)
    )
  })
})
