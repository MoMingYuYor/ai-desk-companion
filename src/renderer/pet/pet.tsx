import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent
} from 'react'
import type { RendererApi } from '../../shared/api'
import type { PetBubble, PetClock, PetMode, PetPort, PetViewState } from './contracts'
import { initialPetState } from './model'
import { createPetController } from './controller'
import { createPetGesture } from './gesture'
import { createPetZoom } from '../../shared/petScale'
import { PetCharacter } from './PetCharacter'
import { PetBubbles } from './PetBubbles'

const systemClock: PetClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id)
}

function todayStr(): string {
  const d = new Date()
  const pad = (n: number): string => (n < 10 ? '0' + n : String(n))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export interface PetAppProps {
  /** 测试或宿主可直接注入端口;缺省使用 window.api(本组件是唯一全局注入点) */
  api?: PetPort
}

export default function PetApp({ api }: PetAppProps = {}) {
  const [view, setView] = useState<{ state: PetViewState; mode: PetMode }>(() => ({
    state: initialPetState(),
    mode: 'idle'
  }))
  const [gestureState, setGestureState] = useState({ pressed: false, dragging: false, releaseKey: 0 })
  const [localBubble, setLocalBubble] = useState<PetBubble | null>(null)
  const [alertKey, setAlertKey] = useState(0)
  const [scale, setScale] = useState(1)
  const zoomRef = useRef(createPetZoom(1))
  const scaleRef = useRef(1)

  const activePointerRef = useRef<number | null>(null)
  const localTimerRef = useRef<number | null>(null)
  const localSeqRef = useRef(10000)
  const lastLocalRef = useRef<{ text: string; at: number } | null>(null)
  const alertSeqRef = useRef(view.state.alertSequence)
  const prevModeRef = useRef<PetMode>('idle')

  // 唯一 window.api 注入点;为 getDayAgenda 补上本地时区今日日期。
  // 显式类型读取,避免依赖 node 工程里被 index.ts 遮蔽的 preload 全局声明。
  const port = useMemo<PetPort>(() => {
    const base = api ?? (window as unknown as { api: RendererApi }).api
    return {
      getDayAgenda: () => base.getDayAgenda(todayStr()),
      addMaterials: (input) => base.addMaterials(input),
      pathForFile: (file) => base.pathForFile(file),
      petDragStart: () => base.petDragStart(),
      petDragEnd: () => base.petDragEnd(),
      petOpenMenu: () => base.petOpenMenu(),
      on: (channel, listener) => base.on(channel, listener),
      getPetActivitySnapshot: () => base.getPetActivitySnapshot(),
      petGetScale: () => Promise.resolve(base.petGetScale?.()),
      petSetScale: (s) => Promise.resolve(base.petSetScale?.(s))
    }
  }, [api])

  const controller = useMemo(
    () => createPetController(port, systemClock, (state, mode) => setView({ state, mode })),
    [port]
  )

  const pushLocalBubble = useCallback((text: string): void => {
    const now = Date.now()
    const last = lastLocalRef.current
    // 去抖:同一文本 1.5 秒内只弹一次
    if (last && last.text === text && now - last.at < 1500) return
    lastLocalRef.current = { text, at: now }
    if (localTimerRef.current !== null) window.clearTimeout(localTimerRef.current)
    localSeqRef.current += 1
    setLocalBubble({ id: localSeqRef.current, text, expiresAt: now + 5000 })
    localTimerRef.current = window.setTimeout(() => {
      localTimerRef.current = null
      setLocalBubble(null)
    }, 5000)
  }, [])

  const gesture = useMemo(
    () =>
      createPetGesture(port, {
        click: () => {
          void controller.showToday()
        },
        change: (value) => setGestureState(value),
        error: () => pushLocalBubble('拖动操作失败,请重试')
      }),
    [port, controller, pushLocalBubble]
  )

  useEffect(() => {
    controller.start()
    return () => {
      controller.dispose()
      void gesture.dispose()
    }
  }, [controller, gesture])

  // 启动时读取已保存的缩放;主进程窗口已按该比例建窗,renderer 同步 zoom
  useEffect(() => {
    let cancelled = false
    void Promise.resolve(port.petGetScale?.())
      .then((s) => {
        if (cancelled || typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return
        zoomRef.current.set(s)
        scaleRef.current = s
        setScale(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [port])

  const applyScale = (next: number): void => {
    if (scaleRef.current === next) return
    scaleRef.current = next
    setScale(next)
    void port.petSetScale?.(next).catch(() => {})
  }

  const handleWheel = (e: ReactWheelEvent): void => {
    applyScale(zoomRef.current.wheel(e.deltaY))
  }

  // 提醒动画仅在进入 alert 或 alertSequence 变化时触发一次
  useEffect(() => {
    let bump = false
    if (view.mode === 'alert') {
      if (prevModeRef.current !== 'alert') bump = true
      if (view.state.alertSequence !== alertSeqRef.current) bump = true
    }
    prevModeRef.current = view.mode
    alertSeqRef.current = view.state.alertSequence
    if (bump) setAlertKey((k) => k + 1)
  }, [view])

  // 窗口隐藏时停止拖动手势;动画由 CSS/隐藏窗口自然停止
  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (document.hidden) {
        activePointerRef.current = null
        gesture.cancel()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [gesture])

  useEffect(
    () => () => {
      if (localTimerRef.current !== null) window.clearTimeout(localTimerRef.current)
    },
    []
  )

  const handlePointerDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0 || !e.isPrimary) return
    if (activePointerRef.current !== null) return
    activePointerRef.current = e.pointerId
    gesture.down({ x: e.screenX, y: e.screenY })
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // 无法捕获时本轮手势作废,避免窗口外拖动失控
      activePointerRef.current = null
      gesture.cancel()
    }
  }

  const handlePointerMove = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (activePointerRef.current !== e.pointerId) return
    gesture.move({ x: e.screenX, y: e.screenY })
  }

  const handlePointerUp = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (activePointerRef.current !== e.pointerId) return
    activePointerRef.current = null
    gesture.up()
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // capture 已失效,忽略
    }
  }

  const handlePointerCancel = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (activePointerRef.current !== null && activePointerRef.current !== e.pointerId) return
    activePointerRef.current = null
    gesture.cancel()
  }

  const handleLostPointerCapture = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (activePointerRef.current !== null && activePointerRef.current !== e.pointerId) return
    activePointerRef.current = null
    gesture.cancel()
  }

  const handleBlur = (): void => {
    if (activePointerRef.current === null) return
    activePointerRef.current = null
    gesture.cancel()
  }

  // 键盘激活与 pointerup 互斥:Enter/Space 走这里,detail===0 的原生 click 不再处理
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      void controller.showToday()
      return
    }
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault()
      void port.petOpenMenu()
    }
  }

  const handleContextMenu = (e: ReactMouseEvent): void => {
    e.preventDefault()
    if (activePointerRef.current !== null) {
      activePointerRef.current = null
      gesture.cancel()
    }
    void port.petOpenMenu()
  }

  const handleDragOver = (e: ReactDragEvent): void => {
    e.preventDefault()
  }

  const handleDrop = (e: ReactDragEvent): void => {
    e.preventDefault()
    const files: string[] = []
    for (const file of Array.from(e.dataTransfer.files)) {
      const path = port.pathForFile(file)
      if (path) files.push(path)
    }
    const text = e.dataTransfer.getData('text/plain') ?? ''
    if (files.length === 0 && !text.trim()) {
      pushLocalBubble('没有可识别的内容')
      return
    }
    void controller.acceptDrop({
      files,
      texts: text.trim() ? [{ name: '拖入的通知文本', content: text }] : []
    })
  }

  const bubbles = localBubble ? [...view.state.bubbles, localBubble] : view.state.bubbles

  return (
    <div
      className="pet-root"
      style={{ zoom: scale }}
      onWheel={handleWheel}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onContextMenu={handleContextMenu}
    >
      <PetBubbles items={bubbles} />
      <button
        type="button"
        className="pet-character-button"
        aria-label="坐姿桌宠"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handleLostPointerCapture}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      >
        <PetCharacter
          mode={view.mode}
          pressed={gestureState.pressed}
          dragging={gestureState.dragging}
          releaseKey={gestureState.releaseKey}
          alertKey={alertKey}
        />
      </button>
    </div>
  )
}
