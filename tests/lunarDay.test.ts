import { describe, expect, it } from 'vitest'
import { lunarInfo, lunarLabel } from '../src/shared/lunarDay'

// 期望值已用 solarlunar 真实输出核对(2026年历)
describe('lunarInfo', () => {
  it('农历传统节日优先于农历日显示', () => {
    expect(lunarInfo(2026, 9, 25).label).toBe('中秋节')
    expect(lunarInfo(2026, 2, 17).label).toBe('春节')
    expect(lunarInfo(2026, 1, 1).label).toBe('元旦')
    expect(lunarInfo(2026, 10, 1).label).toBe('国庆节')
  })

  it('除夕取腊月最后一天(2026 年腊月仅廿九)', () => {
    expect(lunarInfo(2026, 2, 16).label).toBe('除夕')
  })

  it('节气日显示节气名', () => {
    expect(lunarInfo(2026, 9, 7).label).toBe('白露')
    expect(lunarInfo(2026, 9, 23).label).toBe('秋分')
  })

  it('普通日显示农历日;初一显示农历月名', () => {
    expect(lunarInfo(2026, 9, 17).label).toBe('初七')
    expect(lunarInfo(2026, 9, 11).label).toBe('八月')
  })

  it('返回农历月日名供详情页使用', () => {
    const info = lunarInfo(2026, 9, 17)
    expect(info.lunarMonthName).toBe('八月')
    expect(info.lunarDayName).toBe('初七')
  })

  it('lunarLabel 接受 YYYY-MM-DD 字符串', () => {
    expect(lunarLabel('2026-09-25')).toBe('中秋节')
    expect(lunarLabel('2026-09-17')).toBe('初七')
  })
})
