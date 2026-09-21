import { MAIL_LIMITS } from '../../shared/mail'
import type { MailErrorCode, MailSyncNotice } from '../../shared/mail'
import type { MailAccountStore } from './accounts'
import { MailError, classifyError, isMailError } from './errors'
import type { SyncRequestMode, SyncRunResult } from './sync'
import type { MailSyncWorker } from './sync'

export const DEFAULT_BACKOFF_DELAYS: readonly number[] = [30_000, 60_000, 120_000, 300_000]

/** NETWORK 连续失败达到该次数(含首次)后放弃重试,抛出最后一次错误 */
export const DEFAULT_MAX_ATTEMPTS = 5

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

/** 指数退避封装:仅 NETWORK 错误重试,间隔由 delays 注入(测试可传 0);
 *  连续失败达到 maxAttempts(含首次)后放弃并抛出最后一次错误 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts?: { delays?: readonly number[]; signal?: AbortSignal; maxAttempts?: number }
): Promise<T> {
  const delays = opts?.delays ?? DEFAULT_BACKOFF_DELAYS
  const maxAttempts = Math.max(1, opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      const code = isMailError(err) ? err.code : classifyError(err).code
      const delay = retryDelay(attempt, code, delays)
      if (delay == null || opts?.signal?.aborted || attempt + 1 >= maxAttempts) throw err
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
  /** NETWORK 连续失败多少次后放弃(含首次);默认 5。后台 lane 与手动同步共用同一上限 */
  maxAttempts?: number
}

// ---------- 邮箱任务注册表(Task 12 / R10:账号级取消) ----------

export type MailTaskKind = 'sync' | 'history' | 'content'

export interface MailTaskHandle {
  readonly accountId: string
  readonly kind: MailTaskKind
  /** begin 时的账号代数;cancelAccount 提升代数后旧任务按此判定失效 */
  readonly generation: number
  readonly signal: AbortSignal
  /** 任务结束(正常/异常/取消)必须恰好调用一次;cancelAccount 等待它 */
  finish(): void
  /** 把外部停止信号转发到该任务(如 runDue 的整体中止) */
  abort(): void
  /** 每次写仓储/缓存前检查:本任务代数仍是当前代数,且账号存在并启用 */
  assertAlive(): void
}

interface TaskSlot {
  controller: AbortController
  /** finish() 时 resolve;cancelAccount 据此等待任务安全退出 */
  settled: Promise<void>
  kind: MailTaskKind
}

interface AccountEntry {
  generation: number
  /** 停用/移除意图:阻断新任务与迟到写入,直到 resume/forget */
  blocked: boolean
  tasks: Map<number, TaskSlot>
}

/**
 * 账号级任务注册表(R10):
 * - begin 记录账号代数并返回可中止信号;cancelAccount 提升代数、abort 全部在途任务并等待 finish;
 * - assertAlive 供任务在写仓储/缓存前复核代数与账号 enabled/existence;
 * - assertWritable 供仓储写边界阻断"已停用/移除账号"的迟到提交(与代数检查同属写协调范围);
 * - 停用/移除流程:pause(阻断)→ cancelAccount(取消并等待)→ 再落库变更,避免 idle 回写覆盖停用状态。
 */
export class MailTaskRegistry {
  private readonly entries = new Map<string, AccountEntry>()
  private nextTaskId = 0

  constructor(private readonly accounts?: { get(id: string): { enabled: boolean } | null }) {}

  begin(accountId: string, kind: MailTaskKind): MailTaskHandle {
    const entry = this.entryOf(accountId)
    if (entry.blocked) {
      throw new MailError('CANCELLED', '账号正在停用或移除,不接受新任务')
    }
    const generation = entry.generation
    const controller = new AbortController()
    const taskId = ++this.nextTaskId
    let settle!: () => void
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    entry.tasks.set(taskId, { controller, settled, kind })
    const registry = this
    return {
      accountId,
      kind,
      generation,
      signal: controller.signal,
      finish() {
        if (entry.tasks.delete(taskId)) settle()
      },
      abort() {
        controller.abort()
      },
      assertAlive() {
        registry.assertAlive(accountId, generation)
      }
    }
  }

  currentGeneration(accountId: string): number {
    return this.entries.get(accountId)?.generation ?? 0
  }

  /** 任务写前检查:代数一致 + 账号存在且启用;任一不满足以 CANCELLED 放弃写入 */
  assertAlive(accountId: string, generation: number): void {
    const entry = this.entries.get(accountId)
    if (!entry || entry.generation !== generation) {
      throw new MailError('CANCELLED', '账号任务已被取消,放弃本次写入')
    }
    const info = this.accounts?.get(accountId)
    if (!info || !info.enabled) {
      throw new MailError('CANCELLED', '账号已停用或已移除,放弃本次写入')
    }
  }

  /** 仓储/缓存写边界:阻断已停用/移除账号的迟到提交(移除与停用流程先 pause 再落库) */
  assertWritable(accountId: string): void {
    if (this.entries.get(accountId)?.blocked) {
      throw new MailError('CANCELLED', '账号正在停用或移除,写入被阻断')
    }
    const info = this.accounts?.get(accountId)
    if (!info || !info.enabled) {
      throw new MailError('CANCELLED', '账号已停用或已移除,写入被拒绝')
    }
  }

  /** 停用/移除前调用:阻断新任务与迟到写入 */
  pause(accountId: string): void {
    this.entryOf(accountId).blocked = true
  }

  /** 重新启用账号时解除阻断 */
  resume(accountId: string): void {
    const entry = this.entries.get(accountId)
    if (entry) entry.blocked = false
  }

  /** 移除完成后清理账号条目 */
  forget(accountId: string): void {
    this.entries.delete(accountId)
  }

  /** 提升账号代数、abort 全部在途任务并等待其 finish(含迟滞网络请求安全退出) */
  async cancelAccount(accountId: string): Promise<void> {
    const entry = this.entries.get(accountId)
    if (!entry) return
    entry.generation += 1
    const slots = [...entry.tasks.values()]
    for (const slot of slots) slot.controller.abort()
    await Promise.all(slots.map((slot) => slot.settled))
  }

  /** 取消全部账号的在途任务(退出/恢复排他窗口) */
  async cancelAll(): Promise<void> {
    for (const id of [...this.entries.keys()]) {
      if ((this.entries.get(id)?.tasks.size ?? 0) > 0) {
        await this.cancelAccount(id)
      }
    }
  }

  /** 未完成任务清单(退出超时记录用):仅账号 ID 与任务类别,不含任何邮件内容 */
  pendingTasks(): Array<{ accountId: string; kind: MailTaskKind }> {
    const out: Array<{ accountId: string; kind: MailTaskKind }> = []
    for (const [accountId, entry] of this.entries) {
      for (const slot of entry.tasks.values()) {
        out.push({ accountId, kind: slot.kind })
      }
    }
    return out
  }

  private entryOf(accountId: string): AccountEntry {
    let entry = this.entries.get(accountId)
    if (!entry) {
      entry = { generation: 0, blocked: false, tasks: new Map() }
      this.entries.set(accountId, entry)
    }
    return entry
  }
}

/**
 * 同步调度器:同账号互斥串行(并发第二次抛 BUSY),
 * runDue 最多 2 个账号并发,NETWORK 失败按退避重试,
 * 连续失败达 maxAttempts(默认 5)后放弃并标记账号 error。
 * 所有在途同步经由 MailTaskRegistry 管理:账号级取消(停用/移除/退出)统一 abort 并等待。
 */
export class MailScheduler {
  private readonly mutex = new Map<string, Promise<SyncRunResult>>()
  private readonly tasks: MailTaskRegistry
  private readonly backoffDelays: readonly number[]
  private readonly maxAttempts: number

  constructor(
    private readonly worker: MailSyncWorker,
    private readonly accounts: MailAccountStore,
    private readonly hooks: MailSchedulerHooks,
    options?: MailSchedulerOptions,
    tasks?: MailTaskRegistry
  ) {
    this.backoffDelays = options?.backoffDelays ?? DEFAULT_BACKOFF_DELAYS
    this.maxAttempts = Math.max(1, options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
    this.tasks = tasks ?? new MailTaskRegistry(accounts)
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
        signal,
        maxAttempts: this.maxAttempts
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

  /**
   * 同一账号串行:已在运行时再次调用抛 BUSY;停用账号静默跳过。
   * signal 为可选的外部停止信号(runDue 整体中止):转发到账号任务后仍走统一的取消与等待路径。
   */
  async syncAccount(id: string, mode: SyncRequestMode, external?: AbortSignal): Promise<SyncRunResult> {
    if (this.mutex.has(id)) throw new MailError('BUSY', '该账号正在同步中')
    const account = this.accounts.get(id)
    if (!account) throw new MailError('NOT_FOUND', '账号不存在')
    if (!account.enabled) return { added: 0, initial: false }

    // 账号级任务:signal/代数由注册表管理;停用与移除经注册表取消并等待任务结束
    const task = this.tasks.begin(id, mode === 'earlier' ? 'history' : 'sync')
    const forward = (): void => task.abort()
    external?.addEventListener('abort', forward, { once: true })
    const run = this.doSync(id, mode, task.signal).finally(() => {
      external?.removeEventListener('abort', forward)
      task.finish()
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
            try {
              await this.syncAccount(id, 'refresh', signal)
            } catch {
              // 一个账号失败不阻塞另一个账号
            }
          }
        })()
      )
    }
    await Promise.all(workers)
  }

  /** 停止所有在途同步:经注册表先中止再等待全部结束 */
  async stopAll(): Promise<void> {
    await this.tasks.cancelAll()
  }
}
