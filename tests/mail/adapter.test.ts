import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import {
  buildImapOptions,
  createImapSession,
  type ImapClientLike,
  type RawFetchMessage
} from '../../src/main/mail/imapAdapter'

const connection = {
  host: 'imap.qq.com',
  port: 993,
  email: 'test@qq.com',
  password: 'synthetic-secret'
}

/** 注入的 ImapFlow 构造器替身:记录所有调用,不连接网络 */
class FakeClient implements ImapClientLike {
  calls: string[] = []
  searchQueries: Array<{ query: Record<string, unknown>; options?: { uid?: boolean } }> = []
  fetchCalls: Array<{ range: string; query: Record<string, unknown>; options?: { uid?: boolean } }> = []
  downloadCalls: Array<{ range: string; part: string; options?: { uid?: boolean } }> = []
  mailbox: { uidValidity: bigint | number | string; uidNext: number } = { uidValidity: 123n, uidNext: 50 }
  searchResults: number[][] = []
  fetchMessages: RawFetchMessage[] = []
  downloadResult: { content: Readable } | null = { content: Readable.from(['part-data']) }
  connectError: Error | null = null

  async connect(): Promise<boolean> {
    this.calls.push('connect')
    if (this.connectError) throw this.connectError
    return true
  }

  async mailboxOpen(path: string, options?: { readOnly?: boolean }) {
    this.calls.push(`mailboxOpen:${path}:${JSON.stringify(options ?? null)}`)
    return this.mailbox
  }

  async search(query: Record<string, unknown>, options?: { uid?: boolean }): Promise<number[]> {
    this.calls.push(`search:${JSON.stringify(query)}`)
    this.searchQueries.push({ query, options })
    return this.searchResults.shift() ?? []
  }

  async *fetch(
    range: string,
    query: Record<string, unknown>,
    options?: { uid?: boolean }
  ): AsyncGenerator<RawFetchMessage> {
    this.calls.push(`fetch:${range}`)
    this.fetchCalls.push({ range, query, options })
    for (const msg of this.fetchMessages) yield msg
  }

  async download(range: string, part: string, options?: { uid?: boolean }) {
    this.calls.push(`download:${range}:${part}`)
    this.downloadCalls.push({ range, part, options })
    return this.downloadResult
  }

  async logout(): Promise<void> {
    this.calls.push('logout')
  }

  close(): void {
    this.calls.push('close')
  }
}

function makeSession(client = new FakeClient()) {
  const controller = new AbortController()
  const session = createImapSession(connection, controller.signal, { createClient: () => client })
  return { client, session, controller }
}

describe('buildImapOptions', () => {
  it('强制 TLS、校验证书、30 秒超时并关闭协议日志', () => {
    const options = buildImapOptions(connection)
    expect(options).toMatchObject({
      host: 'imap.qq.com',
      port: 993,
      secure: true,
      logger: false,
      logRaw: false,
      tls: { rejectUnauthorized: true },
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 30_000,
      disableAutoIdle: true,
      auth: { user: 'test@qq.com', pass: 'synthetic-secret' },
      clientInfo: { name: 'ai-desk-companion', version: '0.1.0' }
    })
  })
})

describe('createImapSession', () => {
  it('open 只读选中 INBOX 并把 uidValidity 字符串化', async () => {
    const { client, session } = makeSession()
    const info = await session.open()
    expect(info).toEqual({ uidValidity: '123', uidNext: 50 })
    expect(client.calls[0]).toBe('connect')
    expect(client.calls[1]).toBe(`mailboxOpen:INBOX:${JSON.stringify({ readOnly: true })}`)
    await session.close()
    expect(client.calls).toContain('logout')
  })

  it('open 以字符串型 uidValidity 也能正常返回', async () => {
    const { client, session } = makeSession()
    client.mailbox = { uidValidity: '456', uidNext: 9 }
    expect(await session.open()).toEqual({ uidValidity: '456', uidNext: 9 })
  })

  it('cancel 立即关闭连接', () => {
    const { client, session } = makeSession()
    session.cancel()
    expect(client.calls).toContain('close')
  })

  it('searchDays 使用 SINCE/BEFORE 且请求 UID 序号', async () => {
    const { client, session } = makeSession()
    await session.open()
    client.searchResults.push([3, 7])
    expect(await session.searchDays('2026-08-17', '2026-09-16')).toEqual([3, 7])
    expect(client.searchQueries).toHaveLength(1)
    expect(client.searchQueries[0].query).toEqual({ since: '2026-08-17', before: '2026-09-16' })
    expect(client.searchQueries[0].options).toEqual({ uid: true })
  })

  it('searchUids 使用 UID 范围,空区间不发命令', async () => {
    const { client, session } = makeSession()
    await session.open()
    expect(await session.searchUids(100, 100)).toEqual([])
    expect(await session.searchUids(200, 100)).toEqual([])
    expect(client.searchQueries).toHaveLength(0)

    client.searchResults.push([101, 103, 105])
    expect(await session.searchUids(100, 105)).toEqual([101, 103, 105])
    expect(client.searchQueries[0].query).toEqual({ uid: '101:105' })
    expect(client.searchQueries[0].options).toEqual({ uid: true })
  })

  it('envelopes 只请求元数据(零正文下载)并映射字段', async () => {
    const { client, session } = makeSession()
    await session.open()
    client.fetchMessages = [
      {
        uid: 7,
        flags: new Set(['\\Seen']),
        size: 2048,
        internalDate: new Date('2026-09-10T08:00:00Z'),
        envelope: {
          subject: '你好',
          messageId: '<a@example.com>',
          from: [{ name: '张三', address: 'zhang@example.com' }],
          to: [{ address: 'me@example.com' }]
        },
        bodyStructure: {
          part: 'TEXT',
          type: 'multipart/mixed',
          childNodes: [
            { part: '1', type: 'text/plain', parameters: { charset: 'utf-8' }, size: 100 },
            {
              part: '2',
              type: 'application/pdf',
              disposition: 'attachment',
              dispositionParameters: { filename: 'report.pdf' },
              size: 500
            }
          ]
        }
      }
    ]
    const rows = await session.envelopes([7])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      uid: 7,
      messageId: '<a@example.com>',
      subject: '你好',
      from: '张三 <zhang@example.com>',
      to: 'me@example.com',
      receivedAt: '2026-09-10T08:00:00.000Z',
      size: 2048,
      seen: true
    })
    expect(rows[0].textParts).toEqual([{ part: '1', name: '', mime: 'text/plain', size: 100, charset: 'utf-8' }])
    expect(rows[0].htmlParts).toEqual([])
    expect(rows[0].attachments).toEqual([
      { part: '2', name: 'report.pdf', mime: 'application/pdf', size: 500, charset: undefined }
    ])
    const fetchCall = client.fetchCalls[0]
    expect(fetchCall.range).toBe('7')
    expect(fetchCall.options).toEqual({ uid: true })
    expect(fetchCall.query).not.toHaveProperty('source')
    expect(fetchCall.query).not.toHaveProperty('bodyParts')
  })

  it('envelopes 空列表不发 fetch 命令', async () => {
    const { client, session } = makeSession()
    await session.open()
    expect(await session.envelopes([])).toEqual([])
    expect(client.fetchCalls).toHaveLength(0)
  })

  it('part 使用 UID 下载并返回内容流', async () => {
    const { client, session } = makeSession()
    await session.open()
    const stream = await session.part(7, '2')
    expect(client.downloadCalls[0]).toEqual({ range: '7', part: '2', options: { uid: true } })
    let text = ''
    for await (const chunk of stream) text += String(chunk)
    expect(text).toBe('part-data')
  })

  it('认证失败归类为 AUTH 错误', async () => {
    const { client, session } = makeSession()
    client.connectError = new Error('Authentication failed')
    await expect(session.open()).rejects.toMatchObject({ code: 'AUTH' })
  })

  it('连接被拒归类为 NETWORK 错误', async () => {
    const { client, session } = makeSession()
    client.connectError = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:993'), { code: 'ECONNREFUSED' })
    await expect(session.open()).rejects.toMatchObject({ code: 'NETWORK' })
  })

  it('证书问题归类为 TLS 错误', async () => {
    const { client, session } = makeSession()
    client.connectError = new Error('self-signed certificate in certificate chain')
    await expect(session.open()).rejects.toMatchObject({ code: 'TLS' })
  })

  it('信号已中止时操作抛 CANCELLED', async () => {
    const { client, session, controller } = makeSession()
    controller.abort()
    await expect(session.open()).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(client.calls).not.toContain('connect')
  })

  it('操作途中中止会断开连接并抛 CANCELLED', async () => {
    const { client, session, controller } = makeSession()
    await session.open()
    controller.abort()
    await expect(session.searchUids(0, 10)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(client.calls).toContain('close')
  })
})
