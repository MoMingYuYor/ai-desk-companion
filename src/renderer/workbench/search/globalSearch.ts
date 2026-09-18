// 全局聚合搜索:把邮件/待办/日程/会话/待确认归一成可跳转的结果项
import type { MailSummary } from '../../../shared/mail'
import type { CalendarEvent, Conversation, PendingItem, Todo } from '../../../shared/types'

export type SearchPage = 'mail' | 'todos' | 'calendar' | 'chat' | 'pending' | 'profile'

export interface GlobalSearchHit {
  kind: 'todo' | 'event' | 'mail' | 'conversation' | 'pending'
  id: string
  title: string
  subtitle: string
  /** 展示用时间(邮件收信/日程开始) */
  at?: string
  page: SearchPage
}

export const GLOBAL_SEARCH_LIMIT_PER_GROUP = 5

export interface GlobalSearchInput {
  term: string
  mails: MailSummary[]
  todos: Todo[]
  events: CalendarEvent[]
  conversations: Conversation[]
  pendings: PendingItem[]
}

function matches(term: string, ...fields: Array<string | null | undefined>): boolean {
  return fields.some((f) => (f ?? '').toLowerCase().includes(term))
}

function shortTime(iso: string): string {
  return iso.length >= 16 ? iso.slice(11, 16) : iso
}

export function collectHits(input: GlobalSearchInput): GlobalSearchHit[] {
  const term = input.term.trim().toLowerCase()
  if (!term) return []
  const hits: GlobalSearchHit[] = []

  for (const t of input.todos) {
    if (hits.filter((h) => h.kind === 'todo').length >= GLOBAL_SEARCH_LIMIT_PER_GROUP) break
    if (t.completedAt) continue
    if (matches(term, t.title, t.notes)) {
      hits.push({
        kind: 'todo',
        id: t.id,
        title: t.title,
        subtitle: t.dueAt ? `到期 ${t.dueAt.slice(0, 16).replace('T', ' ')}` : '手动待办',
        page: 'todos'
      })
    }
  }

  for (const e of input.events) {
    if (hits.filter((h) => h.kind === 'event').length >= GLOBAL_SEARCH_LIMIT_PER_GROUP) break
    if (e.status === 'cancelled') continue
    if (matches(term, e.title, e.location, e.notes)) {
      hits.push({
        kind: 'event',
        id: e.id,
        title: e.title,
        subtitle: e.location ?? '日程',
        at: e.allDay ? '全天' : shortTime(e.startAt),
        page: 'calendar'
      })
    }
  }

  for (const m of input.mails) {
    if (hits.filter((h) => h.kind === 'mail').length >= GLOBAL_SEARCH_LIMIT_PER_GROUP) break
    if (matches(term, m.subject, m.from, m.to)) {
      hits.push({
        kind: 'mail',
        id: m.id,
        title: m.subject || '(无主题)',
        subtitle: `来自 ${m.from}`,
        at: m.receivedAt.slice(5, 16).replace('T', ' '),
        page: 'mail'
      })
    }
  }

  for (const c of input.conversations) {
    if (hits.filter((h) => h.kind === 'conversation').length >= GLOBAL_SEARCH_LIMIT_PER_GROUP) break
    if (c.status !== 'active') continue
    if (matches(term, c.title)) {
      hits.push({
        kind: 'conversation',
        id: c.id,
        title: c.title,
        subtitle: c.kind === 'chat' ? 'AI 会话' : '分析会话',
        page: 'chat'
      })
    }
  }

  for (const p of input.pendings) {
    if (hits.filter((h) => h.kind === 'pending').length >= GLOBAL_SEARCH_LIMIT_PER_GROUP) break
    if (p.status !== 'open') continue
    if (matches(term, p.title, p.notes)) {
      hits.push({
        kind: 'pending',
        id: p.id,
        title: p.title,
        subtitle: '待确认 · 来自分析',
        page: 'pending'
      })
    }
  }

  return hits
}
