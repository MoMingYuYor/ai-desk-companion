import { describe, expect, it } from 'vitest'
import { collectHits, GLOBAL_SEARCH_LIMIT_PER_GROUP } from '../../src/renderer/workbench/search/globalSearch'
import type { MailSummary } from '../../src/shared/mail'
import type { CalendarEvent, Conversation, PendingItem, Todo } from '../../src/shared/types'

function mail(over: Partial<MailSummary> = {}): MailSummary {
  return {
    id: 'm1',
    accountId: 'a1',
    accountLabel: '学习邮箱',
    from: 'teacher@example.com',
    to: 'me@qq.com',
    receivedAt: '2026-09-17T05:00:00Z',
    read: false,
    hasAttachments: false,
    bodyState: 'ready',
    remoteAvailable: true,
    subject: '关于课程项目中期汇报的安排',
    ...over
  } as MailSummary
}

function todo(over: Partial<Todo> = {}): Todo {
  return {
    id: 't1',
    title: '整理课程项目的汇报材料',
    priority: 'normal',
    completedAt: null,
    source: 'manual',
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:00Z',
    ...over
  } as Todo
}

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1',
    title: '小组讨论',
    startAt: '2026-09-18T14:00',
    endAt: '2026-09-18T15:00',
    allDay: false,
    location: '图书馆',
    notes: null,
    source: 'manual',
    reminderMinutes: null,
    status: 'active',
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:00Z',
    ...over
  } as CalendarEvent
}

function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    title: '通知分析:报名表',
    kind: 'analysis',
    status: 'active',
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:00Z',
    ...over
  } as Conversation
}

function pending(over: Partial<PendingItem> = {}): PendingItem {
  return {
    id: 'p1',
    title: '确认周五讨论时间',
    status: 'open',
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:00Z',
    ...over
  } as PendingItem
}

const input = {
  mails: [mail(), mail({ id: 'm2', subject: '报名分享会明天开始', from: 'club@example.com' })],
  todos: [todo(), todo({ id: 't2', title: '提交阅读笔记', completedAt: '2026-09-17T02:00:00Z' })],
  events: [event(), event({ id: 'e2', title: '软件工程上课', startAt: '2026-09-17T09:00' })],
  conversations: [conversation()],
  pendings: [pending()]
}

describe('collectHits', () => {
  it('空关键词返回空结果', () => {
    expect(collectHits({ ...input, term: '   ' })).toEqual([])
  })

  it('跨分组大小写不敏感地匹配标题/主题/发件人', () => {
    const hits = collectHits({ ...input, term: '课程' })
    const kinds = hits.map((h) => h.kind)
    expect(kinds).toContain('mail')
    expect(kinds).toContain('todo')
    const mailHit = hits.find((h) => h.kind === 'mail')!
    expect(mailHit.title).toContain('课程')
    expect(mailHit.page).toBe('mail')
  })

  it('按发件人也能搜到邮件', () => {
    const hits = collectHits({ ...input, term: 'club@example' })
    expect(hits.map((h) => h.id)).toContain('m2')
  })

  it('每组分发上限,避免长列表淹没结果', () => {
    const many = Array.from({ length: GLOBAL_SEARCH_LIMIT_PER_GROUP + 3 }, (_, i) =>
      mail({ id: `m${i}`, subject: `通知 ${i}` })
    )
    const hits = collectHits({ ...input, mails: many, term: '通知' })
    expect(hits.filter((h) => h.kind === 'mail')).toHaveLength(GLOBAL_SEARCH_LIMIT_PER_GROUP)
  })

  it('已完成的待办与已办结的待确认不出现', () => {
    const hits = collectHits({ ...input, term: '阅读笔记' })
    expect(hits).toEqual([])
    const hits2 = collectHits({
      ...input,
      term: '确认周五',
      pendings: [pending({ status: 'handled' })]
    })
    expect(hits2).toEqual([])
  })

  it('无匹配返回空数组', () => {
    expect(collectHits({ ...input, term: '不存在的关键词' })).toEqual([])
  })
})
