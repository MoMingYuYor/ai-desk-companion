import type { Analysis } from './types'

export type MailProvider = 'qq' | '163' | 'gmail' | 'custom'

export type MailErrorCode =
  | 'INVALID_CONFIG'
  | 'AUTH'
  | 'TLS'
  | 'NETWORK'
  | 'CRYPTO'
  | 'LIMIT'
  | 'CANCELLED'
  | 'NOT_FOUND'
  | 'PARSE'
  | 'STORAGE'
  | 'BUSY'

export type MailResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: MailErrorCode; message: string }

export interface MailAccountInput {
  id?: string
  label: string
  email: string
  provider: MailProvider
  host: string
  port: number
  credential?: string
}

export interface MailAccountInfo {
  id: string
  label: string
  email: string
  provider: MailProvider
  host: string
  port: number
  enabled: boolean
  hasCredential: boolean
  status: 'idle' | 'syncing' | 'paused' | 'error'
  lastSuccessAt: string | null
  error: { code: MailErrorCode; message: string } | null
}

export interface MailListQuery {
  accountId?: string
  unreadOnly?: boolean
  search?: string
  page?: number
}

export interface MailSummary {
  id: string
  accountId: string
  accountLabel: string
  subject: string
  from: string
  to: string
  receivedAt: string
  read: boolean
  hasAttachments: boolean
  bodyState: 'missing' | 'cached' | 'error'
  remoteAvailable: boolean
}

export interface MailAttachmentInfo {
  id: string
  messageId: string
  name: string
  mime: string
  size: number | null
  downloaded: boolean
  analyzable: boolean
}

export interface MailDetail {
  message: MailSummary
  text: string
  safeHtml: string
  links: Array<{ label: string; url: string }>
  attachments: MailAttachmentInfo[]
}

export interface MailSource {
  sourceKey: string
  messageId: string | null
  accountEmail: string
  subject: string
  from: string
  receivedAt: string
  accountRemoved: boolean
}

export interface MailAnalysisRequest {
  messageId: string
  attachmentIds: string[]
}

export interface MailAnalysisStatus {
  conversationId: string
  state: 'preparing' | 'running' | 'done' | 'failed' | 'cancelled'
  analysisId: string | null
  error: string | null
}

export interface MailSyncNotice {
  accountId: string
  status: MailAccountInfo['status']
  loaded: number
  lastSuccessAt: string | null
  error: MailAccountInfo['error']
}

export const MAIL_LIMITS = {
  page: 50,
  batch: 50,
  accounts: 2,
  intervalMs: 300_000,
  timeoutMs: 30_000,
  bodyBytes: 5 * 1024 * 1024,
  attachmentBytes: 20 * 1024 * 1024,
  analysisBytes: 20 * 1024 * 1024
} as const

export interface MailApi {
  accounts(): Promise<MailResult<MailAccountInfo[]>>
  test(input: MailAccountInput): Promise<MailResult<void>>
  save(input: MailAccountInput): Promise<MailResult<MailAccountInfo>>
  setEnabled(id: string, enabled: boolean): Promise<MailResult<void>>
  remove(id: string): Promise<MailResult<void>>
  sync(id: string): Promise<MailResult<void>>
  earlier(id: string): Promise<MailResult<void>>
  list(query: MailListQuery): Promise<MailResult<{ items: MailSummary[]; hasMore: boolean }>>
  detail(id: string): Promise<MailResult<MailDetail>>
  markRead(id: string, read: boolean): Promise<MailResult<void>>
  download(id: string): Promise<MailResult<MailAttachmentInfo>>
  saveAttachment(id: string): Promise<MailResult<{ saved: boolean }>>
  openLink(messageId: string, url: string): Promise<MailResult<void>>
  analyze(input: MailAnalysisRequest): Promise<MailResult<MailAnalysisStatus>>
  analysisStatus(messageId: string): Promise<MailResult<MailAnalysisStatus | null>>
  cancelAnalysis(conversationId: string): Promise<MailResult<void>>
  source(sourceKey: string): Promise<MailResult<MailSource | null>>
}

export interface MailEventMap {
  'evt:mail-sync': MailSyncNotice
  'evt:mail-changed': { accountId: string }
  'evt:mail-analysis': MailAnalysisStatus
}

export type MailSubscribe = <K extends keyof MailEventMap>(
  channel: K,
  listener: (payload: MailEventMap[K]) => void
) => () => void

export interface MailAnalysisHistoryApi {
  listAnalyses(conversationId: string): Promise<Analysis[]>
}
