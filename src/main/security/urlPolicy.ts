// 网页抓取目标地址策略(R5):纯函数模块。
// 拒绝环回、私网、链路本地、多播、未指定与保留段,覆盖 IPv4、IPv6 与映射地址;
// 错误消息只含原因分类,不回显 URL 主机/路径/查询参数。

import { isIP } from 'node:net'

export type UrlPolicyReason =
  | 'protocol-not-allowed'
  | 'loopback-host'
  | 'reserved-address'
  | 'non-public-address'

export class UrlPolicyError extends Error {
  readonly reason: UrlPolicyReason

  constructor(reason: UrlPolicyReason, message: string) {
    super(message)
    this.name = 'UrlPolicyError'
    this.reason = reason
  }
}

// ---------- IPv4 ----------

function v4ToInt(b: [number, number, number, number]): number {
  return (((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0)
}

function cidrRange(ip: string, prefix: number): [number, number] {
  const parts = ip.split('.').map(Number) as [number, number, number, number]
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const lo = (v4ToInt(parts) & mask) >>> 0
  return [lo, (lo | (~mask >>> 0)) >>> 0]
}

/** 保留/受限 IPv4 段:未指定、私网、CGN、环回、链路本地、IETF/TEST-NET、基准、多播、保留 */
const BLOCKED_V4_RANGES: Array<[number, number]> = [
  cidrRange('0.0.0.0', 8),
  cidrRange('10.0.0.0', 8),
  cidrRange('100.64.0.0', 10),
  cidrRange('127.0.0.0', 8),
  cidrRange('169.254.0.0', 16),
  cidrRange('172.16.0.0', 12),
  cidrRange('192.0.0.0', 24),
  cidrRange('192.0.2.0', 24),
  cidrRange('192.88.99.0', 24),
  cidrRange('192.168.0.0', 16),
  cidrRange('198.18.0.0', 15),
  cidrRange('198.51.100.0', 24),
  cidrRange('203.0.113.0', 24),
  cidrRange('224.0.0.0', 4),
  cidrRange('240.0.0.0', 4)
]

function assertPublicIPv4(ip: string): void {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new UrlPolicyError('reserved-address', '目标地址不允许访问(地址格式无效)')
  }
  const n = v4ToInt(parts as [number, number, number, number])
  for (const [lo, hi] of BLOCKED_V4_RANGES) {
    if (n >= lo && n <= hi) {
      throw new UrlPolicyError('non-public-address', '目标地址不允许访问(非公开网络地址)')
    }
  }
}

// ---------- IPv6 ----------

/** 解析 IPv6 为 8 个 16 位组(不含方括号与 zone);非法返回 null */
function parseIPv6(host: string): number[] | null {
  const groupsOf = (s: string): number[] | null => {
    if (s === '') return []
    const out: number[] = []
    for (const part of s.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null
      out.push(parseInt(part, 16))
    }
    return out
  }
  const halves = host.split('::')
  if (halves.length > 2) return null
  if (halves.length === 2) {
    const head = groupsOf(halves[0] ?? '')
    const tail = groupsOf(halves[1] ?? '')
    if (!head || !tail) return null
    const fill = 8 - head.length - tail.length
    if (fill < 0) return null
    return [...head, ...new Array<number>(fill).fill(0), ...tail]
  }
  const groups = groupsOf(host)
  return groups && groups.length === 8 ? groups : null
}

function v4BytesFromGroups(hi: number, lo: number): [number, number, number, number] {
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]
}

function assertPublicIPv6(host: string): void {
  const groups = parseIPv6(host)
  if (!groups) {
    throw new UrlPolicyError('reserved-address', '目标地址不允许访问(地址格式无效)')
  }
  const zerosAt = (from: number, to: number): boolean => {
    for (let i = from; i < to; i++) if (groups[i] !== 0) return false
    return true
  }
  // 环回 ::1 与未指定 ::
  if (zerosAt(0, 7) && (groups[7] === 0 || groups[7] === 1)) {
    throw new UrlPolicyError('non-public-address', '目标地址不允许访问(非公开网络地址)')
  }
  // NAT64 64:ff9b::/96 → 校验内嵌 IPv4;local-use NAT64 64:ff9b:1::/48 直接拒绝
  if (groups[0] === 0x64 && groups[1] === 0xff9b) {
    if (groups[2] === 1 && zerosAt(3, 6)) {
      throw new UrlPolicyError('non-public-address', '目标地址不允许访问(非公开网络地址)')
    }
    if (zerosAt(2, 6)) {
      assertPublicIPv4Bytes(v4BytesFromGroups(groups[6]!, groups[7]!))
      return
    }
  }
  // IPv4-mapped ::ffff:0:0/96 → 校验内嵌 IPv4(点分与十六进制写法同形)
  if (zerosAt(0, 5) && groups[5] === 0xffff) {
    assertPublicIPv4Bytes(v4BytesFromGroups(groups[6]!, groups[7]!))
    return
  }
  // IPv4-compatible ::/96(已废弃)拒绝
  if (zerosAt(0, 6)) {
    throw new UrlPolicyError('non-public-address', '目标地址不允许访问(非公开网络地址)')
  }
  // 丢弃段 100::/64
  if (groups[0] === 0x100 && zerosAt(1, 4)) {
    throw new UrlPolicyError('non-public-address', '目标地址不允许访问(非公开网络地址)')
  }
  // Teredo 2001::/32、文档段 2001:db8::/32
  if (groups[0] === 0x2001 && (groups[1] === 0 || groups[1] === 0xdb8)) {
    throw new UrlPolicyError('non-public-address', '目标地址不允许访问(非公开网络地址)')
  }
  // 6to4 2002::/16(隧道段,S1 保守整段拒绝)
  if (groups[0] === 0x2002) {
    throw new UrlPolicyError('non-public-address', '目标地址不允许访问(非公开网络地址)')
  }
  // ULA fc00::/7、链路本地 fe80::/10、多播 ff00::/8
  const first = groups[0]!
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) {
    throw new UrlPolicyError('non-public-address', '目标地址不允许访问(非公开网络地址)')
  }
}

function assertPublicIPv4Bytes(b: [number, number, number, number]): void {
  assertPublicIPv4(b.join('.'))
}

// ---------- 入口 ----------

/**
 * 校验抓取目标:协议必须为 http(s);主机字面量与 DNS 解析结果逐个校验保留段。
 * resolved 为该主机实际解析到的地址列表;调用方必须把通过校验的地址绑定给连接。
 */
export function assertPublicHttpTarget(url: URL, resolved: readonly string[]): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlPolicyError('protocol-not-allowed', '仅支持 http/https 链接')
  }
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '')
  if (/^localhost$/i.test(host) || /\.localhost$/i.test(host)) {
    throw new UrlPolicyError('loopback-host', '目标地址不允许访问(本机地址)')
  }
  // zone-id(%25 编码)仅出现在链路本地等受限作用域
  if (host.includes('%')) {
    throw new UrlPolicyError('reserved-address', '目标地址不允许访问(受限作用域)')
  }
  // 十进制整数主机名(http://2130706433/ 即 127.0.0.1)
  if (/^\d+$/.test(host)) {
    const n = Number(host)
    if (Number.isSafeInteger(n) && n <= 0xffffffff) {
      assertPublicIPv4Bytes([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
    } else {
      throw new UrlPolicyError('reserved-address', '目标地址不允许访问(地址格式无效)')
    }
  }
  const literalVersion = isIP(host)
  if (literalVersion === 4) assertPublicIPv4(host)
  else if (literalVersion === 6) assertPublicIPv6(host)

  for (const addr of resolved) {
    const version = isIP(addr)
    if (version === 4) assertPublicIPv4(addr)
    else if (version === 6) assertPublicIPv6(addr)
    else throw new UrlPolicyError('reserved-address', '目标地址不允许访问(解析结果无效)')
  }
}
