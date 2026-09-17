// 桌宠原生拖动服务:独立 16ms 轮询光标移动窗口;关闭/隐藏/失焦/销毁均自动清理
import { screen } from 'electron'

interface DragState {
  win: Electron.BrowserWindow
  offset: { x: number; y: number }
  timer: ReturnType<typeof setInterval>
  onEnd?: () => void
}

let dragState: DragState | null = null

function stopInternal(state: DragState, notifyEnd: boolean): void {
  clearInterval(state.timer)
  if (notifyEnd) state.onEnd?.()
}

export function createPetDragService(options?: { onEnd?: () => void }): {
  start(win: Electron.BrowserWindow): void
  end(): void
  isDragging(): boolean
} {
  function cleanupIfStale(): void {
    if (!dragState) return
    const { win } = dragState
    if (win.isDestroyed() || !win.isVisible()) {
      stopInternal(dragState, false)
      dragState = null
    }
  }

  return {
    start(win: Electron.BrowserWindow): void {
      if (dragState) return
      const [wx, wy] = win.getPosition()
      const cursor = screen.getCursorScreenPoint()
      const offset = { x: cursor.x - wx, y: cursor.y - wy }
      const timer = setInterval(() => {
        if (!dragState) return
        if (win.isDestroyed() || !win.isVisible()) {
          stopInternal(dragState, false)
          dragState = null
          return
        }
        const c = screen.getCursorScreenPoint()
        win.setPosition(c.x - offset.x, c.y - offset.y)
      }, 16)
      dragState = { win, offset, timer, onEnd: options?.onEnd }
    },

    end(): void {
      if (!dragState) return
      cleanupIfStale()
      stopInternal(dragState, true)
      dragState = null
    },

    isDragging(): boolean {
      return dragState !== null
    }
  }
}
