// 教学周 → 具体日期的映射,以及某日课程求取(含临时调整)
import type { Course, CourseOccurrence } from '../../shared/types'
import { weekOfDate, weekdayOf, weekRangesContain } from '../../shared/dateUtils'

export function courseOccurrencesForDate(
  courses: Course[],
  overrides: Array<{ courseId: string; date: string; kind: 'cancel' | 'edit'; newStartTime?: string | null; newEndTime?: string | null; newLocation?: string | null }>,
  date: string
): CourseOccurrence[] {
  const wd = weekdayOf(date)
  const result: CourseOccurrence[] = []
  for (const course of courses) {
    if (course.weekday !== wd) continue
    const occ: CourseOccurrence = {
      course,
      date,
      startTime: course.startTime,
      endTime: course.endTime,
      location: course.location,
      cancelled: false
    }
    // 覆盖调整(取消/调时段/调教室)
    const ov = overrides.find((o) => o.courseId === course.id && o.date === date)
    if (ov) {
      if (ov.kind === 'cancel') {
        occ.cancelled = true
      } else {
        if (ov.newStartTime) occ.startTime = ov.newStartTime
        if (ov.newEndTime) occ.endTime = ov.newEndTime
        if (ov.newLocation) occ.location = ov.newLocation
      }
    }
    result.push(occ)
  }
  result.sort((a, b) => a.startTime.localeCompare(b.startTime))
  return result
}

/** 带学期周次过滤的求取:需要学期开始日期以计算当前教学周 */
export function courseOccurrencesForDateWithSemester(
  courses: Course[],
  overrides: Array<{ courseId: string; date: string; kind: 'cancel' | 'edit'; newStartTime?: string | null; newEndTime?: string | null; newLocation?: string | null }>,
  semesterStartDate: string,
  semesterWeeks: number,
  date: string
): CourseOccurrence[] {
  const wd = weekdayOf(date)
  const week = weekOfDate(semesterStartDate, date)
  const inSemester = week >= 1 && week <= semesterWeeks
  const candidates = courses.filter(
    (c) => c.weekday === wd && inSemester && weekRangesContain(c.weeks as Array<[number, number]>, week)
  )
  return courseOccurrencesForDate(candidates, overrides, date)
}
