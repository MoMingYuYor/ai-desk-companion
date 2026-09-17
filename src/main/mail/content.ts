import type {
  MAIL_LIMITS,
  MailAttachmentInfo,
  MailDetail,
  MailSummary
} from '../../shared/mail'
import type { SessionFactory } from './adapter'
import type { MailRepositoryPort } from './ports'
import { MailCodedError, cancelledError, decodeBytes, readLimited, type MailCacheService } from './cache'
import { extractLinks, htmlToText, plainTextToHtml, sanitizeMailHtml } from './sanitize'

/**
 * B 区对仓储的扩展能力（可选方法）：
 * ports.ts 契约由 P0 固化不可修改，body_state 标记与附件枚举通过仓储可选方法提供；
 * 注入的仓储若实现同名方法即自动生效，未实现时按下方回退逻辑运行。
 */
export type MailContentRepository = MailRepositoryPort & {
  /** 正文获取失败（超限等）时把 body_state 标记为 error。 */
  setBodyState?(id: string, state: MailSummary['bodyState']): void
  /** 按邮件枚举附件（含仓储生成的附件 ID），与 repository.attachment(id) 的 ID 体系一致。 */
  listAttachments?(messageId: string): MailAttachmentInfo[]
}

export interface MailContentDeps {
  repository: MailContentRepository
  sessionFactory: SessionFactory
  accounts: { connection(id: string): { host: string; port: number; email: string; password: string } }
  cache: MailCacheService
  limits: typeof MAIL_LIMITS
}

type MailRecord = NonNullable<ReturnType<MailRepositoryPort['record']>>

/** 正文缓存文件格式：首行 JSON 头（版本 + part 的 MIME），随后是原始解码内容。 */
interface BodyCacheFile {
  mime: string
  content: string
}

const BODY_CACHE_VERSION = 1

function encodeBodyCache(mime: string, content: string): Buffer {
  const header = Buffer.from(JSON.stringify({ v: BODY_CACHE_VERSION, mime }) + '\n', 'utf8')
  return Buffer.concat([header, Buffer.from(content, 'utf8')])
}

function decodeBodyCache(bytes: Buffer): BodyCacheFile {
  const newline = bytes.indexOf(0x0a)
  if (newline > 0) {
    try {
      const header = JSON.parse(bytes.subarray(0, newline).toString('utf8')) as {
        v?: number
        mime?: string
      }
      if (header && header.v === BODY_CACHE_VERSION && typeof header.mime === 'string') {
        return { mime: header.mime, content: bytes.subarray(newline + 1).toString('utf8') }
      }
    } catch {
      // 头部损坏时按纯文本处理（展示安全，内容不丢失）
    }
  }
  return { mime: 'text/plain', content: bytes.toString('utf8') }
}

function normalizePlainText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function isAnalyzableMime(mime: string): boolean {
  return mime === 'application/pdf' || mime.startsWith('text/')
}

/**
 * 正文/附件按需获取与读取：
 * - 缓存命中零网络；缺失且 remote_available=1 才建立会话取正文 part；
 * - 正文下载上限 limits.bodyBytes，附件上限 limits.attachmentBytes，超限抛 LIMIT；
 * - 会话用完必须 close；同一邮件的 detail 并发请求共享同一个在途 Promise。
 */
export class MailContentService {
  private readonly deps: MailContentDeps
  private readonly inflightDetails = new Map<string, Promise<MailDetail>>()

  constructor(deps: MailContentDeps) {
    this.deps = deps
  }

  detail(id: string, signal: AbortSignal): Promise<MailDetail> {
    const existing = this.inflightDetails.get(id)
    if (existing) return existing
    const promise = this.detailOnce(id, signal).finally(() => {
      this.inflightDetails.delete(id)
    })
    this.inflightDetails.set(id, promise)
    return promise
  }

  async download(id: string, signal: AbortSignal): Promise<MailAttachmentInfo> {
    if (signal.aborted) throw cancelledError()
    const att = this.resolveAttachment(id)
    if (!att) throw new MailCodedError('NOT_FOUND', '附件不存在或已被删除')

    if (att.cachePath) {
      const existing = await this.deps.cache.readIfExists(att.cachePath)
      if (existing) return this.toAttachmentInfo(att, true)
    }

    const rec = this.deps.repository.record(att.messageId)
    if (!rec) throw new MailCodedError('NOT_FOUND', '附件所属邮件不存在')
    if (!rec.message.remoteAvailable) {
      throw new MailCodedError('NOT_FOUND', '远程邮件已失效，无法下载附件')
    }
    if (rec.uid == null) throw new MailCodedError('NOT_FOUND', '邮件缺少远端标识，无法下载附件')

    const target = att.cachePath ?? this.deps.cache.attachmentPath(rec.message.accountId, att.messageId, att.part)
    const session = this.deps.sessionFactory(
      this.deps.accounts.connection(rec.message.accountId),
      signal
    )
    try {
      await session.open()
      const stream = await session.part(rec.uid, att.part)
      await this.deps.cache.writeAtomic(target, stream, this.deps.limits.attachmentBytes)
    } finally {
      try {
        await session.close()
      } catch {
        // close 失败不掩盖主流程
      }
    }
    this.deps.repository.setAttachmentCache(id, target)
    return this.toAttachmentInfo({ ...att, cachePath: target }, true)
  }

  attachmentPath(id: string): string {
    const att = this.deps.repository.attachment(id)
    if (!att) return ''
    if (att.cachePath) return att.cachePath
    const rec = this.deps.repository.record(att.messageId)
    if (!rec) return ''
    return this.deps.cache.attachmentPath(rec.message.accountId, att.messageId, att.part)
  }

  async removeCache(accountId: string): Promise<void> {
    // 先清 DB 指针（悬空指针读取时按缺失处理），再删文件；文件失败归 STORAGE 供上层提示重试
    try {
      this.deps.repository.removeAccountCache(accountId)
    } catch (err) {
      throw new MailCodedError('STORAGE', `清理邮件缓存记录失败：${String(err)}`)
    }
    await this.deps.cache.removeAccount(accountId)
  }

  private async detailOnce(id: string, signal: AbortSignal): Promise<MailDetail> {
    if (signal.aborted) throw cancelledError()
    const rec = this.deps.repository.record(id)
    if (!rec) throw new MailCodedError('NOT_FOUND', '邮件不存在或已被删除')

    let body: BodyCacheFile
    const cached = rec.bodyPath ? await this.deps.cache.readIfExists(rec.bodyPath) : null
    if (cached) {
      body = decodeBodyCache(cached)
    } else {
      if (!rec.message.remoteAvailable) {
        throw new MailCodedError('NOT_FOUND', '远程邮件已失效且本地无缓存正文')
      }
      if (rec.uid == null) {
        throw new MailCodedError('NOT_FOUND', '邮件缺少远端标识，无法取回正文')
      }
      try {
        body = await this.fetchBody(rec, signal)
      } catch (err) {
        if (err instanceof MailCodedError && err.code === 'LIMIT') {
          try {
            this.deps.repository.setBodyState?.(id, 'error')
          } catch {
            // 标记失败不掩盖原始超限错误
          }
        }
        throw err
      }
    }
    const isHtml = body.mime === 'text/html'
    // 链接必须从未清理的原始内容提取；safeHtml 在展示前清理；附件标志异步校正
    const attachments = await this.resolveAttachments(rec)
    return {
      message: rec.message,
      text: isHtml ? htmlToText(body.content) : body.content,
      safeHtml: isHtml ? sanitizeMailHtml(body.content) : plainTextToHtml(body.content),
      links: isHtml ? extractLinks(body.content) : [],
      attachments
    }
  }

  /** 建立会话取正文 part：优先 HTML part（可同时得到 text 与 safeHtml），否则退回纯文本 part。 */
  private async fetchBody(rec: MailRecord, signal: AbortSignal): Promise<BodyCacheFile> {
    const info = rec.structure.htmlParts[0] ?? rec.structure.textParts[0]
    if (!info) {
      throw new MailCodedError('PARSE', '邮件结构中没有可读取的正文部分')
    }
    const session = this.deps.sessionFactory(
      this.deps.accounts.connection(rec.message.accountId),
      signal
    )
    try {
      await session.open()
      const stream = await session.part(rec.uid as number, info.part)
      const raw = await readLimited(stream, this.deps.limits.bodyBytes, signal)
      const decoded = decodeBytes(raw, info.charset)
      const mime = info.mime === 'text/html' ? 'text/html' : 'text/plain'
      const content = mime === 'text/html' ? decoded : normalizePlainText(decoded)
      const target = this.deps.cache.bodyPath(rec.message.accountId, rec.message.id)
      await this.deps.cache.writeAtomic(target, encodeBodyCache(mime, content), this.deps.limits.bodyBytes)
      this.deps.repository.setBodyCache(rec.message.id, target)
      return { mime, content }
    } finally {
      try {
        await session.close()
      } catch {
        // close 失败不掩盖主流程
      }
    }
  }

  private async resolveAttachments(rec: MailRecord): Promise<MailAttachmentInfo[]> {
    const listed = this.deps.repository.listAttachments?.(rec.message.id)
    const base = listed ?? this.fallbackAttachments(rec)
    return Promise.all(base.map(async (item) => {
      const meta = this.deps.repository.attachment(item.id)
      const part = meta?.part ?? this.syntheticPartOf(rec.message.id, item.id)
      const path = meta?.cachePath
        ?? (part ? this.deps.cache.attachmentPath(rec.message.accountId, rec.message.id, part) : null)
      const downloaded = path ? await this.deps.cache.exists(path) : item.downloaded
      return { ...item, downloaded }
    }))
  }

  /** 仓储未提供 listAttachments 时，从结构信息派生附件列表（ID 采用 messageId#part 约定）。 */
  private fallbackAttachments(rec: MailRecord): MailAttachmentInfo[] {
    return rec.structure.attachments.map((part, index) => ({
      id: `${rec.message.id}#${part.part || String(index)}`,
      messageId: rec.message.id,
      name: part.name || `附件-${part.part || index}`,
      mime: part.mime,
      size: part.size,
      downloaded: false,
      analyzable: isAnalyzableMime(part.mime)
    }))
  }

  /** repository.attachment 未命中时，尝试解析 messageId#part 形式的派生 ID。 */
  private resolveAttachment(id: string): (MailAttachmentInfo & { part: string; cachePath: string | null }) | null {
    const direct = this.deps.repository.attachment(id)
    if (direct) return direct
    const hashIndex = id.lastIndexOf('#')
    if (hashIndex <= 0) return null
    const messageId = id.slice(0, hashIndex)
    const part = id.slice(hashIndex + 1)
    if (!messageId || !part) return null
    const rec = this.deps.repository.record(messageId)
    if (!rec) return null
    const info = rec.structure.attachments.find((item) => item.part === part)
    if (!info) return null
    return {
      id,
      messageId,
      name: info.name || `附件-${part}`,
      mime: info.mime,
      size: info.size,
      downloaded: false,
      analyzable: isAnalyzableMime(info.mime),
      part,
      cachePath: null
    }
  }

  private syntheticPartOf(messageId: string, id: string): string | null {
    return id.startsWith(`${messageId}#`) ? id.slice(messageId.length + 1) : null
  }

  private toAttachmentInfo(
    att: MailAttachmentInfo & { part?: string; cachePath?: string | null },
    downloaded: boolean
  ): MailAttachmentInfo {
    return {
      id: att.id,
      messageId: att.messageId,
      name: att.name,
      mime: att.mime,
      size: att.size,
      downloaded,
      analyzable: att.analyzable
    }
  }
}
