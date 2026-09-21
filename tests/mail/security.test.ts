import { describe, expect, it, vi } from 'vitest'
import { extractLinks, htmlToText, normalizeLinkUrl, sanitizeMailHtml } from '../../src/main/mail/sanitize'
import { MailAccountStore } from '../../src/main/mail/accounts'
import { MailError } from '../../src/main/mail/errors'
import { decryptCredential, encryptCredential, type CredentialStorage } from '../../src/main/mail/credentials'
import { makeTestDb } from '../helpers'

describe('sanitizeMailHtml 白名单清理', () => {
  it('剥离 script 标签及其内容', () => {
    const out = sanitizeMailHtml('<p>你好</p><script>alert(1)</script>')
    expect(out).not.toContain('script')
    expect(out).not.toContain('alert')
    expect(out).toContain('你好')
  })

  it('剥离 onerror/onclick 等事件属性', () => {
    const out = sanitizeMailHtml('<p onerror="alert(1)" onclick="steal()">正文</p>')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('alert(1)')
    expect(out).toContain('正文')
  })

  it('剥离 iframe 及其地址', () => {
    const out = sanitizeMailHtml('<iframe src="https://evil.example/frame"></iframe><p>正文</p>')
    expect(out).not.toContain('iframe')
    expect(out).not.toContain('evil.example')
    expect(out).toContain('正文')
  })

  it('剥离 style 外链、内联样式与 style 元素', () => {
    const out = sanitizeMailHtml(
      '<link rel="stylesheet" href="https://evil.example/x.css">' +
      '<style>@import url("https://evil.example/y.css"); body { display: none }</style>' +
      '<p style="background:url(https://evil.example/z.png)">正文</p>'
    )
    expect(out).not.toContain('evil.example')
    expect(out).not.toContain('@import')
    expect(out).not.toContain('style=')
    expect(out).toContain('正文')
  })

  it('img 一律不加载且不留远程图片地址', () => {
    const out = sanitizeMailHtml('<p>前</p><img src="https://tracker.example/pixel.png" onerror="alert(1)"><p>后</p>')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('tracker.example')
    expect(out).not.toContain('onerror')
    expect(out).toContain('前')
    expect(out).toContain('后')
  })

  it('保留基本文本结构且正文内链接不带 href', () => {
    const out = sanitizeMailHtml(
      '<div><h2>标题</h2><ul><li>一项</li></ul>' +
      '<table><tr><td>表格</td></tr></table>' +
      '<a href="https://example.com/a">官网</a></div>'
    )
    expect(out).toContain('<h2>标题</h2>')
    expect(out).toContain('<li>一项</li>')
    expect(out).toContain('表格')
    expect(out).toContain('官网')
    // 设计要求：正文内链接改为无 href 文本，点击走可信链接列表
    expect(out).not.toContain('href=')
  })

  it('base 与 meta refresh 被丢弃', () => {
    const out = sanitizeMailHtml(
      '<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example/"><p>正文</p>'
    )
    expect(out).not.toContain('evil.example')
    expect(out).not.toContain('base')
    expect(out).not.toContain('refresh')
    expect(out).toContain('正文')
  })

  it('空输入与纯文本输入安全返回', () => {
    expect(sanitizeMailHtml('')).toBe('')
    expect(sanitizeMailHtml('普通文本')).toContain('普通文本')
  })
})

describe('htmlToText 纯文本转换', () => {
  it('产出不含标签的纯文本', () => {
    const text = htmlToText('<h1>会议通知</h1><p>明天 <b>上午十点</b> 开会</p>')
    expect(text).toContain('会议通知')
    expect(text).toContain('上午十点')
    expect(text).not.toContain('<')
    expect(text).not.toContain('h1')
  })

  it('不输出图片地址与脚本内容', () => {
    const text = htmlToText('<p>看图</p><img src="https://tracker.example/p.png" alt="像素"><script>var a = 1</script>')
    expect(text).toContain('看图')
    expect(text).not.toContain('tracker.example')
    expect(text).not.toContain('var a')
  })
})

describe('extractLinks 可信链接提取', () => {
  it('保留 http/https 链接并给出锚点文本', () => {
    const links = extractLinks(
      '<p><a href="https://example.com/meet">会议链接</a> 与 <a href="http://example.org/doc">文档</a></p>'
    )
    expect(links).toEqual([
      { label: '会议链接', url: 'https://example.com/meet' },
      { label: '文档', url: 'http://example.org/doc' }
    ])
  })

  it('丢弃 javascript/data/协议相对/相对地址', () => {
    const links = extractLinks(
      '<a href="javascript:alert(1)">点我</a>' +
      '<a href="data:text/html,<h1>evil</h1>">数据</a>' +
      '<a href="//evil.example/x">协议相对</a>' +
      '<a href="/relative/path">相对</a>' +
      '<a href="https://good.example/ok">好的</a>'
    )
    expect(links).toEqual([{ label: '好的', url: 'https://good.example/ok' }])
  })

  it('URL 解析失败的地址被丢弃', () => {
    expect(extractLinks('<a href="ht!tp://bad">坏地址</a>')).toEqual([])
    expect(extractLinks('<a href="   ">空地址</a>')).toEqual([])
  })

  it('无 href 锚点不收集、重复链接按 URL 去重', () => {
    const links = extractLinks(
      '<a>纯文本锚</a>' +
      '<a href="https://example.com/dup">一次</a>' +
      '<a href="https://example.com/dup">两次</a>'
    )
    expect(links).toEqual([{ label: '一次', url: 'https://example.com/dup' }])
  })
})

describe('normalizeLinkUrl 协议验证', () => {
  it('只放行 http/https', () => {
    expect(normalizeLinkUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(normalizeLinkUrl('http://example.com')).toBe('http://example.com/')
    expect(normalizeLinkUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeLinkUrl('data:text/html,evil')).toBeNull()
    expect(normalizeLinkUrl('file:///C:/Windows/System32')).toBeNull()
    expect(normalizeLinkUrl('ftp://example.com/f')).toBeNull()
    expect(normalizeLinkUrl('')).toBeNull()
  })
})

// R4(Task 6):邮箱凭据加密边界——与模型密钥同一安全要求:拒绝明文降级、不可还原凭据不出库
describe('R4:邮箱凭据加密边界(拒绝明文降级)', () => {
  /** 可对称加解密的凭据存储替身,可控可用性 */
  function makeStorage(available = true): CredentialStorage {
    return {
      isEncryptionAvailable: () => available,
      encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (value: Buffer) => {
        const text = Buffer.from(value).toString('utf8')
        if (!text.startsWith('enc:')) throw new Error('not a protected value')
        return text.slice(4)
      }
    }
  }

  const unavailable = {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn()
  }

  function accountInput() {
    return {
      label: '工作邮箱',
      email: 'Alice@Example.COM',
      provider: 'custom' as const,
      host: 'imap.example.com',
      port: 993,
      credential: 'app-password-1'
    }
  }

  it('系统加密不可用时 encryptCredential 拒绝,不产生可还原凭据', () => {
    expect(() => encryptCredential('app-password-1', unavailable)).toThrow(MailError)
    expect(unavailable.encryptString).not.toHaveBeenCalled()
  })

  it('解密拒绝旧明文/裸 base64/空值,不做明文回落', () => {
    const storage = makeStorage()
    for (const legacy of ['plain:c2VjcmV0', 'c2VjcmV0', '', 'aGk=']) {
      expect(() => decryptCredential(legacy, storage), legacy).toThrow(MailError)
    }
  })

  it('安全存储不可用时保存账号被明确拒绝且不落库', async () => {
    const db = await makeTestDb()
    const store = new MailAccountStore(db, unavailable)
    expect(() => store.saveVerified(accountInput())).toThrow(MailError)
    expect(db.all<{ id: string }>('SELECT id FROM mail_accounts')).toHaveLength(0)
  })

  it('账号信息不携带可还原凭据', async () => {
    const db = await makeTestDb()
    const store = new MailAccountStore(db, makeStorage())
    const info = store.saveVerified(accountInput())
    expect(info.hasCredential).toBe(true)
    expect(JSON.stringify(info)).not.toContain('app-password-1')
    expect(JSON.stringify(info)).not.toContain('enc:')
  })
})
