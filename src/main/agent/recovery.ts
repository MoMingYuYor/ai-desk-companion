// 启动恢复(C-03;OPS-02 扩展)。
//
// 进程异常退出后,仍处于占用执行权状态(planning / executing)的运行已经失去执行者,
// 本进程无法得知其工具调用是否已生效,因此不尝试续跑,一律标记 failed + WORKER_INTERRUPTED
// (总体规格第 7 节:"进程异常退出后,已在执行的运行标记 failed/WORKER_INTERRUPTED")。
//
// 为什么不需要 checkpoint 续跑:已完成调用的幂等由既有 operation_receipts 保证——
// 同一 operationId 重复提交会命中回执并返回首次结果,不会二次执行。
// 因此"重启后不重复执行已完成的工具调用"由回执机制承担,不由本模块承担。
//
// OPS-02 扩展:失去执行者的运行按 failed 落盘的同时,过期其全部未执行审批
// (pending 一律过期;已批准但无回执的同样过期,禁止恢复执行);
// 待人工的运行(awaiting_input / awaiting_confirmation)保留——其中已批准
// 尚未领取的 awaiting_confirmation 项可由 RunScheduler 再次排队执行。

import type { SqliteDb } from '../db/connection'
import { listRunsByStatuses, transitionRun, expireUnexecutedApprovals, type AgentRunRecord } from '../runs/repository'
import { SLOT_HOLDING_STATUSES } from './runQueue'
import { getResearchTaskByRun, updateResearchTaskPhase } from '../research/repository'

/** 进程中断的错误码,与总体规格的 WORKER_INTERRUPTED 一致 */
export const WORKER_INTERRUPTED = 'WORKER_INTERRUPTED'

/**
 * 把失去执行者的运行标记为失败,并过期其未执行审批。返回被标记的运行。
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
    if (run.mode === 'research') {
      const task = getResearchTaskByRun(db, run.runId)
      if (task) updateResearchTaskPhase(db, task.researchTaskId, 'failed')
    }
    // 未执行审批随运行失败一并过期(已提交回执的审批保持原决定,回执不重写)
    expireUnexecutedApprovals(db, run.runId)
  }
  return recovered
}
