import { useCallback, useEffect, useState } from 'react'
import type { DayAgenda } from '../../shared/types'
import { fmtDateCn, fmtTime, toDateStr, weekdayCn } from '../../shared/dateUtils'

export default function PanelApp(): JSX.Element {
  const [agenda, setAgenda] = useState<DayAgenda | null>(null)
  const [pinned, setPinned] = useState(false)
  const today = toDateStr(new Date())

  const reload = useCallback((): void => {
    void window.api.getDayAgenda(today).then(setAgenda)
  }, [today])

  useEffect(() => {
    void window.api.getPanelPinned().then(setPinned)
    reload()
    const timer = setInterval(reload, 60_000)
    const offs = [
      window.api.on('evt:data-changed', () => reload()),
      window.api.on('evt:reminder-fired', () => reload()),
      window.api.on('evt:analysis-updated', () => reload())
    ]
    return () => {
      clearInterval(timer)
      offs.forEach((off) => off())
    }
  }, [reload])

  const weekday = weekdayCn(
    new Date(today).getDay() === 0 ? 7 : new Date(today).getDay()
  )

  return (
    <div className="panel-root" onDoubleClick={() => void window.api.petOpenMenu()}>
      {/* 标题栏(可拖动窗口由主进程设置为无框,这里用简易拖动区) */}
      <div className="panel-titlebar">
        <b>今日面板</b>
        <span className="panel-date">
          {fmtDateCn(today)} {weekday}
        </span>
        <div style={{ flex: 1 }} />
        <button
          className={`ghost panel-title-btn ${pinned ? 'pinned' : ''}`}
          title="固定/取消固定"
          onClick={async () => {
            const next = !pinned
            setPinned(next)
            await window.api.setPanelPinned(next)
          }}
        >
          {pinned ? '📌 已固定' : '📌 固定'}
        </button>
        <button
          className="ghost panel-title-btn"
          onClick={() => {
            window.close()
          }}
        >
          ✕
        </button>
      </div>

      <div className="panel-body">
        <Section title={`📚 今天的课程`}>
          {agenda && agenda.courses.length === 0 && <Empty text="今天没有课" />}
          {agenda?.courses.map((c, i) => (
            <div key={i} className="list-row">
              <span className="chip course">
                {c.startTime}-{c.endTime}
              </span>
              <span style={{ flex: 1, textDecoration: c.cancelled ? 'line-through' : undefined }}>
                {c.course.name} {c.location ? `@${c.location}` : ''}
                {c.cancelled ? '(停课)' : ''}
              </span>
            </div>
          ))}
        </Section>

        <Section title="📅 日程">
          {agenda && agenda.events.length === 0 && <Empty text="今天没有日程" />}
          {agenda?.events.map((ev) => (
            <div key={ev.id} className="list-row">
              <span className="chip event">{ev.allDay ? '全天' : fmtTime(ev.startAt)}</span>
              <span style={{ flex: 1 }}>
                {ev.title} {ev.location ? `@${ev.location}` : ''}
              </span>
            </div>
          ))}
        </Section>

        <Section title="⏰ 今天截止的待办">
          {agenda && agenda.todos.length === 0 && <Empty text="没有今天截止的待办" />}
          {agenda?.todos.map((t) => (
            <div key={t.id} className="list-row">
              <span style={{ flex: 1 }}>
                ☑ {t.title}
                {t.dueAt ? `(${fmtTime(t.dueAt)})` : ''}
              </span>
            </div>
          ))}
        </Section>

        <Section title="🏫 校历">
          {agenda && agenda.schoolEvents.length === 0 && <Empty text="—" />}
          {agenda?.schoolEvents.map((s) => (
            <div key={s.id} className="list-row">
              <span className="chip school">{s.title}</span>
            </div>
          ))}
        </Section>
      </div>

      <div className="panel-footer">
        <button className="primary" style={{ flex: 1 }} onClick={() => void window.api.petAction('open-workbench')}>
          打开工作台
        </button>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="card" style={{ padding: 10 }}>
      <h3 style={{ fontSize: 13 }}>{title}</h3>
      {children}
    </div>
  )
}

function Empty({ text }: { text: string }): JSX.Element {
  return <div className="muted">{text}</div>
}
