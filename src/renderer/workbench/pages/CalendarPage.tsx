import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CalendarEvent, CourseOccurrence, DayAgenda, EventInput } from '../../../shared/types'
import { fmtTime, toDateStr, weekdayCn } from '../../../shared/dateUtils'
import { lunarInfo, lunarLabel } from '../../../shared/lunarDay'
import { Toast, useToast } from '../../shared/util'

interface Props {
  refreshKey: number
  petAction: { action: string; at: number } | null
}

/** 选中日详情各分区初始可见条数(PERF-02):只影响渲染切片,不裁剪业务数据 */
const DETAIL_PAGE_SIZE = 50

export function CalendarPage({ refreshKey, petAction }: Props): JSX.Element {
  const today = toDateStr(new Date())
  const [cursor, setCursor] = useState({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) })
  const [selected, setSelected] = useState(today)
  const [agenda, setAgenda] = useState<DayAgenda | null>(null)
  const [eventsByDay, setEventsByDay] = useState<Record<string, CalendarEvent[]>>({})
  const [coursesByDay, setCoursesByDay] = useState<Record<string, CourseOccurrence[]>>({})
  const [editor, setEditor] = useState<CalendarEvent | 'new' | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [toast, showToast] = useToast()
  // 选中日详情各分区可见上限;切日时重置(见下方 effect)
  const [agendaLimits, setAgendaLimits] = useState({ events: DETAIL_PAGE_SIZE, todos: DETAIL_PAGE_SIZE })
  // PERF-02:请求代号防显示回退——切日/切月/刷新后,晚到的旧日期/旧月份响应一律丢弃
  const monthReqRef = useRef(0)
  const dayReqRef = useRef(0)
  const prevSelectedRef = useRef(selected)

  const monthStart = useMemo(() => `${cursor.y}-${pad(cursor.m)}-01`, [cursor])

  const reload = useCallback((): void => {
    // 读取整个月(含前后各 7 天以覆盖跨月事件)
    const token = ++monthReqRef.current
    const from = addDaysStr(`${cursor.y}-${pad(cursor.m)}-01`, -7)
    const to = addDaysStr(nextMonth(cursor.y, cursor.m) + '-01', 7)
    void window.api.listEvents(from + 'T00:00', to + 'T23:59').then((events) => {
      if (monthReqRef.current !== token) return // 已有更新的月份请求,丢弃旧响应
      const map: Record<string, CalendarEvent[]> = {}
      for (const ev of events) {
        const d = ev.startAt.slice(0, 10)
        ;(map[d] ??= []).push(ev)
      }
      setEventsByDay(map)
    })
    // 课程:按天请求当月
    const days = monthDays(cursor.y, cursor.m)
    void Promise.all(
      days.map((d) => window.api.getDayAgenda(d).then((a) => [d, a.courses] as const))
    ).then((entries) => {
      if (monthReqRef.current !== token) return // 已有更新的月份请求,丢弃旧响应
      const map: Record<string, CourseOccurrence[]> = {}
      for (const [d, c] of entries) map[d] = c
      setCoursesByDay(map)
    })
  }, [cursor])

  useEffect(() => {
    reload()
  }, [reload, refreshKey])

  // 刷新入口:挂载 + App 在 evt:data-changed 时统一递增的 refreshKey(refreshKey 变化
  // 同时经日详情效应重取选中日 agenda)。页面不再自行订阅 evt:data-changed,
  // 否则同一次写入会触发两次整月重载(listEvents + 31 次 getDayAgenda,PERF-02)。

  useEffect(() => {
    const token = ++dayReqRef.current
    void window.api.getDayAgenda(selected).then((a) => {
      if (dayReqRef.current !== token) return // 已切到别的日期,丢弃旧日期响应
      setAgenda(a)
    })
  }, [selected, refreshKey, editor])

  // 切日重置详情各分区可见上限(仅日期变化时;同日的刷新/编辑关闭不折叠)
  useEffect(() => {
    if (prevSelectedRef.current !== selected) {
      prevSelectedRef.current = selected
      setAgendaLimits({ events: DETAIL_PAGE_SIZE, todos: DETAIL_PAGE_SIZE })
    }
  }, [selected])

  // 桌宠"新建日程"
  useEffect(() => {
    if (petAction?.action === 'new-event') setEditor('new')
  }, [petAction])

  // 刷新入口:挂载 + App 在 evt:data-changed 时统一递增的 refreshKey(refreshKey 变化
  // 同时经日详情效应重取选中日 agenda)。页面不再自行订阅 evt:data-changed,
  // 否则同一次写入会触发两次整月重载(listEvents + 31 次 getDayAgenda,PERF-02)。

  const save = async (input: EventInput, id?: string): Promise<void> => {
    try {
      if (id) await window.api.updateEvent(id, input)
      else await window.api.createEvent(input)
    } catch (err) {
      // 落盘失败(R2):不关闭编辑器、不清输入、不提示已保存,
      // 明确标识"保存未确认"并保留重试入口(编辑器内的保存按钮)
      const message = err instanceof Error ? err.message : String(err)
      setSaveError(`保存未确认:数据尚未落盘(${message})。请重试。`)
      return
    }
    setSaveError(null)
    setEditor(null)
    // 网格刷新由 evt:data-changed 广播驱动(写通道统一经主进程 writeNotify 广播),
    // 日详情随编辑器关闭经 [selected, refreshKey, editor] 效应重取;不手动重拉整月(PERF-02)
    showToast('已保存')
  }

  // 生成 6x7 网格
  const cells = useMemo(() => {
    const first = new Date(cursor.y, cursor.m - 1, 1)
    const js = first.getDay()
    const lead = js === 0 ? 6 : js - 1
    const start = new Date(cursor.y, cursor.m - 1, 1 - lead)
    const out: string[] = []
    for (let i = 0; i < 42; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      out.push(toDateStr(d))
    }
    return out
  }, [cursor])

  const selLunar = lunarInfo(
    Number(selected.slice(0, 4)),
    Number(selected.slice(5, 7)),
    Number(selected.slice(8, 10))
  )

  return (
    <div className="page" data-page="calendar" style={{ flexDirection: 'column' }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <button onClick={() => setCursor(stepMonth(cursor, -1))}>←</button>
        <span style={{ fontWeight: 700, fontSize: 16 }}>
          {cursor.y} 年 {cursor.m} 月
        </span>
        <button onClick={() => setCursor(stepMonth(cursor, 1))}>→</button>
        <button onClick={() => setCursor({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) })}>今天</button>
        <div className="spacer" />
        <button className="primary" onClick={() => setEditor('new')}>
          + 新建日程
        </button>
      </div>
      <div style={{ display: 'flex', gap: 14, flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="cal-head">
            {['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((d) => (
              <div key={d}>{d}</div>
            ))}
          </div>
          <div className="cal-grid">
            {cells.map((d) => {
              const evs = eventsByDay[d] ?? []
              const cs = coursesByDay[d] ?? []
              const isToday = d === today
              const otherMonth = Number(d.slice(5, 7)) !== cursor.m
              const lunar = lunarLabel(d)
              const lunarCls = lunarInfo(
                Number(d.slice(0, 4)),
                Number(d.slice(5, 7)),
                Number(d.slice(8, 10))
              )
              return (
                <div
                  key={d}
                  data-date={d}
                  className={`cal-cell ${isToday ? 'today' : ''} ${otherMonth ? 'other-month' : ''}`}
                  onClick={() => setSelected(d)}
                >
                  <div className="d-row">
                    <span className="d">{Number(d.slice(8, 10))}</span>
                    <span className={`lunar ${lunarCls.festival ? 'festival' : ''} ${lunarCls.term ? 'term' : ''}`}>
                      {lunar}
                    </span>
                  </div>
                  {cs.filter((c) => !c.cancelled).slice(0, 2).map((c, i) => (
                    <span key={'c' + i} className="chip course">
                      {c.startTime} {c.course.name}
                    </span>
                  ))}
                  {evs.slice(0, 3).map((ev) => (
                    <span key={ev.id} className="chip event">
                      {ev.allDay ? '全天' : fmtTime(ev.startAt)} {ev.title}
                    </span>
                  ))}
                  {(cs.length > 2 || evs.length > 3) && <span className="muted">…</span>}
                </div>
              )
            })}
          </div>
        </div>

        {/* 日详情 */}
        <div
          className="card"
          data-agenda-date={selected}
          data-agenda-total={agenda ? agenda.courses.length + agenda.events.length + agenda.todos.length + agenda.schoolEvents.length : 0}
          data-agenda-visible={agenda
            ? agenda.courses.length +
              Math.min(agenda.events.length, agendaLimits.events) +
              Math.min(agenda.todos.length, agendaLimits.todos) +
              agenda.schoolEvents.length
            : 0}
          style={{ width: 300, flexShrink: 0 }}
        >
          <h3>
            {selected} {weekdayCn(dayOfWeek(selected))}
          </h3>
          <div className="muted" style={{ marginTop: -4, marginBottom: 8 }}>
            农历{selLunar.lunarMonthName}
            {selLunar.lunarDayName}
            {selLunar.festival ? ` · ${selLunar.festival}` : selLunar.term ? ` · ${selLunar.term}` : ''}
          </div>
          {agenda && (
            <div className="column">
              {agenda.courses.map((c, i) => (
                <div key={'cc' + i} className="list-row">
                  <span className="chip course">
                    {c.startTime}-{c.endTime}
                  </span>
                  <span style={{ flex: 1, textDecoration: c.cancelled ? 'line-through' : undefined }}>
                    {c.course.name} {c.location ? `@${c.location}` : ''}
                    {c.cancelled ? '(停课)' : ''}
                  </span>
                </div>
              ))}
              {(() => {
                // PERF-02:事件/待办分区 50 条分页——切片渲染,总数与继续加载可见,业务数据不裁剪
                const visibleEvents = agenda.events.slice(0, agendaLimits.events)
                const hiddenEvents = agenda.events.length - visibleEvents.length
                return (
                  <>
                    {visibleEvents.map((ev) => (
                      <div key={ev.id} className="list-row">
                        <span className="chip event">
                          {ev.allDay ? '全天' : `${fmtTime(ev.startAt)}-${fmtTime(ev.endAt)}`}
                        </span>
                        <span style={{ flex: 1 }} onClick={() => setEditor(ev)} role="button">
                          {ev.title}
                        </span>
                        <button className="ghost danger" onClick={() => void delEvent(ev.id)}>
                          删
                        </button>
                      </div>
                    ))}
                    {hiddenEvents > 0 && (
                      <div className="muted" style={{ marginBottom: 6 }}>
                        日程 共 {agenda.events.length} 条,已显示 {visibleEvents.length} 条
                        <button className="ghost" style={{ marginLeft: 6 }} onClick={() => setAgendaLimits((prev) => ({ ...prev, events: Math.min(agenda.events.length, prev.events + DETAIL_PAGE_SIZE) }))}>
                          显示更多日程(还有 {hiddenEvents} 条)
                        </button>
                      </div>
                    )}
                  </>
                )
              })()}
              {agenda.schoolEvents.map((s) => (
                <div key={s.id} className="list-row">
                  <span className="chip school">{schoolLabel(s.type)}</span>
                  <span style={{ flex: 1 }}>{s.title}</span>
                </div>
              ))}
              {agenda.todos.length > 0 && (
                <>
                  <div className="group-title">当天截止的待办({agenda.todos.length})</div>
                  {(() => {
                    const visibleTodos = agenda.todos.slice(0, agendaLimits.todos)
                    const hiddenTodos = agenda.todos.length - visibleTodos.length
                    return (
                      <>
                        {visibleTodos.map((t) => (
                          <div key={t.id} className="list-row">
                            ☑ {t.title}
                          </div>
                        ))}
                        {hiddenTodos > 0 && (
                          <div className="muted" style={{ marginBottom: 6 }}>
                            已显示 {visibleTodos.length} 条
                            <button className="ghost" style={{ marginLeft: 6 }} onClick={() => setAgendaLimits((prev) => ({ ...prev, todos: Math.min(agenda.todos.length, prev.todos + DETAIL_PAGE_SIZE) }))}>
                              显示更多待办(还有 {hiddenTodos} 条)
                            </button>
                          </div>
                        )}
                      </>
                    )
                  })()}
                </>
              )}
              {agenda.courses.length === 0 && agenda.events.length === 0 && agenda.schoolEvents.length === 0 && (
                <div className="empty">这一天暂无安排</div>
              )}
              <button className="primary" onClick={() => setEditor('new')}>
                + 这一天新建日程
              </button>
            </div>
          )}
        </div>
      </div>

      {editor && (
        <EventEditor
          initial={editor === 'new' ? { date: selected } : editor}
          error={saveError}
          onClose={() => {
            setSaveError(null)
            setEditor(null)
          }}
          onSave={save}
        />
      )}
      <Toast text={toast} />
    </div>
  )

  async function delEvent(id: string): Promise<void> {
    // 网格刷新由 evt:data-changed 广播驱动,不手动重拉整月(PERF-02)
    await window.api.deleteEvent(id)
    showToast('已删除')
  }
}

// ---------- 编辑器 ----------

function EventEditor({
  initial,
  error,
  onClose,
  onSave
}: {
  initial: { date: string } | CalendarEvent
  /** 保存失败提示(如 PERSIST_FAILED:保存未确认);非空时编辑内容保留、重试入口可见 */
  error?: string | null
  onClose: () => void
  onSave: (input: EventInput, id?: string) => Promise<void>
}): JSX.Element {
  const ev = initial as CalendarEvent
  const isNew = !(initial as CalendarEvent).id
  const date = isNew ? (initial as { date: string }).date : ev.startAt.slice(0, 10)
  const [title, setTitle] = useState(isNew ? '' : ev.title)
  const [d, setD] = useState(date)
  const [allDay, setAllDay] = useState(isNew ? false : ev.allDay)
  const [start, setStart] = useState(isNew ? '09:00' : ev.startAt.slice(11, 16))
  const [end, setEnd] = useState(isNew ? '10:00' : ev.endAt.slice(11, 16))
  const [location, setLocation] = useState(isNew ? '' : (ev.location ?? ''))
  const [notes, setNotes] = useState(isNew ? '' : (ev.notes ?? ''))
  const [reminder, setReminder] = useState(isNew ? '15' : String(ev.reminderMinutes ?? ''))
  const [validationError, setValidationError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (!title.trim()) {
      setValidationError('标题不能为空')
      return
    }
    const startAt = allDay ? `${d}T00:00` : `${d}T${start}`
    const endAt = allDay ? `${d}T23:59` : `${d}T${end}`
    // 无效区间在提交前拦截(R7):相等/倒置区间不落库
    if (!allDay && endAt <= startAt) {
      setValidationError('结束时间必须晚于开始时间')
      return
    }
    setValidationError(null)
    await onSave(
      {
        title: title.trim(),
        startAt,
        endAt,
        allDay,
        location: location || null,
        notes: notes || null,
        reminderMinutes: reminder === '' ? null : Number(reminder)
      },
      isNew ? undefined : ev.id
    )
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{isNew ? '新建日程' : '编辑日程'}</h3>
        <div className="form-grid">
          <label>标题</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="日程标题" />
          <label>日期</label>
          <input type="date" value={d} onChange={(e) => setD(e.target.value)} />
          <label>全天</label>
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          {!allDay && (
            <>
              <label>开始</label>
              <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
              <label>结束</label>
              <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
            </>
          )}
          <label>地点</label>
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="可选" />
          <label>提醒</label>
          <select value={reminder} onChange={(e) => setReminder(e.target.value)}>
            <option value="">不提醒</option>
            <option value="0">准点</option>
            <option value="5">提前 5 分钟</option>
            <option value="15">提前 15 分钟</option>
            <option value="30">提前 30 分钟</option>
            <option value="60">提前 1 小时</option>
            <option value="1440">提前 1 天</option>
          </select>
          <label>备注</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {(error ?? validationError) && (
            <span role="alert" style={{ color: '#e5534b', marginRight: 'auto', alignSelf: 'center' }}>
              {error ?? validationError}
            </span>
          )}
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => void submit()}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------- 日期工具 ----------

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + days)
  return toDateStr(d)
}

function nextMonth(y: number, m: number): string {
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`
}

function stepMonth(c: { y: number; m: number }, dir: number): { y: number; m: number } {
  const m = c.m + dir
  if (m < 1) return { y: c.y - 1, m: 12 }
  if (m > 12) return { y: c.y + 1, m: 1 }
  return { y: c.y, m }
}

function monthDays(y: number, m: number): string[] {
  const out: string[] = []
  const total = new Date(y, m, 0).getDate()
  for (let i = 1; i <= total; i++) out.push(`${y}-${pad(m)}-${pad(i)}`)
  return out
}

function dayOfWeek(dateStr: string): number {
  const js = new Date(dateStr).getDay()
  return js === 0 ? 7 : js
}

function schoolLabel(t: string): string {
  return { holiday: '假期', exam: '考试', registration: '报到', adjust: '调课', other: '校历' }[t] ?? '校历'
}
