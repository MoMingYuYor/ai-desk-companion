import type { EnvelopeRow, MailSession } from '../../src/main/mail/adapter'

/** 生成一条合成信封行 */
export function makeEnvelope(uid: number, overrides: Partial<EnvelopeRow> = {}): EnvelopeRow {
  return {
    uid,
    messageId: `<msg-${uid}@example.com>`,
    subject: `测试邮件 ${uid}`,
    from: 'sender@example.com',
    to: 'me@example.com',
    receivedAt: '2026-09-10T08:00:00.000Z',
    size: 1024,
    seen: false,
    textParts: [{ part: '1', name: '', mime: 'text/plain', size: 100, charset: 'utf-8' }],
    htmlParts: [],
    attachments: [],
    ...overrides
  }
}

/** 完整实现 MailSession 的假会话:信封数据可注入,不连接网络 */
export class FakeSession implements MailSession {
  calls: string[] = []
  uidValidity: string = '111'
  uidNext = 10
  openCount = 0
  closeCount = 0
  cancelCount = 0
  envelopesByUid = new Map<number, EnvelopeRow>()
  /** 每次 envelopes 调用前的钩子(可用于触发 abort) */
  onEnvelopes?: (uids: number[]) => void
  searchError: Error | null = null

  async open(): Promise<{ uidValidity: string; uidNext: number }> {
    this.openCount += 1
    this.calls.push(`open#${this.openCount}`)
    return { uidValidity: String(this.uidValidity), uidNext: this.uidNext }
  }

  async searchDays(since: string, before: string): Promise<number[]> {
    this.calls.push(`searchDays:${since}:${before}`)
    if (this.searchError) throw this.searchError
    return [...this.envelopesByUid.values()]
      .filter((row) => {
        const day = row.receivedAt.slice(0, 10)
        return day >= since && day < before
      })
      .map((row) => row.uid)
      .sort((a, b) => a - b)
  }

  async searchUids(after: number, through: number): Promise<number[]> {
    this.calls.push(`searchUids:${after}:${through}`)
    if (this.searchError) throw this.searchError
    if (after >= through) return []
    return [...this.envelopesByUid.keys()]
      .filter((uid) => uid > after && uid <= through)
      .sort((a, b) => a - b)
  }

  async envelopes(uids: number[]): Promise<EnvelopeRow[]> {
    this.calls.push(`envelopes:${uids.join(',')}`)
    if (this.onEnvelopes) this.onEnvelopes(uids)
    return uids
      .map((uid) => this.envelopesByUid.get(uid))
      .filter((row): row is EnvelopeRow => row != null)
  }

  async part(): Promise<never> {
    throw new Error('FakeSession 未实现 part')
  }

  async close(): Promise<void> {
    this.closeCount += 1
    this.calls.push('close')
  }

  cancel(): void {
    this.cancelCount += 1
    this.calls.push('cancel')
  }
}
