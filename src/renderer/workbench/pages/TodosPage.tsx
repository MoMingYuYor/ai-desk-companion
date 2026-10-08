import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CalendarEvent, Todo, TodoInput } from '../../../shared/types'
import { fmtDateCn, fmtTime, nowLocalIso, toDateStr } from '../../../shared/dateUtils'
import { Toast, useToast } from '../../shared/util'

interface Props {
  refreshKey: number
  petAction: { action: string; at: number } | null
}

/** 各分组初始可见条数(PERF-02):DOM 只渲染可见切片,业务记录不裁剪 */
const PAGE_SIZE = 50

export function TodosPage({ refreshKey, petAction }: Props): JSX.Element {
  const [todos, setTodos] = useState<Todo[]>([])
  const [editor, setEditor] = useState<Todo | 'new' | null>(null)
  const [toast, showToast] = useToast()
  // 各组独立可见上限:只影响渲染切片,不改业务记录;重新进入页面(重新挂载)默认 50,
  // 页内刷新(落库重拉)保留已调大的上限。
  const [visibleByGroup, setVisibleByGroup] = useState<Record<string, number>>({})

  const reload = useCallback((): void => {
    void window.api.listTodos().then(setTodos)
  }, [])

  useEffect(() => {
    reload()
  }, [reload, refreshKey])

  useEffect(() => {
    if (petAction?.action === 'new-todo') setEditor('new')
  }, [petAction])

  // 刷新入口:挂载 + App 在 evt:data-changed 时统一递增的 refreshKey。
  // 页面不再自行订阅 evt:data-changed:App 已把该广播转为 refreshKey,
  // 双重订阅会让同一次写入触发两次全量 listTodos(PERF-02)。

  const toggle = async (t: Todo): Promise<void> => {
    // 列表刷新由 evt:data-changed 广播驱动(写通道统一经主进程 writeNotify 广播,
    // 广播先于 IPC 回执到达),不再手动重拉:避免同一次完成/取消触发两次全量 listTodos(PERF-02)
    await window.api.updateTodo(t.id, { completedAt: t.completedAt ? null : nowLocalIso() })
  }

  // 分组计算移入 useMemo(PERF-02):同一次计算捕获一次 nowLocalIso() 与当天字符串,
  // 避免每次渲染对 10k 级数据重复执行 5 次 filter + 每行重复取当前时间。
  const { groups, nowIso } = useMemo(() => {
    const capturedNow = nowLocalIso()
    const today = toDateStr(new Date())
    const overdueBefore = capturedNow.slice(0, 10) + 'T00:00'
    const computed: Array<{ label: string; items: Todo[] }> = [
      { label: '已逾期', items: todos.filter((t) => !t.completedAt && t.dueAt && t.dueAt < overdueBefore) },
      { label: '今天', items: todos.filter((t) => !t.completedAt && t.dueAt && t.dueAt.slice(0, 10) === today) },
      {
        label: '未来',
        items: todos.filter(
          (t) => !t.completedAt && t.dueAt && t.dueAt.slice(0, 10) > today
        )
      },
      { label: '无截止时间', items: todos.filter((t) => !t.completedAt && !t.dueAt) },
      { label: '已完成', items: todos.filter((t) => t.completedAt) }
    ]
    return { groups: computed, nowIso: capturedNow }
  }, [todos])

  // 当前编辑条目保持可见:分组在编辑期间重算(如页内刷新)后,
  // 该条目所在组的可见上限至少覆盖其位置。
  const editingId = editor && editor !== 'new' ? editor.id : null
  const visibleLimitOf = (g: { label: string; items: Todo[] }): number => {
    const base = visibleByGroup[g.label] ?? PAGE_SIZE
    if (!editingId) return base
    const idx = g.items.findIndex((t) => t.id === editingId)
    return idx >= 0 ? Math.max(base, idx + 1) : base
  }
  const showMore = (g: { label: string; items: Todo[] }): void => {
    setVisibleByGroup((prev) => ({
      ...prev,
      [g.label]: Math.min(g.items.length, (prev[g.label] ?? PAGE_SIZE) + PAGE_SIZE)
    }))
  }

  return (
    <div
      className="page"
      data-page="todos"
      data-record-total={todos.length}
      data-visible-count={groups.reduce((n, g) => n + Math.min(g.items.length, visibleLimitOf(g)), 0)}
      style={{ flexDirection: 'column' }}
    >
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>待办清单</h3>
        <div className="spacer" />
        <button className="primary" onClick={() => setEditor('new')}>
          + 新建待办
        </button>
      </div>
      <div className="card" style={{ flex: 1 }}>
        {todos.length === 0 && <div className="empty">还没有待办。可以把通知拖给桌宠自动生成,或手动新建。</div>}
        {groups.map((g) => {
          if (g.items.length === 0) return null
          const limit = visibleLimitOf(g)
          const visibleItems = g.items.slice(0, limit)
          const hiddenCount = g.items.length - visibleItems.length
          return (
            <div key={g.label}>
              <div className="group-title">
                {g.label}({g.items.length})
              </div>
              {visibleItems.map((t) => (
                <div key={t.id} data-record-id={t.id} className={`todo-item ${t.completedAt ? 'done' : ''}`}>
                  <input type="checkbox" checked={!!t.completedAt} onChange={() => void toggle(t)} />
                  <span className="title" onClick={() => setEditor(t)} role="button">
                    {t.title}
                    {t.priority === 'high' && <span className="tag warn" style={{ marginLeft: 6 }}>重要</span>}
                    {t.linkedEvent && (
                      <span className="tag" style={{ marginLeft: 6 }} title="已关联执行时段">
                        ⏱ {fmtTime(t.linkedEvent.startAt)} 执行
                      </span>
                    )}
                  </span>
                  {t.dueAt && (
                    <span className={`muted ${!t.completedAt && t.dueAt < nowIso ? 'danger' : ''}`} style={{ color: !t.completedAt && t.dueAt < nowIso ? 'var(--danger)' : undefined }}>
                      截止 {fmtDateCn(t.dueAt)} {fmtTime(t.dueAt)}
                    </span>
                  )}
                  <button className="ghost danger" onClick={() => void del(t.id)}>
                    删除
                  </button>
                </div>
              ))}
              {hiddenCount > 0 && (
                <button className="ghost" style={{ margin: '4px 0 8px' }} onClick={() => showMore(g)}>
                  显示更多(还有 {hiddenCount} 条)
                </button>
              )}
            </div>
          )
        })}
      </div>

      {editor && (
        <TodoEditor
          initial={editor === 'new' ? null : editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            // 广播已驱动列表刷新;只负责关闭编辑器
            setEditor(null)
          }}
          onToast={showToast}
        />
      )}
      <Toast text={toast} />
    </div>
  )

  async function del(id: string): Promise<void> {
    // 刷新由 evt:data-changed 广播驱动,不手动重拉(PERF-02)
    await window.api.deleteTodo(id)
  }
}

// ---------- 编辑器 ----------

function TodoEditor({
  initial,
  onClose,
  onSaved,
  onToast
}: {
  initial: Todo | null
  onClose: () => void
  onSaved: () => void
  onToast: (s: string) => void
}): JSX.Element {
  const isNew = !initial
  const [title, setTitle] = useState(initial?.title ?? '')
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [dueDate, setDueDate] = useState(initial?.dueAt ? initial.dueAt.slice(0, 10) : toDateStr(new Date()))
  const [dueTime, setDueTime] = useState(initial?.dueAt ? initial.dueAt.slice(11, 16) : '23:59')
  const [hasDue, setHasDue] = useState(initial?.dueAt != null || isNew)
  const [priority, setPriority] = useState<Todo['priority']>(initial?.priority ?? 'normal')
  const [link, setLink] = useState<{ date: string; time: string; minutes: number } | null>(
    initial?.linkedEvent
      ? { date: initial.linkedEvent.startAt.slice(0, 10), time: initial.linkedEvent.startAt.slice(11, 16), minutes: 30 }
      : null
  )

  const submit = async (): Promise<void> => {
    if (!title.trim()) return
    const input: TodoInput = {
      title: title.trim(),
      notes: notes || null,
      dueAt: hasDue ? `${dueDate}T${dueTime}` : null,
      priority
    }
    let todoId: string
    if (isNew) {
      const t = await window.api.createTodo(input)
      todoId = t.id
    } else {
      todoId = initial!.id
      await window.api.updateTodo(todoId, input)
    }
    // 关联执行时段:截止时间不变,只生成/更新执行日程
    if (link) {
      const startAt = `${link.date}T${link.time}`
      const endAt = new Date(startAt)
      endAt.setMinutes(endAt.getMinutes() + link.minutes)
      const pad = (n: number): string => (n < 10 ? '0' + n : String(n))
      const endStr = `${endAt.getFullYear()}-${pad(endAt.getMonth() + 1)}-${pad(endAt.getDate())}T${pad(endAt.getHours())}:${pad(endAt.getMinutes())}`
      const current = initial?.linkedEvent
      if (current) {
        await window.api.updateEvent(current.id, {
          startAt,
          endAt: endStr,
          title: `${title.trim()}(执行)`
        })
        await window.api.linkTodoEvent(todoId, current.id)
      } else {
        const ev: CalendarEvent = await window.api.createEvent({
          title: `${title.trim()}(执行)`,
          startAt,
          endAt: endStr,
          notes: '由待办关联生成的执行时段'
        })
        await window.api.linkTodoEvent(todoId, ev.id)
      }
    } else if (initial?.linkedEventId) {
      await window.api.linkTodoEvent(todoId, null)
    }
    onToast('已保存(截止时间与执行时段相互独立)')
    onSaved()
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{isNew ? '新建待办' : '编辑待办'}</h3>
        <div className="form-grid">
          <label>标题</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="需要完成的事" />
          <label>截止时间</label>
          <div className="row">
            <input type="checkbox" checked={hasDue} onChange={(e) => setHasDue(e.target.checked)} />
            {hasDue && (
              <>
                <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                <input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
              </>
            )}
          </div>
          <label>优先级</label>
          <select value={priority} onChange={(e) => setPriority(e.target.value as Todo['priority'])}>
            <option value="normal">普通</option>
            <option value="high">重要</option>
            <option value="low">低</option>
          </select>
          <label>执行时段</label>
          <div className="row">
            <input
              type="checkbox"
              checked={link != null}
              onChange={(e) =>
                setLink(e.target.checked ? { date: hasDue ? dueDate : toDateStr(new Date()), time: '19:00', minutes: 30 } : null)
              }
            />
            {link && (
              <>
                <input type="date" value={link.date} onChange={(e) => setLink({ ...link, date: e.target.value })} />
                <input type="time" value={link.time} onChange={(e) => setLink({ ...link, time: e.target.value })} />
                <select value={link.minutes} onChange={(e) => setLink({ ...link, minutes: Number(e.target.value) })}>
                  <option value={15}>15 分钟</option>
                  <option value={30}>30 分钟</option>
                  <option value={60}>1 小时</option>
                  <option value={90}>1.5 小时</option>
                  <option value={120}>2 小时</option>
                </select>
              </>
            )}
          </div>
          <label>备注</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </div>
        {link && <div className="muted">执行时段会作为日程显示在日历中;调整它不会改变上面的截止时间。</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => void submit()}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
