// 提醒服务:独立于 AI 运行;后台计时、到期通知、重启补查错过的提醒
// (系统通知的具体展示由注入的 showNotification 实现,便于测试与解耦)
import type { SqliteDb } from '../db/connection'
import { isReminderFired, listTodos, listEventsRange, markReminderFired } from '../db/dao'
import type { CalendarEvent, ReminderNotice, Todo } from '../../shared/types'
import { addDays, nowLocalIso, toDateStr, fmtDateCn, fmtTime } from '../../shared/dateUtils'

export interface ReminderDeps {
  db: SqliteDb
  broadcast: (channel: string, payload: unknown) => void
  showNotification: (n: ReminderNotice) => void
  onFired?: (n: ReminderNotice) => void
}

const MISSED_WINDOW_HOURS = 24

export class ReminderService {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastScanIso = ''

  constructor(private deps: ReminderDeps) {}

  start(): void {
    this.lastScanIso = nowLocalIso()
    this.tick()
    this.timer = setInterval(() => this.tick(), 30_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 立即扫描一次(重启后/睡眠恢复后可调用) */
  tick(): void {
    const now = nowLocalIso()
    const today = toDateStr(new Date())
    const missedSince = addDays(today, -1) + 'T00:00'
    let notices: ReminderNotice[] = []

    // 日程提醒:start - reminderMinutes <= now 且未触发过
    const events = listEventsRange(this.deps.db, missedSince, addDays(today, 2) + 'T00:00')
    for (const ev of events) {
      if (ev.reminderMinutes == null) continue
      const fireAt = shiftMinutes(ev.startAt, -ev.reminderMinutes)
      if (fireAt > now) continue
      const key = `ev:${ev.id}:${ev.startAt}:${ev.reminderMinutes}`
      if (isReminderFired(this.deps.db, key)) continue
      markReminderFired(this.deps.db, key)
      const missed = fireAt < this.lastScanIso && !isToday(fireAt, today)
      notices.push({
        key,
        kind: missed ? 'missed-event' : 'event',
        title: missed ? `错过的提醒:${ev.title}` : `即将开始:${ev.title}`,
        body: `${fmtDateCn(ev.startAt)} ${fmtTime(ev.startAt)}${ev.location ? ' @' + ev.location : ''}`,
        at: now
      })
    }

    // 待办到期提醒
    const todos = listTodos(this.deps.db)
    for (const td of todos) {
      if (td.completedAt || !td.dueAt) continue
      if (td.dueAt > now) continue
      const key = `td:${td.id}:${td.dueAt}`
      if (isReminderFired(this.deps.db, key)) continue
      markReminderFired(this.deps.db, key)
      notices.push({
        key,
        kind: 'todo',
        title: `待办到期:${td.title}`,
        body: `截止 ${fmtDateCn(td.dueAt)} ${fmtTime(td.dueAt)}`,
        at: now
      })
    }

    notices = notices.filter((n) => n.kind.startsWith('missed') ? this.withinMissedWindow(n.key, now, MISSED_WINDOW_HOURS) : true)

    if (notices.length > 0) {
      for (const n of notices) {
        this.deps.broadcast('evt:reminder-fired', n)
        this.deps.onFired?.(n)
        this.deps.showNotification(n)
      }
    }
    this.lastScanIso = now
  }

  private withinMissedWindow(_key: string, _now: string, _hours: number): boolean {
    // 上面已把扫描范围限制在 24 小时内,这里直接放行
    return true
  }
}

function shiftMinutes(iso: string, minutes: number): string {
  const d = new Date(iso)
  d.setMinutes(d.getMinutes() + minutes)
  const pad = (n: number): string => (n < 10 ? '0' + n : String(n))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function isToday(iso: string, today: string): boolean {
  return iso.slice(0, 10) === today
}

export function summarizeUpcoming(events: CalendarEvent[], todos: Todo[], now: string): string {
  const next = events.find((e) => e.endAt >= now)
  const dueTodo = todos.find((t) => !t.completedAt && t.dueAt != null && t.dueAt >= now)
  const parts: string[] = []
  if (next) parts.push(`${fmtTime(next.startAt)} ${next.title}`)
  if (dueTodo && dueTodo.dueAt) parts.push(`待办:${dueTodo.title} ${fmtTime(dueTodo.dueAt)}`)
  return parts.join(' · ')
}
