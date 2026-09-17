import type { PetPort, Point } from './contracts'

export function createPetGesture(
  port: Pick<PetPort, 'petDragStart' | 'petDragEnd'>,
  callbacks: {
    click(): void
    change(value: { pressed: boolean; dragging: boolean; releaseKey: number }): void
    error(): void
  }
): {
  down(point: Point): void
  move(point: Point): void
  up(): void
  cancel(): void
  dispose(): Promise<void>
} {
  let disposed = false
  let startPoint: Point | null = null
  let isPressed = false
  let isDragging = false
  let dragStarted = false
  let releaseSeq = 0
  let operations: Promise<void> = Promise.resolve()

  function enqueue(action: () => Promise<void>): void {
    if (disposed) return
    let p: Promise<void>
    try {
      p = action()
    } catch {
      p = Promise.reject()
    }
    operations = operations
      .then(() => p)
      .catch(() => {
        if (!disposed) callbacks.error()
      })
  }

  function notify(): void {
    if (disposed) return
    callbacks.change({
      pressed: isPressed,
      dragging: isDragging,
      releaseKey: releaseSeq
    })
  }

  return {
    down(p: Point): void {
      if (disposed) return
      startPoint = { x: p.x, y: p.y }
      isPressed = true
      isDragging = false
      dragStarted = false
      notify()
    },

    move(p: Point): void {
      if (disposed || !isPressed || !startPoint) return
      if (!dragStarted) {
        const dist = Math.hypot(p.x - startPoint.x, p.y - startPoint.y)
        if (dist >= 6) {
          dragStarted = true
          isDragging = true
          notify()
          enqueue(async () => {
            await port.petDragStart()
          })
        }
      }
    },

    up(): void {
      if (disposed || !isPressed) return
      const wasDragging = isDragging || dragStarted
      isPressed = false
      isDragging = false
      startPoint = null

      if (wasDragging) {
        releaseSeq++
        notify()
        enqueue(async () => {
          await port.petDragEnd()
        })
      } else {
        notify()
        callbacks.click()
      }
    },

    cancel(): void {
      if (disposed || !isPressed) return
      const wasDragging = isDragging || dragStarted
      isPressed = false
      isDragging = false
      startPoint = null
      notify()

      if (wasDragging) {
        enqueue(async () => {
          await port.petDragEnd()
        })
      }
    },

    async dispose(): Promise<void> {
      disposed = true
      if (isDragging || dragStarted) {
        try {
          await port.petDragEnd()
        } catch {
          // ignore
        }
      }
      isPressed = false
      isDragging = false
      startPoint = null
      return operations
    }
  }
}
