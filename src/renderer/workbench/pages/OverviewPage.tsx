// 今日概览:综合面板;聚合日程/待办/待处理/邮箱的真实数据,不接示例数字
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DayAgenda, PendingItem, Todo } from '../../../shared/types'
import type { MailAccountInfo, MailSummary } from '../../../shared/mail'
import { fmtTime, nowLocalIso, toDateStr, weekdayCn } from '../../../shared/dateUtils'
import { useSubscribe } from '../../shared/util'
import chibiImage from '../../pet/assets/chibi-seated-v1.png'
import './overview.css'

type NavTarget = 'chat' | 'mail' | 'calendar' | 'todos' | 'pending' | 'timetable' | 'profile' | 'settings'

interface Props {
  refreshKey: number
  onNavigate: (page: NavTarget) => void
}

interface TimelineItem {
  key: string
  minutes: number
  label: string
  title: string
  location?: string | null
  cancelled?: boolean
}

function greetingOf(hour: number): string {
  if (hour < 5) return '夜深了'
  if (hour < 9) return '早上好'
  if (hour < 12) return '上午好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  if (hour < 23) return '晚上好'
  return '夜深了'
}

function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

function buildTimeline(agenda: DayAgenda | null): TimelineItem[] {
  if (!agenda) return []
  const items: TimelineItem[] = agenda.courses.map((c, i) => ({
    key: `course-${i}`,
    minutes: minutesOf(c.startTime),
    label: `${c.startTime} – ${c.endTime}`,
    title: c.course.name,
    location: c.location,
    cancelled: c.cancelled
  }))
  for (const ev of agenda.events) {
    items.push({
      key: `event-${ev.id}`,
      minutes: ev.allDay ? -1 : minutesOf(fmtTime(ev.startAt)),
      label: ev.allDay ? '全天' : `${fmtTime(ev.startAt)} – ${fmtTime(ev.endAt)}`,
      title: ev.title,
      location: ev.location,
      cancelled: ev.status === 'cancelled'
    })
  }
  return items.sort((a, b) => a.minutes - b.minutes)
}

function todoRank(todo: Todo, today: string): number {
  if (!todo.dueAt) return 3
  const day = todo.dueAt.slice(0, 10)
  if (day < today) return 0
  if (day === today) return 1
  return 2
}

export function OverviewPage({ refreshKey, onNavigate }: Props): JSX.Element {
  const today = toDateStr(new Date())
  const [agenda, setAgenda] = useState<DayAgenda | null>(null)
  const [todos, setTodos] = useState<Todo[]>([])
  const [pending, setPending] = useState<PendingItem[]>([])
  const [mailAccounts, setMailAccounts] = useState<MailAccountInfo[] | null>(null)
  const [recentMails, setRecentMails] = useState<MailSummary[]>([])
  const [unread, setUnread] = useState<{ count: number; more: boolean }>({ count: 0, more: false })
  const [eventDays, setEventDays] = useState<Set<string>>(new Set())
  const [monthCursor] = useState(() => {
    const d = new Date()
    return { year: d.getFullYear(), month: d.getMonth() }
  })

  const reload = useCallback((): void => {
    void window.api.getDayAgenda(today).then(setAgenda)
    void window.api.listTodos().then(setTodos)
    void window.api.listPending().then(setPending)
    void (async () => {
      try {
        const accounts = await window.api.mail.accounts()
        if (accounts.ok) setMailAccounts(accounts.value)
        const [recent, unreadList] = await Promise.all([
          window.api.mail.list({ page: 0 }),
          window.api.mail.list({ unreadOnly: true, page: 0 })
        ])
        if (recent.ok) setRecentMails(recent.value.items.slice(0, 5))
        if (unreadList.ok) setUnread({ count: unreadList.value.items.length, more: unreadList.value.hasMore })
      } catch {
        // 邮箱未配置或同步失败时,概览其余部分照常工作
      }
    })()
  }, [today])

  useEffect(() => {
    reload()
  }, [reload, refreshKey])

  // 迷你月历的事件圆点
  useEffect(() => {
    const from = `${monthCursor.year}-${String(monthCursor.month + 1).padStart(2, '0')}-01`
    const nextMonth = monthCursor.month === 11 ? `${monthCursor.year + 1}-01-01` : `${monthCursor.year}-${String(monthCursor.month + 2).padStart(2, '0')}-01`
    void window.api.listEvents(from, nextMonth).then((events) => {
      setEventDays(new Set(events.map((ev) => ev.startAt.slice(0, 10))))
    })
  }, [monthCursor, refreshKey])

  useSubscribe('evt:mail-changed', useCallback(() => reload(), [reload]))
  useSubscribe('evt:mail-sync', useCallback(() => reload(), [reload]))

  const timeline = useMemo(() => buildTimeline(agenda), [agenda])
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes()
  const nextItem = timeline.find((item) => !item.cancelled && item.minutes >= nowMinutes)

  const openTodos = useMemo(
    () =>
      todos
        .filter((t) => !t.completedAt)
        .sort((a, b) => todoRank(a, today) - todoRank(b, today) || (a.dueAt ?? '').localeCompare(b.dueAt ?? '')),
    [todos, today]
  )
  const doneToday = useMemo(
    () => todos.filter((t) => t.completedAt && t.completedAt.slice(0, 10) === today),
    [todos, today]
  )
  const dueTodayCount = openTodos.filter((t) => t.dueAt && t.dueAt.slice(0, 10) <= today).length
  const openPending = pending.filter((p) => p.status === 'open')

  const toggleTodo = async (todo: Todo): Promise<void> => {
    await window.api.updateTodo(todo.id, { completedAt: todo.completedAt ? null : nowLocalIso() })
    reload()
  }

  const now = new Date()
  const weekday = weekdayCn(now.getDay() === 0 ? 7 : now.getDay())
  const enabledAccounts = (mailAccounts ?? []).filter((a) => a.enabled)

  // 迷你月历:周一开头,铺满 6 行
  const calendarCells = useMemo(() => {
    const first = new Date(monthCursor.year, monthCursor.month, 1)
    const startOffset = (first.getDay() + 6) % 7
    const cells: Array<{ date: string; day: number; other: boolean }> = []
    const start = new Date(monthCursor.year, monthCursor.month, 1 - startOffset)
    for (let i = 0; i < 42; i += 1) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
      cells.push({
        date: toDateStr(d),
        day: d.getDate(),
        other: d.getMonth() !== monthCursor.month
      })
    }
    return cells
  }, [monthCursor])

  const assistantHint =
    openPending.length > 0
      ? `有 ${openPending.length} 条 AI 分析的条目等待你确认,处理完我会记在心里。`
      : unread.count > 0
        ? '收到新邮件后,你可以先阅读,需要时再点击「AI 分析」。'
        : '安排之间留出缓冲,不必把每一分钟都填满。'

  return (
    <div className="ov-page">
      <div className="ov-header">
        <div>
          <h2 className="ov-greeting">{greetingOf(now.getHours())},今天也从容一点。</h2>
          <div className="ov-date">
            {now.getMonth() + 1} 月 {now.getDate()} 日,{weekday} · 把重要的事留在眼前
          </div>
        </div>
        <div className="spacer" />
        <button className="primary" onClick={() => onNavigate('calendar')}>
          + 新建安排
        </button>
      </div>

      <div className="ov-columns">
        <div className="ov-main">
          <div className="ov-hero">
            <div className="ov-hero-text">
              <div className="ov-hero-eyebrow">A little company, every day</div>
              <div className="ov-hero-title">把今天,慢慢安排好。</div>
              <div className="ov-hero-sub">
                {openTodos.length > 0 || openPending.length > 0
                  ? `还有 ${openTodos.length + openPending.length} 项事项需要留意。我会在合适的时候,轻轻提醒你。`
                  : '今天的事项都安顿好了。我会在合适的时候,轻轻提醒你。'}
              </div>
            </div>
            <img className="ov-hero-img" src={chibiImage} alt="小助手" />
          </div>

          <div className="ov-stats">
            <button className="ov-stat" onClick={() => onNavigate('calendar')}>
              <span className="ov-stat-label">📅 今日安排</span>
              <span className="ov-stat-num">{timeline.filter((i) => !i.cancelled).length}</span>
              <span className="ov-stat-sub">
                {nextItem ? `下一项 ${nextItem.label.split(' ')[0]}` : timeline.length > 0 ? '已全部结束' : '今天无安排'}
              </span>
            </button>
            <button className="ov-stat" onClick={() => onNavigate('todos')}>
              <span className="ov-stat-label">✅ 待完成事项</span>
              <span className="ov-stat-num">{openTodos.length}</span>
              <span className="ov-stat-sub">今天到期 {dueTodayCount} 项</span>
            </button>
            <button className="ov-stat" onClick={() => onNavigate('mail')}>
              <span className="ov-stat-label">✉️ 未读邮件</span>
              <span className="ov-stat-num">{mailAccounts === null ? '—' : `${unread.count}${unread.more ? '+' : ''}`}</span>
              <span className="ov-stat-sub">
                {mailAccounts === null ? '邮箱未配置' : `来自 ${enabledAccounts.length} 个邮箱`}
              </span>
            </button>
          </div>

          <div className="ov-card">
            <div className="ov-card-head">
              <h3 className="ov-card-title">今天,先做这些</h3>
              <button className="ov-card-link" onClick={() => onNavigate('todos')}>
                全部待办 ›
              </button>
            </div>
            {openTodos.length === 0 && doneToday.length === 0 && openPending.length === 0 && (
              <div className="empty">今天没有待办,喝杯茶吧。</div>
            )}
            {openTodos.slice(0, 5).map((todo) => {
              const rank = todoRank(todo, today)
              return (
                <label key={todo.id} className="ov-todo">
                  <input type="checkbox" checked={false} onChange={() => void toggleTodo(todo)} />
                  <span className="ov-todo-body">
                    <span className="ov-todo-title">{todo.title}</span>
                    <span className="ov-todo-sub">
                      {todo.linkedEvent ? `关联日程:${todo.linkedEvent.title}` : todo.source === 'analysis' ? '来自 AI 分析' : '手动添加'}
                    </span>
                  </span>
                  {rank === 0 && <span className="tag warn ov-todo-tag">已逾期</span>}
                  {rank === 1 && todo.dueAt && <span className="tag ov-todo-tag">今天 {fmtTime(todo.dueAt)}</span>}
                </label>
              )
            })}
            {openPending.slice(0, 3).map((item) => (
              <div key={item.id} className="ov-todo" style={{ cursor: 'pointer' }} onClick={() => onNavigate('pending')}>
                <span className="ov-todo-body">
                  <span className="ov-todo-title">{item.title}</span>
                  <span className="ov-todo-sub">来自分析 · 等待你的确认</span>
                </span>
                <span className="tag warn ov-todo-tag">待确认</span>
              </div>
            ))}
            {doneToday.slice(0, 2).map((todo) => (
              <label key={todo.id} className="ov-todo done">
                <input type="checkbox" checked onChange={() => void toggleTodo(todo)} />
                <span className="ov-todo-body">
                  <span className="ov-todo-title">{todo.title}</span>
                  <span className="ov-todo-sub">已完成 · {fmtTime(todo.completedAt!)}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="ov-card">
            <div className="ov-card-head">
              <h3 className="ov-card-title">收件箱里的新消息</h3>
              <button className="ov-card-link" onClick={() => onNavigate('mail')}>
                查看邮箱 ›
              </button>
            </div>
            {mailAccounts !== null && mailAccounts.length === 0 && (
              <div className="empty">
                还没有配置邮箱。
                <button style={{ marginLeft: 8 }} onClick={() => onNavigate('mail')}>
                  去配置
                </button>
              </div>
            )}
            {mailAccounts !== null && mailAccounts.length > 0 && recentMails.length === 0 && (
              <div className="empty">收件箱静悄悄的。</div>
            )}
            {recentMails.map((mail) => (
              <button key={mail.id} className="ov-mail" onClick={() => onNavigate('mail')}>
                <span className="ov-mail-body">
                  <span className="ov-mail-subject">{mail.subject || '(无主题)'}</span>
                  <span className="ov-mail-sub">
                    {mail.from} · {mail.accountLabel}
                  </span>
                </span>
                <span className="ov-mail-time">{fmtTime(mail.receivedAt)}</span>
                {!mail.read && <span className="ov-dot" aria-label="未读" />}
              </button>
            ))}
          </div>
        </div>

        <div className="ov-rail">
          <div className="ov-card">
            <div className="ov-card-head">
              <h3 className="ov-card-title">
                {monthCursor.year} 年 {monthCursor.month + 1} 月
              </h3>
            </div>
            <div className="ov-cal-head">
              {['一', '二', '三', '四', '五', '六', '日'].map((d) => (
                <div key={d}>{d}</div>
              ))}
            </div>
            <div className="ov-cal-grid">
              {calendarCells.map((cell) => (
                <button
                  key={cell.date}
                  className={`ov-cal-cell ${cell.other ? 'other' : ''} ${cell.date === today ? 'today' : ''}`}
                  onClick={() => onNavigate('calendar')}
                >
                  {cell.day}
                  {eventDays.has(cell.date) && <span className="ov-cal-dot" />}
                </button>
              ))}
            </div>
          </div>

          <div className="ov-card">
            <div className="ov-card-head">
              <h3 className="ov-card-title">今天的时间线</h3>
            </div>
            {timeline.length === 0 && <div className="empty">今天没有安排。</div>}
            <div className="ov-timeline">
              {timeline.map((item) => (
                <div key={item.key} className="ov-tl-item">
                  <span className="ov-tl-time">{item.label}</span>
                  <span>
                    <span className={`ov-tl-title ${item.cancelled ? 'cancelled' : ''}`}>{item.title}</span>
                    {item.location && <span className="ov-tl-loc" style={{ display: 'block' }}>{item.location}</span>}
                  </span>
                </div>
              ))}
            </div>
            {timeline.length > 0 && (
              <div className="muted" style={{ marginTop: 8, lineHeight: 1.6 }}>
                给日程留一点空白:安排之间留出缓冲,不必把每一分钟都填满。
              </div>
            )}
          </div>

          <div className="ov-note">
            <div className="ov-note-title">✧ 小助手的轻提醒</div>
            {assistantHint}
          </div>
        </div>
      </div>
    </div>
  )
}
