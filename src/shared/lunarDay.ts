// 农历/节气/节日标签:日历格子与日详情共用
// 优先级:农历节日(含除夕) > 公历节日 > 节气 > 农历初一(显示月名) > 农历日
import solarLunar from 'solarlunar'

export interface LunarDayInfo {
  /** 日历格子小字:节日/节气/农历月名/农历日 */
  label: string
  /** 命中节日时的高亮名 */
  festival?: string
  /** 命中节气时的名字 */
  term?: string
  lunarMonthName: string
  lunarDayName: string
}

const LUNAR_FESTIVALS: Record<string, string> = {
  '1-1': '春节',
  '1-15': '元宵节',
  '5-5': '端午节',
  '7-7': '七夕',
  '8-15': '中秋节',
  '9-9': '重阳节',
  '12-8': '腊八节'
}

const SOLAR_FESTIVALS: Record<string, string> = {
  '1-1': '元旦',
  '5-1': '劳动节',
  '6-1': '儿童节',
  '10-1': '国庆节'
}

export function lunarInfo(y: number, m: number, d: number): LunarDayInfo {
  const lunar = solarLunar.solar2lunar(y, m, d)
  const key = `${lunar.lMonth}-${lunar.lDay}`
  const festival =
    (!lunar.isLeap ? LUNAR_FESTIVALS[key] : undefined) ??
    (lunar.lMonth === 12 && isLastDayOfLunarYear(y, m, d) ? '除夕' : undefined) ??
    SOLAR_FESTIVALS[`${m}-${d}`]
  const term = lunar.isTerm ? lunar.term : undefined
  return {
    label: festival ?? term ?? (lunar.lDay === 1 ? lunar.monthCn : lunar.dayCn),
    festival,
    term,
    lunarMonthName: lunar.monthCn,
    lunarDayName: lunar.dayCn
  }
}

export function lunarLabel(dateStr: string): string {
  return lunarInfo(Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)), Number(dateStr.slice(8, 10))).label
}

function isLastDayOfLunarYear(y: number, m: number, d: number): boolean {
  const next = new Date(y, m - 1, d + 1)
  const nextLunar = solarLunar.solar2lunar(next.getFullYear(), next.getMonth() + 1, next.getDate())
  return nextLunar.lMonth === 1 && nextLunar.lDay === 1
}
