/** UTC 日历日期纯函数:全部用 UTC 构造,避免本地夏令时导致窗口多一天或少一天 */

/** 把 YYYY-MM-DD 日期移动 delta 天,返回 YYYY-MM-DD */
export function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + delta)
  return date.toISOString().slice(0, 10)
}

/** 初次加载窗口:[day-29, day+1),恰好覆盖最近 30 个自然日 */
export function initialWindow(day: string): { since: string; before: string } {
  return { since: shiftDay(day, -29), before: shiftDay(day, 1) }
}

/** 历史扩展窗口:[oldest-30, oldest),与已有窗口连续且无重叠 */
export function earlierWindow(oldest: string): { since: string; before: string } {
  return { since: shiftDay(oldest, -30), before: oldest }
}

/**
 * 增量 UID 区间:(after, uidNext-1] 的序列串。
 * after >= uidNext-1 表示没有新邮件,返回 null(禁止发送倒序区间或 lastUid+1:* )。
 */
export function incrementalRange(after: number, uidNext: number): string | null {
  if (!Number.isFinite(after) || !Number.isFinite(uidNext)) return null
  return after >= uidNext - 1 ? null : `${after + 1}:${uidNext - 1}`
}
