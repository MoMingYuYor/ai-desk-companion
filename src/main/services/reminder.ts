// 提醒服务:独立于 AI 运行;后台计时、到期通知、重启补查错过的提醒
// (系统通知的具体展示由注入的 showNotification 实现,便于测试与解耦)
import type { SqliteDb } from '../db/connection'
import { isReminderFired, listDueTodoCandidates, listReminderEventCandidates, markReminderFired } from '../db/dao'
import type { CalendarEvent, ReminderNotice, Todo } from '../../shared/types'
import { fmtDateCn, fmtTime, parseLocalDateTimeMs, toLocalIso, toLocalIsoMs } from '../../shared/dateUtils'

export interface ReminderDeps {
  db: SqliteDb
  broadcast: (channel: string, payload: unknown) => void
  showNotification: (n: ReminderNotice) => void
  onFired?: (n: ReminderNotice) => void
  /**
   * 可注入时钟:缺省为真实系统时间。测试经它锚定时刻——
   * 「错过/即将开始」按自然日判定,用真实午夜窗口跑测试会把
   * now-10min 的种子事件翻到前一自然日而误判(见 reminderBackup R6)。
   */
  now?: () => Date
}

/** 补报窗口:fireAt ∈ [now - 24h, now],闭合区间(Global Constraints / R6) */
const MISSED_WINDOW_MS = 24 * 60 * 60 * 1000
/**
 * SQL 粗筛边界余量(1 小时):字符串粗筛只保证候选超集,
 * 精确到毫秒的窗口判定在内存中按 UTC 毫秒完成,余量抵消格式差异与夏令时偏移。
 */
const BOUND_PAD_MS = 60 * 60 * 1000

export interface DueReminder {
  /** 触发提醒的实体 ID(日程或待办) */
  entityId: string
  /** 实际触发时刻(本地朴素时间,毫秒精度) */
  fireAt: string
  /** 幂等键:与既有 fired_reminders 记录格式保持一致 */
  key: string
  kind: ReminderNotice['kind']
  title: string
  body: string
}

/**
 * 当前应触发但尚未触发(fired)的提醒列表,注入时钟 now,便于边界与重启补报测试。
 * 通知前检查已完成/取消:已完成待办与取消/软删日程不出现在结果中;
 * 同一 key 标记 fired 后不再报。窗口为闭合区间 [now-24h, now],边界 1ms 之差都算界外。
 */
export function dueReminders(db: SqliteDb, now: Date): DueReminder[] {
  const nowMs = now.getTime()
  const windowStartMs = nowMs - MISSED_WINDOW_MS
  const out: DueReminder[] = []

  // 日程:fireAt = startAt - reminderMinutes,统一经集中转换进入 UTC 毫秒比较。
  // 粗筛:fireAt ∈ [now-24h, now] 且 reminderMinutes >= 0 时,
  // start_at 必然 ∈ [now-24h, now + 最大提前量],两侧各留 1 小时余量。
  const maxRemMinutes = db.get<{ m: number | null }>(
    "SELECT MAX(reminder_minutes) AS m FROM events WHERE status = 'active' AND reminder_minutes IS NOT NULL"
  )?.m ?? 0
  const startFrom = toLocalIsoMs(new Date(windowStartMs - BOUND_PAD_MS))
  const startTo = toLocalIsoMs(new Date(nowMs + maxRemMinutes * 60_000 + BOUND_PAD_MS))
  for (const ev of listReminderEventCandidates(db, startFrom, startTo)) {
    const startMs = parseLocalDateTimeMs(ev.start_at)
    if (startMs == null) continue // 不可解析的历史数据跳过,不猜测触发时刻
    const fireMs = startMs - ev.reminder_minutes * 60_000
    if (fireMs < windowStartMs || fireMs > nowMs) continue
    const key = `ev:${ev.id}:${ev.start_at}:${ev.reminder_minutes}`
    if (isReminderFired(db, key)) continue
    const fireDate = new Date(fireMs)
    const missed =
      fireDate.getFullYear() !== now.getFullYear() ||
      fireDate.getMonth() !== now.getMonth() ||
      fireDate.getDate() !== now.getDate()
    out.push({
      entityId: ev.id,
      fireAt: toLocalIsoMs(fireDate),
      key,
      kind: missed ? 'missed-event' : 'event',
      title: missed ? `错过的提醒:${ev.title}` : `即将开始:${ev.title}`,
      body: `${fmtDateCn(ev.start_at)} ${fmtTime(ev.start_at)}${ev.location ? ' @' + ev.location : ''}`
    })
  }

  // 待办:dueAt 即触发时刻;已完成与无截止时间的待办不生成提醒
  for (const td of listDueTodoCandidates(db)) {
    const dueMs = parseLocalDateTimeMs(td.due_at)
    if (dueMs == null) continue
    if (dueMs < windowStartMs || dueMs > nowMs) continue
    const key = `td:${td.id}:${td.due_at}`
    if (isReminderFired(db, key)) continue
    out.push({
      entityId: td.id,
      fireAt: td.due_at,
      key,
      kind: 'todo',
      title: `待办到期:${td.title}`,
      body: `截止 ${fmtDateCn(td.due_at)} ${fmtTime(td.due_at)}`
    })
  }
  return out
}

export class ReminderService {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private deps: ReminderDeps) {}

  start(): void {
    this.tick()
    this.timer = setInterval(() => this.tick(), 30_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * 立即扫描一次(重启后/睡眠恢复后可调用)。扫描以实际触发时刻 fireAt 为准,
   * 重启后仅补报过去 24 小时内应触发的活跃事项。
   * 顺序:先通知后标记——showNotification 成功仅代表交给操作系统,
   * 通知抛错时不标记 fired,下一轮重试,避免"先标记后丢通知"。
   */
  tick(): void {
    const now = this.deps.now ? this.deps.now() : new Date()
    for (const due of dueReminders(this.deps.db, now)) {
      const notice: ReminderNotice = {
        key: due.key,
        kind: due.kind,
        title: due.title,
        body: due.body,
        at: toLocalIso(now)
      }
      try {
        this.deps.broadcast('evt:reminder-fired', notice)
        this.deps.onFired?.(notice)
        this.deps.showNotification(notice)
      } catch {
        continue
      }
      markReminderFired(this.deps.db, due.key)
    }
  }
}

export function summarizeUpcoming(events: CalendarEvent[], todos: Todo[], now: string): string {
  const next = events.find((e) => e.endAt >= now)
  const dueTodo = todos.find((t) => !t.completedAt && t.dueAt != null && t.dueAt >= now)
  const parts: string[] = []
  if (next) parts.push(`${fmtTime(next.startAt)} ${next.title}`)
  if (dueTodo && dueTodo.dueAt) parts.push(`待办:${dueTodo.title} ${fmtTime(dueTodo.dueAt)}`)
  return parts.join(' · ')
}
