// Agent 运行状态机(C-03):纯函数,只描述"哪些状态转移合法"。
// 状态集合与总体规格第 6 节一致;合法性判断集中在此,避免各调用点各写一套。

import { isTerminalRunStatus, type RunStatus } from '../../shared/agent'

/** 合法转移表。终态无出边;非终态均可取消(总体规格第 6 节:任意非终态可请求取消) */
const ALLOWED_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['planning', 'cancelled'],
  planning: [
    'awaiting_input',
    'awaiting_confirmation',
    'executing',
    'succeeded',
    'partial',
    'failed',
    'cancelled'
  ],
  // 提交澄清答案后重新入队(总体规格第 6 节:答案提交后重新入队,继续同一运行)
  awaiting_input: ['queued', 'planning', 'failed', 'cancelled'],
  // 批准后进入执行;拒绝后该运行不再执行,按失败收尾
  awaiting_confirmation: ['executing', 'succeeded', 'partial', 'failed', 'cancelled'],
  // 多步计划中后续写操作仍需批准时,可从执行态回到等待确认
  executing: ['awaiting_confirmation', 'succeeded', 'partial', 'failed', 'cancelled'],
  succeeded: [],
  partial: [],
  failed: [],
  cancelled: []
}

/** 是否允许从 from 转移到 to;同一状态之间的"转移"不算合法转移 */
export function canTransition(from: RunStatus, to: RunStatus): boolean {
  if (from === to) return false
  return (ALLOWED_TRANSITIONS[from] as readonly string[]).includes(to)
}

export function allowedTransitions(from: RunStatus): readonly RunStatus[] {
  return ALLOWED_TRANSITIONS[from]
}

/** 从 from 出发可以到达的状态(含多步);用于"取消是否可达"这类判断 */
export function canReach(from: RunStatus, target: RunStatus): boolean {
  if (from === target) return true
  const seen = new Set<RunStatus>([from])
  const queue: RunStatus[] = [from]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const next of ALLOWED_TRANSITIONS[current]) {
      if (next === target) return true
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return false
}

/** 非法转移抛错;调用方不得静默忽略 */
export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`非法状态转移:${from} → ${to}`)
  }
}

/** 终态集合的便捷判断,转发 shared/agent 的定义以免两处枚举漂移 */
export { isTerminalRunStatus }
