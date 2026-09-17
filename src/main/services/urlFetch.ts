// 主进程网页抓取:带超时与大小上限,提取可读正文供分析使用
import { extractMainText } from '../../shared/urlText'

export interface FetchedPage {
  title: string
  text: string
}

const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export function createUrlFetcher(deps: {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxBytes?: number
} = {}): (url: string) => Promise<FetchedPage> {
  const doFetch = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES

  return async (url: string): Promise<FetchedPage> => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`链接格式无效: ${url}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`仅支持 http/https 链接: ${parsed.protocol}`)
    }

    let res: Response
    try {
      res = await doFetch(parsed.toString(), {
        headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,text/plain,*/*' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow'
      })
    } catch (error) {
      const name = (error as { name?: string }).name
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new Error(`网页抓取超时(${Math.round(timeoutMs / 1000)}秒)`)
      }
      throw new Error(`网页抓取失败: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (!res.ok) {
      throw new Error(`网页返回错误状态 ${res.status}`)
    }
    const contentType = res.headers.get('content-type') ?? ''
    if (!/text\/html|text\/plain|xhtml/i.test(contentType)) {
      throw new Error(`链接内容不是网页(${contentType || '未知类型'}),无法提取正文`)
    }
    const buf = await res.arrayBuffer()
    const html = new TextDecoder('utf-8').decode(buf.slice(0, maxBytes))
    const { title, text } = extractMainText(html)
    if (!text) {
      throw new Error('网页中没有可提取的正文')
    }
    return { title, text }
  }
}
