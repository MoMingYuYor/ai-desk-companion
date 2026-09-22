import { describe, expect, it } from 'vitest'
import { fixedClock, measureMs, systemClock } from '../../src/shared/clock'

// C-02:上下文时钟契约。核心约束是"固定时钟只控制领域日期,不代替耗时测量的单调时钟"。

describe('fixedClock 冻结领域时间', () => {
  it('now() 恒定返回注入时刻,不随真实时间推进', () => {
    const clock = fixedClock('2026-09-28T01:00:00.000Z')
    const first = clock.now()
    const second = clock.now()
    expect(first.toISOString()).toBe('2026-09-28T01:00:00.000Z')
    expect(second.getTime()).toBe(first.getTime())
  })

  it('接受 Date 实例', () => {
    const at = new Date('2026-09-28T09:00:00.000Z')
    expect(fixedClock(at).now().getTime()).toBe(at.getTime())
  })

  it('不可解析的时间抛错,不静默回退到当前时间', () => {
    expect(() => fixedClock('not-a-date')).toThrow(/无法解析时间/)
  })
})

describe('monotonicMs 不随固定时钟冻结', () => {
  it('固定时钟的 monotonicMs 仍会随真实时间推进', () => {
    const clock = fixedClock('2026-09-28T01:00:00.000Z')
    const started = clock.monotonicMs()
    // 空转至单调时钟前进(上限 50ms,避免慢机器上成为长尾)
    while (clock.monotonicMs() === started) {
      /* busy wait */
    }
    expect(clock.monotonicMs()).toBeGreaterThan(started)
  })

  it('固定时钟下 measureMs 不恒为 0', () => {
    const clock = fixedClock('2026-09-28T01:00:00.000Z')
    const elapsed = measureMs(clock, () => {
      const t = clock.monotonicMs()
      while (clock.monotonicMs() === t) {
        /* busy wait */
      }
    })
    expect(elapsed).toBeGreaterThan(0)
  })

  it('systemClock 的 now() 与真实时间一致(秒级)', () => {
    const before = Date.now()
    const got = systemClock.now().getTime()
    const after = Date.now()
    expect(got).toBeGreaterThanOrEqual(before)
    expect(got).toBeLessThanOrEqual(after)
  })
})

describe('measureMs 返回耗时', () => {
  it('非空 fn 的耗时非负', () => {
    expect(measureMs(systemClock, () => undefined)).toBeGreaterThanOrEqual(0)
  })

  it('fn 抛错时异常向上传播', () => {
    expect(() =>
      measureMs(systemClock, () => {
        throw new Error('工具执行失败')
      })
    ).toThrow('工具执行失败')
  })
})
