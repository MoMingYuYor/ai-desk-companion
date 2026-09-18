// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import React from 'react'

afterEach(cleanup)

describe('基础组件样例:语义类与可访问性', () => {
  it('button/input/tag 在深色主题下保持角色、名称与禁用语义', () => {
    document.documentElement.dataset.theme = 'dark'
    render(
      <div>
        <button type="button" className="primary">
          保存
        </button>
        <button type="button" disabled>
          不可点
        </button>
        <input aria-label="接口地址" placeholder="如 https://api.example.com/v1" />
        <span className="tag warn">仅文本</span>
        <span className="tag ok">默认</span>
      </div>
    )

    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy()
    const disabled = screen.getByRole('button', { name: '不可点' }) as HTMLButtonElement
    expect(disabled.disabled).toBe(true)
    expect(screen.getByRole('textbox', { name: '接口地址' })).toBeTruthy()
    expect(screen.getByText('仅文本').className).toContain('tag warn')
    expect(screen.getByText('默认').className).toContain('tag ok')

    delete document.documentElement.dataset.theme
  })

  it('基础样式通过变量消费主题,不用全局 filter 反色', async () => {
    const { readFileSync } = await import('node:fs')
    const ui = readFileSync('src/renderer/shared/ui.css', 'utf8')
    const components = readFileSync('src/renderer/shared/theme/components.css', 'utf8')
    // ui.css 不允许残留十六进制颜色字面值(全部走语义变量)
    expect(ui.match(/#[0-9a-fA-F]{3,8}\b/)).toBeNull()
    expect(ui).not.toContain('filter: invert')
    expect(ui).not.toContain('filter:invert')
    // 焦点规则存在且为实线 outline
    expect(components).toContain(':focus-visible')
    expect(components).toMatch(/outline:\s*var\(--ui-focus-width\)\s+solid/)
  })

  it('键盘焦点样式不依赖阴影', async () => {
    const { readFileSync } = await import('node:fs')
    const components = readFileSync('src/renderer/shared/theme/components.css', 'utf8')
    const focusBlock = components.match(/:focus-visible\s*\{([^}]+)\}/)?.[1] ?? ''
    expect(focusBlock).toContain('outline')
    expect(focusBlock).not.toContain('box-shadow')
  })
})
