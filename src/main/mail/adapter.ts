import type { Readable } from 'node:stream'

export interface PartInfo {
  part: string
  name: string
  mime: string
  size: number | null
  charset?: string
}

export interface EnvelopeRow {
  uid: number
  messageId: string | null
  subject: string
  from: string
  to: string
  receivedAt: string
  size: number
  seen: boolean
  textParts: PartInfo[]
  htmlParts: PartInfo[]
  attachments: PartInfo[]
}

export interface MailSession {
  open(): Promise<{ uidValidity: string; uidNext: number }>
  searchDays(since: string, before: string): Promise<number[]>
  searchUids(after: number, through: number): Promise<number[]>
  envelopes(uids: number[]): Promise<EnvelopeRow[]>
  part(uid: number, part: string): Promise<Readable>
  close(): Promise<void>
  cancel(): void
}

export type SessionFactory = (
  connection: {
    host: string
    port: number
    email: string
    password: string
  },
  signal: AbortSignal
) => MailSession
