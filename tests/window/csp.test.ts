// SEC-01:三窗口 CSP 测试(红测试先行——旧 HTML 无 CSP meta 时本文件必须失败)
// 覆盖:
// 1) 三个 src/renderer/*.html 存在唯一 CSP meta、位于 <head> 最前部、指令与生产常量逐字一致;
// 2) 生产常量与规范文本逐字一致,且不含开发放宽项;
// 3) developmentCsp 仅允许 loopback origin/port,派生 ws/wss HMR origin,拒绝公开 host 与缺失来源;
// 4) 开发插件(apply:'serve')只替换生产 meta 那一条,origin 不可用时显式失败;
// 5) electron.vite.config.ts 的 renderer 插件确实挂载了该开发插件。
// 生产产物的静态一致性由 scripts/check-build.mjs 出口负责;实际执行验证由
// scripts/acceptance/csp-smoke.mjs(真实 Chromium)负责,均不在本文件重复。

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import electronViteConfig from '../../electron.vite.config'
import {
  createRendererCspDevPlugin,
  developmentCsp,
  PRODUCTION_RENDERER_CSP,
  replaceCspMetaForDev
} from '../../scripts/lib/renderer-csp'

const here = dirname(fileURLToPath(import.meta.url))
const rendererRoot = resolve(here, '../../src/renderer')

const PAGES = ['workbench', 'pet', 'panel'] as const

// 规范给定文本的独立副本:防止生产常量被无意改动而测试仍用同一常量自证
const SPEC_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; " +
  "font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; " +
  "media-src 'none'; base-uri 'none'; form-action 'none'"

function readPage(name: string): string {
  return readFileSync(join(rendererRoot, `${name}.html`), 'utf8')
}

function findAllCspMetas(html: string): string[] {
  return html.match(/<meta\s[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi) ?? []
}

function cspContentOf(tag: string): string {
  // content 值内含单引号,按开引号类型配对取值,避免 [^"']* 在 'self' 处截断
  const m = tag.match(/content=(["'])([\s\S]*?)\1/i)
  return m ? m[2] : ''
}

describe('SEC-01 生产 CSP 常量', () => {
  it('与规范文本逐字一致,且不含 frame-ancestors(在 meta 中无效)', () => {
    expect(PRODUCTION_RENDERER_CSP).toBe(SPEC_CSP)
    expect(PRODUCTION_RENDERER_CSP).not.toContain('frame-ancestors')
  })

  it('不含任何开发放宽项(内联脚本/unsafe-eval/远程或通配连接)', () => {
    expect(PRODUCTION_RENDERER_CSP).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(PRODUCTION_RENDERER_CSP).not.toContain('unsafe-eval')
    expect(PRODUCTION_RENDERER_CSP).not.toContain('ws://')
    expect(PRODUCTION_RENDERER_CSP).not.toContain('wss://')
    expect(PRODUCTION_RENDERER_CSP).not.toContain('localhost')
    expect(PRODUCTION_RENDERER_CSP).not.toContain('127.0.0.1')
    expect(PRODUCTION_RENDERER_CSP).toMatch(/connect-src 'none'/)
    expect(PRODUCTION_RENDERER_CSP).not.toMatch(/connect-src 'none' http/)
  })
})

describe('SEC-01 三个 renderer HTML 的 CSP meta(旧 HTML 无 meta 时应失败)', () => {
  it.each(PAGES)('%s.html 恰好存在一条 CSP meta', (page) => {
    const metas = findAllCspMetas(readPage(page))
    expect(metas).toHaveLength(1)
  })

  it.each(PAGES)('%s.html CSP meta 位于 <head> 最前部、所有可执行/样式资源之前', (page) => {
    const html = readPage(page)
    const tag = findAllCspMetas(html)[0]
    expect(tag).toBeDefined()
    // head 开标签之后(允许空白)紧跟 CSP meta
    expect(html).toMatch(/<head[^>]*>\s*<meta\s[^>]*http-equiv=["']Content-Security-Policy["']/i)
    // 且先于任何 script/link/style 资源出现
    for (const marker of ['<script', '<link', '<style']) {
      const resourceIdx = html.toLowerCase().indexOf(marker)
      if (resourceIdx !== -1) {
        expect(html.indexOf(tag)).toBeLessThan(resourceIdx)
      }
    }
  })

  it.each(PAGES)('%s.html CSP 指令与生产常量逐字一致', (page) => {
    const tag = findAllCspMetas(readPage(page))[0]
    expect(cspContentOf(tag)).toBe(PRODUCTION_RENDERER_CSP)
  })
})

describe('SEC-01 developmentCsp 开发策略', () => {
  it('localhost http:放行内联脚本与该 origin + ws HMR origin', () => {
    const csp = developmentCsp('http://localhost:5173/')
    expect(csp).toContain("script-src 'self' 'unsafe-inline'")
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("connect-src 'self' http://localhost:5173 ws://localhost:5173")
    expect(csp).not.toContain('frame-ancestors')
  })

  it('127.0.0.1 与 [::1] 被接受', () => {
    expect(developmentCsp('http://127.0.0.1:5173')).toContain('http://127.0.0.1:5173')
    expect(developmentCsp('http://[::1]:5173')).toContain('ws://[::1]:5173')
  })

  it('https origin 派生 wss HMR origin', () => {
    const csp = developmentCsp('https://127.0.0.1:5173')
    expect(csp).toContain('wss://127.0.0.1:5173')
    expect(csp).not.toContain('ws://127.0.0.1:5173')
  })

  it('公开 host、伪造前缀主机与非 http(s) 协议被拒绝', () => {
    expect(() => developmentCsp('http://evil.example:5173')).toThrowError('DEV_CSP_ORIGIN_REJECTED')
    // 前缀攻击:主机名包含 localhost 字样但并非 loopback
    expect(() => developmentCsp('http://localhost.5173.evil.com:5173')).toThrowError('DEV_CSP_ORIGIN_REJECTED')
    expect(() => developmentCsp('ftp://localhost:5173')).toThrowError('DEV_CSP_ORIGIN_REJECTED')
  })

  it('缺失来源被拒绝', () => {
    expect(() => developmentCsp('')).toThrow()
  })

  it('开发策略仍禁止对象/框架/worker/media', () => {
    const csp = developmentCsp('http://localhost:5173')
    expect(csp).toMatch(/object-src 'none'/)
    expect(csp).toMatch(/frame-src 'none'/)
    expect(csp).toMatch(/worker-src 'none'/)
    expect(csp).toMatch(/base-uri 'none'/)
    expect(csp).toMatch(/form-action 'none'/)
  })
})

describe('SEC-01 开发插件 transformIndexHtml', () => {
  function pageHtml(): string {
    return readPage('workbench')
  }

  it('只替换生产 meta 那一条,其余内容逐字节不变,替换结果等于 developmentCsp(origin)', () => {
    const plugin = createRendererCspDevPlugin()
    const origin = 'http://127.0.0.1:5173'
    const out = replaceCspMetaForDev(pageHtml(), origin)
    // 其余内容不变:把替换后的 dev meta 换回生产 meta 应与原文完全一致
    const devMeta = findAllCspMetas(out)[0]
    const restored = out.replace(devMeta, findAllCspMetas(pageHtml())[0])
    expect(restored).toBe(pageHtml())
    // 新 meta 内容 = developmentCsp(origin)
    expect(cspContentOf(devMeta)).toBe(developmentCsp(origin))
  })

  it('通过插件钩子触发时需要先有 listening 捕获的 origin,否则显式失败', () => {
    const plugin = createRendererCspDevPlugin()
    expect(plugin.apply).toBe('serve')
    expect(plugin.transformIndexHtml).toBeDefined()
    // 未经过 configureServer/listening 时直接请求 HTML → 可见失败,而非静默生产策略
    expect(() => (plugin.transformIndexHtml as (h: string) => string)(pageHtml())).toThrowError(
      'DEV_CSP_ORIGIN_UNRESOLVED'
    )
  })

  it('模拟 listening 捕获 resolvedUrls 后,钩子输出开发策略', () => {
    const plugin = createRendererCspDevPlugin()
    const origin = 'http://localhost:5173/'
    const fakeServer = {
      resolvedUrls: { local: [origin], network: [] },
      httpServer: { once: (_e: string, cb: () => void) => cb() }
    }
    ;(plugin.configureServer as (s: unknown) => void)(fakeServer)
    const out = (plugin.transformIndexHtml as (h: string) => string)(pageHtml())
    expect(cspContentOf(findAllCspMetas(out)[0])).toBe(developmentCsp(origin))
  })

  it('meta 缺失或被改动时抛错(不做静默替换)', () => {
    expect(() => replaceCspMetaForDev('<html><head></head></html>', 'http://localhost:5173')).toThrowError(
      'CSP_META_NOT_FOUND'
    )
    const tampered = pageHtml().replace(PRODUCTION_RENDERER_CSP, "default-src 'self'")
    expect(() => replaceCspMetaForDev(tampered, 'http://localhost:5173')).toThrowError('CSP_META_UNEXPECTED')
  })
})

describe('SEC-01 electron.vite.config.ts 挂载开发插件', () => {
  it('renderer 插件包含 renderer-csp-dev 且 apply 为 serve', async () => {
    // electron-vite 的 defineConfig 返回类型含 Promise 分支,先归一再收窄
    const cfg = (await Promise.resolve(electronViteConfig)) as {
      renderer?: { plugins?: Array<{ name?: string; apply?: unknown } | false | null | undefined> }
    }
    const plugins = cfg.renderer?.plugins ?? []
    const cspPlugin = plugins.find(
      (p): p is { name?: string; apply?: unknown } =>
        typeof p === 'object' && p !== null && p.name === 'renderer-csp-dev'
    )
    expect(cspPlugin).toBeDefined()
    expect(cspPlugin?.apply).toBe('serve')
  })
})
