// R 区集成:把账号、仓储、同步、内容、分析与确认服务组合成 IPC 依赖
import { copyFileSync, readFileSync, statSync } from 'node:fs'
import { shell } from 'electron'
import type { SqliteDb } from '../db/connection'
import type {
  MailAccountInfo,
  MailAccountInput,
  MailAnalysisRequest,
  MailAnalysisStatus,
  MailApi,
  MailAttachmentInfo,
  MailResult,
  MailSource,
  MailSyncNotice,
  MailListQuery,
  MailErrorCode
} from '../../shared/mail'
import { MAIL_LIMITS } from '../../shared/mail'
import type { Engine } from '../services/engine'
import { parseLocalFile } from '../services/materials'
import { MailAccountStore } from './accounts'
import type { CredentialStorage } from './credentials'
import { MailRepository } from './repository'
import { MailSyncWorker } from './sync'
import { MailScheduler, todayLocalDay } from './scheduler'
import { createImapSession } from './imapAdapter'
import { MailCacheService } from './cache'
import { MailContentService } from './content'
import {
  MailAnalysisService,
  type MailAnalysisAttachmentInput
} from './analysis'
import { MailConfirmationService } from './confirmation'
import { ensureLink, getLinkByConversation } from './analysisRepository'
import { validateAccountInput } from './presets'
import { classifyError } from './errors'

export type MailBroadcast = (channel: string, payload: unknown) => void

export interface MailServiceDeps {
  db: SqliteDb
  engine: Engine
  storage: CredentialStorage
  /** 正文/附件缓存根目录(userData/mail) */
  cacheDir: string
  broadcast: MailBroadcast
}

function ok<T>(value: T): MailResult<T> {
  return { ok: true, value }
}

function fail(code: MailErrorCode, message: string): MailResult<never> {
  return { ok: false, code, message }
}

function toResult<T>(fn: () => T): MailResult<T> {
  try {
    return ok(fn())
  } catch (err) {
    return fail(classifyError(err).code, err instanceof Error ? err.message : String(err))
  }
}

async function toResultAsync<T>(fn: () => Promise<T>): Promise<MailResult<T>> {
  try {
    return ok(await fn())
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return fail('CANCELLED', '已取消')
    return fail(classifyError(err).code, err instanceof Error ? err.message : String(err))
  }
}

/** 邮件附件是否按文本读入分析材料 */
function isTextLikeMime(mime: string): boolean {
  return mime.startsWith('text/') || mime === 'application/json'
}

export class MailService implements MailApi {
  readonly accountStore: MailAccountStore
  readonly repository: MailRepository
  readonly scheduler: MailScheduler
  readonly content: MailContentService
  readonly analysis: MailAnalysisService
  readonly confirmation: MailConfirmationService
  private readonly cache: MailCacheService
  private readonly worker: MailSyncWorker
  private syncTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: MailServiceDeps) {
    this.accountStore = new MailAccountStore(deps.db, deps.storage)
    this.repository = new MailRepository(deps.db)
    this.cache = new MailCacheService(deps.cacheDir)
    this.worker = new MailSyncWorker(this.accountStore, this.repository, createImapSession)
    this.scheduler = new MailScheduler(this.worker, this.accountStore, {
      onNotice: (n) => this.onSyncNotice(n)
    })
    this.content = new MailContentService({
      repository: this.repository,
      sessionFactory: createImapSession,
      accounts: this.accountStore,
      cache: this.cache,
      limits: MAIL_LIMITS
    })
    this.analysis = new MailAnalysisService({
      db: deps.db,
      runner: {
        runAnalysis: async (conversationId) => {
          try {
            return await deps.engine.runAnalysis(conversationId)
          } finally {
            this.broadcastAnalysisByConversation(conversationId)
          }
        },
        stop: (conversationId) => deps.engine.stop(conversationId)
      },
      materials: {
        addTextMaterial: (conversationId, name, content) => {
          const conv = { conversationId, name, type: 'text' as const, content }
          // 复用引擎材料表;不经 intakeMaterials 以避免触发自动分析
          const id = deps.engine.insertMailMaterial(conv)
          return { id }
        }
      },
      analysisBytes: MAIL_LIMITS.analysisBytes
    })
    this.confirmation = new MailConfirmationService({
      db: deps.db,
      confirmItem: (analysisId, item) => deps.engine.confirmItem(analysisId, item)
    })
  }

  // ---------- 账号 ----------

  accounts(): Promise<MailResult<MailAccountInfo[]>> {
    return Promise.resolve(toResult(() => this.accountStore.list()))
  }

  async test(input: MailAccountInput): Promise<MailResult<void>> {
    return toResultAsync(async () => {
      const v = validateAccountInput(input)
      const session = createImapSession(
        { host: v.host, port: v.port, email: v.email, password: input.credential ?? '' },
        new AbortController().signal
      )
      try {
        await session.open()
      } finally {
        await session.close().catch(() => undefined)
      }
    })
  }

  async save(input: MailAccountInput): Promise<MailResult<MailAccountInfo>> {
    return toResultAsync(async () => {
      const info = this.accountStore.saveVerified(input)
      // 保存成功后立即首次同步(后台执行,不阻塞返回)
      void this.scheduler
        .syncAccount(info.id, 'refresh', new AbortController().signal)
        .catch(() => undefined)
      return info
    })
  }

  setEnabled(id: string, enabled: boolean): Promise<MailResult<void>> {
    return Promise.resolve(toResult(() => this.accountStore.setEnabled(id, enabled)))
  }

  async remove(id: string): Promise<MailResult<void>> {
    return toResultAsync(async () => {
      this.accountStore.remove(id)
      await this.content.removeCache(id)
      this.deps.broadcast('evt:mail-changed', { accountId: id })
    })
  }

  // ---------- 同步 ----------

  async sync(id: string): Promise<MailResult<void>> {
    return toResultAsync(async () => {
      await this.scheduler.syncAccount(id, 'refresh', new AbortController().signal)
    })
  }

  async earlier(id: string): Promise<MailResult<void>> {
    return toResultAsync(async () => {
      await this.scheduler.syncAccount(id, 'earlier', new AbortController().signal)
    })
  }

  list(query: MailListQuery): Promise<MailResult<{ items: import('../../shared/mail').MailSummary[]; hasMore: boolean }>> {
    return Promise.resolve(toResult(() => this.repository.list(query)))
  }

  // ---------- 阅读 ----------

  async detail(id: string): Promise<MailResult<import('../../shared/mail').MailDetail>> {
    const result = await toResultAsync(() => this.content.detail(id, new AbortController().signal))
    if (result.ok) {
      // 阅读成功即本地已读;不写回服务器
      this.repository.markRead(id, true)
      this.deps.broadcast('evt:mail-changed', { accountId: result.value.message.accountId })
    }
    return result
  }

  markRead(id: string, read: boolean): Promise<MailResult<void>> {
    const r = toResult(() => {
      this.repository.markRead(id, read)
      const summary = this.repository.get(id)
      if (summary) this.deps.broadcast('evt:mail-changed', { accountId: summary.accountId })
    })
    return Promise.resolve(r)
  }

  download(id: string): Promise<MailResult<MailAttachmentInfo>> {
    return toResultAsync(() => this.content.download(id, new AbortController().signal))
  }

  async saveAttachment(id: string): Promise<MailResult<{ saved: boolean }>> {
    return toResultAsync(async () => {
      const att = this.repository.attachment(id)
      if (!att) throw new Error('NOT_FOUND: 附件不存在')
      let path = att.cachePath
      if (!path) {
        await this.content.download(id, new AbortController().signal)
        path = this.repository.attachment(id)?.cachePath ?? null
      }
      if (!path) throw new Error('STORAGE: 附件缓存不可用')
      const { dialog, BrowserWindow } = await import('electron')
      const win = BrowserWindow.getFocusedWindow() ?? undefined
      const r = await dialog.showSaveDialog(win!, {
        title: '保存附件',
        defaultPath: att.name
      })
      if (r.canceled || !r.filePath) return { saved: false }
      copyFileSync(path, r.filePath)
      return { saved: true }
    })
  }

  async openLink(messageId: string, url: string): Promise<MailResult<void>> {
    void messageId
    return toResultAsync(async () => {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('INVALID_CONFIG: 仅允许 HTTP/HTTPS 链接')
      }
      await shell.openExternal(parsed.toString())
    })
  }

  // ---------- 手动分析 ----------

  async analyze(input: MailAnalysisRequest): Promise<MailResult<MailAnalysisStatus>> {
    return toResultAsync(async () => {
      const summary = this.repository.get(input.messageId)
      if (!summary) throw new Error('NOT_FOUND: 邮件不存在')
      const account = this.accountStore.get(summary.accountId)
      // 程序绑定来源:分析前确保来源快照存在
      ensureLink(this.deps.db, {
        sourceKey: input.messageId,
        messageId: input.messageId,
        snapshot: JSON.stringify({
          sourceKey: input.messageId,
          messageId: null,
          accountEmail: account?.email ?? '',
          subject: summary.subject,
          from: summary.from,
          receivedAt: summary.receivedAt,
          accountRemoved: false
        })
      })
      const started = await this.analysis.start(input)
      this.deps.broadcast('evt:mail-analysis', started)

      // 准备材料:正文 + 选中附件文本(失败取消排队任务,不留悬挂等待)
      try {
        const detail = await this.content.detail(input.messageId, new AbortController().signal)
        const attachments: MailAnalysisAttachmentInput[] = []
        for (const attId of input.attachmentIds) {
          const meta = this.repository.attachment(attId)
          if (!meta) continue
          await this.content.download(attId, new AbortController().signal)
          const path = this.repository.attachment(attId)?.cachePath
          if (!path) continue
          if (meta.mime === 'application/pdf') {
            const parsed = await parseLocalFile(path)
            attachments.push({
              id: attId,
              name: meta.name,
              mime: meta.mime,
              content: parsed.content ?? parsed.parseError ?? ''
            })
          } else if (isTextLikeMime(meta.mime)) {
            const size = statSync(path).size
            if (size > MAIL_LIMITS.attachmentBytes) throw new Error(`LIMIT: 附件 ${meta.name} 超过大小限制`)
            attachments.push({
              id: attId,
              name: meta.name,
              mime: meta.mime,
              content: readFileSync(path, 'utf-8')
            })
          }
        }
        this.analysis.prepareMaterials(started.conversationId, detail.text, attachments)
      } catch (err) {
        await this.analysis.cancel(started.conversationId)
        throw err
      }
      const running: MailAnalysisStatus = { ...started, state: 'running' }
      this.deps.broadcast('evt:mail-analysis', running)
      return running
    })
  }

  analysisStatus(messageId: string): Promise<MailResult<MailAnalysisStatus | null>> {
    return Promise.resolve(toResult(() => this.analysis.status(messageId)))
  }

  async cancelAnalysis(conversationId: string): Promise<MailResult<void>> {
    return toResultAsync(async () => {
      await this.analysis.cancel(conversationId)
      this.broadcastAnalysisByConversation(conversationId)
    })
  }

  source(sourceKey: string): Promise<MailResult<MailSource | null>> {
    return Promise.resolve(toResult(() => this.analysis.source(sourceKey)))
  }

  // ---------- 生命周期 ----------

  start(intervalMs: number = MAIL_LIMITS.intervalMs): void {
    if (this.syncTimer) return
    this.syncTimer = setInterval(() => {
      this.runDueNow().catch((err) => console.error('[mail] scheduled sync failed:', err))
    }, intervalMs)
    // 启动即检查一次到期任务
    this.runDueNow().catch((err) => console.error('[mail] startup sync failed:', err))
  }

  async runDueNow(): Promise<void> {
    const ids = this.accountStore
      .list()
      .filter((a) => a.enabled)
      .map((a) => a.id)
    if (ids.length === 0) return
    await this.scheduler.runDue(ids, new AbortController().signal)
  }

  async stop(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer)
      this.syncTimer = null
    }
    await this.scheduler.stopAll()
  }

  /** 备份导入前暂停邮件分析写入,返回恢复函数 */
  quiesceForBackup(): Promise<() => void> {
    return this.analysis.quiesce()
  }

  // ---------- 内部 ----------

  private onSyncNotice(n: MailSyncNotice): void {
    this.deps.broadcast('evt:mail-sync', n)
    this.deps.broadcast('evt:mail-changed', { accountId: n.accountId })
  }

  private broadcastAnalysisByConversation(conversationId: string): void {
    const link = getLinkByConversation(this.deps.db, conversationId)
    if (!link) return
    const status = this.analysis.status(link.messageId ?? '')
    if (status) this.deps.broadcast('evt:mail-analysis', status)
  }
}

export { todayLocalDay }
