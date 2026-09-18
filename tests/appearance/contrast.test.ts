import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// 以真实 palettes.css 为输入的对比度门禁:文字组合 ≥4.5,交互边界/焦点 ≥3。
// 解析辅助函数只处理该文件明确的十六进制声明,不冒充通用 CSS 解析器。

function luminance(hex: string): number {
  const c = hex
    .replace('#', '')
    .match(/../g)!
    .map((x) => parseInt(x, 16) / 255)
    .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

function ratio(a: string, b: string): number {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const css = readFileSync('src/renderer/shared/theme/palettes.css', 'utf8')
const THEMES = ['light', 'dark'] as const

function palette(theme: (typeof THEMES)[number]): (key: string) => string {
  const block = css.match(new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([^}]+)\\}`))?.[1]
  if (!block) throw new Error(`palettes.css 缺少 [data-theme="${theme}"] 色板`)
  return (key: string) => {
    const value = block.match(new RegExp(`${key}:\\s*(#[0-9a-fA-F]{6})`))?.[1]
    if (!value) throw new Error(`[data-theme="${theme}"] 缺少 ${key} 的十六进制声明`)
    return value
  }
}

describe('日夜色板对比度', () => {
  it('两个主题都定义了完整语义变量', () => {
    for (const theme of THEMES) {
      const color = palette(theme)
      for (const key of [
        '--ui-bg',
        '--ui-surface',
        '--ui-surface-nav',
        '--ui-text',
        '--ui-text-muted',
        '--ui-accent',
        '--ui-accent-surface',
        '--ui-on-accent',
        '--ui-border',
        '--ui-control-border',
        '--ui-warning-text',
        '--ui-warning-surface',
        '--ui-success-text',
        '--ui-success-surface',
        '--ui-error-text',
        '--ui-error-surface',
        '--ui-toast-bg',
        '--ui-toast-text',
        '--ui-focus-ring'
      ]) {
        expect(() => color(key), `${theme} ${key}`).not.toThrow()
      }
    }
  })

  it('正文与辅助文字对实际面板/背景均达到 4.5', () => {
    for (const theme of THEMES) {
      const color = palette(theme)
      for (const surface of ['--ui-bg', '--ui-surface', '--ui-surface-nav']) {
        expect(ratio(color('--ui-text'), color(surface)), `${theme} text on ${surface}`).toBeGreaterThanOrEqual(4.5)
        expect(ratio(color('--ui-text-muted'), color(surface)), `${theme} muted on ${surface}`).toBeGreaterThanOrEqual(
          4.5
        )
      }
      // 选中态/次级填充上的文字
      expect(ratio(color('--ui-text'), color('--ui-accent-surface')), `${theme} text on accent-surface`).toBeGreaterThanOrEqual(4.5)
      expect(ratio(color('--ui-text-muted'), color('--ui-accent-surface')), `${theme} muted on accent-surface`).toBeGreaterThanOrEqual(4.5)
      expect(ratio(color('--ui-text'), color('--ui-subtle-surface')), `${theme} text on subtle-surface`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('强调色组合:链接/选中文字与主按钮文字均达到 4.5', () => {
    for (const theme of THEMES) {
      const color = palette(theme)
      expect(ratio(color('--ui-accent'), color('--ui-surface')), `${theme} accent on surface`).toBeGreaterThanOrEqual(4.5)
      expect(ratio(color('--ui-accent'), color('--ui-accent-surface')), `${theme} accent on accent-surface`).toBeGreaterThanOrEqual(4.5)
      expect(ratio(color('--ui-on-accent'), color('--ui-accent')), `${theme} on-accent on accent`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('警示/成功/错误语义色对各自底色达到 4.5', () => {
    for (const theme of THEMES) {
      const color = palette(theme)
      for (const kind of ['warning', 'success', 'error']) {
        expect(
          ratio(color(`--ui-${kind}-text`), color(`--ui-${kind}-surface`)),
          `${theme} ${kind}`
        ).toBeGreaterThanOrEqual(4.5)
      }
      expect(ratio(color('--ui-error-text'), color('--ui-surface')), `${theme} error on surface`).toBeGreaterThanOrEqual(4.5)
      expect(ratio(color('--ui-success-text'), color('--ui-surface')), `${theme} success on surface`).toBeGreaterThanOrEqual(4.5)
      expect(ratio(color('--ui-warning-text'), color('--ui-surface')), `${theme} warning on surface`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('输入边界与焦点环达到 3:1 非文字对比', () => {
    for (const theme of THEMES) {
      const color = palette(theme)
      expect(ratio(color('--ui-control-border'), color('--ui-surface')), `${theme} control on surface`).toBeGreaterThanOrEqual(3)
      expect(ratio(color('--ui-control-border'), color('--ui-bg')), `${theme} control on bg`).toBeGreaterThanOrEqual(3)
      expect(ratio(color('--ui-focus-ring'), color('--ui-surface')), `${theme} focus on surface`).toBeGreaterThanOrEqual(3)
      expect(ratio(color('--ui-focus-ring'), color('--ui-bg')), `${theme} focus on bg`).toBeGreaterThanOrEqual(3)
    }
  })

  it('反色提示(toast)文字达到 4.5', () => {
    for (const theme of THEMES) {
      const color = palette(theme)
      expect(ratio(color('--ui-toast-text'), color('--ui-toast-bg')), `${theme} toast`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
