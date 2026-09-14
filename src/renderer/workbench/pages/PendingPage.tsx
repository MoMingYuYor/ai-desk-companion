import { useCallback, useEffect, useState } from 'react'
import type { PendingItem } from '../../../shared/types'
import { Toast, useSubscribe, useToast } from '../../shared/util'

interface Props {
  refreshKey: number
}

export function PendingPage({ refreshKey }: Props): JSX.Element {
  const [items, setItems] = useState<PendingItem[]>([])
  const [toast, showToast] = useToast()

  const reload = useCallback((): void => {
    void window.api.listPending().then(setItems)
  }, [])

  useEffect(() => {
    reload()
  }, [reload, refreshKey])

  useSubscribe('evt:data-changed', useCallback(() => reload(), [reload]))

  const toTodo = async (p: PendingItem): Promise<void> => {
    await window.api.createTodo({ title: p.title, notes: p.notes ?? null })
    await window.api.updatePending(p.id, { status: 'handled' })
    reload()
    showToast('已转为待办')
  }

  const toEvent = async (p: PendingItem): Promise<void> => {
    await window.api.createEvent({
      title: p.title,
      startAt: nextHourSlot(),
      endAt: nextHourSlot(),
      notes: p.notes ?? null
    })
    await window.api.updatePending(p.id, { status: 'handled' })
    reload()
    showToast('已按最近空闲整点加入日历,可在日历中调整时间')
  }

  return (
    <div className="page" style={{ flexDirection: 'column' }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>📥 待处理</h3>
        <span className="muted">暂未决定的事项:读完通知后先放一放,之后可以补充材料继续讨论</span>
      </div>
      <div className="card" style={{ flex: 1 }}>
        {items.length === 0 && <div className="empty">没有待处理事项。分析结果中点"暂不处理"的事项会出现在这里。</div>}
        {items.map((p) => (
          <div key={p.id} className="todo-item">
            <div style={{ flex: 1 }}>
              <div>{p.title}</div>
              {p.notes && <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>{p.notes}</div>}
            </div>
            <button onClick={() => void toTodo(p)}>转为待办</button>
            <button onClick={() => void toEvent(p)}>转为日程</button>
            <button
              className="ghost danger"
              onClick={async () => {
                await window.api.deletePending(p.id)
                reload()
              }}
            >
              删除
            </button>
          </div>
        ))}
      </div>
      <Toast text={toast} />
    </div>
  )
}

function nextHourSlot(): string {
  const d = new Date()
  d.setMinutes(0, 0, 0)
  d.setHours(d.getHours() + 1)
  const pad = (n: number): string => (n < 10 ? '0' + n : String(n))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`
}
