import { useCallback, useEffect, useRef, useState } from 'react'
import '../shared/ui.css'

type PetState = 'idle' | 'busy' | 'alert'

interface Bubble {
  id: number
  text: string
}

let bubbleSeq = 1

export default function PetApp(): JSX.Element {
  const [state, setState] = useState<PetState>('idle')
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [hover, setHover] = useState(false)
  const [bounce, setBounce] = useState(false)
  const dragRef = useRef<{ active: boolean; moved: boolean; startX: number; startY: number } | null>(null)

  const pushBubble = useCallback((text: string, ttl = 5000): void => {
    const b = { id: bubbleSeq++, text }
    setBubbles((prev) => [...prev.slice(-2), b])
    setTimeout(() => {
      setBubbles((prev) => prev.filter((x) => x.id !== b.id))
    }, ttl)
  }, [])

  useEffect(() => {
    const offs = [
      window.api.on('evt:pet-bubble', (p) => {
        const { text } = p as { text: string }
        if (text) pushBubble(text)
      }),
      window.api.on('evt:pet-state', (p) => {
        const { state: s } = p as { state: PetState }
        setState(s)
      }),
      window.api.on('evt:reminder-fired', (p) => {
        const { title } = p as { title: string }
        pushBubble('⏰ ' + title, 8000)
        setState('alert')
        setTimeout(() => setState('idle'), 8000)
      }),
      window.api.on('evt:model-switched', (p) => {
        const { from, to, reason } = p as { from: string; to: string; reason: string }
        if (from && to) pushBubble(`🔀 ${reason}:${to}`, 6000)
        else if (reason) pushBubble(`⚠ ${reason}`, 8000)
      }),
      window.api.on('evt:materials-accepted', () => {
        setState('busy')
        pushBubble('收到材料,分析中…')
      }),
      window.api.on('evt:analysis-updated', () => {
        setState('idle')
        pushBubble('分析完成,打开工作台查看结果')
      })
    ]
    return () => offs.forEach((off) => off())
  }, [pushBubble])

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setHover(false)
    const files: string[] = []
    for (const f of Array.from(e.dataTransfer.files)) {
      const p = window.api.pathForFile(f)
      if (p) files.push(p)
    }
    const text = e.dataTransfer.getData('text/plain') ?? ''
    if (files.length === 0 && !text.trim()) {
      pushBubble('没有可识别的内容')
      return
    }
    try {
      await window.api.addMaterials({
        files,
        texts: text.trim() ? [{ name: '拖入的通知文本', content: text }] : []
      })
    } catch {
      pushBubble('接收材料失败')
    }
  }

  const onMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    dragRef.current = { active: true, moved: false, startX: e.screenX, startY: e.screenY }
    void window.api.petDragStart()
  }

  const onMouseMove = (e: React.MouseEvent): void => {
    const d = dragRef.current
    if (!d?.active) return
    if (!d.moved && Math.abs(e.screenX - d.startX) + Math.abs(e.screenY - d.startY) > 5) {
      d.moved = true
      void window.api.petDragMove()
    }
  }

  const onMouseUp = (): void => {
    const d = dragRef.current
    dragRef.current = null
    void window.api.petDragEnd()
    if (d && !d.moved) {
      // 点击互动:蹦一下,并提示今日要点
      setBounce(true)
      setTimeout(() => setBounce(false), 600)
      void window.api.getDayAgenda(todayStr()).then((a) => {
        const count = a.events.length + a.courses.filter((c) => !c.cancelled).length
        const todo = a.todos.length
        pushBubble(
          count === 0 && todo === 0
            ? '今天没有安排,好好休息~'
            : `今天有 ${a.courses.filter((c) => !c.cancelled).length} 节课、${a.events.length} 个日程` + (todo ? `,${todo} 项待办到期` : '')
        )
      })
    }
  }

  const eyeShift = state === 'busy' ? 2 : 0

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-end',
        background: 'transparent',
        userSelect: 'none',
        WebkitAppRegion: 'no-drag'
      } as React.CSSProperties}
      onDragOver={(e) => {
        e.preventDefault()
        setHover(true)
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => void onDrop(e)}
      onContextMenu={(e) => {
        e.preventDefault()
        void window.api.petOpenMenu()
      }}
    >
      {/* 气泡 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center', marginBottom: 4 }}>
        {bubbles.map((b) => (
          <div
            key={b.id}
            style={{
              background: 'rgba(35, 42, 59, 0.92)',
              color: '#fff',
              padding: '6px 12px',
              borderRadius: 10,
              fontSize: 12,
              maxWidth: 260,
              lineHeight: 1.5,
              boxShadow: '0 4px 14px rgba(0,0,0,.25)'
            }}
          >
            {b.text}
          </div>
        ))}
      </div>

      {/* 桌宠本体 */}
      <div
        style={{
          width: 110,
          height: 110,
          position: 'relative',
          cursor: 'grab',
          transform: hover ? 'scale(1.06)' : bounce ? 'translateY(-10px)' : 'none',
          transition: 'transform .18s ease',
          animation: state === 'busy' ? 'pet-wobble 1s ease-in-out infinite' : 'pet-bob 3.2s ease-in-out infinite'
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
      >
        {hover && (
          <div
            style={{
              position: 'absolute',
              inset: -8,
              border: '2px dashed #4f7cff',
              borderRadius: '50%'
            }}
          />
        )}
        <svg viewBox="0 0 110 110" width="110" height="110">
          <defs>
            <radialGradient id="bodyGrad" cx="35%" cy="30%">
              <stop offset="0%" stopColor={state === 'alert' ? '#ffb199' : '#9db9ff'} />
              <stop offset="100%" stopColor={state === 'alert' ? '#e5534b' : '#4f7cff'} />
            </radialGradient>
          </defs>
          <ellipse cx="55" cy="60" rx="44" ry="40" fill="url(#bodyGrad)" />
          {/* 耳朵 */}
          <circle cx="26" cy="26" r="12" fill="#4f7cff" />
          <circle cx="84" cy="26" r="12" fill="#4f7cff" />
          <circle cx="26" cy="26" r="6" fill="#ffd9e8" />
          <circle cx="84" cy="26" r="6" fill="#ffd9e8" />
          {/* 眼睛 */}
          {state === 'busy' ? (
            <>
              <path d="M32 52 q6 -6 12 0" stroke="#1e2a4a" strokeWidth="3" fill="none" strokeLinecap="round" />
              <path d="M66 52 q6 -6 12 0" stroke="#1e2a4a" strokeWidth="3" fill="none" strokeLinecap="round" />
            </>
          ) : (
            <>
              <circle cx="38" cy={52 + eyeShift} r="5.5" fill="#1e2a4a" />
              <circle cx="72" cy={52 + eyeShift} r="5.5" fill="#1e2a4a" />
              <circle cx={40 + eyeShift} cy={50 + eyeShift} r="1.8" fill="#fff" />
              <circle cx={74 + eyeShift} cy={50 + eyeShift} r="1.8" fill="#fff" />
            </>
          )}
          {/* 腮红 */}
          <ellipse cx="27" cy="64" rx="6" ry="3.5" fill="#ff9db1" opacity="0.7" />
          <ellipse cx="83" cy="64" rx="6" ry="3.5" fill="#ff9db1" opacity="0.7" />
          {/* 嘴 */}
          {state === 'alert' ? (
            <ellipse cx="55" cy="72" rx="5" ry="6" fill="#1e2a4a" />
          ) : (
            <path d="M46 70 q9 8 18 0" stroke="#1e2a4a" strokeWidth="3" fill="none" strokeLinecap="round" />
          )}
          {state === 'alert' && (
            <text x="94" y="20" fontSize="22" fontWeight="700" fill="#e5534b">
              !
            </text>
          )}
        </svg>
      </div>

      <style>{`
        @keyframes pet-bob {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-5px); }
        }
        @keyframes pet-wobble {
          0%, 100% { transform: rotate(-4deg); }
          50% { transform: rotate(4deg); }
        }
      `}</style>
    </div>
  )
}

function todayStr(): string {
  const d = new Date()
  const pad = (n: number): string => (n < 10 ? '0' + n : String(n))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
