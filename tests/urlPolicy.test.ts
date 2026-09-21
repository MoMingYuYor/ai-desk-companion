import { describe, expect, it } from 'vitest'
import { assertPublicHttpTarget, UrlPolicyError } from '../src/main/security/urlPolicy'

// R5(Task 7):assertPublicHttpTarget 拒绝环回/私网/链路本地/多播/未指定/保留段,
// 覆盖 IPv4、IPv6、映射地址;错误消息不回显 URL 参数。

function expectBlocked(raw: string, resolved: readonly string[] = []): void {
  expect(() => assertPublicHttpTarget(new URL(raw), resolved), raw).toThrow(UrlPolicyError)
}

function expectAllowed(raw: string, resolved: readonly string[] = []): void {
  expect(() => assertPublicHttpTarget(new URL(raw), resolved), raw).not.toThrow()
}

describe('assertPublicHttpTarget IPv4 保留段', () => {
  it('拒绝环回/未指定/私网/链路本地/多播/保留/测试段', () => {
    for (const raw of [
      'http://127.0.0.1/',
      'http://127.1.2.3/',
      'http://0.0.0.0/',
      'http://10.0.0.5/',
      'http://172.16.0.1/',
      'http://172.31.255.255/',
      'http://192.168.1.1/',
      'http://169.254.1.1/',
      'http://100.64.0.1/',
      'http://192.0.2.1/',
      'http://198.51.100.7/',
      'http://203.0.113.9/',
      'http://198.18.0.1/',
      'http://224.0.0.1/',
      'http://240.0.0.1/',
      'http://255.255.255.255/'
    ]) {
      expectBlocked(raw)
    }
  })

  it('放行公网字面量地址', () => {
    expectAllowed('http://8.8.8.8/')
    expectAllowed('https://93.184.216.34/page')
    expectAllowed('http://192.168.255.255.example.com/') // 公网域名,不因子串误判
  })
})

describe('assertPublicHttpTarget IPv6 与映射地址', () => {
  it('拒绝 IPv6 环回/未指定/链路本地/ULA/多播/文档/丢弃段', () => {
    for (const raw of [
      'http://[::1]/',
      'http://[::]/',
      'http://[fe80::1]/',
      'http://[fc00::1]/',
      'http://[fd12:3456::1]/',
      'http://[ff02::1]/',
      'http://[2001:db8::1]/',
      'http://[100::1]/'
    ]) {
      expectBlocked(raw)
    }
  })

  it('拒绝 IPv4-mapped 的保留地址(::ffff: 形式的点分与十六进制写法)', () => {
    expectBlocked('http://[::ffff:127.0.0.1]/')
    expectBlocked('http://[::ffff:10.0.0.1]/')
    expectBlocked('http://[::ffff:192.168.0.1]/')
    expectBlocked('http://[::ffff:7f00:1]/') // 127.0.0.1 的十六进制写法
  })

  it('拒绝 NAT64/6to4 隧道段', () => {
    expectBlocked('http://[64:ff9b::7f00:1]/') // NAT64 → 127.0.0.1
    expectBlocked('http://[64:ff9b::a00:1]/') // NAT64 → 10.0.0.1
    expectBlocked('http://[64:ff9b:1::1]/') // local-use NAT64
    expectBlocked('http://[2002:7f00:1::]/') // 6to4 → 127.0.0.1
  })

  it('放行映射后的公网地址与公网 IPv6', () => {
    expectAllowed('http://[::ffff:93.184.216.34]/')
    expectAllowed('http://[2606:4700::1111]/')
  })
})

describe('assertPublicHttpTarget 主机名与解析结果', () => {
  it('拒绝 localhost 及其子域', () => {
    expectBlocked('http://localhost/')
    expectBlocked('http://api.localhost/')
  })

  it('拒绝十进制整数主机名(http://2130706433/ 即 127.0.0.1)', () => {
    expectBlocked('http://2130706433/')
  })

  it('拒绝带 zone-id 的地址(链路本地作用域);http(s) URL 层本身也拒绝该形态', () => {
    // Node 的 WHATWG URL 不接受 http(s) 下的 zone-id,策略层再对 hostname 中的 '%' 兜底拒绝
    expect(() => new URL('http://[fe80::1%25eth0]/')).toThrow()
    const fake = { protocol: 'http:', hostname: 'fe80::1%eth0' } as unknown as URL
    expect(() => assertPublicHttpTarget(fake, [])).toThrow(UrlPolicyError)
  })

  it('DNS 解析结果含保留地址时拒绝(rebinding),全为公网时放行', () => {
    expectBlocked('https://example.com/', ['93.184.216.34', '10.0.0.1'])
    expectBlocked('https://example.com/', ['::ffff:127.0.0.1'])
    expectAllowed('https://example.com/', ['93.184.216.34', '2606:4700::1111'])
  })

  it('解析结果非 IP 一律拒绝', () => {
    expectBlocked('https://example.com/', ['not-an-ip'])
  })

  it('非 http(s) 协议拒绝', () => {
    expectBlocked('ftp://example.com/')
    expectBlocked('file:///etc/passwd')
  })
})

describe('UrlPolicyError 脱敏', () => {
  it('错误消息不含 URL 查询参数等敏感内容', () => {
    try {
      assertPublicHttpTarget(new URL('http://127.0.0.1/?token=secret'), [])
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(UrlPolicyError)
      const text = `${(err as Error).message}|${String((err as { reason?: string }).reason)}`
      expect(text).not.toContain('token')
      expect(text).not.toContain('secret')
      expect(text).not.toContain('127.0.0.1')
    }
  })
})
