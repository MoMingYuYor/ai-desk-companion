import { describe, expect, it } from 'vitest'
import { webmailUrlFor } from '../src/shared/webmail'

describe('webmailUrlFor', () => {
  it('常见域名映射到对应网页版邮箱', () => {
    expect(webmailUrlFor('study@qq.com')).toBe('https://mail.qq.com')
    expect(webmailUrlFor('a@foxmail.com')).toBe('https://mail.qq.com')
    expect(webmailUrlFor('a@163.com')).toBe('https://mail.163.com')
    expect(webmailUrlFor('a@126.com')).toBe('https://mail.126.com')
    expect(webmailUrlFor('a@gmail.com')).toBe('https://mail.google.com')
    expect(webmailUrlFor('a@outlook.com')).toBe('https://outlook.live.com')
    expect(webmailUrlFor('a@hotmail.com')).toBe('https://outlook.live.com')
  })

  it('大小写与空白不敏感', () => {
    expect(webmailUrlFor('  Study@QQ.COM ')).toBe('https://mail.qq.com')
  })

  it('未识别域名回退 mail.<域名>', () => {
    expect(webmailUrlFor('a@mail.example.edu.cn')).toBe('https://mail.mail.example.edu.cn')
    expect(webmailUrlFor('a@zju.edu.cn')).toBe('https://mail.zju.edu.cn')
  })

  it('非法输入返回 null', () => {
    expect(webmailUrlFor('')).toBeNull()
    expect(webmailUrlFor('not-an-email')).toBeNull()
    expect(webmailUrlFor('@no-local.com')).toBeNull()
  })
})
