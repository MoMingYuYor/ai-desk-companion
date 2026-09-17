import { describe, expect, it } from 'vitest'
import { extractUrls, extractMainText } from '../src/shared/urlText'

describe('extractUrls', () => {
  it('从文本中提取 http/https 链接并去重', () => {
    const text = '看这篇 https://mp.weixin.qq.com/s/abc123，还有 http://example.com/a 以及 https://mp.weixin.qq.com/s/abc123'
    expect(extractUrls(text)).toEqual([
      'https://mp.weixin.qq.com/s/abc123',
      'http://example.com/a'
    ])
  })

  it('去掉结尾标点,忽略无协议的域名', () => {
    expect(extractUrls('https://example.com/x。')).toEqual(['https://example.com/x'])
    expect(extractUrls('去 www.example.com 看看')).toEqual([])
  })
})

describe('extractMainText', () => {
  it('提取标题并剥离 script/style,保留块级换行', () => {
    const html = `<!doctype html><html><head><title>微信文章标题</title>
      <style>body{color:red}</style><script>var a=1;</script></head>
      <body><h1> ignored </h1><div id="js_content">
      <p>第一段内容。</p><p>第二段<br/>内容含<br>换行</p>
      <script>evil()</script><span>行内文字</span></div></body></html>`
    const r = extractMainText(html)
    expect(r.title).toBe('微信文章标题')
    expect(r.text).toContain('第一段内容。')
    expect(r.text).toContain('第二段')
    expect(r.text).toContain('内容含')
    expect(r.text).toContain('行内文字')
    expect(r.text).not.toContain('evil')
    expect(r.text).not.toContain('color:red')
  })

  it('解码常见 HTML 实体并折叠多余空行', () => {
    const html = '<title>t</title><body><p>A&amp;B&nbsp;测试</p><p>&quot;引号&#39;单引号&quot;</p><p>&lt;tag&gt;</p></body>'
    const r = extractMainText(html)
    expect(r.text).toContain('A&B 测试')
    expect(r.text).toContain('"引号\'单引号"')
    expect(r.text).toContain('<tag>')
  })
})
