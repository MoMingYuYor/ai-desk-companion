// 构建发送给模型的"个人背景 + 近期日程"上下文
import type { SqliteDb } from '../db/connection'
import { listCourseOverrides, listCourses, listEventsRange, listProfileFacts, listSchoolEvents, listSemesters, listTodos } from '../db/dao'
import type { CourseOccurrence, DayAgenda } from '../../shared/types'
import {
  addDays,
  fmtWeekRanges,
  nowLocalIso,
  toDateStr,
  weekOfDate,
  weekdayOf
} from '../../shared/dateUtils'
import { courseOccurrencesForDateWithSemester } from './teachingWeeks'

export function buildProfileContext(db: SqliteDb): string {
  const facts = listProfileFacts(db, 'confirmed')
  if (facts.length === 0) return ''
  const lines = facts.map((f) => `- [${f.category}] ${f.key}: ${f.value}`)
  return '用户个人背景(已确认资料):\n' + lines.join('\n')
}

export function buildAgendaContext(db: SqliteDb): string {
  const today = toDateStr(new Date())
  const from = `${today}T00:00`
  const to = addDays(today, 8) + 'T23:59'
  const events = listEventsRange(db, from, to)
  const lines: string[] = []
  for (const ev of events.slice(0, 30)) {
    lines.push(`- ${ev.startAt} ~ ${ev.endAt} ${ev.title}${ev.location ? ` @${ev.location}` : ''}`)
  }
  let ctx = lines.length > 0 ? `近期日程(未来8天):\n${lines.join('\n')}` : '近期日程:未来8天没有已安排的日程。'

  const sem = activeSemester(db, today)
  if (sem) {
    const occs = courseOccurrencesOn(db, today)
    if (occs.length > 0) {
      ctx += `\n今天(周${weekdayOf(today)})的课程:\n` + occs.map((o) => `- ${o.startTime}~${o.endTime} ${o.course.name}${o.location ? ` @${o.location}` : ''}${o.cancelled ? '(已停课)' : ''}`).join('\n')
    }
  }
  return ctx
}

export function activeSemester(db: SqliteDb, today: string): { id: string; name: string; startDate: string; weeks: number } | null {
  const sems = listSemesters(db)
  for (const s of sems) {
    const week = weekOfDate(s.startDate, today)
    if (week >= 1 && week <= s.weeks) return s
  }
  return sems[0] ?? null
}

export function courseOccurrencesOn(db: SqliteDb, date: string): CourseOccurrence[] {
  const sem = activeSemester(db, date)
  if (!sem) return []
  return courseOccurrencesForDateWithSemester(
    listCourses(db, sem.id).map((c) => ({ ...c, weeks: c.weeks as Array<[number, number]> })),
    listCourseOverrides(db),
    sem.startDate,
    sem.weeks,
    date
  )
}

export function semesterSummary(db: SqliteDb): string {
  const today = toDateStr(new Date())
  const sem = activeSemester(db, today)
  if (!sem) return ''
  const courses = listCourses(db, sem.id)
  if (courses.length === 0) return ''
  const week = weekOfDate(sem.startDate, today)
  const lines = courses.map(
    (c) =>
      `- ${c.name}:周${'一二三四五六日'[c.weekday - 1]} ${c.startTime}~${c.endTime} ${fmtWeekRanges(c.weeks as Array<[number, number]>)}${c.location ? ` @${c.location}` : ''}`
  )
  const school = listSchoolEvents(db, sem.id)
    .slice(0, 10)
    .map((e) => `- ${e.title}: ${e.startDate}${e.endDate ? ` ~ ${e.endDate}` : ''}(${e.type})`)
  return `当前学期 ${sem.name}(第 ${week} 教学周,共 ${sem.weeks} 周),课表:\n${lines.join('\n')}${
    school.length > 0 ? `\n校历要点:\n${school.join('\n')}` : ''
  }`
}

export function buildFullContext(db: SqliteDb): string {
  const p = buildProfileContext(db)
  const a = buildAgendaContext(db)
  const s = semesterSummary(db)
  return [p, a, s].filter((x) => x.length > 0).join('\n\n')
}

/** 某日聚合视图:课程 + 日程 + 相关待办 + 校历事件 */
export function buildDayAgenda(db: SqliteDb, date: string): DayAgenda {
  const courses = courseOccurrencesOn(db, date)
  const events = listEventsRange(db, `${date}T00:00`, `${date}T23:59`)
  const todos = listTodos(db).filter((t) => {
    if (t.completedAt) return false
    if (!t.dueAt) return false
    return t.dueAt.slice(0, 10) === date
  })
  const school = listSchoolEvents(db).filter(
    (e) => e.startDate.slice(0, 10) <= date && (!e.endDate || e.endDate.slice(0, 10) >= date)
  )
  return { date, courses, events, todos, schoolEvents: school }
}

export function nowIso(): string {
  return nowLocalIso()
}
