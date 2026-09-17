// 邮件分析来源、版本与确认映射的数据库操作(C 区)。
// 只操作 mail_analysis_links / mail_analysis_versions / mail_confirmations 三张表。
import type { SqliteDb } from '../db/connection'

export type MailLinkStatus = 'idle' | 'preparing' | 'running' | 'done' | 'failed' | 'cancelled'
export type MailConfirmationRefType = 'todo' | 'event'

export interface MailLink {
  sourceKey: string
  messageId: string | null
  conversationId: string | null
  /** JSON 字符串,MailSource 形状的来源快照 */
  snapshot: string
  lastMaterialIds: string[]
  status: MailLinkStatus
  lastError: string | null
}

export interface MailAnalysisVersionRow {
  analysisId: string
  version: number
  status: string
  createdAt: string
  materialIds: string[]
}

export interface MailConfirmation {
  analysisId: string
  candidateIndex: number
  sourceKey: string
  refType: MailConfirmationRefType
  refId: string
}

interface LinkRow {
  sourceKey: string
  messageId: string | null
  conversationId: string | null
  snapshot: string
  lastMaterialIds: string
  status: string
  lastError: string | null
}

const LINK_COLS =
  'source_key AS sourceKey, message_id AS messageId, conversation_id AS conversationId, ' +
  'snapshot, last_material_ids AS lastMaterialIds, status, last_error AS lastError'
const CONF_COLS =
  'analysis_id AS analysisId, candidate_index AS candidateIndex, source_key AS sourceKey, ' +
  'ref_type AS refType, ref_id AS refId'

function parseIdList(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : []
  } catch {
    return []
  }
}

function toLink(row: LinkRow | undefined): MailLink | null {
  if (!row) return null
  return {
    sourceKey: row.sourceKey,
    messageId: row.messageId,
    conversationId: row.conversationId,
    snapshot: row.snapshot,
    lastMaterialIds: parseIdList(row.lastMaterialIds),
    status: (row.status as MailLinkStatus) ?? 'idle',
    lastError: row.lastError
  }
}

/** 幂等建立来源链接:已存在(按 sourceKey)返回既有记录,否则插入 idle 状态新行 */
export function ensureLink(
  db: SqliteDb,
  input: { sourceKey: string; messageId: string | null; snapshot: string }
): MailLink {
  const existing = getLinkBySource(db, input.sourceKey)
  if (existing) return existing
  db.run(
    `INSERT INTO mail_analysis_links (source_key, message_id, snapshot, last_material_ids, status, last_error)
     VALUES (?, ?, ?, '[]', 'idle', NULL)`,
    [input.sourceKey, input.messageId, input.snapshot]
  )
  return getLinkBySource(db, input.sourceKey)!
}

export function getLinkBySource(db: SqliteDb, sourceKey: string): MailLink | null {
  return toLink(
    db.get<LinkRow>(`SELECT ${LINK_COLS} FROM mail_analysis_links WHERE source_key = ?`, [sourceKey])
  )
}

export function getLinkByMessage(db: SqliteDb, messageId: string): MailLink | null {
  return toLink(
    db.get<LinkRow>(`SELECT ${LINK_COLS} FROM mail_analysis_links WHERE message_id = ?`, [messageId])
  )
}

export function getLinkByConversation(db: SqliteDb, conversationId: string): MailLink | null {
  return toLink(
    db.get<LinkRow>(
      `SELECT ${LINK_COLS} FROM mail_analysis_links WHERE conversation_id = ?`,
      [conversationId]
    )
  )
}

/** 分析首次开始创建会话后回写绑定(link 与会话一对一) */
export function setLinkConversation(db: SqliteDb, sourceKey: string, conversationId: string): void {
  db.run('UPDATE mail_analysis_links SET conversation_id = ? WHERE source_key = ?', [
    conversationId,
    sourceKey
  ])
}

export function setLinkStatus(
  db: SqliteDb,
  sourceKey: string,
  status: MailLinkStatus,
  error?: string | null
): void {
  db.run('UPDATE mail_analysis_links SET status = ?, last_error = ? WHERE source_key = ?', [
    status,
    error ?? null,
    sourceKey
  ])
}

export function setLinkLastMaterials(db: SqliteDb, sourceKey: string, materialIds: string[]): void {
  db.run('UPDATE mail_analysis_links SET last_material_ids = ? WHERE source_key = ?', [
    JSON.stringify(materialIds),
    sourceKey
  ])
}

/** 记录一次分析的输入版本,并把快照同步到 link.last_material_ids */
export function recordVersion(
  db: SqliteDb,
  analysisId: string,
  sourceKey: string,
  materialIds: string[]
): void {
  db.transaction(() => {
    db.run(
      'INSERT INTO mail_analysis_versions (analysis_id, source_key, material_ids) VALUES (?, ?, ?)',
      [analysisId, sourceKey, JSON.stringify(materialIds)]
    )
    db.run('UPDATE mail_analysis_links SET last_material_ids = ? WHERE source_key = ?', [
      JSON.stringify(materialIds),
      sourceKey
    ])
  })
}

export function listAnalysisVersions(db: SqliteDb, sourceKey: string): MailAnalysisVersionRow[] {
  return db
    .all<{
      analysisId: string
      version: number
      status: string
      createdAt: string
      materialIds: string
    }>(
      `SELECT v.analysis_id AS analysisId, a.version AS version, a.status AS status,
              a.created_at AS createdAt, v.material_ids AS materialIds
       FROM mail_analysis_versions v
       JOIN analyses a ON a.id = v.analysis_id
       WHERE v.source_key = ?
       ORDER BY a.version, v.rowid`,
      [sourceKey]
    )
    .map((row) => ({ ...row, materialIds: parseIdList(row.materialIds) }))
}

/** 按 analysisId 反查来源键(非邮箱分析的普通会话返回 null) */
export function getSourceKeyByAnalysis(db: SqliteDb, analysisId: string): string | null {
  const row = db.get<{ sourceKey: string }>(
    'SELECT source_key AS sourceKey FROM mail_analysis_versions WHERE analysis_id = ?',
    [analysisId]
  )
  return row?.sourceKey ?? null
}

/** 幂等写入确认映射:主键(analysis_id, candidate_index)已存在时不重复插入,返回是否新插入 */
export function recordConfirmation(
  db: SqliteDb,
  input: {
    analysisId: string
    candidateIndex: number
    sourceKey: string
    refType: MailConfirmationRefType
    refId: string
  }
): boolean {
  const existing = db.get(
    'SELECT analysis_id FROM mail_confirmations WHERE analysis_id = ? AND candidate_index = ?',
    [input.analysisId, input.candidateIndex]
  )
  if (existing) return false
  db.run(
    `INSERT OR IGNORE INTO mail_confirmations (analysis_id, candidate_index, source_key, ref_type, ref_id)
     VALUES (?, ?, ?, ?, ?)`,
    [input.analysisId, input.candidateIndex, input.sourceKey, input.refType, input.refId]
  )
  return true
}

/**
 * 按候选查找确认映射。
 * candidateIdOrIndex 为 number 时按 (source_key, candidate_index) 取最近一条;
 * 为 string 时按邮箱候选 ID 约定 `${analysisId}:${index}` 精确匹配。
 */
export function findConfirmationByCandidate(
  db: SqliteDb,
  sourceKey: string,
  candidateIdOrIndex: string | number
): MailConfirmation | null {
  if (typeof candidateIdOrIndex === 'number') {
    const row = db.get<MailConfirmation>(
      `SELECT ${CONF_COLS} FROM mail_confirmations
       WHERE source_key = ? AND candidate_index = ?
       ORDER BY rowid DESC LIMIT 1`,
      [sourceKey, candidateIdOrIndex]
    )
    return row ?? null
  }
  const match = /^(.+):(\d+)$/.exec(candidateIdOrIndex)
  if (!match) return null
  const row = db.get<MailConfirmation>(
    `SELECT ${CONF_COLS} FROM mail_confirmations
     WHERE source_key = ? AND analysis_id = ? AND candidate_index = ?`,
    [sourceKey, match[1], Number(match[2])]
  )
  return row ?? null
}
