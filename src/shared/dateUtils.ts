// 统一使用"本地朴素时间"存储:
// - 日期:YYYY-MM-DD
// - 日期时间:YYYY-MM-DDTHH:mm(无时区后缀,同格式字符串可直接按字典序比较)

export function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function toLocalIso(d: Date): string {
  return `${toDateStr(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function nowLocalIso(): string {
  return toLocalIso(new Date())
}

export function nowTimestamp(): string {
  return new Date().toISOString()
}

export function parseLocalIso(s: string): Date | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s)
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
  }
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

export function addDays(dateStr: string, days: number): string {
  const d = parseLocalIso(dateStr)
  if (!d) return dateStr
  d.setDate(d.getDate() + days)
  return toDateStr(d)
}

export function addMinutesIso(iso: string, minutes: number): string {
  const d = parseLocalIso(iso)
  if (!d) return iso
  d.setMinutes(d.getMinutes() + minutes)
  return toLocalIso(d)
}

export function weekdayOf(dateStr: string): number {
  // 1=周一 ... 7=周日
  const d = parseLocalIso(dateStr)
  if (!d) return 1
  const js = d.getDay()
  return js === 0 ? 7 : js
}

/** ISO 周一(日期属于的周的周一) */
export function mondayOf(dateStr: string): string {
  return addDays(dateStr, -(weekdayOf(dateStr) - 1))
}

export function combineDateAndTime(dateStr: string, timeStr: string): string {
  return `${dateStr}T${timeStr.length === 5 ? timeStr : timeStr.slice(0, 5)}`
}

export function minutesOfDay(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

export function fmtTime(iso: string): string {
  return iso.length >= 16 ? iso.slice(11, 16) : iso
}

export function fmtDateCn(dateStr: string): string {
  return `${Number(dateStr.slice(5, 7))}月${Number(dateStr.slice(8, 10))}日`
}

export function weekdayCn(weekday: number): string {
  return ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][weekday - 1] ?? '周一'
}

/**
 * 教学周计算:semester.startDate 视为第 1 教学周的周一。
 * dateOfWeek(semester, week, weekday) = startDate + (week-1)*7 + (weekday-1)
 */
export function dateOfWeek(startDate: string, week: number, weekday: number): string {
  return addDays(startDate, (week - 1) * 7 + (weekday - 1))
}

export function weekOfDate(startDate: string, dateStr: string): number {
  const diff = Math.round(
    (parseLocalIso(mondayOf(dateStr))!.getTime() - parseLocalIso(mondayOf(startDate))!.getTime()) / 86400000
  )
  return Math.floor(diff / 7) + 1
}

/** 周次数组 [[1,6],[8,17]] 是否包含某周 */
export function weekRangesContain(ranges: Array<[number, number]>, week: number): boolean {
  return ranges.some(([s, e]) => week >= s && week <= e)
}

/** 把 [[1,6],[8,17]] 格式化为 "1-6, 8-17 周" */
export function fmtWeekRanges(ranges: Array<[number, number]>): string {
  return ranges.map(([s, e]) => (s === e ? `${s}` : `${s}-${e}`)).join(', ') + ' 周'
}
