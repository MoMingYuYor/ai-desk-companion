import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTestDb } from '../helpers'
import type { SqliteDb } from '../../src/main/db/connection'
import { MAIL_LIMITS, type MailAttachmentInfo, type MailSummary } from '../../src/shared/mail'
import type { EnvelopeRow, SessionFactory } from '../../src/main/mail/adapter'
import { MailCacheService, MailCodedError, readLimited } from '../../src/main/mail/cache'
import { MailContentService } from '../../src/main/mail/content'

type MailRecord = {
  message: MailSummary
  uid: number | null
  uidValidity: string | null
  structure: EnvelopeRow
  bodyPath: string | null
}

type PartProvider = () => Readable | Promise<Readable>

/** 内存仓储替身：仅实现 B 区消费的方法，缓存写入按契约调用 db.flush 落盘。 */
class FakeRepository {
  records = new Map<string, MailRecord>()
  attachments = new Map<string, MailAttachmentInfo & { part: string; cachePath: string | null }>()
  bodyCacheCalls: Array<{ id: string; path: string }> = []
  attachmentCacheCalls: Array<{ id: string; path: string }> = []
  bodyStates: Array<{ id: string; state: MailSummary['bodyState'] }> = []
  removedAccounts: string[] = []

  constructor(private readonly db: SqliteDb) {}

  record(id: string): MailRecord | null {
    return this.records.get(id) ?? null
  }

  attachment(id: string): (MailAttachmentInfo & { part: string; cachePath: string | null }) | null {
    return this.attachments.get(id) ?? null
  }

  setBodyCache(id: string, path: string): void {
    const rec = this.records.get(id)
    if (rec) {
      rec.bodyPath = path
      rec.message.bodyState = 'cached'
    }
    this.bodyCacheCalls.push({ id, path })
    this.db.flush() // 与真实仓储契约一致：缓存标志通过 flush 落盘
  }

  setAttachmentCache(id: string, path: string): void {
    const att = this.attachments.get(id)
    if (att) att.cachePath = path
    this.attachmentCacheCalls.push({ id, path })
    this.db.flush()
  }

  setBodyState(id: string, state: MailSummary['bodyState']): void {
    const rec = this.records.get(id)
    if (rec) rec.message.bodyState = state
    this.bodyStates.push({ id, state })
  }

  listAttachments(messageId: string): MailAttachmentInfo[] {
    return [...this.attachments.values()]
      .filter((att) => att.messageId === messageId)
      .map(({ part: _part, cachePath: _cachePath, ...info }) => info)
  }

  removeAccountCache(accountId: string): void {
    this.removedAccounts.push(accountId)
  }

  // 以下方法 B 区不消费，仅为满足 MailRepositoryPort 结构
  state() {
    return { mailbox: 'INBOX', uidValidity: null, lastUid: 0, oldestDay: null, initialized: false }
  }

  commitBatch(): number {
    return 0
  }

  list() {
    return { items: [], hasMore: false }
  }

  get(): null {
    return null
  }

  markRead(): void {
    /* 未使用 */
  }

  invalidateRemote(): void {
    /* 未使用 */
  }
}

interface FakeSessionState {
  created: number
  opened: number
  closed: number
  partCalls: Array<{ uid: number; part: string }>
  lastConnection: { host: string; port: number; email: string; password: string } | null
}

function makeSessionFactory(parts: Map<string, PartProvider>): { factory: SessionFactory; state: FakeSessionState } {
  const state: FakeSessionState = {
    created: 0,
    opened: 0,
    closed: 0,
    partCalls: [],
    lastConnection: null
  }
  const factory: SessionFactory = (connection) => {
    state.created += 1
    state.lastConnection = connection
    return {
      open: async () => {
        state.opened += 1
        return { uidValidity: '9001', uidNext: 500 }
      },
      searchDays: async () => {
        throw new Error('测试未使用 searchDays')
      },
      searchUids: async () => {
        throw new Error('测试未使用 searchUids')
      },
      envelopes: async () => {
        throw new Error('测试未使用 envelopes')
      },
      part: async (uid: number, part: string) => {
        state.partCalls.push({ uid, part })
        const provider = parts.get(part)
        if (!provider) throw new Error(`测试未提供 part ${part}`)
        return await provider()
      },
      close: async () => {
        state.closed += 1
      },
      cancel: () => {
        /* 未使用 */
      }
    }
  }
  return { factory, state }
}

function makeSummary(overrides: Partial<MailSummary> = {}): MailSummary {
  return {
    id: 'msg-1',
    accountId: 'acc-1',
    accountLabel: '测试邮箱',
    subject: '报名通知',
    from: 'teacher@example.com',
    to: 'me@example.com',
    receivedAt: '2026-09-15T01:00:00.000Z',
    read: false,
    hasAttachments: true,
    bodyState: 'missing',
    remoteAvailable: true,
    ...overrides
  }
}

function makeEnvelope(overrides: Partial<EnvelopeRow> = {}): EnvelopeRow {
  return {
    uid: 101,
    messageId: '<msg-1@example.com>',
    subject: '报名通知',
    from: 'teacher@example.com',
    to: 'me@example.com',
    receivedAt: '2026-09-15T01:00:00.000Z',
    size: 2048,
    seen: false,
    textParts: [{ part: '1', name: '', mime: 'text/plain', size: 32, charset: 'utf-8' }],
    htmlParts: [{ part: '2', name: '', mime: 'text/html', size: 96, charset: 'utf-8' }],
    attachments: [{ part: '3', name: '说明.pdf', mime: 'application/pdf', size: 2048 }],
    ...overrides
  }
}

/** 超限大流：按 1MiB 分片产出 totalBytes 字节（避免一次性分配完整大 Buffer）。 */
function oversizedStream(totalBytes: number, chunkSize = 1024 * 1024): Readable {
  let sent = 0
  return new Readable({
    read() {
      const size = Math.min(chunkSize, totalBytes - sent)
      if (size <= 0) {
        this.push(null)
        return
      }
      sent += size
      this.push(Buffer.alloc(size))
    }
  })
}

function neverEndingStream(): Readable {
  return new Readable({
    read() {
      /* 永不产出数据，等待取消 */
    }
  })
}

const delay = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

const tempDirs: string[] = []

function makeCache(): MailCacheService {
  const baseDir = mkdtempSync(join(tmpdir(), 'mail-content-'))
  tempDirs.push(baseDir)
  return new MailCacheService(baseDir)
}

function makeHarness(
  db: SqliteDb,
  options: { parts: Map<string, PartProvider>; limits?: typeof MAIL_LIMITS }
): { service: MailContentService; repo: FakeRepository; state: FakeSessionState; cache: MailCacheService } {
  const cache = makeCache()
  const repo = new FakeRepository(db)
  const { factory, state } = makeSessionFactory(options.parts)
  const service = new MailContentService({
    repository: repo,
    sessionFactory: factory,
    accounts: {
      connection: () => ({ host: 'imap.example.com', port: 993, email: 'me@example.com', password: 'synthetic-password' })
    },
    cache,
    limits: options.limits ?? MAIL_LIMITS
  })
  return { service, repo, state, cache }
}

let db: SqliteDb

beforeEach(async () => {
  db = await makeTestDb()
})

afterEach(() => {
  db.close()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

describe('MailContentService 正文按需加载', () => {
  it('首取走会话并落缓存，二次调用读缓存不再开会话', async () => {
    const html = '<html><body><p>会议在 <a href="https://example.com/meet">这里</a>。</p><script>alert(1)</script></body></html>'
    const { service, repo, state, cache } = makeHarness(db, {
      parts: new Map([['2', () => Readable.from([Buffer.from(html, 'utf8')])]])
    })
    repo.records.set('msg-1', {
      message: makeSummary(),
      uid: 101,
      uidValidity: '9001',
      structure: makeEnvelope(),
      bodyPath: null
    })
    repo.attachments.set('att-1', {
      id: 'att-1', messageId: 'msg-1', name: '说明.pdf', mime: 'application/pdf',
      size: 2048, downloaded: false, analyzable: true, part: '3', cachePath: null
    })

    const first = await service.detail('msg-1', new AbortController().signal)
    expect(state.created).toBe(1)
    expect(state.partCalls).toEqual([{ uid: 101, part: '2' }]) // 优先取 HTML part
    expect(state.lastConnection?.host).toBe('imap.example.com')
    expect(state.closed).toBe(1) // 会话用完必须 close
    expect(repo.bodyCacheCalls).toEqual([{ id: 'msg-1', path: cache.bodyPath('acc-1', 'msg-1') }])
    expect(first.message.bodyState).toBe('cached')
    expect(first.safeHtml).toContain('会议在')
    expect(first.safeHtml).toContain('这里')
    expect(first.safeHtml).not.toContain('alert')
    expect(first.safeHtml).not.toContain('href=')
    expect(first.links).toEqual([{ label: '这里', url: 'https://example.com/meet' }])
    expect(first.text).toContain('会议在')
    expect(first.text).not.toContain('alert')
    expect(first.attachments).toEqual([
      { id: 'att-1', messageId: 'msg-1', name: '说明.pdf', mime: 'application/pdf', size: 2048, downloaded: false, analyzable: true }
    ])

    // 缓存文件保存原始 HTML（带 JSON 头），链接可由原始内容恢复
    const bodyPath = cache.bodyPath('acc-1', 'msg-1')
    const raw = await readFile(bodyPath, 'utf8')
    const header = JSON.parse(raw.slice(0, raw.indexOf('\n'))) as { v: number; mime: string }
    expect(header).toEqual({ v: 1, mime: 'text/html' })
    expect(raw).toContain('https://example.com/meet')

    const second = await service.detail('msg-1', new AbortController().signal)
    expect(state.created).toBe(1) // 未再建立会话
    expect(state.partCalls).toHaveLength(1)
    expect(second.safeHtml).toBe(first.safeHtml)
    expect(second.links).toEqual(first.links)
    expect(second.message.bodyState).toBe('cached')
  })

  it('纯文本邮件退回 text part 且 safeHtml 转义换行', async () => {
    const { service, repo, state, cache } = makeHarness(db, {
      parts: new Map([['1', () => Readable.from([Buffer.from('第一行\r\n第二行 <b>加粗</b>', 'utf8')])]])
    })
    repo.records.set('msg-1', {
      message: makeSummary(),
      uid: 101,
      uidValidity: '9001',
      structure: makeEnvelope({ htmlParts: [] }),
      bodyPath: null
    })

    const detail = await service.detail('msg-1', new AbortController().signal)
    expect(state.partCalls).toEqual([{ uid: 101, part: '1' }])
    expect(detail.text).toBe('第一行\n第二行 <b>加粗</b>')
    expect(detail.safeHtml).toContain('第一行<br>')
    expect(detail.safeHtml).toContain('&lt;b&gt;加粗&lt;/b&gt;')
    expect(detail.links).toEqual([])

    const raw = await readFile(cache.bodyPath('acc-1', 'msg-1'), 'utf8')
    const header = JSON.parse(raw.slice(0, raw.indexOf('\n'))) as { mime: string }
    expect(header.mime).toBe('text/plain')
  })

  it('正文超过 5MiB 抛 LIMIT 并标记 body_state=error', async () => {
    const { service, repo, state, cache } = makeHarness(db, {
      parts: new Map([['2', () => oversizedStream(MAIL_LIMITS.bodyBytes + 1)]])
    })
    repo.records.set('msg-1', {
      message: makeSummary(),
      uid: 101,
      uidValidity: '9001',
      structure: makeEnvelope(),
      bodyPath: null
    })

    const pending = service.detail('msg-1', new AbortController().signal)
    await expect(pending).rejects.toBeInstanceOf(MailCodedError)
    await expect(pending).rejects.toThrow(/超过大小限制/)
    await expect(pending).rejects.toMatchObject({ code: 'LIMIT' })
    expect(repo.bodyStates).toEqual([{ id: 'msg-1', state: 'error' }])
    expect(repo.records.get('msg-1')?.message.bodyState).toBe('error')
    expect(repo.bodyCacheCalls).toHaveLength(0) // 未落缓存
    expect(state.closed).toBe(1)
    expect(await cache.readIfExists(cache.bodyPath('acc-1', 'msg-1'))).toBeNull()
  })

  it('remote_available=0 且无缓存抛 NOT_FOUND', async () => {
    const { service, repo, state } = makeHarness(db, { parts: new Map() })
    repo.records.set('msg-1', {
      message: makeSummary({ remoteAvailable: false }),
      uid: 101,
      uidValidity: '9001',
      structure: makeEnvelope(),
      bodyPath: null
    })

    await expect(service.detail('msg-1', new AbortController().signal)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(state.created).toBe(0)
  })

  it('邮件记录不存在抛 NOT_FOUND', async () => {
    const { service } = makeHarness(db, { parts: new Map() })
    await expect(service.detail('nope', new AbortController().signal)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('远端失效但本地缓存正文仍可离线阅读', async () => {
    const { service, repo, state, cache } = makeHarness(db, { parts: new Map() })
    const bodyPath = cache.bodyPath('acc-1', 'msg-1')
    const cachedFile = Buffer.from(JSON.stringify({ v: 1, mime: 'text/html' }) + '\n<p>离线正文</p>', 'utf8')
    await cache.writeAtomic(bodyPath, cachedFile, MAIL_LIMITS.bodyBytes)
    repo.records.set('msg-1', {
      message: makeSummary({ remoteAvailable: false, bodyState: 'cached' }),
      uid: null,
      uidValidity: null,
      structure: makeEnvelope(),
      bodyPath
    })

    const detail = await service.detail('msg-1', new AbortController().signal)
    expect(state.created).toBe(0) // 缓存命中零网络
    expect(detail.safeHtml).toContain('离线正文')
    expect(detail.message.bodyState).toBe('cached')
  })

  it('邮件结构无正文 part 抛 PARSE 且不建会话', async () => {
    const { service, repo, state } = makeHarness(db, { parts: new Map() })
    repo.records.set('msg-1', {
      message: makeSummary(),
      uid: 101,
      uidValidity: '9001',
      structure: makeEnvelope({ textParts: [], htmlParts: [] }),
      bodyPath: null
    })

    await expect(service.detail('msg-1', new AbortController().signal)).rejects.toMatchObject({ code: 'PARSE' })
    expect(state.created).toBe(0)
    expect(repo.bodyStates).toEqual([]) // 仅 LIMIT 标记 error
  })

  it('按 part charset 解码中文（gb2312）', async () => {
    const { service, repo } = makeHarness(db, {
      parts: new Map([['1', () => Readable.from([Buffer.from([0xd6, 0xd0, 0xce, 0xc4])])]])
    })
    repo.records.set('msg-1', {
      message: makeSummary(),
      uid: 101,
      uidValidity: '9001',
      structure: makeEnvelope({
        htmlParts: [],
        textParts: [{ part: '1', name: '', mime: 'text/plain', size: 4, charset: 'gb2312' }]
      }),
      bodyPath: null
    })

    const detail = await service.detail('msg-1', new AbortController().signal)
    expect(detail.text).toBe('中文')
    expect(detail.safeHtml).toContain('中文')
  })

  it('abort 时抛 CANCELLED 并关闭会话', async () => {
    const { service, repo, state } = makeHarness(db, {
      parts: new Map([['2', () => neverEndingStream()]])
    })
    repo.records.set('msg-1', {
      message: makeSummary(),
      uid: 101,
      uidValidity: '9001',
      structure: makeEnvelope(),
      bodyPath: null
    })

    const controller = new AbortController()
    const pending = service.detail('msg-1', controller.signal)
    setTimeout(() => controller.abort(), 15)
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(state.closed).toBe(1)

    // 进入前已中止：不建立会话
    const preAborted = new AbortController()
    preAborted.abort()
    await expect(service.detail('msg-1', preAborted.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(state.created).toBe(1)
  })

  it('同一邮件 detail 并发请求去重，只建立一次会话', async () => {
    const { service, repo, state } = makeHarness(db, {
      parts: new Map([
        ['2', async () => {
          await delay(30)
          return Readable.from([Buffer.from('<p>并发正文</p>', 'utf8')])
        }]
      ])
    })
    repo.records.set('msg-1', {
      message: makeSummary(),
      uid: 101,
      uidValidity: '9001',
      structure: makeEnvelope(),
      bodyPath: null
    })

    const [a, b] = await Promise.all([
      service.detail('msg-1', new AbortController().signal),
      service.detail('msg-1', new AbortController().signal)
    ])
    expect(state.created).toBe(1)
    expect(state.partCalls).toHaveLength(1)
    expect(a.safeHtml).toBe(b.safeHtml)
  })
})

describe('MailContentService 附件下载', () => {
  it('附件下载落缓存并写回 cache_path，二次下载命中缓存', async () => {
    const { service, repo, state, cache } = makeHarness(db, {
      parts: new Map([
        ['2', () => Readable.from([Buffer.from('<p>正文</p>', 'utf8')])],
        ['3', () => Readable.from([Buffer.from('PDF-bytes', 'utf8')])]
      ])
    })
    repo.records.set('msg-1', {
      message: makeSummary(),
      uid: 101,
      uidValidity: '9001',
      structure: makeEnvelope(),
      bodyPath: null
    })
    repo.attachments.set('att-1', {
      id: 'att-1', messageId: 'msg-1', name: '说明.pdf', mime: 'application/pdf',
      size: 10, downloaded: false, analyzable: true, part: '3', cachePath: null
    })

    const first = await service.download('att-1', new AbortController().signal)
    expect(first.downloaded).toBe(true)
    expect(first.name).toBe('说明.pdf')
    const target = cache.attachmentPath('acc-1', 'msg-1', '3')
    expect(await readFile(target, 'utf8')).toBe('PDF-bytes')
    expect(repo.attachmentCacheCalls).toEqual([{ id: 'att-1', path: target }])
    expect(state.partCalls).toEqual([{ uid: 101, part: '3' }])
    expect(state.closed).toBe(1)
    expect(repo.attachments.get('att-1')?.cachePath).toBe(target)

    // detail 的 downloaded 标志按缓存文件实际存在情况校正（detail 取正文会另建一次会话）
    const detail = await service.detail('msg-1', new AbortController().signal)
    expect(detail.attachments[0]?.downloaded).toBe(true)
    expect(state.partCalls.filter((call) => call.part === '3')).toHaveLength(1)

    const second = await service.download('att-1', new AbortController().signal)
    expect(second.downloaded).toBe(true)
    expect(state.created).toBe(2) // 仅 detail 取正文新建过一次会话；二次下载命中缓存未再建
    expect(state.partCalls.filter((call) => call.part === '3')).toHaveLength(1)
  })

  it('附件超过 20MiB 抛 LIMIT 且不写缓存', async () => {
    const { service, repo, state, cache } = makeHarness(db, {
      parts: new Map([['3', () => oversizedStream(MAIL_LIMITS.attachmentBytes + 1)]])
    })
    repo.records.set('msg-1', {
      message: makeSummary(),
      uid: 101,
      uidValidity: '9001',
      structure: makeEnvelope(),
      bodyPath: null
    })
    repo.attachments.set('att-1', {
      id: 'att-1', messageId: 'msg-1', name: 'huge.bin', mime: 'application/octet-stream',
      size: MAIL_LIMITS.attachmentBytes + 1, downloaded: false, analyzable: false, part: '3', cachePath: null
    })

    const pending = service.download('att-1', new AbortController().signal)
    await expect(pending).rejects.toBeInstanceOf(MailCodedError)
    await expect(pending).rejects.toThrow(/超过大小限制/)
    await expect(pending).rejects.toMatchObject({ code: 'LIMIT' })
    expect(repo.attachmentCacheCalls).toHaveLength(0)
    expect(state.closed).toBe(1)
    expect(await cache.readIfExists(cache.attachmentPath('acc-1', 'msg-1', '3'))).toBeNull()
  })

  it('附件不存在或远端失效抛 NOT_FOUND', async () => {
    const { service, repo } = makeHarness(db, { parts: new Map() })
    repo.records.set('msg-1', {
      message: makeSummary({ remoteAvailable: false }),
      uid: 101,
      uidValidity: '9001',
      structure: makeEnvelope(),
      bodyPath: null
    })
    repo.attachments.set('att-orphan', {
      id: 'att-orphan', messageId: 'msg-9', name: 'x.pdf', mime: 'application/pdf',
      size: 1, downloaded: false, analyzable: true, part: '9', cachePath: null
    })
    repo.attachments.set('att-off', {
      id: 'att-off', messageId: 'msg-1', name: 'y.pdf', mime: 'application/pdf',
      size: 1, downloaded: false, analyzable: true, part: '3', cachePath: null
    })

    await expect(service.download('missing', new AbortController().signal)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(service.download('att-orphan', new AbortController().signal)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(service.download('att-off', new AbortController().signal)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('attachmentPath 返回已缓存或预测路径', () => {
    const { service, repo, cache } = makeHarness(db, { parts: new Map() })
    repo.records.set('msg-1', {
      message: makeSummary(),
      uid: 101,
      uidValidity: '9001',
      structure: makeEnvelope(),
      bodyPath: null
    })
    repo.attachments.set('att-1', {
      id: 'att-1', messageId: 'msg-1', name: 'a.pdf', mime: 'application/pdf',
      size: 1, downloaded: false, analyzable: true, part: '3', cachePath: null
    })
    repo.attachments.set('att-2', {
      id: 'att-2', messageId: 'msg-1', name: 'b.pdf', mime: 'application/pdf',
      size: 1, downloaded: true, analyzable: true, part: '4', cachePath: 'Z:\\managed\\att-2.bin'
    })
    expect(service.attachmentPath('att-1')).toBe(cache.attachmentPath('acc-1', 'msg-1', '3'))
    expect(service.attachmentPath('att-2')).toBe('Z:\\managed\\att-2.bin')
    expect(service.attachmentPath('missing')).toBe('')
  })

  it('结构派生附件 ID（messageId#part）也可直接下载', async () => {
    const { service, repo, state, cache } = makeHarness(db, {
      parts: new Map([['3', () => Readable.from([Buffer.from('derived', 'utf8')])]])
    })
    repo.records.set('msg-1', {
      message: makeSummary(),
      uid: 101,
      uidValidity: '9001',
      structure: makeEnvelope(),
      bodyPath: null
    })
    // 仓储没有登记附件，listAttachments 缺省时回退到结构派生
    ;(repo as unknown as { listAttachments?: FakeRepository['listAttachments'] }).listAttachments = undefined

    const info = await service.download('msg-1#3', new AbortController().signal)
    expect(info.downloaded).toBe(true)
    expect(info.name).toBe('说明.pdf')
    expect(await readFile(cache.attachmentPath('acc-1', 'msg-1', '3'), 'utf8')).toBe('derived')
    expect(state.partCalls).toEqual([{ uid: 101, part: '3' }])
  })

  it('removeCache 清理 DB 记录与账号缓存目录', async () => {
    const { service, repo, cache } = makeHarness(db, { parts: new Map() })
    const bodyPath = cache.bodyPath('acc-1', 'msg-1')
    await cache.writeAtomic(bodyPath, Buffer.from('正文', 'utf8'), MAIL_LIMITS.bodyBytes)

    await service.removeCache('acc-1')
    expect(repo.removedAccounts).toEqual(['acc-1'])
    expect(await cache.readIfExists(bodyPath)).toBeNull()
    expect(existsSync(bodyPath)).toBe(false)

    // 重复清理幂等
    await expect(service.removeCache('acc-1')).resolves.toBeUndefined()
  })
})

describe('缓存服务', () => {
  it('路径归一化防穿越且结果确定', () => {
    const cache = makeCache()
    const body1 = cache.bodyPath('acc-1', 'msg-1')
    const base = baseDirOf(cache)
    expect(body1.startsWith(base + sep)).toBe(true)
    expect(cache.bodyPath('acc-1', 'msg-1')).toBe(body1)

    const traversal = cache.bodyPath('acc-1', '../../evil')
    expect(traversal.startsWith(base + sep)).toBe(true)
    expect(traversal).not.toBe(body1)

    const att = cache.attachmentPath('acc-1', 'msg-1', '../../../evil.exe')
    expect(att.startsWith(base + sep)).toBe(true)
    expect(att.endsWith('.bin')).toBe(true)
    expect(cache.attachmentPath('acc-1', 'msg-1', '3')).not.toBe(att)
  })

  it('writeAtomic 超限拒绝且不留任何文件', async () => {
    const cache = makeCache()
    const target = cache.bodyPath('acc-1', 'msg-1')
    await expect(cache.writeAtomic(target, Buffer.alloc(11), 10)).rejects.toMatchObject({ code: 'LIMIT' })
    expect(existsSync(target)).toBe(false)
    expect(readdirSync(dirname(target))).toHaveLength(0)

    await expect(
      cache.writeAtomic(target, Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), 10)
    ).rejects.toMatchObject({ code: 'LIMIT' })
    expect(readdirSync(dirname(target))).toHaveLength(0)
  })

  it('writeAtomic 流写入先临时后 rename 原子落盘', async () => {
    const cache = makeCache()
    const target = cache.bodyPath('acc-1', 'msg-1')
    const data = Buffer.from('原子写入内容', 'utf8')
    await cache.writeAtomic(target, Readable.from([data.subarray(0, 3), data.subarray(3)]), 1024)
    expect(readFileSync(target).equals(data)).toBe(true)
    expect(readdirSync(dirname(target))).toEqual([basename(target)])
  })

  it('readIfExists 缺失返回 null', async () => {
    const cache = makeCache()
    expect(await cache.readIfExists(cache.bodyPath('acc-1', 'nope'))).toBeNull()
  })

  it('readLimited 按实际字节拒绝并支持取消', async () => {
    const stream = Readable.from([Buffer.alloc(3), Buffer.alloc(3)])
    await expect(readLimited(stream, 5, new AbortController().signal)).rejects.toThrow(/超过大小限制/)

    const controller = new AbortController()
    const pending = readLimited(neverEndingStream(), 1024, controller.signal)
    setTimeout(() => controller.abort(), 10)
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
  })
})

/** 从缓存服务生成的路径反推 base 目录（bodyPath 位于 base/<账号哈希>/<邮件哈希>/ 之下）。 */
function baseDirOf(cache: MailCacheService): string {
  const body = cache.bodyPath('acc-x', 'msg-x')
  return resolve(dirname(dirname(dirname(body))))
}
