// 主进程网页抓取(R5):地址策略校验 + DNS 结果绑定连接 + 逐跳手动重定向 + 解码后流式 2 MiB 上限。
// 传输层可注入(测试用假 transport);默认传输用 node:http(s) 连到已校验地址并以主机名做 SNI/Host。
import { extractMainText } from '../../shared/urlText'
import { assertPublicHttpTarget } from '../security/urlPolicy'

export interface FetchedPage {
  title: string
  text: string
}

const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_REDIRECTS = 4
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 单跳请求目标:地址必须来自通过 assertPublicHttpTarget 校验的 DNS 结果 */
export interface FetchTarget {
  url: URL
  address: string
  signal: AbortSignal
}

/** 传输响应:body 为(必要时解压后的)解码响应流,close 用于提前中止底层连接 */
export interface TransportResponse {
  status: number
  headers: Record<string, string>
  body: AsyncIterable<Uint8Array> | null
  close?: () => void
}

export type FetchTransport = (target: FetchTarget) => Promise<TransportResponse>
export type DnsResolver = (hostname: string) => Promise<readonly string[]>

export interface CreateUrlFetcherDeps {
  transport?: FetchTransport
  resolveDns?: DnsResolver
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function closeBody(res: TransportResponse): void {
  try {
    res.close?.()
  } catch {
    // 关闭失败不影响错误上抛
  }
}

function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

export function createUrlFetcher(deps: CreateUrlFetcherDeps = {}): (url: string) => Promise<FetchedPage> {
  const transport = deps.transport ?? defaultTransport
  const resolveDns = deps.resolveDns ?? defaultResolveDns
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = deps.maxRedirects ?? DEFAULT_MAX_REDIRECTS

  return async (url: string): Promise<FetchedPage> => {
    let current: URL
    try {
      current = new URL(url)
    } catch {
      throw new Error('链接格式无效')
    }
    assertHttpProtocol(current)

    // 整个抓取(含逐跳重定向)共享一个超时信号
    const signal = AbortSignal.timeout(timeoutMs)

    let res: TransportResponse | null = null
    let redirectsLeft = maxRedirects
    for (;;) {
      // 每跳重新解析并校验:主机字面量 + 解析结果;通过后把地址绑定给连接,防解析后改道
      const addresses = await resolveAddresses(current.hostname)
      assertPublicHttpTarget(current, addresses)
      const address = addresses[0]
      if (!address) throw new Error('域名没有可用地址')
      try {
        res = await transport({ url: current, address, signal })
      } catch (err) {
        if (isTimeoutError(err)) throw new Error(`网页抓取超时(${Math.round(timeoutMs / 1000)}秒)`)
        throw new Error(`网页抓取失败: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (isRedirectStatus(res.status)) {
        const location = res.headers['location']
        closeBody(res)
        if (!location) throw new Error('重定向缺少目标地址,已中止')
        if (redirectsLeft <= 0) throw new Error('重定向次数过多,已中止')
        let next: URL
        try {
          next = new URL(location, current)
        } catch {
          throw new Error('重定向目标地址无效,已中止')
        }
        assertHttpProtocol(next)
        current = next
        redirectsLeft -= 1
        continue
      }
      break
    }

    const final = res!
    if (final.status < 200 || final.status >= 300) {
      closeBody(final)
      throw new Error(`网页返回错误状态 ${final.status}`)
    }
    const contentType = (final.headers['content-type'] ?? '').toLowerCase()
    if (!/text\/html|text\/plain|xhtml/.test(contentType)) {
      closeBody(final)
      throw new Error(`链接内容不是网页(${contentType || '未知类型'}),无法提取正文`)
    }
    // Content-Length 仅作提前拒绝依据;实际限制以流式累计为准
    const declared = Number(final.headers['content-length'] ?? NaN)
    if (Number.isFinite(declared) && declared > maxBytes) {
      closeBody(final)
      throw sizeLimitError(maxBytes)
    }
    const html = await readBodyLimited(final, maxBytes)
    const { title, text } = extractMainText(html)
    if (!text) {
      throw new Error('网页中没有可提取的正文')
    }
    return { title, text }
  }

  async function resolveAddresses(hostname: string): Promise<readonly string[]> {
    let addresses: readonly string[]
    try {
      addresses = await resolveDns(hostname)
    } catch {
      throw new Error('域名解析失败')
    }
    return addresses
  }
}

function sizeLimitError(maxBytes: number): Error {
  return new Error(`网页超过大小上限(${Math.round(maxBytes / 1024)}KB),已中止`)
}

/** 流式读取响应体:按(解码后)字节累计,超过 maxBytes 立即中止并关闭连接,不全量入内存 */
async function readBodyLimited(res: TransportResponse, maxBytes: number): Promise<string> {
  if (!res.body) throw new Error('网页响应没有内容')
  let total = 0
  const decoder = new TextDecoder('utf-8')
  let html = ''
  try {
    for await (const chunk of res.body) {
      total += chunk.byteLength
      if (total > maxBytes) throw sizeLimitError(maxBytes)
      html += decoder.decode(chunk, { stream: true })
      if (html.length > maxBytes) throw sizeLimitError(maxBytes)
    }
    html += decoder.decode()
  } finally {
    closeBody(res)
  }
  return html
}

function assertHttpProtocol(u: URL): void {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('仅支持 http/https 链接')
  }
}

// ---------- 默认传输与 DNS ----------

function stripBrackets(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '')
}

function flattenHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value ?? '')
  }
  return out
}

const defaultResolveDns: DnsResolver = async (hostname) => {
  const dns = await import('node:dns')
  const results = await dns.promises.lookup(stripBrackets(hostname).split('%')[0], { all: true })
  return results.map((r) => r.address)
}

const defaultTransport: FetchTransport = (target) =>
  new Promise((resolve, reject) => {
    void (async () => {
      const { request: httpRequest } = await import('node:http')
      const { request: httpsRequest } = await import('node:https')
      const { createBrotliDecompress, createGunzip, createInflate } = await import('node:zlib')

      const url = target.url
      const isHttps = url.protocol === 'https:'
      try {
        const req = (isHttps ? httpsRequest : httpRequest)({
          host: target.address,
          port: url.port ? Number(url.port) : isHttps ? 443 : 80,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          // TLS:连接的是已校验地址,证书/SNI 仍按原始主机名校验
          servername: isHttps ? stripBrackets(url.hostname) : undefined,
          headers: {
            Host: url.host,
            'User-Agent': BROWSER_UA,
            Accept: 'text/html,text/plain,*/*',
            'Accept-Encoding': 'gzip, deflate, br'
          },
          signal: target.signal
        })
        req.on('error', reject)
        req.end()
        req.on('response', (res) => {
          res.on('error', () => req.destroy())
          let body: AsyncIterable<Uint8Array> = res
          const encoding = String(res.headers['content-encoding'] ?? '')
            .trim()
            .toLowerCase()
          // 压缩响应先解压:大小上限按解码后的流累计
          if (encoding === 'gzip' || encoding === 'deflate' || encoding === 'br') {
            const zlibStream =
              encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : createBrotliDecompress()
            zlibStream.on('error', () => req.destroy())
            res.pipe(zlibStream)
            body = zlibStream
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: flattenHeaders(res.headers),
            body,
            close: () => req.destroy()
          })
        })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })()
  })
