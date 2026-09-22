// 启动恢复(C-03)。
//
// 进程异常退出后,仍处于占用执行权状态(planning / executing)的运行已经失去执行者,
// 本进程无法得知其工具调用是否已生效,因此不尝试续跑,一律标记 failed + WORKER_INTERRUPTED
// (总体规格第 7 节:"进程异常退出后,已在执行的运行标记 failed/WORKER_INTERRUPTED")。
//
// 为什么不需要 checkpoint 续跑:已完成调用的幂等由既有 operation_receipts 保证——
// 同一 operationId 重复提交会命中回执并返回首次结果,不会二次执行。
// 因此"重启后不重复执行已完成的工具调用"由回执机制承担,不由本模块承担。

import type { SqliteDb } from '../db/connection'
import { listRunsByStatuses, transitionRun, type AgentRunRecord } from '../runs/repository'
import { SLOT_HOLDING_STATUSES } from './runQueue'

/** 进程中断的错误码,与总体规格的 WORKER_INTERRUPTED 一致 */
export const WORKER_INTERRUPTED = 'WORKER_INTERRUPTED'

/**
 * 把失去执行者的运行标记为失败。返回被标记的运行。
 * 应在 initSchema 之后、启动运行队列之前调用一次。
 */
export function recoverInterruptedRuns(
  db: SqliteDb,
  errorCode: string = WORKER_INTERRUPTED
): AgentRunRecord[] {
  const interrupted = listRunsByStatuses(db, SLOT_HOLDING_STATUSES)
  const recovered: AgentRunRecord[] = []
  for (const run of interrupted) {
    recovered.push(transitionRun(db, run.runId, 'failed', { errorCode }))
  }
  return recovered
}
