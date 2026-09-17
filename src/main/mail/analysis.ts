// 邮件分析服务(C 区):来源会话编排、材料准备、输入版本与状态管理。
// 不直接依赖 Engine:runner / materials 均为结构化注入,便于测试替身与 R 区组合。
import type { SqliteDb } from '../db/connection'
import { createConversation, getConversation } from '../db/dao'
import type { Analysis, AnalysisPayload } from '../../shared/types'
import type {
  MailAnalysisRequest,
  MailAnalysisStatus,
  MailErrorCode,
  MailSource
} from '../../shared/mail'
import type { MailAnalysisPort } from './ports'
import {
  getLinkByConversation,
  getLinkByMessage,
  getLinkBySource,
  listAnalysisVersions,
  recordVersion,
  setLinkConversation,
  setLinkLastMaterials,
  setLinkStatus
} from './analysisRepository'

/** 带邮箱错误码的分析错误,IPC 层(R 区)负责转换为 MailResult */
export class MailAnalysisError extends Error {
  readonly code: MailErrorCode
  constructor(code: MailErrorCode, message: string) {
    super(message)
    this.name = 'MailAnalysisError'
    this.code = code
  }
}

export interface MailAnalysisAttachmentInput {
  id: string
  name: string
  mime: string
  content: string
}

export interface MailAnalysisDeps {
  db: SqliteDb
  runner: {
    runAnalysis(conversationId: string): Promise<Analysis | null>
    stop(conversationId: string): void
  }
  materials: {
    addTextMaterial(conversationId: string, name: string, content: string): { id: string }
  }
  /** 一次分析的材料合计字节上限(生产传 MAIL_LIMITS.analysisBytes) */
  analysisBytes: number
}

interface MemState {
  conversationId: string
  state: MailAnalysisStatus['state']
  analysisId: string | null
  error: string | null
}

interface AnalysisRow {
  id: string
  conversationId: string
  version: number
  payload: string
  rawResponse: string | null
  modelLabel: string | null
  status: Analysis['status']
  error: string | null
  createdAt: string
}

type MaterialsWaiter = (ids: string[] | null) => void

function parseSnapshot(raw: string): Partial<MailSource> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed ? (parsed as Partial<MailSource>) : {}
  } catch {
    return {}
  }
}

function parsePayload(raw: string): AnalysisPayload {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed ? (parsed as AnalysisPayload) : {}
  } catch {
    return {}
  }
}

export class MailAnalysisService implements MailAnalysisPort {
  /** sourceKey → 在途/最近一次分析状态 */
  private readonly mem = new Map<string, MemState>()
  /** sourceKey → 等待 prepareMaterials 提供材料的唤醒函数 */
  private readonly waits = new Map<string, MaterialsWaiter>()
  private readonly inflight = new Set<Promise<void>>()
  private paused = false

  constructor(private readonly deps: MailAnalysisDeps) {}

  /**
   * 发起邮件分析:只等待取得/创建会话并排队,不等待模型完成。
   * 调用方随后用 prepareMaterials(conversationId, 正文, 附件) 提供本次输入;
   * 材料就绪后服务置 running 并调用 runner.runAnalysis。
   */
  async start(req: MailAnalysisRequest): Promise<MailAnalysisStatus> {
    if (this.paused) {
      throw new MailAnalysisError('BUSY', '分析已暂停(备份导入中),请稍后重试')
    }
    const link = getLinkByMessage(this.deps.db, req.messageId)
    if (!link) {
      throw new MailAnalysisError('NOT_FOUND', '未找到该邮件的分析来源')
    }
    const sourceKey = link.sourceKey
    // 双击互斥:同一来源已有准备中/运行中的任务时直接返回现状态,不重复调用 runner
    const current = this.mem.get(sourceKey)
    if (
      link.conversationId &&
      current &&
      (current.state === 'preparing' || current.state === 'running')
    ) {
      return this.toStatus(current)
    }

    let conversationId = link.conversationId
    if (!conversationId) {
      const snapshot = parseSnapshot(link.snapshot)
      const conv = createConversation(this.deps.db, 'analysis', snapshot.subject || '邮件分析')
      conversationId = conv.id
      setLinkConversation(this.deps.db, sourceKey, conversationId)
    }
    const st: MemState = { conversationId, state: 'preparing', analysisId: null, error: null }
    this.mem.set(sourceKey, st)
    setLinkStatus(this.deps.db, sourceKey, 'preparing')
    this.spawn(sourceKey, conversationId, st)
    return { conversationId, state: 'preparing', analysisId: null, error: null }
  }

  /**
   * 提供本次分析材料:正文(名称取邮件主题/会话标题)与选中的附件。
   * 合计字节超过 analysisBytes 时抛 LIMIT,不写入任何材料。
   * 材料就绪后唤醒 start 排队的任务(如有)。
   */
  prepareMaterials(
    conversationId: string,
    bodyText: string,
    attachments: MailAnalysisAttachmentInput[]
  ): string[] {
    const totalBytes =
      Buffer.byteLength(bodyText, 'utf8') +
      attachments.reduce((sum, a) => sum + Buffer.byteLength(a.content ?? '', 'utf8'), 0)
    if (totalBytes > this.deps.analysisBytes) {
      throw new MailAnalysisError(
        'LIMIT',
        `分析材料合计 ${totalBytes} 字节,超过单次上限 ${this.deps.analysisBytes} 字节`
      )
    }
    const ids: string[] = []
    const conv = getConversation(this.deps.db, conversationId)
    const bodyName = conv?.title || '邮件正文'
    ids.push(this.deps.materials.addTextMaterial(conversationId, bodyName, bodyText).id)
    for (const att of attachments) {
      ids.push(this.deps.materials.addTextMaterial(conversationId, att.name || att.id, att.content ?? '').id)
    }
    const link = getLinkByConversation(this.deps.db, conversationId)
    if (link) {
      setLinkLastMaterials(this.deps.db, link.sourceKey, ids)
      const resolveWait = this.waits.get(link.sourceKey)
      if (resolveWait) {
        this.waits.delete(link.sourceKey)
        resolveWait(ids)
      }
    }
    return ids
  }

  /** 内存状态优先,link 表兜底(重启后仍可查询最近结果) */
  status(messageId: string): MailAnalysisStatus | null {
    const link = getLinkByMessage(this.deps.db, messageId)
    if (!link) return null
    const mem = this.mem.get(link.sourceKey)
    if (mem) return this.toStatus(mem)
    if (!link.conversationId || link.status === 'idle') return null
    const versions = listAnalysisVersions(this.deps.db, link.sourceKey)
    const latest = versions.length > 0 ? versions[versions.length - 1] : null
    return {
      conversationId: link.conversationId,
      state: link.status,
      analysisId: latest?.analysisId ?? null,
      error: link.lastError
    }
  }

  /** 取消:调用 runner.stop 并置 cancelled;已结束的任务不回写 */
  async cancel(conversationId: string): Promise<void> {
    this.deps.runner.stop(conversationId)
    const entry = [...this.mem.entries()].find(([, st]) => st.conversationId === conversationId)
    if (!entry) return
    const [sourceKey, st] = entry
    if (st.state !== 'preparing' && st.state !== 'running') return
    st.state = 'cancelled'
    setLinkStatus(this.deps.db, sourceKey, 'cancelled')
    const resolveWait = this.waits.get(sourceKey)
    if (resolveWait) {
      this.waits.delete(sourceKey)
      resolveWait(null)
    }
  }

  /** 读来源快照;accountRemoved 恒为 false(账号移除保留来源,字段预留) */
  source(sourceKey: string): MailSource | null {
    const link = getLinkBySource(this.deps.db, sourceKey)
    if (!link) return null
    const snap = parseSnapshot(link.snapshot)
    return {
      sourceKey,
      messageId: snap.messageId ?? link.messageId,
      accountEmail: snap.accountEmail ?? '',
      subject: snap.subject ?? '',
      from: snap.from ?? '',
      receivedAt: snap.receivedAt ?? '',
      accountRemoved: false
    }
  }

  /** 会话的历史分析版本(直接 SQL 显式别名,不改 dao) */
  listAnalyses(conversationId: string): Analysis[] {
    const rows = this.deps.db.all<AnalysisRow>(
      `SELECT id, conversation_id AS conversationId, version, payload,
              raw_response AS rawResponse, model_label AS modelLabel,
              status, error, created_at AS createdAt
       FROM analyses WHERE conversation_id = ?
       ORDER BY version, rowid`,
      [conversationId]
    )
    return rows.map((row) => ({ ...row, payload: parsePayload(row.payload) }))
  }

  /**
   * 暂停新分析入口并等待在途任务结束,返回解除暂停的函数(备份导入前使用)。
   * 仍在等待材料的准备任务直接取消,避免无限等待;运行中的任务等待其自然完成。
   */
  async quiesce(): Promise<() => void> {
    this.paused = true
    for (const [sourceKey, resolveWait] of [...this.waits]) {
      this.waits.delete(sourceKey)
      const st = this.mem.get(sourceKey)
      if (st && st.state === 'preparing') {
        st.state = 'cancelled'
        setLinkStatus(this.deps.db, sourceKey, 'cancelled')
      }
      resolveWait(null)
    }
    await Promise.allSettled([...this.inflight])
    return () => {
      this.paused = false
    }
  }

  // ---------- 内部 ----------

  private toStatus(st: MemState): MailAnalysisStatus {
    return {
      conversationId: st.conversationId,
      state: st.state,
      analysisId: st.analysisId,
      error: st.error
    }
  }

  /** cancel/quiesce 可能在 runner 执行期间并发改写状态,每次都读实时值 */
  private isCancelled(st: MemState): boolean {
    return st.state === 'cancelled'
  }

  private spawn(sourceKey: string, conversationId: string, st: MemState): void {
    const task = this.runTask(sourceKey, conversationId, st)
    this.inflight.add(task)
    task.then(
      () => {
        this.inflight.delete(task)
      },
      () => {
        this.inflight.delete(task)
      }
    )
  }

  private async runTask(sourceKey: string, conversationId: string, st: MemState): Promise<void> {
    let waiterResolve!: MaterialsWaiter
    const waiter = new Promise<string[] | null>((resolve) => {
      waiterResolve = resolve
    })
    try {
      this.waits.set(sourceKey, waiterResolve)
      const materialIds = await waiter
      if (!materialIds || st.state !== 'preparing') return

      st.state = 'running'
      setLinkStatus(this.deps.db, sourceKey, 'running')

      let analysis: Analysis | null = null
      try {
        analysis = await this.deps.runner.runAnalysis(conversationId)
      } catch (err) {
        if (this.isCancelled(st)) return
        if (err instanceof Error && err.name === 'AbortError') {
          st.state = 'cancelled'
          setLinkStatus(this.deps.db, sourceKey, 'cancelled')
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        st.state = 'failed'
        st.error = message
        setLinkStatus(this.deps.db, sourceKey, 'failed', message)
        return
      }
      // 迟到结果不覆盖取消状态
      if (this.isCancelled(st)) return

      if (!analysis) {
        st.state = 'failed'
        st.error = '分析未产生结果'
        setLinkStatus(this.deps.db, sourceKey, 'failed', st.error)
        return
      }
      // 版本表主键为 analysisId,在 runner 产生分析记录后写入本次输入快照
      recordVersion(this.deps.db, analysis.id, sourceKey, materialIds)
      st.analysisId = analysis.id
      if (analysis.status === 'failed') {
        st.state = 'failed'
        st.error = analysis.error ?? '分析失败'
        setLinkStatus(this.deps.db, sourceKey, 'failed', st.error)
        return
      }
      st.state = 'done'
      st.error = null
      setLinkStatus(this.deps.db, sourceKey, 'done')
    } finally {
      // 仅清理自己注册的等待项,避免取消后立即重开的任务被误删等待器
      if (this.waits.get(sourceKey) === waiterResolve) this.waits.delete(sourceKey)
    }
  }
}
