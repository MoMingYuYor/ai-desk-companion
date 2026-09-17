import { describe, expect, it, vi } from 'vitest'
import { createUrlFetcher } from '../src/main/services/urlFetch'

function htmlResponse(html: string, contentType = 'text/html; charset=utf-8'): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': contentType }),
    arrayBuffer: async () => new TextEncoder().encode(html).buffer as ArrayBuffer
  } as unknown as Response
}

describe('createUrlFetcher', () => {
  it('带浏览器 UA 抓取并解析标题与正文', async () => {
    let seenUrl = ''
    let seenUa = ''
    const fetcher = createUrlFetcher({
      fetchImpl: (async (url: string, init?: RequestInit) => {
        seenUrl = url
        seenUa = String((init?.headers as Record<string, string>)['User-Agent'])
        return htmlResponse('<title>文章标题</title><body><p>正文第一段</p></body>')
      }) as typeof fetch
    })
    const page = await fetcher('https://mp.weixin.qq.com/s/abc')
    expect(seenUrl).toBe('https://mp.weixin.qq.com/s/abc')
    expect(seenUa).toContain('Mozilla')
    expect(page.title).toBe('文章标题')
    expect(page.text).toContain('正文第一段')
  })

  it('拒绝非 http/https 协议且不发起请求', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not be called')
    })
    const fetcher = createUrlFetcher({ fetchImpl })
    await expect(fetcher('file:///C:/Windows/system32')).rejects.toThrow('仅支持 http')
    await expect(fetcher('ftp://example.com/a')).rejects.toThrow('仅支持 http')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('非网页内容类型返回明确错误', async () => {
    const fetcher = createUrlFetcher({
      fetchImpl: (async () => htmlResponse('x', 'image/png')) as typeof fetch
    })
    await expect(fetcher('https://example.com/a.png')).rejects.toThrow('不是网页')
  })

  it('HTTP 错误状态返回含状态码的错误', async () => {
    const fetcher = createUrlFetcher({
      fetchImpl: (async () =>
        ({
          ok: false,
          status: 404,
          headers: new Headers({ 'content-type': 'text/html' }),
          arrayBuffer: async () => new ArrayBuffer(0)
        }) as unknown as Response) as typeof fetch
    })
    await expect(fetcher('https://example.com/gone')).rejects.toThrow('404')
  })

  it('超时错误转换为可读提示', async () => {
    const fetcher = createUrlFetcher({
      fetchImpl: (async () => {
        throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })
      }) as typeof fetch
    })
    await expect(fetcher('https://slow.example.com/a')).rejects.toThrow('超时')
  })

  it('正文按 maxBytes 截断,避免超大页面撑爆内存', async () => {
    const big = '<title>big</title><p>' + '字'.repeat(100000) + '</p>'
    const fetcher = createUrlFetcher({
      maxBytes: 2000,
      fetchImpl: (async () => htmlResponse(big)) as typeof fetch
    })
    const page = await fetcher('https://example.com/big')
    expect(page.text.length).toBeLessThan(2000)
    expect(page.text).toContain('字')
  })
})
