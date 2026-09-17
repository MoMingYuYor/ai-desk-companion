import { MAIL_LIMITS } from '../../shared/mail'
import type { MailErrorCode, MailSyncNotice } from '../../shared/mail'
import type { MailAccountStore } from './accounts'
import { MailError, classifyError, isMailError } from './errors'
import type { SyncRequestMode, SyncRunResult } from './sync'
import type { MailSyncWorker } from './sync'

export const DEFAULT_BACKOFF_DELAYS: readonly number[] = [30_000, 60_000, 120_000, 300_000]

/** NETWORK 按退避间隔重试;AUTH/TLS/CRYPTO 等不可恢复错误返回 null(直接抛出) */
export function retryDelay(
  attempt: number,
  code: MailErrorCode,
  delays: readonly number[] = DEFAULT_BACKOFF_DELAYS
): number | null {
  if (code !== 'NETWORK') return null
  return delays[Math.min(Math.max(attempt, 0), delays.length - 1)]
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      reject(new MailError('CANCELLED', '等待重试时已取消'))
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/** 指数退避封装:仅 NETWORK 错误重试,间隔由 delays 注入(测试可传 0) */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts?: { delays?: readonly number[]; signal?: AbortSignal }
): Promise<T> {
  const delays = opts?.delays ?? DEFAULT_BACKOFF_DELAYS
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      const code = isMailError(err) ? err.code : classifyError(err).code
      const delay = retryDelay(attempt, code, delays)
      if (delay == null || opts?.signal?.aborted) throw err
      await sleep(delay, opts?.signal)
    }
  }
}

/** 本地日历日期,用于初始同步窗口锚点 */
export function todayLocalDay(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export interface MailSchedulerHooks {
  onNotice(notice: MailSyncNotice): void
}

export interface MailSchedulerOptions {
  /** 退避间隔注入点;默认 30s → 1m → 2m → 5m */
  backoffDelays?: number[]
}

/**
 * 同步调度器:同账号互斥串行(并发第二次抛 BUSY),
 * runDue 最多 2 个账号并发,NETWORK 失败按退避重试。
 */
export class MailScheduler {
  private readonly mutex = new Map<string, Promise<SyncRunResult>>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly backoffDelays: readonly number[]

  constructor(
    private readonly worker: MailSyncWorker,
    private readonly accounts: MailAccountStore,
    private readonly hooks: MailSchedulerHooks,
    options?: MailSchedulerOptions
  ) {
    this.backoffDelays = options?.backoffDelays ?? DEFAULT_BACKOFF_DELAYS
  }

  private emit(
    id: string,
    status: MailSyncNotice['status'],
    loaded: number,
    error: MailSyncNotice['error'] = null
  ): void {
    const info = this.accounts.get(id)
    this.hooks.onNotice({
      accountId: id,
      status,
      loaded,
      lastSuccessAt: info?.lastSuccessAt ?? null,
      error
    })
  }

  private async doSync(id: string, mode: SyncRequestMode, signal: AbortSignal): Promise<SyncRunResult> {
    this.accounts.setStatus(id, 'syncing')
    this.emit(id, 'syncing', 0)
    try {
      const result = await withBackoff(() => this.worker.run(id, mode, todayLocalDay(), signal), {
        delays: this.backoffDelays,
        signal
      })
      this.accounts.updateSuccess(id)
      this.emit(id, 'idle', result.added)
      return result
    } catch (err) {
      const mailError = err instanceof MailError ? err : classifyError(err)
      if (mailError.code === 'CANCELLED') {
        this.accounts.setStatus(id, 'idle', undefined)
        this.emit(id, 'idle', 0)
      } else {
        this.accounts.setStatus(id, 'error', { code: mailError.code, message: mailError.message })
        this.emit(id, 'error', 0, { code: mailError.code, message: mailError.message })
      }
      throw mailError
    }
  }

  /** 同一账号串行:已在运行时再次调用抛 BUSY;停用账号静默跳过 */
  async syncAccount(id: string, mode: SyncRequestMode, signal: AbortSignal): Promise<SyncRunResult> {
    if (this.mutex.has(id)) throw new MailError('BUSY', '该账号正在同步中')
    const account = this.accounts.get(id)
    if (!account) throw new MailError('NOT_FOUND', '账号不存在')
    if (!account.enabled) return { added: 0, initial: false }

    const run = this.doSync(id, mode, signal).finally(() => {
      this.mutex.delete(id)
    })
    this.mutex.set(id, run)
    return run
  }

  /** 到期账号批量同步:最多 2 个账号并发,单个失败不阻塞其他账号 */
  async runDue(accountIds: string[], signal: AbortSignal): Promise<void> {
    const queue = [...accountIds]
    const lanes = Math.min(MAIL_LIMITS.accounts, queue.length)
    const workers: Array<Promise<void>> = []
    for (let lane = 0; lane < lanes; lane += 1) {
      workers.push(
        (async () => {
          for (;;) {
            if (signal.aborted) return
            const id = queue.shift()
            if (id == null) return
            const controller = new AbortController()
            this.controllers.set(id, controller)
            const forward = (): void => controller.abort()
            signal.addEventListener('abort', forward, { once: true })
            try {
              await this.syncAccount(id, 'refresh', controller.signal)
            } catch {
              // 一个账号失败不阻塞另一个账号
            } finally {
              signal.removeEventListener('abort', forward)
              this.controllers.delete(id)
            }
          }
        })()
      )
    }
    await Promise.all(workers)
  }

  /** 停止所有在途同步:先中止再等待全部结束 */
  async stopAll(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
    await Promise.allSettled([...this.mutex.values()])
  }
}
