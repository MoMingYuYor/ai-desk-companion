import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CalendarEvent, CourseOccurrence, DayAgenda, EventInput } from '../../../shared/types'
import { fmtTime, toDateStr, weekdayCn } from '../../../shared/dateUtils'
import { lunarInfo, lunarLabel } from '../../../shared/lunarDay'
import { Toast, useSubscribe, useToast } from '../../shared/util'

interface Props {
  refreshKey: number
  petAction: { action: string; at: number } | null
}

export function CalendarPage({ refreshKey, petAction }: Props): JSX.Element {
  const today = toDateStr(new Date())
  const [cursor, setCursor] = useState({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) })
  const [selected, setSelected] = useState(today)
  const [agenda, setAgenda] = useState<DayAgenda | null>(null)
  const [eventsByDay, setEventsByDay] = useState<Record<string, CalendarEvent[]>>({})
  const [coursesByDay, setCoursesByDay] = useState<Record<string, CourseOccurrence[]>>({})
  const [editor, setEditor] = useState<CalendarEvent | 'new' | null>(null)
  const [toast, showToast] = useToast()

  const monthStart = useMemo(() => `${cursor.y}-${pad(cursor.m)}-01`, [cursor])

  const reload = useCallback((): void => {
    // 读取整个月(含前后各 7 天以覆盖跨月事件)
    const from = addDaysStr(`${cursor.y}-${pad(cursor.m)}-01`, -7)
    const to = addDaysStr(nextMonth(cursor.y, cursor.m) + '-01', 7)
    void window.api.listEvents(from + 'T00:00', to + 'T23:59').then((events) => {
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
      const map: Record<string, CourseOccurrence[]> = {}
      for (const [d, c] of entries) map[d] = c
      setCoursesByDay(map)
    })
  }, [cursor])

  useEffect(() => {
    reload()
  }, [reload, refreshKey])

  useEffect(() => {
    void window.api.getDayAgenda(selected).then(setAgenda)
  }, [selected, refreshKey, editor])

  // 桌宠"新建日程"
  useEffect(() => {
    if (petAction?.action === 'new-event') setEditor('new')
  }, [petAction])

  useSubscribe('evt:data-changed', useCallback(() => reload(), [reload]))

  const save = async (input: EventInput, id?: string): Promise<void> => {
    if (id) await window.api.updateEvent(id, input)
    else await window.api.createEvent(input)
    setEditor(null)
    reload()
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
    <div className="page" style={{ flexDirection: 'column' }}>
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
        <div className="card" style={{ width: 300, flexShrink: 0 }}>
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
              {agenda.events.map((ev) => (
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
              {agenda.schoolEvents.map((s) => (
                <div key={s.id} className="list-row">
                  <span className="chip school">{schoolLabel(s.type)}</span>
                  <span style={{ flex: 1 }}>{s.title}</span>
                </div>
              ))}
              {agenda.todos.length > 0 && (
                <>
                  <div className="group-title">当天截止的待办</div>
                  {agenda.todos.map((t) => (
                    <div key={t.id} className="list-row">
                      ☑ {t.title}
                    </div>
                  ))}
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
          onClose={() => setEditor(null)}
          onSave={save}
        />
      )}
      <Toast text={toast} />
    </div>
  )

  async function delEvent(id: string): Promise<void> {
    await window.api.deleteEvent(id)
    reload()
    showToast('已删除')
  }
}

// ---------- 编辑器 ----------

function EventEditor({
  initial,
  onClose,
  onSave
}: {
  initial: { date: string } | CalendarEvent
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

  const submit = async (): Promise<void> => {
    if (!title.trim()) return
    const startAt = allDay ? `${d}T00:00` : `${d}T${start}`
    const endAt = allDay ? `${d}T23:59` : `${d}T${end}`
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
