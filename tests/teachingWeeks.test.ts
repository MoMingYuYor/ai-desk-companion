import { describe, expect, it } from 'vitest'
import {
  dateOfWeek,
  fmtWeekRanges,
  minutesOfDay,
  mondayOf,
  parseLocalIso,
  weekOfDate,
  weekRangesContain,
  weekdayOf
} from '../src/shared/dateUtils'
import { courseOccurrencesForDateWithSemester } from '../src/main/services/teachingWeeks'
import type { Course } from '../src/shared/types'

describe('教学周与日期映射(含跨年)', () => {
  it('第 1 教学周周一 = 开学日期', () => {
    // 2026-09-07 是周一
    expect(weekdayOf('2026-09-07')).toBe(1)
    expect(dateOfWeek('2026-09-07', 1, 1)).toBe('2026-09-07')
  })

  it('跨元旦的教学周映射正确(如 17 周学期)', () => {
    const start = '2026-09-07'
    // 第 18 周周一 = 2026-09-07 + 17*7 = 2027-01-04
    expect(dateOfWeek(start, 18, 1)).toBe('2027-01-04')
    expect(weekOfDate(start, '2027-01-04')).toBe(18)
    expect(weekOfDate(start, '2026-12-28')).toBe(17)
  })

  it('某个日期属于哪一周、周几', () => {
    const start = '2026-09-07'
    expect(weekOfDate(start, '2026-09-09')).toBe(1)
    expect(weekdayOf('2026-09-09')).toBe(3)
    expect(mondayOf('2026-09-09')).toBe('2026-09-07')
  })

  it('周次区间判断与格式化', () => {
    const ranges: Array<[number, number]> = [
      [1, 6],
      [8, 17]
    ]
    expect(weekRangesContain(ranges, 3)).toBe(true)
    expect(weekRangesContain(ranges, 7)).toBe(false)
    expect(weekRangesContain(ranges, 17)).toBe(true)
    expect(fmtWeekRanges(ranges)).toBe('1-6, 8-17 周')
  })
})

describe('课表 → 日历(单双周/指定周次/临时调整)', () => {
  const semesterStart = '2026-09-07' // 周一
  const courses: Course[] = [
    {
      id: 'c1',
      semesterId: 's1',
      name: '计算智能',
      weekday: 1,
      startTime: '16:25',
      endTime: '17:50',
      weeks: [
        [1, 6],
        [8, 17]
      ],
      location: '3601',
      createdAt: ''
    },
    {
      id: 'c2',
      semesterId: 's1',
      name: '深度学习',
      weekday: 3,
      startTime: '19:30',
      endTime: '21:40',
      weeks: [[1, 6]],
      location: '3607',
      createdAt: ''
    }
  ]

  it('第 1 周周一有课,第 7 周周一停课(单双周区间)', () => {
    const week1 = courseOccurrencesForDateWithSemester(courses, [], semesterStart, 20, '2026-09-07')
    expect(week1.map((o) => o.course.name)).toEqual(['计算智能'])
    const week7 = courseOccurrencesForDateWithSemester(courses, [], semesterStart, 20, '2026-10-19')
    expect(week7).toHaveLength(0) // 2026-10-19 是第 7 周周一
  })

  it('指定周次课程在区间外不出现', () => {
    // 第 10 周周三:深度学习只到第 6 周
    const d10w3 = dateOfWeek(semesterStart, 10, 3)
    const occs = courseOccurrencesForDateWithSemester(courses, [], semesterStart, 20, d10w3)
    expect(occs).toHaveLength(0)
  })

  it('临时停课与调课只影响当次', () => {
    const d1w1 = dateOfWeek(semesterStart, 1, 1)
    const occs = courseOccurrencesForDateWithSemester(
      courses,
      [{ courseId: 'c1', date: d1w1, kind: 'cancel' }],
      semesterStart,
      20,
      d1w1
    )
    expect(occs[0].cancelled).toBe(true)
    // 下周一正常
    const d2w1 = dateOfWeek(semesterStart, 2, 1)
    const next = courseOccurrencesForDateWithSemester(courses, [], semesterStart, 20, d2w1)
    expect(next[0].cancelled).toBe(false)
  })

  it('调课(换时段/教室)只影响指定日期', () => {
    const d2w1 = dateOfWeek(semesterStart, 2, 1)
    const occs = courseOccurrencesForDateWithSemester(
      courses,
      [{ courseId: 'c1', date: d2w1, kind: 'edit', newStartTime: '10:00', newEndTime: '11:25', newLocation: '3201' }],
      semesterStart,
      20,
      d2w1
    )
    expect(occs[0].startTime).toBe('10:00')
    expect(occs[0].location).toBe('3201')
    const d3w1 = dateOfWeek(semesterStart, 3, 1)
    const normal = courseOccurrencesForDateWithSemester(courses, [], semesterStart, 20, d3w1)
    expect(normal[0].startTime).toBe('16:25')
  })

  it('时间解析', () => {
    expect(minutesOfDay('08:00')).toBe(480)
    expect(minutesOfDay('19:30')).toBe(1170)
    expect(parseLocalIso('2026-09-07')!.getDay()).toBe(1)
  })
})
