import { useCallback, useEffect, useState } from 'react'
import { ChatPage } from './pages/ChatPage'
import { CalendarPage } from './pages/CalendarPage'
import { TodosPage } from './pages/TodosPage'
import { PendingPage } from './pages/PendingPage'
import { TimetablePage } from './pages/TimetablePage'
import { ProfilePage } from './pages/ProfilePage'
import { SettingsPage } from './pages/SettingsPage'
import { MailPage } from './mail/MailPage'
import { useSubscribe } from '../shared/util'
import type { PendingItem } from '../../shared/types'

type PageName = 'chat' | 'mail' | 'calendar' | 'todos' | 'pending' | 'timetable' | 'profile' | 'settings'

const NAV: Array<{ key: PageName; icon: string; label: string }> = [
  { key: 'chat', icon: '💬', label: '工作台' },
  { key: 'mail', icon: '📧', label: '邮箱' },
  { key: 'calendar', icon: '📅', label: '日历' },
  { key: 'todos', icon: '✅', label: '待办' },
  { key: 'pending', icon: '📥', label: '待处理' },
  { key: 'timetable', icon: '🎓', label: '课表' },
  { key: 'profile', icon: '👤', label: '画像' },
  { key: 'settings', icon: '⚙️', label: '设置' }
]

export default function App(): JSX.Element {
  const [page, setPage] = useState<PageName>('chat')
  const [pendingCount, setPendingCount] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)
  const [petAction, setPetAction] = useState<{ action: string; at: number } | null>(null)
  const [locateConversation, setLocateConversation] = useState<{ id: string; at: number } | null>(null)

  const refreshPending = useCallback((): void => {
    void window.api.listPending().then((items: PendingItem[]) => setPendingCount(items.length))
  }, [])

  useEffect(() => {
    refreshPending()
  }, [refreshPending, refreshKey])

  useSubscribe('evt:data-changed', useCallback(() => {
    setRefreshKey((k) => k + 1)
  }, []))

  useSubscribe('evt:pet-action', useCallback((payload: unknown) => {
    const { action } = payload as { action: string }
    setPetAction({ action, at: Date.now() })
    if (action === 'new-event') setPage('calendar')
    if (action === 'new-todo') setPage('todos')
  }, []))

  return (
    <div className="app">
      <div className="sidebar">
        <div className="logo">事务助手</div>
        {NAV.map((n) => (
          <div
            key={n.key}
            className={`nav-item ${page === n.key ? 'active' : ''}`}
            onClick={() => setPage(n.key)}
          >
            <span>{n.icon}</span>
            <span>{n.label}</span>
            {n.key === 'pending' && pendingCount > 0 && <span className="badge">{pendingCount}</span>}
          </div>
        ))}
        <div className="spacer" />
        <div className="muted" style={{ color: '#8b93a8', padding: '0 10px', fontSize: 11 }}>
          把通知或文件拖给<br />桌宠即可开始分析
        </div>
      </div>
      <div className="main">
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
        {page === 'settings' && <SettingsPage refreshKey={refreshKey} />}
      </div>
    </div>
  )
}
