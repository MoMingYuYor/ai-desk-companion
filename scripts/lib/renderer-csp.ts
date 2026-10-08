// Renderer CSP 单一来源(SEC-01,2026-10-08 六项改进计划):
// - PRODUCTION_RENDERER_CSP:生产策略常量。三个 renderer HTML 的 <head> meta、
//   check-build 静态出口与 csp-smoke 实际执行验证均以此为准。
// - developmentCsp(origin):开发策略派生(规范代码逐字)。仅接受 loopback origin,
//   放行 React Refresh 所需内联脚本(仅开发)与由实际 origin 派生的 ws/wss HMR 连接。
// - createRendererCspDevPlugin():electron-vite renderer 开发插件(apply:'serve'),
//   只替换生产 meta 这一条,不改动页面其余内容;生产 build 不应用此插件。

import type { Plugin, ViteDevServer } from 'vite'

/**
 * 生产 CSP(与规范逐字一致):
 * 脚本仅限本地(self),样式保留内联以兼容现有主题与 React 行内样式,
 * 图片仅限本地,连接/对象/框架/worker/media 一律关闭。
 * meta 形态不含 frame-ancestors(该指令在 meta 中无效,由窗口导航限制承担)。
 */
export const PRODUCTION_RENDERER_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; " +
  "font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; " +
  "media-src 'none'; base-uri 'none'; form-action 'none'"

/**
 * 开发策略:只允许指定 loopback origin/port;由实际 origin 派生 ws/wss HMR origin。
 * 缺失来源或公开 host 一律拒绝(抛 DEV_CSP_ORIGIN_REJECTED 或 URL 解析错误)。
 * React Refresh 所需内联脚本只在开发策略放行,生产 build 不继承。
 * 注意:本函数体为规范给定代码,逐字保留,勿做"等价"改写。
 */
export function developmentCsp(origin: string): string {
  const url = new URL(origin)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('DEV_CSP_ORIGIN_REJECTED')
  }
  const socketOrigin = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`
  return "default-src 'none'; script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'none'; " +
    `connect-src 'self' ${url.origin} ${socketOrigin}; ` +
    "object-src 'none'; frame-src 'none'; worker-src 'none'; media-src 'none'; " +
    "base-uri 'none'; form-action 'none'"
}

/** 从 HTML 中提取第一条 CSP meta(通用形态,兼容单双引号与自闭合斜杠) */
export function extractCspMeta(html: string): { tag: string; content: string } | null {
  const tagMatch = html.match(/<meta\s[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i)
  if (!tagMatch) return null
  // content 值内含单引号(如 'self'),须按开引号类型配对取值,禁止用 [^"']* 截断
  const contentMatch = tagMatch[0].match(/content=(["'])([\s\S]*?)\1/i)
  return { tag: tagMatch[0], content: contentMatch ? contentMatch[2] : '' }
}

/**
 * 开发态替换:只把内容与生产常量逐字一致的那条 meta 替换为开发策略。
 * meta 缺失(CSP_META_NOT_FOUND)或内容被改动(CSP_META_UNEXPECTED)时抛错,
 * 让开发服务器以 500 显式失败,而不是静默沿用生产策略导致 HMR 不可用。
 */
export function replaceCspMetaForDev(html: string, origin: string): string {
  const found = extractCspMeta(html)
  if (!found) throw new Error('CSP_META_NOT_FOUND')
  if (found.content !== PRODUCTION_RENDERER_CSP) throw new Error('CSP_META_UNEXPECTED')
  const devCsp = developmentCsp(origin)
  return html.replace(
    found.tag,
    `<meta http-equiv="Content-Security-Policy" content="${devCsp}">`
  )
}

/**
 * electron-vite renderer 开发插件:
 * - apply:'serve' 保证生产 build 完全不应用,产物只保留生产 meta;
 * - origin 取开发 server 实际 resolved URL(优先 resolvedUrls,回退 httpServer 地址),
 *   在 httpServer 'listening' 时两者均已就绪;
 * - 无法取得来源时 devOrigin 保持 null,transformIndexHtml 每次请求抛
 *   DEV_CSP_ORIGIN_UNRESOLVED(可见失败),不给页面留下生产 connect-src 'none' 的假象。
 */
export function createRendererCspDevPlugin(): Plugin {
  let devOrigin: string | null = null
  return {
    name: 'renderer-csp-dev',
    apply: 'serve',
    configureServer(server: ViteDevServer): void {
      server.httpServer?.once('listening', () => {
        const local = server.resolvedUrls?.local?.[0]
        if (local) {
          devOrigin = new URL(local).origin
          return
        }
        // 回退:直接读 httpServer 实际监听地址(IPv6 需带方括号)
        const addr = server.httpServer?.address()
        if (addr && typeof addr === 'object') {
          const host = addr.address.includes(':') ? `[${addr.address}]` : addr.address
          devOrigin = `http://${host}:${addr.port}`
        }
      })
    },
    transformIndexHtml(html: string): string {
      if (devOrigin == null) throw new Error('DEV_CSP_ORIGIN_UNRESOLVED')
      return replaceCspMetaForDev(html, devOrigin)
    }
  }
}
