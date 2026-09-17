import type { PetActivityNotice } from '../../shared/pet'
import type { PetClock, PetPort, PetViewState } from './contracts'
import { addBubble, applyActivity, expire, initialPetState, selectMode, setAlert } from './model'

export interface PetController {
  start(): void
  mode(): ReturnType<typeof selectMode>
  state(): PetViewState
  showToday(): Promise<void>
  acceptDrop(input: Parameters<PetPort['addMaterials']>[0]): Promise<void>
  dispose(): void
}

const BUBBLE_TTL = { default: 5000, analysis: 6000, alert: 8000 } as const

export function createPetController(
  api: PetPort,
  clock: PetClock,
  render: (state: PetViewState, mode: ReturnType<typeof selectMode>) => void
): PetController {
  let current = initialPetState()
  let disposed = false
  const timers = new Set<number>()
  const seenReminders: string[] = []

  function schedule(fn: () => void, ms: number): void {
    const id = clock.setTimeout(() => {
      timers.delete(id)
      if (disposed) return
      fn()
    }, ms)
    timers.add(id)
  }

  function emit(): void {
    if (disposed) return
    render(current, selectMode(current, clock.now()))
  }

  function push(text: string, ttl: number = BUBBLE_TTL.default): void {
    current = addBubble(current, text, clock.now(), ttl)
    emit()
    schedule(() => {
      current = expire(current, clock.now())
      emit()
    }, ttl + 50)
  }

  function handleActivity(n: PetActivityNotice): void {
    const before = current.activity
    current = applyActivity(current, n)
    if (current.activity.revision === before.revision) return
    const finished = n.finished
    if (finished) {
      if (finished.outcome === 'done') {
        push('分析完成,打开工作台查看结果', BUBBLE_TTL.analysis)
      } else if (finished.outcome === 'failed') {
        current = setAlert(current, clock.now(), BUBBLE_TTL.alert)
        push('分析失败,请在工作台查看原因', BUBBLE_TTL.alert)
      }
      // cancelled: 不显示成功、不弹错误
    }
    emit()
    schedule(() => {
      current = expire(current, clock.now())
      emit()
    }, 100)
  }

  return {
    start(): void {
      // 先订阅,再取快照;只应用较新 revision
      api.on('evt:pet-activity', (n) => {
        handleActivity(n as PetActivityNotice)
      })
      api.on('evt:reminder-fired', (p) => {
        const { key, title } = p as { key?: string; title: string }
        const dedupKey = key ?? title
        if (seenReminders.includes(dedupKey)) return
        seenReminders.push(dedupKey)
        if (seenReminders.length > 100) seenReminders.shift()
        current = setAlert(current, clock.now(), BUBBLE_TTL.alert)
        push(`⏰ ${title}`, BUBBLE_TTL.alert)
        schedule(() => {
          current = expire(current, clock.now())
          emit()
        }, BUBBLE_TTL.alert + 50)
      })
      api.on('evt:model-switched', (p) => {
        const { from, to, reason } = p as { from: string; to: string; reason: string }
        if (from && to) push(`🔀 ${reason}:${to}`, BUBBLE_TTL.analysis)
        else if (reason) push(`⚠ ${reason}`, BUBBLE_TTL.alert)
      })
      api.on('evt:pet-bubble', (p) => {
        const { text } = p as { text: string }
        if (text) push(text)
      })
      // materials-accepted / analysis-updated 不再直接改 busy 或生成成功气泡

      void api.getPetActivitySnapshot().then((snap) => {
        if (disposed) return
        current = applyActivity(current, snap)
        emit()
      })
      emit()
    },

    mode(): ReturnType<typeof selectMode> {
      return selectMode(current, clock.now())
    },

    state(): PetViewState {
      return current
    },

    async showToday(): Promise<void> {
      try {
        const now = new Date(clock.now())
        const pad = (n: number): string => (n < 10 ? '0' + n : String(n))
        const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
        const a = await api.getDayAgenda(today)
        const courseCount = a.courses.filter((c) => !c.cancelled).length
        const count = a.events.length + courseCount
        const todo = a.todos.length
        push(
          count === 0 && todo === 0
            ? '今天没有安排,好好休息~'
            : `今天有 ${courseCount} 节课、${a.events.length} 个日程` +
                (todo ? `,${todo} 项待办到期` : '')
        )
      } catch {
        push('今日要点获取失败')
      }
    },

    async acceptDrop(input: Parameters<PetPort['addMaterials']>[0]): Promise<void> {
      current = { ...current, pendingIntakes: current.pendingIntakes + 1 }
      emit()
      try {
        await api.addMaterials(input)
      } catch {
        push('接收材料失败')
      } finally {
        current = { ...current, pendingIntakes: Math.max(0, current.pendingIntakes - 1) }
        emit()
      }
    },

    dispose(): void {
      disposed = true
      for (const id of timers) clock.clearTimeout(id)
      timers.clear()
    }
  }
}
