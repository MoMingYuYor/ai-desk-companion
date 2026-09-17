import { screen } from 'electron'

export interface WindowPlacement {
  x: number
  y: number
  width: number
  height: number
}

/** 求矩形与某显示器工作区的有效交集面积 */
function intersectionArea(r: { x: number; y: number; width: number; height: number }, area: Electron.Rectangle): number {
  const x1 = Math.max(r.x, area.x)
  const y1 = Math.max(r.y, area.y)
  const x2 = Math.min(r.x + r.width, area.x + area.width)
  const y2 = Math.min(r.y + r.height, area.y + area.height)
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
}

/**
 * 计算桌宠窗口还原位置:
 * - 校验旧坐标为有限数值;
 * - 若与任一显示器工作区有有效交集则按原位置返回;
 * - 否则回主屏工作区右下角,不越过任务栏。
 */
export function resolvePetPlacement(
  savedX: string | null | undefined,
  savedY: string | null | undefined,
  size: { width: number; height: number }
): { x: number; y: number } {
  const x = Number(savedX)
  const y = Number(savedY)
  const valid =
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    savedX !== null &&
    savedX !== undefined &&
    savedY !== null &&
    savedY !== undefined

  if (valid) {
    const rect = { x, y, width: size.width, height: size.height }
    const displays = screen.getAllDisplays()
    const best = displays.reduce((max, d) => Math.max(max, intersectionArea(rect, d.workArea)), 0)
    if (best > 0) return { x, y }
  }

  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: workArea.x + workArea.width - size.width - 24,
    y: workArea.y + workArea.height - size.height - 24
  }
}

/** 信息面板摆放在桌宠左侧,间距 16,按目标显示器工作区收拢 */
export function panelBoundsForPet(
  pet: { x: number; y: number; width: number },
  panelSize: { width: number; height: number }
): { x: number; y: number } {
  const target =
    screen.getAllDisplays().find((d) => {
      const { workArea } = d
      return pet.x >= workArea.x && pet.x < workArea.x + workArea.width
    }) ?? screen.getPrimaryDisplay()
  const { workArea } = target
  const x = Math.max(workArea.x, Math.min(pet.x - pet.width + 0 - panelSize.width - 16, workArea.x + workArea.width - panelSize.width))
  const y = Math.max(workArea.y, Math.min(pet.y, workArea.y + workArea.height - panelSize.height))
  return { x, y }
}
