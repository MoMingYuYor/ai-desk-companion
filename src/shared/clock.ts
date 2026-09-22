// 上下文时钟(C-02 契约底座):领域时间与耗时测量分离。
// 约束(总体规格第 5 节):固定时钟只控制领域日期,不代替耗时测量的单调时钟。
// 因此本模块把两者拆成独立能力:now() 可被固定时钟替换,monotonicMs() 始终走真实单调时钟。

export interface Clock {
  /** 领域"当前时间";可被固定时钟替换,用于固定日期场景与评测 */
  now(): Date
  /**
   * 单调毫秒,用于测量耗时(duration_ms)。
   * 固定时钟不替换本能力:否则评测中的 duration 恒为 0,无法区分真实耗时与占位值。
   */
  monotonicMs(): number
}

function readMonotonicMs(): number {
  const perf = globalThis.performance
  return typeof perf?.now === 'function' ? perf.now() : Date.now()
}

/** 生产时钟:领域时间取系统时间,耗时取单调时钟 */
export const systemClock: Clock = {
  now: () => new Date(),
  monotonicMs: readMonotonicMs
}

/**
 * 固定时钟:冻结领域时间,耗时仍走真实单调时钟。
 * instant 接受 ISO 8601 串或 Date;不可解析时抛错,不做静默回退(与 dateUtils 的 parseLocalIso 约定一致)。
 */
export function fixedClock(instant: string | Date): Clock {
  const at = typeof instant === 'string' ? new Date(instant) : instant
  const ms = at.getTime()
  if (Number.isNaN(ms)) {
    throw new Error(`fixedClock: 无法解析时间 ${String(instant)}`)
  }
  return {
    now: () => new Date(ms),
    monotonicMs: readMonotonicMs
  }
}

/** 以固定时钟包装一个同步耗时区间;返回毫秒,用于 duration_ms 落库 */
export function measureMs(clock: Clock, fn: () => void): number {
  const started = clock.monotonicMs()
  fn()
  return clock.monotonicMs() - started
}
