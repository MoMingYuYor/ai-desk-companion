// 邮件草稿数据访问(A-01):Agent 可创建草稿,永远不能发送(无发送状态字段)。
// 领域规则:收件人以 JSON 数组持久化;草稿不进入既有邮件收件缓存。

import type { SqliteDb } from '../db/connection'
import { uid } from '../db/dao'
import { nowTimestamp } from '../../shared/dateUtils'
import { appError } from '../../shared/operations'
import { OperationError } from '../db/operations'

export interface MailDraft {
  draftId: string
  recipients: string[]
  subject: string
  body: string
  sourceRef: string | null
  revision: number
  createdAt: string
  updatedAt: string
}

export interface CreateMailDraftInput {
  recipients?: string[]
  subject?: string
  body: string
  sourceRef?: string | null
}

interface DraftRow {
  draft_id: string
  recipients: string
  subject: string
  body: string
  source_ref: string | null
  revision: number
  created_at: string
  updated_at: string
}

function toDraft(row: DraftRow): MailDraft {
  let recipients: string[] = []
  try {
    const parsed: unknown = JSON.parse(row.recipients)
    if (Array.isArray(parsed)) recipients = parsed.filter((r): r is string => typeof r === 'string')
  } catch {
    recipients = []
  }
  return {
    draftId: row.draft_id,
    recipients,
    subject: row.subject,
    body: row.body,
    sourceRef: row.source_ref,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function createMailDraft(db: SqliteDb, input: CreateMailDraftInput): MailDraft {
  if (input.body.trim() === '') {
    throw new OperationError(appError('VALIDATION', '草稿正文不能为空', { retryable: false }))
  }
  const draft: MailDraft = {
    draftId: uid(),
    recipients: input.recipients ?? [],
    subject: input.subject ?? '',
    body: input.body,
    sourceRef: input.sourceRef ?? null,
    revision: 1,
    createdAt: nowTimestamp(),
    updatedAt: nowTimestamp()
  }
  db.run(
    `INSERT INTO mail_drafts (draft_id, recipients, subject, body, source_ref, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      draft.draftId,
      JSON.stringify(draft.recipients),
      draft.subject,
      draft.body,
      draft.sourceRef,
      draft.revision,
      draft.createdAt,
      draft.updatedAt
    ]
  )
  return draft
}

export function listMailDrafts(db: SqliteDb): MailDraft[] {
  return db
    .all<DraftRow>('SELECT * FROM mail_drafts ORDER BY created_at DESC, draft_id ASC')
    .map(toDraft)
}

export function getMailDraft(db: SqliteDb, draftId: string): MailDraft | null {
  const row = db.get<DraftRow>('SELECT * FROM mail_drafts WHERE draft_id = ?', [draftId])
  return row ? toDraft(row) : null
}
