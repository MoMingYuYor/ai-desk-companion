// 显式运行队列(C-03)。
//
// 语义(架构决策记录第 4.3 节):主进程是单一事件循环,天然串行;
// 因此不新建"worker + 数据库租约"机制,改为显式队列——
// 同一时刻只允许一个运行占用执行权,其余排队。
//
// 关键区分:占用执行权的状态是 planning 与 executing。
// 进入 awaiting_input / awaiting_confirmation 时运行在等人工,
// 按约定"人工等待不计入 active time",因此必须让出执行权,
// 否则一次澄清就会把整条队列堵住。终态自然也不再占用。
//
// 占用判定从数据库读取而不是只放内存:重启后队列状态不会丢,
// 也不需要额外的恢复逻辑。验收标准是"同一时刻只有一个运行占用执行权"。

import type { SqliteDb } from '../db/connection'
import { getRun, listRunsByStatus, listRunsByStatuses, transitionRun, type AgentRunRecord } from '../runs/repository'
import type { RunStatus } from '../../shared/agent'

/** 占用执行权的状态:规划与执行。等待人工输入或确认时释放 */
export const SLOT_HOLDING_STATUSES: readonly RunStatus[] = ['planning', 'executing']

export class RunQueue {
  constructor(private readonly db: SqliteDb) {}

  /**
   * 当前占用执行权的运行;没有则 null。
   * 出现多于一个说明队列语义被绕过,直接抛错而不是静默挑一个。
   */
  currentActive(): AgentRunRecord | null {
    const active = listRunsByStatuses(this.db, SLOT_HOLDING_STATUSES)
    if (active.length === 0) return null
    if (active.length > 1) {
      throw new Error(
        `队列不变量被破坏:同时有 ${active.length} 个运行占用执行权(${active.map((r) => r.runId).join(', ')})`
      )
    }
    return active[0]!
  }

  /** 是否有运行占用执行权 */
  isBusy(): boolean {
    return this.currentActive() !== null
  }

  /** 按入队顺序(开始时间升序)取下一个待启动的运行 */
  nextQueued(): AgentRunRecord | null {
    const queued = listRunsByStatus(this.db, 'queued')
    return queued.length > 0 ? queued[0]! : null
  }

  /**
   * 尝试占用执行权:把 queued 运行推进到 planning(状态机允许的唯一首步)。
   * 已有运行占用时返回 false(调用方应让它继续排队)——排队是正常路径,不是异常。
   * 对已占用执行权的运行重复调用返回 true(幂等)。
   */
  tryStart(runId: string): boolean {
    const run = getRun(this.db, runId)
    if (!run) throw new Error(`运行不存在:${runId}`)
    if ((SLOT_HOLDING_STATUSES as readonly string[]).includes(run.status)) return true
    const active = this.currentActive()
    if (active) return false
    transitionRun(this.db, runId, 'planning')
    return true
  }

  /** 待执行与占用中的运行数量,用于队列容量与展示 */
  depth(): number {
    return (
      listRunsByStatus(this.db, 'queued').length + listRunsByStatuses(this.db, SLOT_HOLDING_STATUSES).length
    )
  }
}
