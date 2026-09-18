import { createHash } from 'node:crypto'
import type { SqliteDb } from '../db/connection'
import {
  SCHEMA_SQL,
  SCHEMA_VERSION
} from '../db/schema'
import { migrateMailV2 } from '../mail/schema'
import type {
  ActionCandidate,
  Analysis,
  AnalysisPayload,
  CalendarEvent,
  ChatMessage,
  Conversation,
  Course,
  CourseOverride,
  EventInput,
  ExtractedSchoolEvent,
  Material,
  PendingImport,
  PendingItem,
  ProfileFact,
  ProviderInfo,
  SchoolEvent,
  Semester,
  Todo,
  TodoInput
} from '../../shared/types'
import { nowTimestamp, addMinutesIso } from '../../shared/dateUtils'

export function uid(): string {
  return createHash('sha1')
    .update(String(Date.now()) + Math.random().toString(36).slice(2) + process.pid.toString(36))
    .digest('hex')
    .slice(0, 20)
}

export function initSchema(db: SqliteDb): void {
  // PRAGMA foreign_keys 在事务外执行
  db.run('PRAGMA foreign_keys = ON')
  db.transaction(() => {
    db.run(SCHEMA_SQL)
    const row = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")
    if (!row) {
      migrateMailV2(db)
      db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)])
    } else {
      const currentVer = parseInt(row.value, 10)
      if (currentVer > SCHEMA_VERSION) {
        throw new Error(`数据库版本 (${currentVer}) 高于当前支持的版本 (${SCHEMA_VERSION})`)
      }
      if (currentVer < 2) migrateMailV2(db)
      if (currentVer < 3) {
        // v3:providers 增加 JSON 结构化输出能力开关
        db.run('ALTER TABLE providers ADD COLUMN supports_json_mode INTEGER NOT NULL DEFAULT 0')
      }
      if (currentVer < SCHEMA_VERSION) {
        db.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [String(SCHEMA_VERSION)])
      }
    }
  })
}

// ---------- fingerprint(重复确认/重复导入防护) ----------

export function normalizeForFingerprint(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase()
}

/** 事件指纹只含 标题+开始时间:结束时间/时长变化不影响查重(与确认去重逻辑一致) */
export function eventFingerprint(input: {
  title: string
  startAt?: string | null
  endAt?: string | null
}): string {
  return createHash('sha1')
    .update(['event', normalizeForFingerprint(input.title), input.startAt ?? ''].join('|'))
    .digest('hex')
}

export function todoFingerprint(input: { title: string; dueAt?: string | null }): string {
  return createHash('sha1')
    .update(['todo', normalizeForFingerprint(input.title), input.dueAt ?? ''].join('|'))
    .digest('hex')
}

export function findDuplicateEvent(db: SqliteDb, fp: string): CalendarEvent | undefined {
  return db.get<CalendarEvent>('SELECT * FROM events WHERE fingerprint = ? LIMIT 1', [fp]) as
    | CalendarEvent
    | undefined
}

export function findDuplicateTodo(db: SqliteDb, fp: string): Todo | undefined {
  return db.get<Todo>('SELECT * FROM todos WHERE fingerprint = ? LIMIT 1', [fp]) as Todo | undefined
}

// ---------- meta ----------

export function getMeta(db: SqliteDb, key: string): string | undefined {
  return db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])?.value
}

export function setMeta(db: SqliteDb, key: string, value: string): void {
  db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value])
}

// ---------- providers ----------

interface ProviderRow {
  id: string
  name: string
  base_url: string
  api_key_enc: string
  protocol: string
  models: string
  default_model: string
  supports_vision: number
  supports_json_mode: number
  is_default: number
  sort_order: number
  created_at: string
  updated_at: string
}

function providerToInfo(r: ProviderRow): ProviderInfo {
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    protocol: r.protocol as ProviderInfo['protocol'],
    models: JSON.parse(r.models || '[]'),
    defaultModel: r.default_model,
    supportsVision: !!r.supports_vision,
    supportsJsonMode: !!r.supports_json_mode,
    isDefault: !!r.is_default,
    sortOrder: r.sort_order,
    hasApiKey: r.api_key_enc.length > 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

export function listProviders(db: SqliteDb): ProviderInfo[] {
  return (db.all<ProviderRow>('SELECT * FROM providers ORDER BY sort_order, created_at') as ProviderRow[]).map(
    providerToInfo
  )
}

export function getProviderRow(db: SqliteDb, id: string): ProviderRow | undefined {
  return db.get<ProviderRow>('SELECT * FROM providers WHERE id = ?', [id]) as ProviderRow | undefined
}

export function getProviderApiKey(db: SqliteDb, id: string): string | null {
  const row = getProviderRow(db, id)
  if (!row || !row.api_key_enc) return null
  // 原样返回存储串('plain:xxx' 前缀明文或 safeStorage 密文),解密职责完全在 decryptApiKey
  return row.api_key_enc
}

export function saveProvider(
  db: SqliteDb,
  input: {
    id?: string
    name: string
    baseUrl: string
    protocol: string
    models: string[]
    defaultModel: string
    supportsVision: boolean
    supportsJsonMode?: boolean
    /** undefined = 保留已存密钥;'' = 用户清空 → 删除已存密钥;非空 = 新密文 */
    apiKeyEnc?: string
    isDefault?: boolean
    sortOrder?: number
  }
): string {
  const ts = nowTimestamp()
  const id = input.id ?? uid()
  const existing = input.id ? getProviderRow(db, input.id) : undefined
  const apiKeyEnc = input.apiKeyEnc !== undefined ? input.apiKeyEnc : (existing?.api_key_enc ?? '')
  const isDefault = input.isDefault ?? existing?.is_default === 1
  const sortOrder = input.sortOrder ?? existing?.sort_order ?? 0
  const supportsJsonMode = input.supportsJsonMode ?? existing?.supports_json_mode === 1
  db.run(
    `INSERT INTO providers (id, name, base_url, api_key_enc, protocol, models, default_model, supports_vision, supports_json_mode, is_default, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, base_url = excluded.base_url, api_key_enc = excluded.api_key_enc,
       protocol = excluded.protocol, models = excluded.models, default_model = excluded.default_model,
       supports_vision = excluded.supports_vision, supports_json_mode = excluded.supports_json_mode,
       is_default = excluded.is_default,
       sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
    [
      id,
      input.name,
      input.baseUrl,
      apiKeyEnc,
      input.protocol,
      JSON.stringify(input.models),
      input.defaultModel,
      input.supportsVision ? 1 : 0,
      supportsJsonMode ? 1 : 0,
      isDefault ? 1 : 0,
      sortOrder,
      ts,
      ts
    ]
  )
  if (isDefault) setDefaultProvider(db, id)
  return id
}

export function setDefaultProvider(db: SqliteDb, id: string): void {
  db.transaction(() => {
    db.run('UPDATE providers SET is_default = 0')
    db.run('UPDATE providers SET is_default = 1 WHERE id = ?', [id])
  })
}

export function deleteProvider(db: SqliteDb, id: string): void {
  db.run('DELETE FROM providers WHERE id = ?', [id])
}

// ---------- conversations ----------

interface ConversationRow {
  id: string
  title: string
  kind: Conversation['kind']
  status: Conversation['status']
  created_at: string
  updated_at: string
}

/** sql.js getAsObject 返回蛇形列名，出 dao 前必须映射为 shared/types 驼峰接口 */
function mapConversation(r: ConversationRow): Conversation {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

export function listConversations(db: SqliteDb): Conversation[] {
  return (db.all<ConversationRow>(
    "SELECT * FROM conversations WHERE status = 'active' ORDER BY updated_at DESC"
  ) as ConversationRow[]).map(mapConversation)
}

export function getConversation(db: SqliteDb, id: string): Conversation | undefined {
  const r = db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', [id]) as
    | ConversationRow
    | undefined
  return r ? mapConversation(r) : undefined
}

export function createConversation(
  db: SqliteDb,
  kind: Conversation['kind'],
  title: string
): Conversation {
  const ts = nowTimestamp()
  const conv: Conversation = { id: uid(), title, kind, status: 'active', createdAt: ts, updatedAt: ts }
  db.run('INSERT INTO conversations (id, title, kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
    conv.id,
    conv.title,
    conv.kind,
    conv.status,
    conv.createdAt,
    conv.updatedAt
  ])
  return conv
}

export function touchConversation(db: SqliteDb, id: string, title?: string): void {
  if (title && title.trim()) {
    db.run('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?', [title.trim(), nowTimestamp(), id])
  } else {
    db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', [nowTimestamp(), id])
  }
}

export function renameConversation(db: SqliteDb, id: string, title: string): void {
  db.run('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?', [title, nowTimestamp(), id])
}

export function deleteConversation(db: SqliteDb, id: string): void {
  db.transaction(() => {
    db.run('DELETE FROM messages WHERE conversation_id = ?', [id])
    db.run('DELETE FROM materials WHERE conversation_id = ?', [id])
    db.run('DELETE FROM analyses WHERE conversation_id = ?', [id])
    db.run("UPDATE pending_items SET status = 'dismissed' WHERE conversation_id = ? AND status = 'open'", [id])
    db.run('DELETE FROM conversations WHERE id = ?', [id])
  })
}

// ---------- messages ----------

interface MessageRow {
  id: string
  conversation_id: string
  role: ChatMessage['role']
  content: string
  model_label: string | null
  meta: string | null
  created_at: string
}

function mapMessage(r: MessageRow): ChatMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    modelLabel: r.model_label,
    meta: r.meta,
    createdAt: r.created_at
  }
}

export function listMessages(db: SqliteDb, conversationId: string): ChatMessage[] {
  return (db.all<MessageRow>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid',
    [conversationId]
  ) as MessageRow[]).map(mapMessage)
}

export function insertMessage(
  db: SqliteDb,
  msg: Omit<ChatMessage, 'id'> & { id?: string }
): ChatMessage {
  const full: ChatMessage = { ...msg, id: msg.id ?? uid() }
  db.run(
    'INSERT INTO messages (id, conversation_id, role, content, model_label, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [full.id, full.conversationId, full.role, full.content, full.modelLabel ?? null, full.meta ?? null, full.createdAt]
  )
  return full
}

export function appendMessageContent(db: SqliteDb, id: string, delta: string): void {
  db.run('UPDATE messages SET content = content || ? WHERE id = ?', [delta, id])
}

export function setMessageContent(db: SqliteDb, id: string, content: string, modelLabel?: string): void {
  db.run('UPDATE messages SET content = ?, model_label = COALESCE(?, model_label) WHERE id = ?', [content, modelLabel ?? null, id])
}

export function deleteMessagesFrom(db: SqliteDb, conversationId: string, createdAt: string, inclusiveRole?: string): void {
  if (inclusiveRole) {
    db.run(
      'DELETE FROM messages WHERE conversation_id = ? AND created_at >= ? AND role = ?',
      [conversationId, createdAt, inclusiveRole]
    )
  } else {
    db.run('DELETE FROM messages WHERE conversation_id = ? AND created_at >= ?', [conversationId, createdAt])
  }
}

export function lastAssistantMessage(db: SqliteDb, conversationId: string): ChatMessage | undefined {
  const r = db.get<MessageRow>(
    "SELECT * FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    [conversationId]
  ) as MessageRow | undefined
  return r ? mapMessage(r) : undefined
}

// ---------- materials ----------

export function insertMaterial(
  db: SqliteDb,
  m: Omit<Material, 'id' | 'createdAt'> & { id?: string }
): Material {
  const full: Material = { ...m, id: m.id ?? uid(), createdAt: nowTimestamp() }
  db.run(
    'INSERT INTO materials (id, conversation_id, name, type, mime, size, content, path, parse_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [full.id, full.conversationId, full.name, full.type, full.mime ?? null, full.size ?? null, full.content ?? null, full.path ?? null, full.parseError ?? null, full.createdAt]
  )
  return full
}

export function listMaterials(db: SqliteDb, conversationId: string): Material[] {
  return db.all<Material>('SELECT * FROM materials WHERE conversation_id = ? ORDER BY created_at, rowid', [
    conversationId
  ]) as Material[]
}

// ---------- analyses ----------

export function insertAnalysis(
  db: SqliteDb,
  conversationId: string,
  payload: AnalysisPayload,
  opts: { rawResponse?: string; modelLabel?: string; status?: Analysis['status']; error?: string } = {}
): Analysis {
  const last = db.get<{ version: number }>(
    'SELECT MAX(version) AS version FROM analyses WHERE conversation_id = ?',
    [conversationId]
  )
  const version = (last?.version ?? 0) + 1
  const a: Analysis = {
    id: uid(),
    conversationId,
    version,
    payload,
    rawResponse: opts.rawResponse ?? null,
    modelLabel: opts.modelLabel ?? null,
    status: opts.status ?? 'done',
    error: opts.error ?? null,
    createdAt: nowTimestamp()
  }
  db.run(
    'INSERT INTO analyses (id, conversation_id, version, payload, raw_response, model_label, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [a.id, a.conversationId, a.version, JSON.stringify(payload), a.rawResponse, a.modelLabel, a.status, a.error, a.createdAt]
  )
  return a
}

interface AnalysisRow {
  id: string
  conversation_id: string
  version: number
  payload: string | null
  raw_response: string | null
  model_label: string | null
  status: Analysis['status']
  error: string | null
  created_at: string
}

function mapAnalysis(r: AnalysisRow): Analysis {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    version: r.version,
    payload: safeParse(r.payload),
    rawResponse: r.raw_response,
    modelLabel: r.model_label,
    status: r.status,
    error: r.error,
    createdAt: r.created_at
  }
}

export function latestAnalysis(db: SqliteDb, conversationId: string): Analysis | undefined {
  const row = db.get<AnalysisRow>(
    'SELECT * FROM analyses WHERE conversation_id = ? ORDER BY version DESC LIMIT 1',
    [conversationId]
  ) as AnalysisRow | undefined
  return row ? mapAnalysis(row) : undefined
}

export function getAnalysis(db: SqliteDb, id: string): Analysis | undefined {
  const row = db.get<AnalysisRow>('SELECT * FROM analyses WHERE id = ?', [id]) as AnalysisRow | undefined
  return row ? mapAnalysis(row) : undefined
}

function safeParse(s: string | null | undefined): AnalysisPayload {
  try {
    return s ? (JSON.parse(s) as AnalysisPayload) : {}
  } catch {
    return {}
  }
}

// ---------- 课表/校历导入待确认 ----------

/** 每个导入类会话取最新一条 status=done 且含可导入内容的提取结果 */
export function listPendingImports(db: SqliteDb, limit = 3): PendingImport[] {
  const rows = db.all<{
    id: string
    conversation_id: string
    payload: string | null
    created_at: string
    kind: string
    title: string
  }>(
    `SELECT a.id, a.conversation_id, a.payload, a.created_at, c.kind, c.title
     FROM analyses a JOIN conversations c ON c.id = a.conversation_id
     WHERE c.kind IN ('timetable','school-calendar') AND a.status = 'done' AND a.payload IS NOT NULL
     ORDER BY a.created_at DESC`
  )
  const seenConvs = new Set<string>()
  const out: PendingImport[] = []
  for (const r of rows) {
    if (seenConvs.has(r.conversation_id)) continue
    const payload = safeParse(r.payload)
    if ((payload.courses?.length ?? 0) === 0 && (payload.schoolEvents?.length ?? 0) === 0) continue
    seenConvs.add(r.conversation_id)
    out.push({
      analysisId: r.id,
      conversationId: r.conversation_id,
      kind: r.kind === 'timetable' ? 'timetable' : 'school-calendar',
      title: r.title,
      createdAt: r.created_at,
      payload
    })
    if (out.length >= limit) break
  }
  return out
}

export function markImportHandled(db: SqliteDb, analysisId: string): void {
  db.run("UPDATE analyses SET status = 'handled' WHERE id = ?", [analysisId])
}

// ---------- events ----------

const EVENT_COLS = 'id, title, start_at AS startAt, end_at AS endAt, all_day AS allDay, color, location, notes, source, source_ref AS sourceRef, reminder_minutes AS reminderMinutes, status, fingerprint, created_at AS createdAt, updated_at AS updatedAt'

export function listEventsRange(db: SqliteDb, from: string, to: string): CalendarEvent[] {
  return db.all<CalendarEvent>(
    `SELECT ${EVENT_COLS} FROM events WHERE status = 'active' AND start_at < ? AND end_at >= ? ORDER BY start_at`,
    [to, from]
  ) as CalendarEvent[]
}

export function getEvent(db: SqliteDb, id: string): CalendarEvent | undefined {
  return db.get<CalendarEvent>(`SELECT ${EVENT_COLS} FROM events WHERE id = ?`, [id]) as CalendarEvent | undefined
}

export function createEvent(db: SqliteDb, input: EventInput, source: CalendarEvent['source'] = 'manual'): CalendarEvent {
  const ts = nowTimestamp()
  const ev: CalendarEvent = {
    id: uid(),
    title: input.title,
    startAt: input.startAt!,
    endAt: input.endAt ?? input.startAt!,
    allDay: input.allDay ?? false,
    color: input.color ?? null,
    location: input.location ?? null,
    notes: input.notes ?? null,
    source,
    sourceRef: input.sourceRef ?? null,
    reminderMinutes: input.reminderMinutes ?? null,
    status: 'active',
    createdAt: ts,
    updatedAt: ts
  }
  const fp = eventFingerprint(ev)
  db.run(
    `INSERT INTO events (id, title, start_at, end_at, all_day, color, location, notes, source, source_ref, reminder_minutes, status, fingerprint, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [ev.id, ev.title, ev.startAt, ev.endAt, ev.allDay ? 1 : 0, ev.color, ev.location, ev.notes, ev.source, ev.sourceRef, ev.reminderMinutes ?? null, fp, ev.createdAt, ev.updatedAt]
  )
  ev.fingerprint = fp
  return ev
}

export function updateEvent(db: SqliteDb, id: string, patch: Partial<EventInput>): void {
  const existing = getEvent(db, id)
  if (!existing) return
  const merged = { ...existing, ...patch } as CalendarEvent
  db.run(
    `UPDATE events SET title = ?, start_at = ?, end_at = ?, all_day = ?, color = ?, location = ?, notes = ?, reminder_minutes = ?, status = ?, fingerprint = ?, updated_at = ? WHERE id = ?`,
    [
      merged.title,
      merged.startAt,
      merged.endAt,
      merged.allDay ? 1 : 0,
      merged.color ?? null,
      merged.location ?? null,
      merged.notes ?? null,
      merged.reminderMinutes ?? null,
      merged.status,
      eventFingerprint(merged),
      nowTimestamp(),
      id
    ]
  )
}

export function deleteEvent(db: SqliteDb, id: string): void {
  db.transaction(() => {
    db.run('UPDATE todos SET linked_event_id = NULL WHERE linked_event_id = ?', [id])
    db.run('DELETE FROM events WHERE id = ?', [id])
  })
}

// ---------- todos ----------

const TODO_COLS = 'id, title, notes, due_at AS dueAt, priority, completed_at AS completedAt, linked_event_id AS linkedEventId, source, source_ref AS sourceRef, fingerprint, created_at AS createdAt, updated_at AS updatedAt'

function attachLinkedEvent(db: SqliteDb, t: Todo): Todo {
  if (t.linkedEventId) {
    const ev = getEvent(db, t.linkedEventId)
    if (ev) t.linkedEvent = ev
  }
  return t
}

export function listTodos(db: SqliteDb): Todo[] {
  return (db.all<Todo>(`SELECT ${TODO_COLS} FROM todos ORDER BY (due_at IS NULL), due_at, created_at`) as Todo[]).map(
    (t) => attachLinkedEvent(db, t)
  )
}

export function getTodo(db: SqliteDb, id: string): Todo | undefined {
  const t = db.get<Todo>(`SELECT ${TODO_COLS} FROM todos WHERE id = ?`, [id]) as Todo | undefined
  return t ? attachLinkedEvent(db, t) : undefined
}

export function createTodo(db: SqliteDb, input: TodoInput, source: Todo['source'] = 'manual'): Todo {
  const ts = nowTimestamp()
  const todo: Todo = {
    id: uid(),
    title: input.title,
    notes: input.notes ?? null,
    dueAt: input.dueAt ?? null,
    priority: input.priority ?? 'normal',
    completedAt: null,
    linkedEventId: input.linkedEventId ?? null,
    source,
    sourceRef: input.sourceRef ?? null,
    createdAt: ts,
    updatedAt: ts
  }
  db.run(
    `INSERT INTO todos (id, title, notes, due_at, priority, completed_at, linked_event_id, source, source_ref, fingerprint, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [todo.id, todo.title, todo.notes, todo.dueAt, todo.priority, todo.completedAt, todo.linkedEventId, todo.source, todo.sourceRef, todoFingerprint(todo), todo.createdAt, todo.updatedAt]
  )
  return todo
}

export function updateTodo(db: SqliteDb, id: string, patch: Partial<TodoInput>): void {
  const existing = getTodo(db, id)
  if (!existing) return
  const merged = { ...existing, ...patch } as Todo
  db.run(
    `UPDATE todos SET title = ?, notes = ?, due_at = ?, priority = ?, completed_at = ?, linked_event_id = ?, fingerprint = ?, updated_at = ? WHERE id = ?`,
    [
      merged.title,
      merged.notes ?? null,
      merged.dueAt ?? null,
      merged.priority,
      merged.completedAt ?? null,
      merged.linkedEventId ?? null,
      todoFingerprint(merged),
      nowTimestamp(),
      id
    ]
  )
}

export function deleteTodo(db: SqliteDb, id: string): void {
  db.run('DELETE FROM todos WHERE id = ?', [id])
}

/** 确认候选事项:截止时间(待办)与执行时间(日程)分离 */
export function confirmCandidate(
  db: SqliteDb,
  item: ActionCandidate & { reminderMinutes?: number | null }
): { result: 'created' | 'duplicate'; refType: 'todo' | 'event'; refId: string } {
  // 参与人物并入备注,不改表结构
  const participantsNote =
    item.participants && item.participants.length > 0
      ? `${item.notes ? item.notes + '\n' : ''}参与人:${item.participants.join('、')}`
      : item.notes
  const notesWithParticipants = participantsNote
  if (item.type === 'event' && item.start) {
    const startAt = item.start
    const endAt = item.durationMinutes ? addMinutesIso(item.start, item.durationMinutes) : startAt
    const fp = eventFingerprint({ title: item.title, startAt })
    if (findDuplicateEvent(db, fp)) return { result: 'duplicate', refType: 'event', refId: '' }
    const ev = createEvent(
      db,
      { title: item.title, startAt, endAt, location: item.location, notes: notesWithParticipants, sourceRef: item.sourceRef, reminderMinutes: item.reminderMinutes ?? null },
      'analysis'
    )
    return { result: 'created', refType: 'event', refId: ev.id }
  }
  // 待办:有截止时间用截止时间;执行时间若提供则关联生成日程
  const fp = todoFingerprint({ title: item.title, dueAt: item.deadline ?? null })
  if (findDuplicateTodo(db, fp)) return { result: 'duplicate', refType: 'todo', refId: '' }
  const todo = createTodo(
    db,
    { title: item.title, notes: notesWithParticipants, dueAt: item.deadline ?? null, sourceRef: item.sourceRef },
    'analysis'
  )
  if (item.start) {
    const ev = createEvent(
      db,
      {
        title: `${item.title}(执行)`,
        startAt: item.start,
        endAt: item.durationMinutes ? addMinutesIso(item.start, item.durationMinutes) : item.start,
        notes: notesWithParticipants,
        sourceRef: item.sourceRef
      },
      'analysis'
    )
    updateTodo(db, todo.id, { linkedEventId: ev.id })
  }
  return { result: 'created', refType: 'todo', refId: todo.id }
}

// ---------- pending ----------

export function listPending(db: SqliteDb): PendingItem[] {
  return db.all<PendingItem>(
    "SELECT id, conversation_id AS conversationId, title, notes, status, created_at AS createdAt, updated_at AS updatedAt FROM pending_items WHERE status = 'open' ORDER BY created_at"
  ) as PendingItem[]
}

export function insertPending(
  db: SqliteDb,
  input: { conversationId?: string | null; title: string; notes?: string }
): PendingItem {
  const ts = nowTimestamp()
  const p: PendingItem = {
    id: uid(),
    conversationId: input.conversationId ?? null,
    title: input.title,
    notes: input.notes ?? null,
    status: 'open',
    createdAt: ts,
    updatedAt: ts
  }
  db.run(
    'INSERT INTO pending_items (id, conversation_id, title, notes, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [p.id, p.conversationId, p.title, p.notes, p.status, p.createdAt, p.updatedAt]
  )
  return p
}

export function updatePending(db: SqliteDb, id: string, patch: Partial<Pick<PendingItem, 'status' | 'title' | 'notes'>>): void {
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.status !== undefined) {
    sets.push('status = ?')
    vals.push(patch.status)
  }
  if (patch.title !== undefined) {
    sets.push('title = ?')
    vals.push(patch.title)
  }
  if (patch.notes !== undefined) {
    sets.push('notes = ?')
    vals.push(patch.notes)
  }
  if (sets.length === 0) return
  sets.push('updated_at = ?')
  vals.push(nowTimestamp())
  vals.push(id)
  db.run(`UPDATE pending_items SET ${sets.join(', ')} WHERE id = ?`, vals as never)
}

export function deletePending(db: SqliteDb, id: string): void {
  db.run('DELETE FROM pending_items WHERE id = ?', [id])
}

// ---------- semesters / courses / school events ----------

export function listSemesters(db: SqliteDb): Semester[] {
  return db.all<Semester>(
    'SELECT id, name, start_date AS startDate, weeks, created_at AS createdAt FROM semesters ORDER BY start_date DESC'
  ) as Semester[]
}

export function saveSemester(db: SqliteDb, input: { id?: string; name: string; startDate: string; weeks: number }): Semester {
  const id = input.id ?? uid()
  db.run(
    `INSERT INTO semesters (id, name, start_date, weeks, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, start_date = excluded.start_date, weeks = excluded.weeks`,
    [id, input.name, input.startDate, input.weeks, nowTimestamp()]
  )
  return { id, name: input.name, startDate: input.startDate, weeks: input.weeks, createdAt: nowTimestamp() }
}

export function deleteSemester(db: SqliteDb, id: string): void {
  db.transaction(() => {
    const courseIds = db.all<{ id: string }>('SELECT id FROM courses WHERE semester_id = ?', [id]).map((r) => r.id)
    for (const cid of courseIds) db.run('DELETE FROM course_overrides WHERE course_id = ?', [cid])
    db.run('DELETE FROM courses WHERE semester_id = ?', [id])
    db.run('DELETE FROM school_events WHERE semester_id = ?', [id])
    db.run('DELETE FROM semesters WHERE id = ?', [id])
  })
}

export function listCourses(db: SqliteDb, semesterId: string): Course[] {
  return db.all<Course & { weeks: string }>(
    'SELECT id, semester_id AS semesterId, name, weekday, start_time AS startTime, end_time AS endTime, weeks, location, teacher, created_at AS createdAt FROM courses WHERE semester_id = ? ORDER BY weekday, start_time',
    [semesterId]
  ).map((r) => ({ ...r, weeks: JSON.parse(r.weeks || '[]') })) as unknown as Course[]
}

export function saveCourse(db: SqliteDb, input: Course): string {
  const id = input.id ?? uid()
  db.run(
    `INSERT INTO courses (id, semester_id, name, weekday, start_time, end_time, weeks, location, teacher, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET semester_id = excluded.semester_id, name = excluded.name, weekday = excluded.weekday,
       start_time = excluded.start_time, end_time = excluded.end_time, weeks = excluded.weeks,
       location = excluded.location, teacher = excluded.teacher`,
    [id, input.semesterId, input.name, input.weekday, input.startTime, input.endTime, JSON.stringify(input.weeks), input.location ?? null, input.teacher ?? null, nowTimestamp()]
  )
  return id
}

export function deleteCourse(db: SqliteDb, id: string): void {
  db.transaction(() => {
    db.run('DELETE FROM course_overrides WHERE course_id = ?', [id])
    db.run('DELETE FROM courses WHERE id = ?', [id])
  })
}

export function listCourseOverrides(db: SqliteDb, courseId?: string): CourseOverride[] {
  const cols = 'id, course_id AS courseId, date, kind, new_start_time AS newStartTime, new_end_time AS newEndTime, new_location AS newLocation, note, created_at AS createdAt'
  if (courseId) return db.all<CourseOverride>(`SELECT ${cols} FROM course_overrides WHERE course_id = ?`, [courseId]) as CourseOverride[]
  return db.all<CourseOverride>(`SELECT ${cols} FROM course_overrides`) as CourseOverride[]
}

export function saveCourseOverride(db: SqliteDb, input: Omit<CourseOverride, 'createdAt'>): string {
  const id = input.id ?? uid()
  db.run(
    `INSERT INTO course_overrides (id, course_id, date, kind, new_start_time, new_end_time, new_location, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, new_start_time = excluded.new_start_time,
       new_end_time = excluded.new_end_time, new_location = excluded.new_location, note = excluded.note`,
    [id, input.courseId, input.date, input.kind, input.newStartTime ?? null, input.newEndTime ?? null, input.newLocation ?? null, input.note ?? null, nowTimestamp()]
  )
  return id
}

export function deleteCourseOverride(db: SqliteDb, id: string): void {
  db.run('DELETE FROM course_overrides WHERE id = ?', [id])
}

export function listSchoolEvents(db: SqliteDb, semesterId?: string): SchoolEvent[] {
  const cols = 'id, semester_id AS semesterId, type, title, start_date AS startDate, end_date AS endDate, note, created_at AS createdAt'
  if (semesterId) return db.all<SchoolEvent>(`SELECT ${cols} FROM school_events WHERE semester_id = ? ORDER BY start_date`, [semesterId]) as SchoolEvent[]
  return db.all<SchoolEvent>(`SELECT ${cols} FROM school_events ORDER BY start_date`) as SchoolEvent[]
}

export function saveSchoolEvent(db: SqliteDb, input: Omit<SchoolEvent, 'createdAt'>): string {
  const id = input.id ?? uid()
  db.run(
    `INSERT INTO school_events (id, semester_id, type, title, start_date, end_date, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET semester_id = excluded.semester_id, type = excluded.type, title = excluded.title,
       start_date = excluded.start_date, end_date = excluded.end_date, note = excluded.note`,
    [id, input.semesterId ?? null, input.type, input.title, input.startDate, input.endDate ?? null, input.note ?? null, nowTimestamp()]
  )
  return id
}

export function deleteSchoolEvent(db: SqliteDb, id: string): void {
  db.run('DELETE FROM school_events WHERE id = ?', [id])
}

// ---------- profile ----------

export function listProfileFacts(db: SqliteDb, status?: ProfileFact['status']): ProfileFact[] {
  const cols = 'id, category, key, value, source, status, created_at AS createdAt, updated_at AS updatedAt'
  if (status) return db.all<ProfileFact>(`SELECT ${cols} FROM profile_facts WHERE status = ? ORDER BY category, key`, [status]) as ProfileFact[]
  return db.all<ProfileFact>(`SELECT ${cols} FROM profile_facts ORDER BY category, key`) as ProfileFact[]
}

export function saveProfileFact(db: SqliteDb, input: { id?: string; category: ProfileFact['category']; key: string; value: string; source?: ProfileFact['source']; status?: ProfileFact['status'] }): ProfileFact {
  const id = input.id ?? uid()
  const ts = nowTimestamp()
  db.run(
    `INSERT INTO profile_facts (id, category, key, value, source, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET category = excluded.category, key = excluded.key, value = excluded.value,
       source = excluded.source, status = excluded.status, updated_at = excluded.updated_at`,
    [id, input.category, input.key, input.value, input.source ?? 'explicit', input.status ?? 'confirmed', ts, ts]
  )
  return { id, category: input.category, key: input.key, value: input.value, source: input.source ?? 'explicit', status: input.status ?? 'confirmed', createdAt: ts, updatedAt: ts }
}

export function deleteProfileFact(db: SqliteDb, id: string): void {
  db.run('DELETE FROM profile_facts WHERE id = ?', [id])
}

// ---------- fired reminders ----------

export function isReminderFired(db: SqliteDb, key: string): boolean {
  return !!db.get('SELECT key FROM fired_reminders WHERE key = ?', [key])
}

export function markReminderFired(db: SqliteDb, key: string): void {
  db.run('INSERT OR IGNORE INTO fired_reminders (key, fired_at) VALUES (?, ?)', [key, nowTimestamp()])
}

// ---------- school event type guard ----------

export function isExtractedSchoolEvent(x: unknown): x is ExtractedSchoolEvent {
  return !!x && typeof x === 'object' && 'title' in (x as object) && 'startDate' in (x as object)
}
