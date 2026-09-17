import sanitizeHtml from 'sanitize-html'
import { convert } from 'html-to-text'
import type { FormatCallback, HtmlToTextOptions } from 'html-to-text'

/**
 * 邮件正文白名单标签：基本文本、段落、链接文本、列表、表格、标题与代码。
 * 链接仅保留标签文本（href 一律剥离），点击统一走可信链接列表；
 * 图片一律不加载，img 被替换为占位文本。
 */
const ALLOWED_TAGS = [
  'a', 'b', 'blockquote', 'br', 'caption', 'code', 'div', 'em',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'li', 'ol', 'p',
  'pre', 's', 'small', 'span', 'strong', 'sub', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul'
] as const

/** 这些标签连同其内部文本一起丢弃，防止 script/style 等内容以纯文本形式漏出。 */
const NON_TEXT_TAGS = [
  'script', 'style', 'textarea', 'option', 'xmp', 'noscript',
  'noembed', 'template', 'title', 'svg', 'math'
] as const

const SANITIZE_OPTIONS = {
  allowedTags: [...ALLOWED_TAGS],
  allowedAttributes: {},
  allowedSchemes: ['http', 'https'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard' as const,
  nonTextTags: [...NON_TEXT_TAGS],
  transformTags: {
    img: (): { tagName: string; attribs: Record<string, string>; text: string } => ({
      tagName: 'span',
      attribs: {},
      text: '[图片]'
    })
  }
}

/** 清理邮件 HTML：剥离 script/iframe/style 外链、on* 事件属性与全部属性，图片替换为占位。 */
export function sanitizeMailHtml(html: string): string {
  return sanitizeHtml(html ?? '', SANITIZE_OPTIONS)
}

/** 把原始 HTML 转为纯文本（不加载图片、不输出脚本内容）。 */
export function htmlToText(html: string): string {
  return convert(html ?? '', {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' }
    ]
  })
}

/** 用 URL 构造器验证并归一化链接：仅保留 http/https，其余（javascript:/data:/相对地址等）丢弃。 */
export function normalizeLinkUrl(raw: string): string | null {
  const candidate = (raw ?? '').trim()
  if (!candidate) return null
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

/** 链接数量防御上限，避免病态邮件拖垮主进程。 */
const MAX_LINKS = 500

/**
 * 提取正文中的可信链接列表：基于 html-to-text 的解析器自定义 formatter 收集
 * 锚点文本与 href（禁止正则解析 HTML），并逐条用 URL 构造器验证协议。
 */
export function extractLinks(html: string): Array<{ label: string; url: string }> {
  const collected: Array<{ label: string; url: string }> = []
  const options: HtmlToTextOptions = {
    wordwrap: false,
    formatters: {
      mailLinkCollector: ((elem, walk, builder) => {
        const rawHref = typeof elem.attribs?.href === 'string' ? elem.attribs.href : ''
        let text = ''
        builder.pushWordTransform((str: string) => {
          if (str) text += str
          return str
        })
        walk(elem.children, builder)
        builder.popWordTransform()
        const label = text.replace(/\s+/g, ' ').trim()
        const url = normalizeLinkUrl(rawHref)
        if (url && collected.length < MAX_LINKS) {
          collected.push({ label: label || url, url })
        }
        if (label) builder.addInline(label, { noWordTransform: true })
      }) as FormatCallback
    },
    selectors: [{ selector: 'a[href]', format: 'mailLinkCollector' }]
  }
  convert(html ?? '', options)
  // 按 URL 去重，保留首次出现顺序
  const seen = new Set<string>()
  return collected.filter((link) => {
    if (seen.has(link.url)) return false
    seen.add(link.url)
    return true
  })
}

/** 渲染入口：一次输入同时产出安全 HTML、纯文本与可信链接列表。 */
export function renderMailHtml(html: string): {
  safeHtml: string
  text: string
  links: Array<{ label: string; url: string }>
} {
  return {
    safeHtml: sanitizeMailHtml(html),
    text: htmlToText(html),
    links: extractLinks(html)
  }
}

/** 把纯文本正文转为安全 HTML（转义后换行转 <br>），供 safeHtml 展示。 */
export function plainTextToHtml(text: string): string {
  const escaped = (text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  return `<p>${escaped.replace(/\r?\n/g, '<br>\n')}</p>`
}
