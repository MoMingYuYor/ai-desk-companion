import { useCallback, useEffect, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { OverviewPage } from './pages/OverviewPage'
import { ChatPage } from './pages/ChatPage'
import { CalendarPage } from './pages/CalendarPage'
import { TodosPage } from './pages/TodosPage'
import { PendingPage } from './pages/PendingPage'
import { TimetablePage } from './pages/TimetablePage'
import { ProfilePage } from './pages/ProfilePage'
import { SettingsPage } from './pages/SettingsPage'
import { MailPage } from './mail/MailPage'
import { TopBar } from './TopBar'
import { useSubscribe } from '../shared/util'
import type { PendingItem, Todo } from '../../shared/types'

type PageName = 'overview' | 'chat' | 'mail' | 'calendar' | 'todos' | 'pending' | 'timetable' | 'profile' | 'settings'

interface NavItem {
  key: PageName
  icon: string
  label: string
}

// 侧栏信息架构:我的空间(核心工作区) / 个人设置,对齐初版手账设计
const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: '我的空间',
    items: [
      { key: 'overview', icon: '🏠', label: '今日概览' },
      { key: 'chat', icon: '💬', label: 'AI 工作台' },
      { key: 'mail', icon: '📧', label: '邮箱' },
      { key: 'calendar', icon: '📅', label: '日历' },
      { key: 'todos', icon: '✅', label: '待办' },
      { key: 'pending', icon: '📥', label: '待处理' },
      { key: 'timetable', icon: '🎓', label: '课表' }
    ]
  },
  {
    label: '个人设置',
    items: [{ key: 'profile', icon: '👤', label: '个人资料' }]
  }
]

const ALL_NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.items)
// settings 入口单独挂在侧栏底部,不在 NAV_GROUPS 里,面包屑映射要补上,否则顶栏显示错路径
const PAGE_GROUP = new Map<PageName, string>([
  ...NAV_GROUPS.flatMap((g) => g.items.map((i) => [i.key, g.label] as const)),
  ['settings', '个人设置'] as const
])
const PAGE_LABEL = new Map<PageName, string>([
  ...ALL_NAV.map((i) => [i.key, i.label] as const),
  ['settings', '偏好设置'] as const
])

/** 侧栏导航项键盘可达:Enter / 空格触发,与点击行为一致 */
function navKeyDown(handler: () => void): (e: ReactKeyboardEvent) => void {
  return (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handler()
    }
  }
}

export default function App(): JSX.Element {
  const [page, setPage] = useState<PageName>('overview')
  const [pendingCount, setPendingCount] = useState(0)
  const [mailUnread, setMailUnread] = useState<number | null>(null)
  const [mailUnreadMore, setMailUnreadMore] = useState(false)
  const [openTodos, setOpenTodos] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)
  const [petAction, setPetAction] = useState<{ action: string; at: number } | null>(null)
  const [locateConversation, setLocateConversation] = useState<{ id: string; at: number } | null>(null)

  const refreshPending = useCallback((): void => {
    void window.api
      .listPending()
      .then((items: PendingItem[]) => setPendingCount(items.length))
      .catch(() => {})
  }, [])

  const refreshMailUnread = useCallback((): void => {
    void window.api.mail
      .list({ unreadOnly: true, page: 0 })
      .then((res) => {
        if (!res.ok) return
        setMailUnread(res.value.items.length)
        setMailUnreadMore(res.value.hasMore)
      })
      .catch(() => {})
  }, [])

  const refreshTodos = useCallback((): void => {
    void window.api
      .listTodos()
      .then((items: Todo[]) => setOpenTodos(items.filter((t) => !t.completedAt).length))
      .catch(() => {})
  }, [])

  useEffect(() => {
    refreshPending()
    refreshMailUnread()
    refreshTodos()
  }, [refreshPending, refreshMailUnread, refreshTodos, refreshKey])

  useSubscribe('evt:data-changed', useCallback(() => {
    setRefreshKey((k) => k + 1)
  }, []))
  useSubscribe('evt:mail-changed', useCallback(() => refreshMailUnread(), [refreshMailUnread]))

  useSubscribe('evt:pet-action', useCallback((payload: unknown) => {
    const { action } = payload as { action: string }
    setPetAction({ action, at: Date.now() })
    if (action === 'new-event') setPage('calendar')
    if (action === 'new-todo') setPage('todos')
  }, []))

  const searchSources = {
    mails: (term: string) =>
      window.api.mail
        .list({ search: term, page: 0 })
        .then((r) => (r.ok ? r.value.items : []))
        .catch(() => []),
    todos: () => window.api.listTodos().catch(() => []),
    events: () => {
      const now = new Date()
      const from = `${now.getFullYear() - 1}-01-01T00:00`
      const to = `${now.getFullYear() + 1}-12-31T23:59`
      return window.api.listEvents(from, to).catch(() => [])
    },
    conversations: () => window.api.listConversations().catch(() => []),
    pendings: () => window.api.listPending().catch(() => [])
  }

  return (
    <div className="app">
      <div className="sidebar">
        <div className="logo">✨ 事务助手</div>
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="nav-group">
            <div className="nav-group-label">{group.label}</div>
            {group.items.map((n) => (
              <div
                key={n.key}
                className={`nav-item ${page === n.key ? 'active' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => setPage(n.key)}
                onKeyDown={navKeyDown(() => setPage(n.key))}
              >
                <span>{n.icon}</span>
                <span>{n.label}</span>
                <span className="spacer" />
                {n.key === 'mail' && (mailUnread ?? 0) > 0 && (
                  <span className="badge">{mailUnreadMore ? `${mailUnread}+` : mailUnread}</span>
                )}
                {n.key === 'todos' && openTodos > 0 && <span className="badge">{openTodos}</span>}
                {n.key === 'pending' && pendingCount > 0 && <span className="badge">{pendingCount}</span>}
              </div>
            ))}
          </div>
        ))}
        <div className="spacer" />
        <div
          className={`nav-item ${page === 'settings' ? 'active' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => setPage('settings')}
          onKeyDown={navKeyDown(() => setPage('settings'))}
        >
          <span>⚙️</span>
          <span>偏好设置</span>
        </div>
        <div className="sidebar-footer">● 本机工作空间</div>
      </div>
      <div className="main">
        <TopBar
          group={PAGE_GROUP.get(page) ?? '我的空间'}
          pageLabel={PAGE_LABEL.get(page) ?? '今日概览'}
          pendingCount={pendingCount}
          onNavigate={setPage}
          searchSources={searchSources}
        />
        {page === 'overview' && <OverviewPage refreshKey={refreshKey} onNavigate={setPage} />}
        {page === 'chat' && (
          <ChatPage refreshKey={refreshKey} petAction={petAction} locateConversationId={locateConversation} />
        )}
        {page === 'mail' && (
          <MailPage
            api={window.api.mail}
            subscribe={window.api.subscribeMail}
            onOpenConversation={(conversationId) => {
              setLocateConversation({ id: conversationId, at: Date.now() })
              setPage('chat')
            }}
          />
        )}
        {page === 'calendar' && <CalendarPage refreshKey={refreshKey} petAction={petAction} />}
        {page === 'todos' && <TodosPage refreshKey={refreshKey} petAction={petAction} />}
        {page === 'pending' && <PendingPage refreshKey={refreshKey} />}
        {page === 'timetable' && <TimetablePage refreshKey={refreshKey} />}
        {page === 'profile' && <ProfilePage refreshKey={refreshKey} />}
        {page === 'settings' && <SettingsPage refreshKey={refreshKey} appearance={window.api.appearance} />}
      </div>
    </div>
  )
}
