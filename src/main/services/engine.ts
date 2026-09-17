// 会话引擎:统一材料接收、流式聊天、通知分析、课表/校历导入与确认
import type { SqliteDb } from '../db/connection'
import {
  appendMessageContent,
  confirmCandidate,
  createConversation,
  deleteMessagesFrom,
  getConversation,
  insertAnalysis,
  insertMaterial,
  insertMessage,
  insertPending,
  lastAssistantMessage,
  listMaterials,
  listMessages,
  listProviders,
  getProviderApiKey,
  renameConversation,
  saveProfileFact,
  touchConversation
} from '../db/dao'
import type {
  ActionCandidate,
  Analysis,
  AnalysisPayload,
  ChatMessage,
  Conversation,
  Material,
  ProfileFact
} from '../../shared/types'
import type { PetActivityChange } from '../../shared/pet'
import {
  ANALYSIS_SYSTEM_PROMPT,
  CHAT_SYSTEM_PROMPT,
  SCHOOL_CALENDAR_SYSTEM_PROMPT,
  TIMETABLE_SYSTEM_PROMPT
} from './prompts'
import { buildFullContext } from './context'
import { fileToDataUrl, parseLocalFile } from './materials'
import { ModelRouter, type LlmMessage, type RouterNotice } from './modelRouter'

export type Broadcast = (channel: string, payload: unknown) => void

export interface EngineDeps {
  db: SqliteDb
  router: ModelRouter
  broadcast: Broadcast
  notifyModelSwitch?: (n: { from: string; to: string; reason: string }) => void
  onProfileSuggestion?: () => void
  onPetActivity?: (change: PetActivityChange) => void
}

interface CallOutcome {
  text: string
  label: string
}

export class Engine {
  private aborts = new Map<string, AbortController>()

  constructor(private deps: EngineDeps) {}

  private get db(): SqliteDb {
    return this.deps.db
  }

  // ---------- 材料接收 ----------

  async intakeMaterials(input: {
    conversationId?: string
    kind?: Conversation['kind']
    texts?: Array<{ name: string; content: string }>
    files?: string[]
    autoRun?: boolean
  }): Promise<{ conversationId: string; materials: Material[] }> {
    let conv = input.conversationId ? getConversation(this.db, input.conversationId) : undefined
    if (!conv) {
      conv = createConversation(this.db, input.kind ?? 'analysis', '新分析')
    }
    const materials: Material[] = []
    for (const t of input.texts ?? []) {
      materials.push(
        insertMaterial(this.db, {
          conversationId: conv.id,
          name: t.name || '粘贴的通知文本',
          type: 'text',
          content: t.content
        })
      )
    }
    for (const f of input.files ?? []) {
      const parsed = await parseLocalFile(f)
      materials.push(
        insertMaterial(this.db, {
          conversationId: conv.id,
          name: parsed.name,
          type: parsed.type,
          mime: parsed.mime,
          size: parsed.size,
          content: parsed.content,
          path: parsed.path,
          parseError: parsed.parseError
        })
      )
    }
    const firstName = materials[0]?.name
    if (conv.title === '新分析' && firstName) {
      renameConversation(
        this.db,
        conv.id,
        firstName.replace(/\.[a-z0-9]+$/i, '').slice(0, 30) || '新分析'
      )
    } else {
      touchConversation(this.db, conv.id)
    }

    const autoRun = input.autoRun ?? true
    if (autoRun) {
      if (conv.kind === 'analysis') await this.runAnalysis(conv.id)
      else if (conv.kind === 'timetable') await this.runImport(conv.id, 'timetable')
      else if (conv.kind === 'school-calendar') await this.runImport(conv.id, 'school-calendar')
      // chat 会话:材料作为上下文,等待用户发送消息
    }
    this.deps.broadcast('evt:materials-accepted', { conversationId: conv.id, count: materials.length })
    this.deps.broadcast('evt:conversation-changed', { conversationId: conv.id })
    return { conversationId: conv.id, materials }
  }

  // ---------- 通知分析 ----------

  async runAnalysis(conversationId: string): Promise<Analysis | null> {
    const conv = getConversation(this.db, conversationId)
    if (!conv) return null
    const materials = listMaterials(this.db, conversationId)
    if (materials.length === 0) return null

    const taskId = `analysis:${conversationId}`
    this.deps.onPetActivity?.({ phase: 'start', taskId })
    const controller = new AbortController()
    this.aborts.set(conversationId, controller)
    let analysis: Analysis | null = null
    let outcome: 'done' | 'failed' | 'cancelled' = 'failed'
    try {
      const userText =
        `以下是本次事项的全部材料:\n\n` +
        materials
          .map((m) => {
            const head = `【材料:${m.name}(${m.type})】`
            if (m.parseError) return `${head}\n(未能读取:${m.parseError})`
            if (m.type === 'image') return `${head}\n(见附图)`
            return `${head}\n${m.content ?? ''}`
          })
          .join('\n\n') +
        `\n\n${buildFullContext(this.db)}\n\n请按系统要求输出 JSON 分析结果。`
      const { content: userContent, hasImages } = buildUserContent(userText, materials)

      const { text: raw, label } = await this.callModel(
        conversationId,
        [
          { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
          { role: 'user', content: userContent }
        ],
        hasImages,
        controller.signal
      )
      const payload = extractJsonPayload(raw)
      analysis = payload
        ? insertAnalysis(this.db, conversationId, payload, { rawResponse: raw, modelLabel: label })
        : insertAnalysis(this.db, conversationId, {}, {
            rawResponse: raw,
            status: 'failed',
            error: '模型输出无法解析为 JSON,可稍后重试或更换模型'
          })
      if (payload?.title) renameConversation(this.db, conversationId, payload.title.slice(0, 30))
      outcome = payload ? 'done' : 'failed'
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      outcome = aborted ? 'cancelled' : 'failed'
      analysis = await this.recordFailure(conversationId, err)
    } finally {
      this.aborts.delete(conversationId)
      this.deps.onPetActivity?.({ phase: 'finish', taskId, outcome })
    }
    this.deps.broadcast('evt:analysis-updated', { conversationId, analysisId: analysis?.id })
    return analysis
  }

  // ---------- 课表 / 校历导入 ----------

  async runImport(conversationId: string, kind: 'timetable' | 'school-calendar'): Promise<Analysis | null> {
    const conv = getConversation(this.db, conversationId)
    if (!conv) return null
    const materials = listMaterials(this.db, conversationId)
    if (materials.length === 0) return null

    const taskId = `import:${conversationId}`
    this.deps.onPetActivity?.({ phase: 'start', taskId })
    const controller = new AbortController()
    this.aborts.set(conversationId, controller)
    let analysis: Analysis | null = null
    let outcome: 'done' | 'failed' | 'cancelled' = 'failed'
    try {
      const userText =
        `请提取以下材料中的${kind === 'timetable' ? '课程表' : '校历'}信息:\n\n` +
        materials
          .map((m) => {
            const head = `【材料:${m.name}(${m.type})】`
            if (m.parseError) return `${head}\n(未能读取:${m.parseError})`
            if (m.type === 'image') return `${head}\n(见附图)`
            return `${head}\n${m.content ?? ''}`
          })
          .join('\n\n')
      const { content: userContent, hasImages } = buildUserContent(userText, materials)

      const { text: raw, label } = await this.callModel(
        conversationId,
        [
          {
            role: 'system',
            content: kind === 'timetable' ? TIMETABLE_SYSTEM_PROMPT : SCHOOL_CALENDAR_SYSTEM_PROMPT
          },
          { role: 'user', content: userContent }
        ],
        hasImages,
        controller.signal
      )
      const payload = extractJsonPayload(raw)
      analysis = payload
        ? insertAnalysis(this.db, conversationId, payload, { rawResponse: raw, modelLabel: label })
        : insertAnalysis(this.db, conversationId, {}, {
            rawResponse: raw,
            status: 'failed',
            error: '模型输出无法解析为 JSON,可稍后重试'
          })
      outcome = payload ? 'done' : 'failed'
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      outcome = aborted ? 'cancelled' : 'failed'
      analysis = await this.recordFailure(conversationId, err)
    } finally {
      this.aborts.delete(conversationId)
      this.deps.onPetActivity?.({ phase: 'finish', taskId, outcome })
    }
    this.deps.broadcast('evt:analysis-updated', { conversationId, analysisId: analysis?.id })
    return analysis
  }

  // ---------- 聊天 ----------

  async sendChat(conversationId: string, text: string): Promise<void> {
    const conv = getConversation(this.db, conversationId)
    if (!conv || !text.trim()) return
    insertMessage(this.db, {
      conversationId,
      role: 'user',
      content: text.trim(),
      createdAt: new Date().toISOString()
    })
    touchConversation(this.db, conversationId)
    this.deps.broadcast('evt:conversation-changed', { conversationId })

    if (conv.kind === 'chat') {
      await this.streamChatReply(conversationId)
    } else if (conv.kind === 'analysis') {
      // 分析会话中的追问:补充信息写入材料,并生成新版本分析
      await this.intakeMaterials({
        conversationId,
        texts: [{ name: '用户补充说明', content: text.trim() }],
        autoRun: true
      })
    } else {
      await this.runImport(conversationId, conv.kind === 'timetable' ? 'timetable' : 'school-calendar')
    }
  }

  private async streamChatReply(conversationId: string): Promise<void> {
    const conv = getConversation(this.db, conversationId)
    if (!conv) return
    const controller = new AbortController()
    this.aborts.set(conversationId, controller)
    const assistant = insertMessage(this.db, {
      conversationId,
      role: 'assistant',
      content: '',
      createdAt: new Date(Date.now() + 1).toISOString()
    })
    let usedLabel = ''
    try {
      const history = listMessages(this.db, conversationId).filter((m) => m.id !== assistant.id)
      const recent = history.slice(-40)
      const context = buildFullContext(this.db)
      const system =
        CHAT_SYSTEM_PROMPT +
        (context ? `\n\n${context}` : '') +
        `\n当前时间:${new Date().toLocaleString('zh-CN')}`

      const materials = listMaterials(this.db, conversationId)
      const attach = buildAttachmentMessages(materials)
      const messages: LlmMessage[] = [
        { role: 'system', content: system },
        ...attach,
        ...recent.map((m) => ({
          role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
          content: m.content
        }))
      ]

      const { text: raw, label } = await this.callModel(
        conversationId,
        messages,
        materials.some((m) => m.type === 'image'),
        controller.signal,
        (full, delta) => {
          void full
          void delta
        }
      )
      usedLabel = label
      let display = raw
      const pIdx = raw.indexOf('[PROFILE]')
      if (pIdx >= 0) {
        display = raw.slice(0, pIdx).trim()
        this.applyProfileSuggestion(raw.slice(pIdx))
      }
      // [PROFILE] 标记在流式过程中可能已部分显示,统一以清洗后的全文为准
      appendMessageContent(this.db, assistant.id, '')
      this.db.run('UPDATE messages SET content = ?, model_label = ? WHERE id = ?', [display, usedLabel || null, assistant.id])
      this.deps.broadcast('evt:chat-done', { conversationId, messageId: assistant.id })
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      const message = aborted ? '(已停止生成)' : err instanceof Error ? err.message : String(err)
      this.db.run("UPDATE messages SET content = ? WHERE id = ?", [aborted ? '(已停止生成)' : `⚠ ${message}`, assistant.id])
      this.deps.broadcast(aborted ? 'evt:chat-done' : 'evt:chat-error', {
        conversationId,
        messageId: assistant.id,
        error: aborted ? undefined : message
      })
    } finally {
      this.aborts.delete(conversationId)
    }
    this.deps.broadcast('evt:conversation-changed', { conversationId })
  }

  private applyProfileSuggestion(line: string): void {
    const m = /\[PROFILE\]\s*([a-z]+)\s*\|\s*([^|]+)\|\s*(.+)/i.exec(line.trim())
    if (!m) return
    const category = (['basic', 'preference', 'schedule'] as const).includes(m[1] as ProfileFact['category'])
      ? (m[1] as ProfileFact['category'])
      : 'preference'
    saveProfileFact(this.db, { category, key: m[2].trim(), value: m[3].trim(), source: 'suggested', status: 'pending' })
    this.deps.onProfileSuggestion?.()
  }

  // ---------- 停止 / 重试 ----------

  stop(conversationId: string): void {
    this.aborts.get(conversationId)?.abort()
  }

  /** 邮箱分析材料注入:直接写入材料表,不触发自动分析(由邮箱服务控制时序) */
  insertMailMaterial(input: {
    conversationId: string
    name: string
    type: Material['type']
    content: string
  }): string {
    return insertMaterial(this.db, {
      conversationId: input.conversationId,
      name: input.name,
      type: input.type,
      content: input.content
    }).id
  }

  async retry(conversationId: string): Promise<void> {
    const conv = getConversation(this.db, conversationId)
    if (!conv) return
    const last = lastAssistantMessage(this.db, conversationId)
    if (last) deleteMessagesFrom(this.db, conversationId, last.createdAt, 'assistant')
    if (conv.kind === 'chat') await this.streamChatReply(conversationId)
    else if (conv.kind === 'analysis') await this.runAnalysis(conversationId)
    else await this.runImport(conversationId, conv.kind === 'timetable' ? 'timetable' : 'school-calendar')
  }

  // ---------- 确认 / 暂存 ----------

  confirmItem(
    analysisId: string,
    item: unknown
  ): { result: 'created' | 'duplicate'; refType: 'todo' | 'event'; refId: string } {
    const cand = normalizeCandidate(item)
    const r = confirmCandidate(this.db, cand)
    this.deps.broadcast('evt:data-changed', { scope: 'items' })
    return r
  }

  deferItem(analysisId: string, item: unknown): string {
    const cand = normalizeCandidate(item)
    const due = cand.deadline ? `\n截止:${cand.deadline}` : ''
    const p = insertPending(this.db, { title: cand.title, notes: (cand.notes ?? '') + due })
    this.deps.broadcast('evt:data-changed', { scope: 'pending' })
    return p.id
  }

  // ---------- 内部 ----------

  private async recordFailure(conversationId: string, err: unknown): Promise<Analysis> {
    const aborted = err instanceof Error && err.name === 'AbortError'
    const message = aborted ? '已取消' : err instanceof Error ? err.message : String(err)
    const analysis = insertAnalysis(this.db, conversationId, {}, { status: 'failed', error: message })
    if (!aborted) this.deps.broadcast('evt:chat-error', { conversationId, error: message })
    return analysis
  }

  private async callModel(
    conversationId: string,
    messages: LlmMessage[],
    needVision: boolean,
    signal: AbortSignal,
    _onDelta?: (full: string, delta: string) => void
  ): Promise<CallOutcome> {
    const providers = listProviders(this.db)
    const result = await this.deps.router.call(providers, {
      messages,
      needVision,
      signal,
      onNotice: (n: RouterNotice) => {
        if (n.type === 'switched') {
          this.deps.notifyModelSwitch?.({ from: n.from, to: n.to, reason: n.reason })
          this.deps.broadcast('evt:model-switched', { from: n.from, to: n.to, reason: n.reason })
        }
        if (n.type === 'exhausted') {
          this.deps.notifyModelSwitch?.({ from: '默认模型', to: '无', reason: n.reason })
          this.deps.broadcast('evt:model-switched', { from: '', to: '', reason: n.reason })
        }
      }
    })
    return { text: result.text, label: `${result.used.providerName} / ${result.used.model}` }
  }
}

// ---------- 工具函数 ----------

function buildUserContent(
  userText: string,
  materials: Material[]
): { content: LlmMessage['content']; hasImages: boolean } {
  const images = materials
    .filter((m) => m.type === 'image' && m.path)
    .map((m) => fileToDataUrl(m.path!))
    .filter((u): u is string => !!u)
  if (images.length === 0) return { content: userText, hasImages: false }
  return {
    content: [
      { type: 'text', text: userText },
      ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))
    ],
    hasImages: true
  }
}

function buildAttachmentMessages(materials: Material[]): LlmMessage[] {
  if (materials.length === 0) return []
  const parts: LlmMessage['content'] = []
  const texts = materials.filter((m) => m.content)
  if (texts.length > 0) {
    parts.push({
      type: 'text',
      text:
        '附上本会话的材料:\n' +
        texts.map((m) => `【${m.name}】\n${m.content}`).join('\n\n')
    })
  }
  for (const m of materials.filter((x) => x.type === 'image' && x.path)) {
    const url = fileToDataUrl(m.path!)
    if (url) parts.push({ type: 'image_url', image_url: { url } })
  }
  if (parts.length === 0) return []
  return [{ role: 'user', content: parts }]
}

export function extractJsonPayload(text: string): AnalysisPayload | null {
  if (!text) return null
  let s = text.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s)
  if (fence) s = fence[1].trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  const body = s.slice(start, end + 1)
  try {
    return JSON.parse(body) as AnalysisPayload
  } catch {
    try {
      return JSON.parse(body.replace(/,\s*([}\]])/g, '$1')) as AnalysisPayload
    } catch {
      return null
    }
  }
}

export function normalizeCandidate(item: unknown): ActionCandidate & { reminderMinutes?: number | null } {
  const x = (item ?? {}) as Record<string, unknown>
  const type = x.type === 'event' ? 'event' : 'todo'
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim() : undefined
  const num = (v: unknown): number | null =>
    typeof v === 'number' && isFinite(v) ? Math.round(v) : null
  return {
    title: str(x.title) ?? '未命名事项',
    type,
    deadline: normalizeDateTime(str(x.deadline)),
    start: normalizeDateTime(str(x.start)),
    durationMinutes: num(x.durationMinutes),
    notes: str(x.notes),
    location: str(x.location),
    sourceRef: str(x.sourceRef),
    confidence: (['high', 'medium', 'low'] as const).includes(x.confidence as 'high')
      ? (x.confidence as 'high' | 'medium' | 'low')
      : 'medium'
  }
}

/** 把模型输出的时间统一为 YYYY-MM-DDTHH:mm;只含日期时:截止按 23:59,开始按 00:00 */
export function normalizeDateTime(s?: string | null, isStart = false): string | null {
  if (!s) return null
  const t = s.trim()
  const dateOnly = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t)
  if (dateOnly) {
    return `${dateOnly[1]}-${pad(dateOnly[2])}-${pad(dateOnly[3])}T${isStart ? '00:00' : '23:59'}`
  }
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2})/.exec(t)
  if (m) {
    return `${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(m[4])}:${pad(m[5])}`
  }
  return null
}

function pad(n: string | number): string {
  const v = Number(n)
  return v < 10 ? '0' + v : String(v)
}

export type { ChatMessage }
