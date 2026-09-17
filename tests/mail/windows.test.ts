import { describe, expect, it } from 'vitest'
import { earlierWindow, incrementalRange, initialWindow, shiftDay } from '../../src/main/mail/windows'

describe('日期区间与 UID 边界纯函数', () => {
  it('按计划示例给出初始窗口与历史窗口', () => {
    expect(initialWindow('2026-09-15')).toEqual({ since: '2026-08-17', before: '2026-09-16' })
    expect(earlierWindow('2026-08-17')).toEqual({ since: '2026-07-18', before: '2026-08-17' })
    expect(incrementalRange(100, 101)).toBeNull()
    expect(incrementalRange(100, 105)).toBe('101:104')
  })

  it('连续 30 天窗口无缝且无重叠', () => {
    const first = initialWindow('2026-09-15')
    const windows = [first]
    let oldest = first.since
    for (let i = 0; i < 12; i += 1) {
      const win = earlierWindow(oldest)
      windows.push(win)
      oldest = win.since
    }
    for (let i = 1; i < windows.length; i += 1) {
      // 上一窗口的 since 恰好是本窗口的 before,覆盖连续且不重复
      expect(windows[i].before).toBe(windows[i - 1].since)
    }
    for (const win of windows) {
      expect(shiftDay(win.since, 30)).toBe(win.before)
    }
  })

  it('UTC 日历运算跨月与闰年稳定', () => {
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftDay('2024-03-01', -1)).toBe('2024-02-29')
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31')
    expect(initialWindow('2026-01-01')).toEqual({ since: '2025-12-03', before: '2026-01-02' })
  })

  it('增量区间拒绝空区间与倒序区间', () => {
    expect(incrementalRange(5, 6)).toBeNull()
    expect(incrementalRange(10, 10)).toBeNull()
    expect(incrementalRange(200, 100)).toBeNull()
    expect(incrementalRange(0, 2)).toBe('1:1')
  })
})
