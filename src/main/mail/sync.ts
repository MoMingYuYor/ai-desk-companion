import { MAIL_LIMITS } from '../../shared/mail'
import type { MailSession, SessionFactory } from './adapter'
import { MailError } from './errors'
import type { MailAccountPort, MailRepositoryPort, SyncState } from './ports'
import { earlierWindow, incrementalRange, initialWindow, shiftDay } from './windows'

export type SyncRequestMode = 'refresh' | 'earlier'
export type SyncKind = 'initial' | 'incremental' | 'history'

export interface SyncRunResult {
  added: number
  initial: boolean
}

/** 决定本次同步的分支:未初始化先扫初始窗口;否则按请求走增量或历史 */
export function syncMode(state: SyncState, requested: SyncRequestMode): SyncKind {
  if (!state.initialized) return 'initial'
  return requested === 'earlier' ? 'history' : 'incremental'
}

function cancelledError(): MailError {
  return new MailError('CANCELLED', '同步已取消')
}

function chunkBatch<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

/**
 * 初次、增量与历史同步工作流。
 * 通过 SessionFactory 建立只读会话,游标与邮件批次由 MailRepositoryPort 持久化。
 */
export class MailSyncWorker {
  constructor(
    private readonly accounts: MailAccountPort,
    private readonly repository: MailRepositoryPort,
    private readonly factory: SessionFactory
  ) {}

  private ensureLive(signal: AbortSignal): void {
    if (signal.aborted) throw cancelledError()
  }

  /** 分批抓取并提交;buildNext 决定游标推进策略,最后一批才允许落终态 */
  private async commitUidChunks(
    accountId: string,
    session: MailSession,
    validity: string,
    uids: number[],
    signal: AbortSignal,
    buildNext: (chunkTop: number, isFinal: boolean, lastUid: number) => SyncState
  ): Promise<number> {
    let added = 0
    let lastUid = 0
    const chunks = chunkBatch(uids, MAIL_LIMITS.batch)
    for (let index = 0; index < chunks.length; index += 1) {
      this.ensureLive(signal)
      const chunk = chunks[index]
      const rows = await session.envelopes(chunk)
      const chunkTop = chunk[chunk.length - 1]
      lastUid = Math.max(lastUid, chunkTop)
      const isFinal = index === chunks.length - 1
      added += this.repository.commitBatch(accountId, validity, rows, buildNext(chunkTop, isFinal, lastUid))
    }
    return added
  }

  private async runInitial(
    accountId: string,
    session: MailSession,
    state: SyncState,
    day: string,
    signal: AbortSignal
  ): Promise<SyncRunResult> {
    const first = await session.open()
    const validity = first.uidValidity
    // cap 是初始 open() 的固定快照:本轮窗口检索只装载 uid <= cap,完成后游标一次性推进到 cap
    const cap = first.uidNext - 1
    let lastUid = state.lastUid
    if (state.uidValidity != null && validity !== state.uidValidity) {
      // 上次初始化中断后邮箱被重建:旧行全部失效,由仓储按指纹复用
      this.repository.invalidateRemote(accountId)
      lastUid = 0
    }
    const win = initialWindow(day)
    this.ensureLive(signal)
    const uids = (await session.searchDays(win.since, win.before))
      .filter((uid) => uid <= cap)
      .sort((a, b) => a - b)

    let added = 0
    if (uids.length === 0) {
      // 空窗口:提交成功即推进到 cap 并完成初始化,绝不回捞窗口外历史(AC10)
      added += this.repository.commitBatch(accountId, validity, [], {
        mailbox: 'INBOX',
        uidValidity: validity,
        lastUid: Math.max(lastUid, cap),
        oldestDay: win.since,
        initialized: true
      })
    } else {
      added = await this.commitUidChunks(accountId, session, validity, uids, signal, (_top, isFinal, maxUid) => {
        // 非最后一批只推进到该批已处理最大 UID 并保留未初始化标记;
        // 最后一批完整提交才把 lastUid 推进到 cap
        lastUid = isFinal ? Math.max(lastUid, cap) : Math.max(lastUid, maxUid)
        return {
          mailbox: 'INBOX',
          uidValidity: validity,
          lastUid,
          oldestDay: win.since,
          initialized: isFinal
        }
      })
    }

    // 补收初始扫描期间新到的邮件:仅补 (cap, 新 uidNext-1],不重扫 cap 及以下
    this.ensureLive(signal)
    const reopened = await session.open()
    if (validity !== reopened.uidValidity) {
      // 初始化期间邮箱身份被重建:进入远端身份重建分支,不把旧 UID 当新邮箱记录
      return this.rescanAfterReset(accountId, session, state, reopened.uidValidity, reopened.uidNext, day, signal)
    }
    if (incrementalRange(cap, reopened.uidNext) != null) {
      const catchUp = (await session.searchUids(cap, reopened.uidNext - 1)).sort((a, b) => a - b)
      added += await this.commitUidChunks(accountId, session, validity, catchUp, signal, (_top, isFinal, maxUid) => {
        lastUid = isFinal ? Math.max(lastUid, reopened.uidNext - 1) : Math.max(lastUid, maxUid)
        return {
          mailbox: 'INBOX',
          uidValidity: validity,
          lastUid,
          oldestDay: win.since,
          initialized: true
        }
      })
    }
    return { added, initial: true }
  }

  /** UIDVALIDITY 变化后的重建:失效旧行,从最早已扫描日(或初始窗口)重新扫到当天 */
  private async rescanAfterReset(
    accountId: string,
    session: MailSession,
    state: SyncState,
    validity: string,
    uidNext: number,
    day: string,
    signal: AbortSignal
  ): Promise<SyncRunResult> {
    this.repository.invalidateRemote(accountId)
    const since = state.oldestDay ?? shiftDay(day, -29)
    const before = shiftDay(day, 1)
    const cap = uidNext - 1
    this.ensureLive(signal)
    const uids = (await session.searchDays(since, before))
      .filter((uid) => uid <= cap)
      .sort((a, b) => a - b)
    let lastUid = 0
    const added = await this.commitUidChunks(accountId, session, validity, uids, signal, (_top, _isFinal, maxUid) => {
      lastUid = Math.max(lastUid, maxUid)
      return {
        mailbox: 'INBOX',
        uidValidity: validity,
        lastUid,
        oldestDay: state.oldestDay ?? since,
        initialized: true
      }
    })
    return { added, initial: false }
  }

  private async runIncremental(
    accountId: string,
    session: MailSession,
    state: SyncState,
    day: string,
    signal: AbortSignal
  ): Promise<SyncRunResult> {
    const { uidValidity: validity, uidNext } = await session.open()
    if (state.uidValidity != null && validity !== state.uidValidity) {
      return this.rescanAfterReset(accountId, session, state, validity, uidNext, day, signal)
    }
    if (incrementalRange(state.lastUid, uidNext) == null) return { added: 0, initial: false }
    this.ensureLive(signal)
    const uids = (await session.searchUids(state.lastUid, uidNext - 1)).sort((a, b) => a - b)
    let lastUid = state.lastUid
    const added = await this.commitUidChunks(accountId, session, validity, uids, signal, (_top, _isFinal, maxUid) => {
      // 被远端删除的 UID 可以跳过,批次进度推进到已处理请求上界
      lastUid = Math.max(lastUid, maxUid)
      return {
        mailbox: 'INBOX',
        uidValidity: validity,
        lastUid,
        oldestDay: state.oldestDay,
        initialized: true
      }
    })
    return { added, initial: false }
  }

  private async runHistory(
    accountId: string,
    session: MailSession,
    state: SyncState,
    day: string,
    signal: AbortSignal
  ): Promise<SyncRunResult> {
    const { uidValidity: validity, uidNext } = await session.open()
    if (state.uidValidity != null && validity !== state.uidValidity) {
      return this.rescanAfterReset(accountId, session, state, validity, uidNext, day, signal)
    }
    const oldest = state.oldestDay ?? shiftDay(day, -29)
    const win = earlierWindow(oldest)
    this.ensureLive(signal)
    const uids = (await session.searchDays(win.since, win.before)).sort((a, b) => a - b)
    if (uids.length === 0) {
      // 空历史窗口正常返回 0,但窗口照常前移,不重复扫描同一区间
      this.repository.commitBatch(accountId, validity, [], {
        mailbox: 'INBOX',
        uidValidity: validity,
        lastUid: state.lastUid,
        oldestDay: win.since,
        initialized: true
      })
      return { added: 0, initial: false }
    }
    let lastUid = state.lastUid
    const added = await this.commitUidChunks(accountId, session, validity, uids, signal, (_top, isFinal, maxUid) => {
      // 历史扫描只前移 oldestDay,不回退 lastUid
      lastUid = Math.max(lastUid, maxUid)
      return {
        mailbox: 'INBOX',
        uidValidity: validity,
        lastUid,
        oldestDay: isFinal ? win.since : state.oldestDay,
        initialized: true
      }
    })
    return { added, initial: false }
  }

  async run(
    accountId: string,
    mode: SyncRequestMode,
    day: string,
    signal: AbortSignal
  ): Promise<SyncRunResult> {
    const state = this.repository.state(accountId)
    const kind = syncMode(state, mode)
    this.ensureLive(signal)
    const connection = this.accounts.connection(accountId)
    const session = this.factory(connection, signal)
    try {
      if (kind === 'initial') return await this.runInitial(accountId, session, state, day, signal)
      if (kind === 'history') return await this.runHistory(accountId, session, state, day, signal)
      return await this.runIncremental(accountId, session, state, day, signal)
    } finally {
      try {
        await session.close()
      } catch {
        // 关闭失败不掩盖同步结果
      }
    }
  }
}
