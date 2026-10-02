// RunScheduler(OPS-02):Ops 与 Research 共用的接力与生命周期调度入口(F-04)。
//
// 背景:此前排队接力由各工作流自行"收尾驱动下一个"(orchestrator.driveNextQueued、
// research.driveNextQueued),等待/失败/取消/批准路径各自实现,容易出现缺接力;
// 批准更是直接转 executing,与队列状态可能竞争。本调度器提供唯一出口:
//
// 1. register(mode, driver):按 mode 注册驱动,重复注册抛错;
// 2. request():合并唤醒——下一微任务挑选就绪项,没有可执行项即停止,不忙轮询;
// 3. abort(runId):发出取消信号;旧 Promise settle 前仍保留驱动占用,
//    调度器到驱动 finally 才释放,释放后再唤醒挑选下一就绪项。
//
// 占用是数据库 + 内存双重检查:RunQueue 约束 planning/executing 状态数,
// 调度器约束同时未退出的异步驱动数 ≤ 1(单写者事件循环,一次只有一个驱动在途)。
// 就绪项全部来自数据库现有记录,不新增任务表:
//   - queued 运行(初次规划或澄清重入):就绪时间 = startedAt / 答案 trace.createdAt;
//   - awaiting_confirmation 且存在已批准未执行审批:就绪时间 = decidedAt;
// 同一运行每轮只选一个待执行审批;排序按就绪时间、runId、approvalId。

import type { SqliteDb } from '../db/connection'
import { listApprovals, listRunsByStatus, listTraceEvents, isApprovalExecuted, type AgentRunRecord } from '../runs/repository'
import type { RunMode } from '../../shared/agent'
import type { RunQueue } from './runQueue'
import { OperationError } from '../db/operations'
import { appError } from '../../shared/operations'

export type DispatchIntent = { kind: 'plan' } | { kind: 'approved'; approvalId: string }

export type RunDriver = (runId: string, intent: DispatchIntent, signal: AbortSignal) => Promise<void>

/** 一个待派发项:驱动按 intent 自行领取执行权(plan → tryStart,approved → tryResume) */
interface DispatchItem {
  runId: string
  mode: RunMode
  intent: DispatchIntent
  /** 就绪时间(ISO);排序第一键 */
  readyAt: string
  approvalId: string | null
}

interface ActiveDriver {
  runId: string
  controller: AbortController
  settled: Promise<void>
  epoch: string | undefined
}

export interface RunSchedulerOptions {
  /** 生产组合传入当前 workspace epoch；独立调度测试可只依赖对象身份。 */
  workspaceEpoch?: () => string
  onDriverError?: (runId: string, error: unknown) => Promise<void>
}

export class RunScheduler {
  private readonly drivers = new Map<RunMode, RunDriver>()
  /** 当前在途驱动:旧 Promise settle 前保持占用,abort 不提前释放 */
  private active: ActiveDriver | null = null
  /** 合并唤醒标记:已有待执行微任务时忽略后续 request */
  private scheduled = false
  private pauses = 0
  private faulted = false

  constructor(
    private readonly db: SqliteDb,
    private readonly queue: RunQueue,
    private readonly options: RunSchedulerOptions = {}
  ) {}

  /** 按 mode 注册驱动;重复注册视为接线错误抛错 */
  register(mode: RunMode, driver: RunDriver): void {
    if (this.drivers.has(mode)) {
      throw new Error(`调度器驱动重复注册:${mode}`)
    }
    this.drivers.set(mode, driver)
  }

  /** 合并唤醒:下一微任务挑选就绪项;空队列/占用中不派发,不忙轮询 */
  request(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.dispatch()
    })
  }

  /** 发出取消信号;旧 Promise settle 前驱动占用保留,由 finally 释放后再唤醒 */
  abort(runId: string): void {
    if (this.active?.runId === runId) {
      this.active.controller.abort()
    }
  }

  /** 当前在途驱动信息(诊断用):runId 与取消信号 */
  currentDriver(): { runId: string; signal: AbortSignal } | null {
    return this.active ? { runId: this.active.runId, signal: this.active.controller.signal } : null
  }

  /** 暂停先于 await 生效；必须等包括 finally 在内的旧驱动退出后才能替换数据库。 */
  async quiesceForRestore(cancelActive: (runId: string) => void, timeoutMs = 5000): Promise<() => void> {
    this.pauses++
    let resumed = false
    const resume = (): void => {
      if (resumed) return
      resumed = true
      this.pauses--
      this.request()
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const active = this.active
      if (active) {
        active.controller.abort()
        cancelActive(active.runId)
        await Promise.race([
          active.settled,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new OperationError(
              appError('BUSY', '恢复中止：Agent 驱动排空超时，未替换数据', { retryable: true })
            )), timeoutMs)
          })
        ])
      }
      return resume
    } catch (error) {
      resume()
      throw error
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  // ---------- 派发 ----------

  private dispatch(): void {
    // 内存占用:旧异步驱动尚未退出,不得叠加第二个驱动(由其 finally 重新唤醒)
    if (this.faulted || this.pauses > 0 || this.active) return
    // 数据库占用:仍有 planning/executing 运行时不派发(双保险;正常路径驱动
    // 已在等待人工/终态时退出,不会同时持有状态与在途 Promise)
    if (this.queue.isBusy()) return

    const item = this.pickReady()
    if (!item) return // 没有可执行项即停止;人工等待项不循环请求

    const driver = this.drivers.get(item.mode)
    if (!driver) return
    const controller = new AbortController()
    const active: ActiveDriver = {
      runId: item.runId, controller, epoch: this.options.workspaceEpoch?.(), settled: Promise.resolve()
    }
    this.active = active
    const ownsSlot = (): boolean => this.active === active &&
      this.options.workspaceEpoch?.() === active.epoch
    active.settled = Promise.resolve()
      .then(() => driver(item.runId, item.intent, controller.signal))
      .catch(async (err: unknown) => {
        if (!ownsSlot()) return
        console.error(
          '[run-scheduler] 驱动异常:',
          err instanceof Error ? err.message : String(err)
        )
        try {
          if (!this.options.onDriverError) throw new Error('未接线驱动错误收尾')
          await this.options.onDriverError(item.runId, err)
        } catch (cleanupError) {
          this.faulted = true
          console.error('[run-scheduler] 错误收尾失败，已暂停派发:', cleanupError)
        }
      })
      .finally(() => {
        // 到 finally 才释放驱动;释放后合并唤醒挑选下一就绪项
        if (ownsSlot()) {
          this.active = null
          this.request()
        }
      })
  }

  /** 挑选下一就绪项:就绪时间 → runId → approvalId;同一运行只选一个待执行审批 */
  private pickReady(): DispatchItem | null {
    const items = this.collectReadyItems()
    if (items.length === 0) return null
    items.sort((a, b) => {
      const byTime = a.readyAt.localeCompare(b.readyAt)
      if (byTime !== 0) return byTime
      const byRun = a.runId.localeCompare(b.runId)
      if (byRun !== 0) return byRun
      return (a.approvalId ?? '').localeCompare(b.approvalId ?? '')
    })
    return items[0]!
  }

  private collectReadyItems(): DispatchItem[] {
    const items: DispatchItem[] = []
    for (const run of listRunsByStatus(this.db, 'queued')) {
      if (!this.drivers.has(run.mode)) continue
      items.push({
        runId: run.runId,
        mode: run.mode,
        intent: { kind: 'plan' },
        readyAt: queuedReadinessAt(this.db, run),
        approvalId: null
      })
    }
    for (const run of listRunsByStatus(this.db, 'awaiting_confirmation')) {
      if (!this.drivers.has(run.mode)) continue
      const approval = firstApprovedUnexecuted(this.db, run.runId)
      if (!approval) continue
      items.push({
        runId: run.runId,
        mode: run.mode,
        intent: { kind: 'approved', approvalId: approval.approvalId },
        readyAt: approval.decidedAt ?? run.startedAt,
        approvalId: approval.approvalId
      })
    }
    return items
  }
}

/**
 * queued 运行的就绪时间:澄清重入取最后一次答案轨迹的 createdAt,
 * 初次运行取 startedAt(答案事件由 acceptAnswers 落库,驱动从轨迹恢复回答)。
 */
function queuedReadinessAt(db: SqliteDb, run: AgentRunRecord): string {
  const events = listTraceEvents(db, run.runId)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!
    if (event.eventType !== 'input') continue
    const answers = (event.payload as { answers?: unknown }).answers
    if (Array.isArray(answers) && answers.length > 0) return event.createdAt
  }
  return run.startedAt
}

/** 该运行最早的"已批准且未执行"审批(每轮每运行只选一个);无则 null */
function firstApprovedUnexecuted(db: SqliteDb, runId: string) {
  const approved = listApprovals(db, runId)
    .filter((a) => a.decision === 'approved')
    .sort((a, b) => {
      const byTime = (a.decidedAt ?? '').localeCompare(b.decidedAt ?? '')
      return byTime !== 0 ? byTime : a.approvalId.localeCompare(b.approvalId)
    })
  for (const approval of approved) {
    if (!isApprovalExecuted(db, runId, approval)) return approval
  }
  return null
}
