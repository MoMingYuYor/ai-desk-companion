import type {
  MailAccountInfo,
  MailAttachmentInfo,
  MailDetail,
  MailListQuery,
  MailSummary,
  MailAnalysisRequest,
  MailAnalysisStatus
} from '../../shared/mail'
import type { EnvelopeRow } from './adapter'

export interface SyncState {
  mailbox: string
  uidValidity: string | null
  lastUid: number
  oldestDay: string | null
  initialized: boolean
}

export interface MailAccountPort {
  list(): MailAccountInfo[]
  get(id: string): MailAccountInfo | null
  connection(id: string): { host: string; port: number; email: string; password: string }
}

export interface MailRepositoryPort {
  state(accountId: string): SyncState
  commitBatch(accountId: string, validity: string, rows: EnvelopeRow[], next: SyncState): number
  list(query: MailListQuery): { items: MailSummary[]; hasMore: boolean }
  get(id: string): MailSummary | null
  markRead(id: string, read: boolean): void
  invalidateRemote(accountId: string): void
  removeAccountCache(accountId: string): void
  record(id: string): {
    message: MailSummary
    uid: number | null
    uidValidity: string | null
    structure: EnvelopeRow
    bodyPath: string | null
  } | null
  attachment(id: string): (MailAttachmentInfo & { part: string; cachePath: string | null }) | null
  setBodyCache(id: string, path: string): void
  setAttachmentCache(id: string, path: string): void
}

export interface MailExecutionPort {
  runExclusive<T>(id: string, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>
}

export interface MailContentPort {
  detail(id: string, signal: AbortSignal): Promise<MailDetail>
  download(id: string, signal: AbortSignal): Promise<MailAttachmentInfo>
  attachmentPath(id: string): string
  removeCache(accountId: string): Promise<void>
}

export interface MailAnalysisPort {
  start(input: MailAnalysisRequest): Promise<MailAnalysisStatus>
  status(messageId: string): MailAnalysisStatus | null
  cancel(conversationId: string): Promise<void>
  quiesce(): Promise<() => void>
}
