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
import { webmailUrlFor } from '../../shared/webmail'
import type { Engine } from '../services/engine'
import { isRestoreWindowOpen } from '../services/backup'
import { parseLocalFile } from '../services/materials'
import type { SessionFactory } from './adapter'
import { MailAccountStore } from './accounts'
import type { CredentialStorage } from './credentials'
import { MailRepository } from './repository'
import { MailSyncWorker } from './sync'
import { MailScheduler, MailTaskRegistry, todayLocalDay } from './scheduler'
import { createImapSession } from './imapAdapter'
import { MailCacheService, isMailCodedError, type MailCodedError } from './cache'
import { MailContentService } from './content'
import {
  MailAnalysisService,
  type MailAnalysisAttachmentInput
} from './analysis'
import { MailConfirmationService } from './confirmation'
import { ensureLink, getLinkByConversation } from './analysisRepository'
import { validateAccountInput } from './presets'
import { MailError, classifyError, isMailError } from './errors'

export type MailBroadcast = (channel: string, payload: unknown) => void

export interface MailServiceDeps {
  db: SqliteDb
  engine: Engine
  storage: CredentialStorage
  /** 正文/附件缓存根目录(userData/mail) */
  cacheDir: string
  broadcast: MailBroadcast
  /** 测试注入:覆盖 IMAP 会话工厂(生产默认 createImapSession) */
  sessionFactory?: SessionFactory
}

/** 退出等待在途账号任务的上限;超时记录未完成任务后放行退出流程 */
export const DEFAULT_MAIL_STOP_TIMEOUT_MS = 10_000

function ok<T>(value: T): MailResult<T> {
  return { ok: true, value }
}

function fail(code: MailErrorCode, message: string): MailResult<never> {
  return { ok: false, code, message }
}

/** 缺陷修复(Task 12 Step 3):MailCodedError(正文/附件缓存层)的 code 此前被 classifyError 误归为 NETWORK */
function knownCode(err: unknown): MailErrorCode | null {
  if (isMailError(err)) return err.code
  if (isMailCodedError(err)) return err.code
  return null
}

function toResult<T>(fn: () => T): MailResult<T> {
  try {
    return ok(fn())
  } catch (err) {
    const code = knownCode(err)
    if (code) return fail(code, err instanceof Error ? err.message : String(err))
    return fail(classifyError(err).code, err instanceof Error ? err.message : String(err))
  }
}

async function toResultAsync<T>(fn: () => Promise<T>): Promise<MailResult<T>> {
  try {
    return ok(await fn())
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return fail('CANCELLED', '已取消')
    const code = knownCode(err)
    if (code) return fail(code, err instanceof Error ? err.message : String(err))
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
  /** 账号级任务注册表(R10):停用/移除/退出统一取消并等待对应账号任务 */
  readonly tasks: MailTaskRegistry
  private readonly cache: MailCacheService
  private readonly worker: MailSyncWorker
  private syncTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: MailServiceDeps) {
    const sessionFactory = deps.sessionFactory ?? createImapSession
    this.accountStore = new MailAccountStore(deps.db, deps.storage)
    this.tasks = new MailTaskRegistry(this.accountStore)
    this.repository = new MailRepository(deps.db)
    // 仓储写边界:停用/移除/代数失效后拒绝迟到的批次与缓存提交
    this.repository.setWriteGuard({ assertWritable: (accountId) => this.tasks.assertWritable(accountId) })
    this.cache = new MailCacheService(deps.cacheDir)
    this.worker = new MailSyncWorker(this.accountStore, this.repository, sessionFactory)
    this.scheduler = new MailScheduler(
      this.worker,
      this.accountStore,
      { onNotice: (n) => this.onSyncNotice(n) },
      undefined,
      this.tasks
    )
    this.content = new MailContentService({
      repository: this.repository,
      sessionFactory,
      accounts: this.accountStore,
      cache: this.cache,
      limits: MAIL_LIMITS,
      tasks: this.tasks
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
      void this.scheduler.syncAccount(info.id, 'refresh').catch(() => undefined)
      return info
    })
  }

  async setEnabled(id: string, enabled: boolean): Promise<MailResult<void>> {
    return toResultAsync(async () => {
      if (enabled) {
        this.tasks.resume(id)
        this.accountStore.setEnabled(id, true)
        return
      }
      // R10/AC11:先阻断新任务并取消在途任务,任务完全结束后再更新状态,
      // 避免任务收尾的 idle 回写覆盖停用状态;只影响该账号,其他账号继续工作
      this.tasks.pause(id)
      await this.tasks.cancelAccount(id)
      this.accountStore.setEnabled(id, false)
    })
  }

  async remove(id: string): Promise<MailResult<void>> {
    return toResultAsync(async () => {
      // R10:先阻断后删除——取消并等待该账号全部任务结束,再清理数据与缓存
      this.tasks.pause(id)
      await this.tasks.cancelAccount(id)
      this.tasks.forget(id)
      this.accountStore.remove(id)
      await this.content.removeCache(id)
      this.deps.broadcast('evt:mail-changed', { accountId: id })
    })
  }

  // ---------- 同步 ----------

  async sync(id: string): Promise<MailResult<void>> {
    return toResultAsync(async () => {
      this.rejectDuringRestore()
      await this.scheduler.syncAccount(id, 'refresh')
    })
  }

  async earlier(id: string): Promise<MailResult<void>> {
    return toResultAsync(async () => {
      this.rejectDuringRestore()
      await this.scheduler.syncAccount(id, 'earlier')
    })
  }

  list(query: MailListQuery): Promise<MailResult<{ items: import('../../shared/mail').MailSummary[]; hasMore: boolean }>> {
    return Promise.resolve(toResult(() => this.repository.list(query)))
  }

  // ---------- 阅读 ----------

  async detail(id: string): Promise<MailResult<import('../../shared/mail').MailDetail>> {
    const result = await toResultAsync(() => this.content.detail(id, new AbortController().signal))
    if (result.ok) {
      // 阅读成功即本地已读;不写回服务器。
      // 停用/移除竞态中该写会被守卫拒绝:阅读结果照常返回,仅不标记已读
      try {
        this.repository.markRead(id, true)
      } catch {
        /* 迟到标记被账号级取消守卫阻断,不影响阅读结果 */
      }
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
    return toResultAsync(() => {
      this.rejectDuringRestore()
      return this.content.download(id, new AbortController().signal)
    })
  }

  async saveAttachment(id: string): Promise<MailResult<{ saved: boolean }>> {
    return toResultAsync(async () => {
      this.rejectDuringRestore()
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

  // 发件不走本地:用系统浏览器打开对应邮箱的网页版
  async openWebmail(email: string): Promise<MailResult<void>> {
    return toResultAsync(async () => {
      const url = webmailUrlFor(email)
      if (!url) throw new Error('INVALID_CONFIG: 邮箱地址无效,无法打开网页版')
      await shell.openExternal(url)
    })
  }

  // ---------- 手动分析 ----------

  async analyze(input: MailAnalysisRequest): Promise<MailResult<MailAnalysisStatus>> {
    return toResultAsync(async () => {
      this.rejectDuringRestore()
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
    // 恢复排他窗口内不再发起新的账号同步任务
    if (isRestoreWindowOpen()) return
    const ids = this.accountStore
      .list()
      .filter((a) => a.enabled)
      .map((a) => a.id)
    if (ids.length === 0) return
    await this.scheduler.runDue(ids, new AbortController().signal)
  }

  /**
   * 退出流程(R10):停新任务、取消全部在途账号任务并等待其安全退出;
   * 超过 timeoutMs 仍未结束时记录未完成任务(账号 ID + 类别,不含邮件内容)后放行,
   * 由后续落盘流程收尾。
   */
  async stop(timeoutMs: number = DEFAULT_MAIL_STOP_TIMEOUT_MS): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer)
      this.syncTimer = null
    }
    try {
      await this.waitFor(this.scheduler.stopAll(), timeoutMs)
    } catch {
      const pending = this.tasks
        .pendingTasks()
        .map((t) => `${t.kind}:${t.accountId}`)
        .join(',') || '未知'
      console.error(`[mail] 退出等待超时,未完成邮箱任务已标记取消(${pending})`)
    }
  }

  private waitFor(p: Promise<void>, ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待超时(${ms}ms)`)), ms)
      p.then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        (err: unknown) => {
          clearTimeout(timer)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      )
    })
  }

  /** 备份导入前暂停邮件分析写入,返回恢复函数(既有兼容入口) */
  quiesceForBackup(): Promise<() => void> {
    return this.analysis.quiesce()
  }

  /**
   * 恢复排他窗口的外部任务排空(R10→R1 接线):
   * 暂停分析写入,并取消/等待全部在途账号任务(同步、历史、正文、附件)。
   */
  async quiesceExternal(): Promise<() => void> {
    const resumeAnalysis = await this.analysis.quiesce()
    await this.scheduler.stopAll()
    return () => {
      resumeAnalysis()
    }
  }

  // ---------- 内部 ----------

  /** 恢复排他窗口内邮箱不再接受新任务(手动同步/阅读下载/分析) */
  private rejectDuringRestore(): void {
    if (isRestoreWindowOpen()) {
      throw new MailError('BUSY', '正在恢复备份,请稍后重试')
    }
  }

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
