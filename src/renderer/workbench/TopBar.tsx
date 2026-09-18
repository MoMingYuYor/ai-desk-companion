// 顶栏:面包屑 + 全局聚合搜索(Ctrl K) + 通知/头像入口,对齐初版手账设计
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  collectHits,
  type GlobalSearchHit,
  type SearchPage
} from './search/globalSearch'
import type { MailSummary } from '../../shared/mail'
import type { CalendarEvent, Conversation, PendingItem, Todo } from '../../shared/types'

export interface SearchSources {
  mails: (term: string) => Promise<MailSummary[]>
  todos: () => Promise<Todo[]>
  events: () => Promise<CalendarEvent[]>
  conversations: () => Promise<Conversation[]>
  pendings: () => Promise<PendingItem[]>
}

interface Props {
  group: string
  pageLabel: string
  pendingCount: number
  onNavigate: (page: SearchPage) => void
  searchSources: SearchSources
}

const KIND_LABEL: Record<GlobalSearchHit['kind'], string> = {
  todo: '待办',
  event: '日程',
  mail: '邮件',
  conversation: '会话',
  pending: '待确认'
}

export function TopBar({ group, pageLabel, pendingCount, onNavigate, searchSources }: Props): JSX.Element {
  const [term, setTerm] = useState('')
  const [hits, setHits] = useState<GlobalSearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Ctrl+K 聚焦搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 点击外部关闭结果面板
  useEffect(() => {
    if (hits === null) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setHits(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [hits])

  const runSearch = useCallback(async (): Promise<void> => {
    const q = term.trim()
    if (!q) {
      setHits(null)
      return
    }
    setSearching(true)
    try {
      const [mails, todos, events, conversations, pendings] = await Promise.all([
        searchSources.mails(q).catch(() => [] as MailSummary[]),
        searchSources.todos().catch(() => [] as Todo[]),
        searchSources.events().catch(() => [] as CalendarEvent[]),
        searchSources.conversations().catch(() => [] as Conversation[]),
        searchSources.pendings().catch(() => [] as PendingItem[])
      ])
      setHits(collectHits({ term: q, mails, todos, events, conversations, pendings }))
    } finally {
      setSearching(false)
    }
  }, [term, searchSources])

  const go = (hit: GlobalSearchHit): void => {
    setHits(null)
    onNavigate(hit.page)
  }

  // 分组展示保持固定顺序
  const grouped = hits === null ? [] : (['todo', 'event', 'mail', 'conversation', 'pending'] as const)
    .map((kind) => ({ kind, items: hits.filter((h) => h.kind === kind) }))
    .filter((g) => g.items.length > 0)

  return (
    <div className="topbar">
      <nav className="topbar-crumb" aria-label="位置">
        <span className="topbar-crumb-group">{group}</span>
        <span className="topbar-crumb-sep">/</span>
        <span className="topbar-crumb-page">{pageLabel}</span>
      </nav>
      <span className="spacer" />
      <div className="topbar-search" ref={rootRef}>
        <input
          ref={inputRef}
          className="topbar-search-input"
          type="search"
          role="searchbox"
          aria-label="全局搜索"
          placeholder="搜索安排、邮件…"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch()
            if (e.key === 'Escape') setHits(null)
          }}
        />
        <span className="topbar-search-kbd">Ctrl K</span>
        {hits !== null && (
          <div className="search-pop" role="listbox" aria-label="搜索结果">
            {searching && <div className="search-empty">搜索中…</div>}
            {!searching && grouped.length === 0 && <div className="search-empty">没有匹配的结果</div>}
            {grouped.map((g) => (
              <div key={g.kind} className="search-group">
                <div className="search-group-label">{KIND_LABEL[g.kind]}</div>
                {g.items.map((hit) => (
                  <button
                    key={`${hit.kind}-${hit.id}`}
                    type="button"
                    className="search-hit"
                    role="option"
                    aria-selected={false}
                    onClick={() => go(hit)}
                  >
                    <span className="search-hit-title">{hit.title}</span>
                    <span className="search-hit-sub">
                      {hit.subtitle}
                      {hit.at ? ` · ${hit.at}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        className="topbar-icon-btn"
        aria-label="通知与待处理"
        title="通知与待处理"
        onClick={() => onNavigate('pending')}
      >
        🔔
        {pendingCount > 0 && <span className="topbar-dot" />}
      </button>
      <button
        type="button"
        className="topbar-icon-btn topbar-avatar"
        aria-label="个人资料"
        title="个人资料"
        onClick={() => onNavigate('profile')}
      >
        我
      </button>
    </div>
  )
}
