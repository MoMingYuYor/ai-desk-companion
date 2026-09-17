// 纯函数:聊天输入中的 URL 提取与网页 HTML 正文提取
// 供渲染层(识别链接)与主进程(抓取后解析)共用,不依赖 Node/Electron API

const URL_RE = /https?:\/\/[^\s<>"'）)\]}。，、；：？！,;:?！?]+/g

export function extractUrls(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.match(URL_RE) ?? []) {
    const url = raw.replace(/[.,;:!?、。，；：？！]+$/, '')
    if (!seen.has(url)) {
      seen.add(url)
      out.push(url)
    }
  }
  return out
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
}

const BLOCK_END = /<(?:br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section|\/article)[^>]*>/gi

export function extractMainText(html: string): { title: string; text: string } {
  const rawTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''
  const stripped = html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(BLOCK_END, '\n')
    .replace(/<[^>]+>/g, ' ')
  const text = decodeEntities(stripped)
    .split(/\n+/)
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
  return { title: decodeEntities(rawTitle).trim(), text }
}
