import { ImapFlow } from 'imapflow'
import type { Readable } from 'node:stream'
import type { EnvelopeRow, MailSession, PartInfo } from './adapter'
import { MailError, classifyError, isMailError } from './errors'

/** 构造 ImapFlow 客户端的纯函数配置:强制 TLS、校验证书、30 秒超时、关日志与自动 IDLE */
export function buildImapOptions(c: { host: string; port: number; email: string; password: string }) {
  return {
    host: c.host,
    port: c.port,
    secure: true as const,
    auth: { user: c.email, pass: c.password },
    logger: false as const,
    logRaw: false as const,
    tls: { rejectUnauthorized: true },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 30_000,
    disableAutoIdle: true,
    clientInfo: { name: 'ai-desk-companion', version: '0.1.0' }
  }
}

export type ImapClientOptions = ReturnType<typeof buildImapOptions>

/** 会话内部使用最小结构化客户端接口,便于测试注入替身 */
export interface ImapClientLike {
  connect(): Promise<boolean>
  mailboxOpen(
    path: string,
    options?: { readOnly?: boolean }
  ): Promise<{ uidValidity: bigint | number | string; uidNext: number }>
  search(
    query: Record<string, unknown>,
    options?: { uid?: boolean }
  ): Promise<number[] | boolean | null | undefined>
  fetch(range: string, query: Record<string, unknown>, options?: { uid?: boolean }): AsyncIterable<RawFetchMessage>
  download(range: string, part: string, options?: { uid?: boolean }): Promise<{ content: Readable } | boolean | null>
  logout(): Promise<void>
  close(): void
}

export interface ImapAdapterDeps {
  createClient?: (options: ImapClientOptions) => ImapClientLike
}

/** fetch 返回的最小字段集(仅请求 uid/envelope/flags/internalDate/size/bodyStructure) */
export interface RawFetchMessage {
  uid: number
  flags?: Set<string>
  size?: number
  internalDate?: Date | string
  envelope?: {
    subject?: string
    messageId?: string
    date?: Date | string
    from?: Array<{ name?: string; address?: string }>
    to?: Array<{ name?: string; address?: string }>
  }
  bodyStructure?: RawStructureNode
}

export interface RawStructureNode {
  part?: string
  type: string
  parameters?: Record<string, string>
  disposition?: string
  dispositionParameters?: Record<string, string>
  size?: number
  childNodes?: RawStructureNode[]
}

const EPOCH_ISO = '1970-01-01T00:00:00.000Z'

function cancelled(): MailError {
  return new MailError('CANCELLED', '操作已取消')
}

function toIsoDate(value: Date | string | undefined): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value === 'string' && value !== '') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return EPOCH_ISO
}

function formatAddresses(
  addresses: Array<{ name?: string; address?: string }> | undefined
): string {
  if (!addresses || addresses.length === 0) return ''
  return addresses
    .map((addr) => {
      const name = (addr.name ?? '').trim()
      const address = (addr.address ?? '').trim()
      if (name !== '' && address !== '') return `${name} <${address}>`
      return address !== '' ? address : name
    })
    .filter((text) => text !== '')
    .join(', ')
}

function toPartInfo(node: RawStructureNode): PartInfo {
  return {
    part: String(node.part ?? ''),
    name: node.dispositionParameters?.filename ?? node.parameters?.name ?? '',
    mime: (node.type ?? '').toLowerCase(),
    size: typeof node.size === 'number' ? node.size : null,
    charset: node.parameters?.charset
  }
}

/** 遍历 BODYSTRUCTURE 树,划分正文与附件;不在 fetch 内部发起其他 IMAP 命令 */
function collectParts(
  node: RawStructureNode | undefined,
  out: { text: PartInfo[]; html: PartInfo[]; attachments: PartInfo[] }
): void {
  if (!node) return
  const type = (node.type ?? '').toLowerCase()
  const children = node.childNodes
  if (children && children.length > 0) {
    for (const child of children) collectParts(child, out)
    return
  }
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? ''
  const disposition = (node.disposition ?? '').toLowerCase()
  const info = toPartInfo(node)
  if (disposition === 'attachment' || filename !== '') {
    out.attachments.push(info)
  } else if (type === 'text/plain') {
    out.text.push(info)
  } else if (type === 'text/html') {
    out.html.push(info)
  }
}

function mapEnvelope(msg: RawFetchMessage): EnvelopeRow {
  const out = { text: [] as PartInfo[], html: [] as PartInfo[], attachments: [] as PartInfo[] }
  collectParts(msg.bodyStructure, out)
  return {
    uid: msg.uid,
    messageId: msg.envelope?.messageId ?? null,
    subject: msg.envelope?.subject ?? '',
    from: formatAddresses(msg.envelope?.from),
    to: formatAddresses(msg.envelope?.to),
    receivedAt: toIsoDate(msg.internalDate ?? msg.envelope?.date),
    size: typeof msg.size === 'number' ? msg.size : 0,
    seen: msg.flags?.has('\\Seen') === true,
    textParts: out.text,
    htmlParts: out.html,
    attachments: out.attachments
  }
}

function toUidList(result: number[] | boolean | null | undefined): number[] {
  return Array.isArray(result) ? result.filter((uid): uid is number => typeof uid === 'number') : []
}

/**
 * 创建只读 ImapFlow 会话:
 * open 只读选中 INBOX;search 全部使用 UID SEARCH;envelopes 只取元数据(零正文下载);
 * cancel/close 真正断开 socket;所有操作支持 AbortSignal,中止时抛 CANCELLED。
 */
export function createImapSession(
  connection: { host: string; port: number; email: string; password: string },
  signal: AbortSignal,
  deps?: ImapAdapterDeps
): MailSession {
  const options = buildImapOptions(connection)
  const client: ImapClientLike = deps?.createClient
    ? deps.createClient(options)
    : (new ImapFlow(options as unknown as ConstructorParameters<typeof ImapFlow>[0]) as unknown as ImapClientLike)

  let connected = false
  let closed = false

  const ensureLive = (): void => {
    if (signal.aborted) throw cancelled()
    if (closed) throw new MailError('NETWORK', '连接已关闭')
  }

  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    ensureLive()
    try {
      return await work()
    } catch (err) {
      if (signal.aborted) throw cancelled()
      if (isMailError(err)) throw err
      throw classifyError(err)
    }
  }

  const shutdown = (): void => {
    if (closed) return
    closed = true
    try {
      client.close()
    } catch {
      // 忽略关闭异常:连接可能已中断
    }
  }

  const onAbort = (): void => shutdown()
  signal.addEventListener('abort', onAbort, { once: true })

  const session: MailSession = {
    async open() {
      return guard(async () => {
        if (!connected) {
          await client.connect()
          connected = true
        }
        const mailbox = await client.mailboxOpen('INBOX', { readOnly: true })
        return { uidValidity: String(mailbox.uidValidity), uidNext: mailbox.uidNext }
      })
    },

    async searchDays(since: string, before: string) {
      return guard(async () => {
        const result = await client.search({ since, before }, { uid: true })
        return toUidList(result)
      })
    },

    async searchUids(after: number, through: number) {
      return guard(async () => {
        if (after >= through) return []
        const result = await client.search({ uid: `${after + 1}:${through}` }, { uid: true })
        return toUidList(result)
      })
    },

    async envelopes(uids: number[]) {
      return guard(async () => {
        if (uids.length === 0) return []
        const range = uids.join(',')
        const query = { uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true }
        // 先完整收完这一批元数据,再映射;迭代过程中不发其他 IMAP 命令
        const messages: RawFetchMessage[] = []
        for await (const msg of client.fetch(range, query, { uid: true })) {
          messages.push(msg)
        }
        return messages.map(mapEnvelope)
      })
    },

    async part(uid: number, part: string) {
      return guard(async () => {
        const downloaded = await client.download(String(uid), part, { uid: true })
        if (!downloaded || typeof downloaded === 'boolean') {
          throw new MailError('NOT_FOUND', '邮件部件不存在')
        }
        return downloaded.content
      })
    },

    async close() {
      signal.removeEventListener('abort', onAbort)
      if (closed) return
      try {
        if (connected) {
          await client.logout()
        } else {
          shutdown()
        }
      } catch {
        shutdown()
      } finally {
        closed = true
      }
    },

    cancel() {
      shutdown()
    }
  }

  return session
}
