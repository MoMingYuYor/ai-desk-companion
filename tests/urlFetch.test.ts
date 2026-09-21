import { describe, expect, it, vi } from 'vitest'
import {
  createUrlFetcher,
  type FetchTarget,
  type FetchTransport,
  type TransportResponse
} from '../src/main/services/urlFetch'

// R5(Task 7):抓取核心使用可注入 transport 与 DNS 解析器;
// DNS 校验结果绑定实际连接地址,逐跳手动重定向,按解码后的响应流累计最多 maxBytes。

interface CapturedCall {
  url: string
  address: string
  readBytes: number
  bodyReads: number
  closed: boolean
}

function textBody(captured: CapturedCall | null, ...chunks: string[]): AsyncGenerator<Uint8Array> {
  return (async function* () {
    for (const chunk of chunks) {
      const bytes = new TextEncoder().encode(chunk)
      if (captured) {
        captured.bodyReads += 1
        captured.readBytes += bytes.byteLength
      }
      yield bytes
    }
  })()
}

function response(opts: {
  status?: number
  headers?: Record<string, string>
  chunks?: string[]
  body?: AsyncIterable<Uint8Array> | null
} = {}): TransportResponse {
  const headers = opts.headers ?? { 'content-type': 'text/html; charset=utf-8' }
  return {
    status: opts.status ?? 200,
    headers,
    body: opts.body !== undefined ? opts.body : textBody(null, ...(opts.chunks ?? ['<title>t</title><p>body</p>'])),
    close: () => {}
  }
}

/** 构造记录调用的假 transport,按序返回预设响应 */
function makeTransport(
  handler: (call: CapturedCall, index: number) => TransportResponse | Promise<TransportResponse>,
  calls: CapturedCall[] = []
): FetchTransport {
  return async (target: FetchTarget) => {
    const captured: CapturedCall = {
      url: target.url.toString(),
      address: target.address,
      readBytes: 0,
      bodyReads: 0,
      closed: false
    }
    calls.push(captured)
    const res = await handler(captured, calls.length - 1)
    const originalClose = res.close
    res.close = () => {
      captured.closed = true
      originalClose?.()
    }
    return res
  }
}

const PUBLIC_DNS = async (hostname: string): Promise<readonly string[]> =>
  hostname.endsWith('example.com') ? ['93.184.216.34'] : ['203.0.113.50']

function makeFetcher(over: {
  transport?: FetchTransport
  resolveDns?: (hostname: string) => Promise<readonly string[]>
  maxBytes?: number
  maxRedirects?: number
  timeoutMs?: number
}) {
  return createUrlFetcher({
    transport: over.transport ?? makeTransport(() => response()),
    resolveDns: over.resolveDns ?? PUBLIC_DNS,
    maxBytes: over.maxBytes,
    maxRedirects: over.maxRedirects,
    timeoutMs: over.timeoutMs
  })
}

describe('createUrlFetcher 基础抓取', () => {
  it('抓取并解析标题与正文,连接地址为 DNS 校验结果', async () => {
    const calls: CapturedCall[] = []
    const transport = makeTransport(() => response({ chunks: ['<title>文章标题</title><body><p>正文第一段</p></body>'] }), calls)
    const fetcher = makeFetcher({ transport })
    const page = await fetcher('https://mp.example.com/s/abc')
    expect(page.title).toBe('文章标题')
    expect(page.text).toContain('正文第一段')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.address).toBe('93.184.216.34')
    expect(calls[0]!.url).toBe('https://mp.example.com/s/abc')
  })

  it('拒绝非 http/https 协议且不发起请求', async () => {
    const transport = vi.fn()
    const fetcher = makeFetcher({ transport: transport as unknown as FetchTransport })
    await expect(fetcher('file:///C:/Windows/system32')).rejects.toThrow('仅支持 http')
    await expect(fetcher('ftp://example.com/a')).rejects.toThrow('仅支持 http')
    expect(transport).not.toHaveBeenCalled()
  })

  it('HTTP 错误状态返回含状态码的错误', async () => {
    const fetcher = makeFetcher({ transport: makeTransport(() => response({ status: 404 })) })
    await expect(fetcher('https://gone.example.com/x')).rejects.toThrow('404')
  })

  it('非网页内容类型返回明确错误', async () => {
    const fetcher = makeFetcher({
      transport: makeTransport(() => response({ headers: { 'content-type': 'image/png' } }))
    })
    await expect(fetcher('https://img.example.com/a.png')).rejects.toThrow('不是网页')
  })

  it('超时错误转换为可读提示', async () => {
    const fetcher = makeFetcher({
      transport: makeTransport(() => {
        throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })
      })
    })
    await expect(fetcher('https://slow.example.com/a')).rejects.toThrow('超时')
  })
})

describe('R5:内网与重定向逐跳校验', () => {
  it('环回/私网直连拒绝且不发起连接', async () => {
    const transport = vi.fn()
    const fetcher = makeFetcher({ transport: transport as unknown as FetchTransport })
    await expect(fetcher('http://127.0.0.1/x')).rejects.toThrow()
    await expect(fetcher('http://10.0.0.5/x')).rejects.toThrow()
    await expect(fetcher('http://[::1]/x')).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })

  it('公共域名解析到内网地址时拒绝(rebinding),不发起连接', async () => {
    const transport = vi.fn()
    const fetcher = makeFetcher({
      transport: transport as unknown as FetchTransport,
      resolveDns: async () => ['10.1.2.3']
    })
    await expect(fetcher('https://example.com/a')).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })

  it('公共地址 302 → 内网:重定向目标在连接前被拒绝', async () => {
    const calls: CapturedCall[] = []
    const fetcher = makeFetcher({
      transport: makeTransport((_c, i) =>
        i === 0
          ? response({ status: 302, headers: { location: 'http://10.0.0.5/inner', 'content-type': 'text/html' }, body: null })
          : response(),
        calls
      )
    })
    await expect(fetcher('https://public.example.com/redirect')).rejects.toThrow()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.closed).toBe(true)
  })

  it('重定向到新主机时逐跳重新解析并绑定地址', async () => {
    const calls: CapturedCall[] = []
    const resolvedHosts: string[] = []
    const fetcher = makeFetcher({
      transport: makeTransport((_c, i) =>
        i === 0
          ? response({ status: 302, headers: { location: 'https://other.example.com/next', 'content-type': 'text/html' }, body: null })
          : response({ chunks: ['<title>落点</title><p>终</p>'] }),
        calls
      ),
      resolveDns: async (hostname) => {
        resolvedHosts.push(hostname)
        return hostname.startsWith('other') ? ['104.18.32.7'] : ['93.184.216.34']
      }
    })
    const page = await fetcher('https://public.example.com/go')
    expect(page.title).toBe('落点')
    expect(resolvedHosts).toEqual(['public.example.com', 'other.example.com'])
    expect(calls).toHaveLength(2)
    expect(calls[1]!.address).toBe('104.18.32.7')
  })

  it('相对路径重定向按当前 URL 解析', async () => {
    const calls: CapturedCall[] = []
    const fetcher = makeFetcher({
      transport: makeTransport((_c, i) =>
        i === 0
          ? response({ status: 301, headers: { location: '/moved', 'content-type': 'text/html' }, body: null })
          : response({ chunks: ['<title>ok</title><p>ok</p>'] }),
        calls
      )
    })
    await fetcher('https://public.example.com/old')
    expect(calls[1]!.url).toBe('https://public.example.com/moved')
  })

  it('重定向次数超过上限拒绝', async () => {
    const calls: CapturedCall[] = []
    const fetcher = makeFetcher({
      maxRedirects: 1,
      transport: makeTransport(() =>
        response({ status: 302, headers: { location: '/loop', 'content-type': 'text/html' }, body: null }), calls)
    })
    await expect(fetcher('https://public.example.com/loop')).rejects.toThrow('重定向次数')
    expect(calls).toHaveLength(2)
  })

  it('重定向到非 http(s) 目标拒绝', async () => {
    const fetcher = makeFetcher({
      transport: makeTransport(() =>
        response({ status: 302, headers: { location: 'file:///etc/passwd', 'content-type': 'text/html' }, body: null }))
    })
    await expect(fetcher('https://public.example.com/tofile')).rejects.toThrow('仅支持 http')
  })

  it('重定向缺少 location 头拒绝', async () => {
    const fetcher = makeFetcher({
      transport: makeTransport(() => response({ status: 302, headers: { 'content-type': 'text/html' }, body: null }))
    })
    await expect(fetcher('https://public.example.com/nolocation')).rejects.toThrow('重定向')
  })
})

describe('R5:响应流大小上限(按解码后累计,提前中止)', () => {
  it('Content-Length 超上限提前拒绝,不读取响应体', async () => {
    const calls: CapturedCall[] = []
    const fetcher = makeFetcher({
      maxBytes: 1000,
      transport: makeTransport(() => response({ headers: { 'content-type': 'text/html', 'content-length': '999999' }, chunks: [] }), calls)
    })
    await expect(fetcher('https://big.example.com/file')).rejects.toThrow('大小上限')
    expect(calls[0]!.bodyReads).toBe(0)
    expect(calls[0]!.closed).toBe(true)
  })

  it('分块流累计超上限提前中止读取(不解压全量入内存)', async () => {
    let closed = false
    async function* endlessDecodedBody(): AsyncGenerator<Uint8Array> {
      try {
        for (;;) {
          yield new Uint8Array(500).fill(0x61)
        }
      } finally {
        closed = true
      }
    }
    const fetcher = makeFetcher({
      maxBytes: 1000,
      transport: makeTransport(() => response({ body: endlessDecodedBody() }))
    })
    await expect(fetcher('https://stream.example.com/big')).rejects.toThrow('大小上限')
    expect(closed).toBe(true)
  })

  it('未超上限的流正常读完', async () => {
    const fetcher = makeFetcher({
      maxBytes: 10_000,
      transport: makeTransport(() => response({ chunks: ['<title>a</title>', '<p>bbb</p>'] }))
    })
    const page = await fetcher('https://ok.example.com/')
    expect(page.text).toContain('bbb')
  })
})

describe('R5:错误脱敏', () => {
  it('抓取失败不回显 URL 查询参数', async () => {
    const fetcher = makeFetcher({
      transport: makeTransport(() => response({ status: 500 }))
    })
    await expect(fetcher('https://secret.example.com/api?token=topsecret')).rejects.toThrow()
    try {
      await fetcher('https://secret.example.com/api?token=topsecret')
    } catch (err) {
      expect((err as Error).message).not.toContain('topsecret')
    }
  })
})
