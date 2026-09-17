// 桌宠缩放:滚轮步进与范围限制(渲染层手势与主进程窗口共用)
export const PET_SCALE_MIN = 0.5
export const PET_SCALE_MAX = 2
export const PET_SCALE_STEP = 0.1
/** 触控板小增量累积到此阈值才步进一次(约一个滚轮格) */
const WHEEL_STEP_DELTA = 100

export function clampPetScale(s: number): number {
  const rounded = Math.round(s * 100) / 100
  return Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, rounded))
}

export interface PetZoom {
  get(): number
  set(s: number): number
  wheel(deltaY: number): number
}

export function createPetZoom(initial = 1): PetZoom {
  let scale = clampPetScale(initial)
  let acc = 0
  return {
    get: () => scale,
    set(s: number): number {
      scale = clampPetScale(s)
      acc = 0
      return scale
    },
    wheel(deltaY: number): number {
      acc += deltaY
      if (Math.abs(acc) >= WHEEL_STEP_DELTA) {
        // 向下滚(deltaY>0)缩小,向上滚放大
        const step = acc > 0 ? -PET_SCALE_STEP : PET_SCALE_STEP
        acc = 0
        scale = clampPetScale(scale + step)
      }
      return scale
    }
  }
}
