// @vitest-environment jsdom
// PERF-02「按瓶颈选择最小优化」:日历页反例。
// 规范:docs/superpowers/plans/2026-10-08-desk-companion-improvements/performance.md#perf-02
// - 选中日详情事件/待办分区 50 条分页:显示总数、继续加载、当前日期;切日重置上限;
// - 晚到旧日期/旧月份响应不得覆盖新日期/新月份(请求代号防显示回退);
// - 42 格与每格预览限制保持;同日编辑关闭不折叠已调大的上限。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import React from 'react'
import { CalendarPage } from '../../src/renderer/workbench/pages/CalendarPage'
import type { CalendarEvent, DayAgenda, Todo } from '../../src/shared/types'
import { toDateStr } from '../../src/shared/dateUtils'

afterEach(cleanup)

const pad2 = (n: number): string => String(n).padStart(2, '0')

function dayOffsetStr(days: number): string {
  const d = new Date(toDateStr(new Date()))
  d.setDate(d.getDate() + days)
  return toDateStr(d)
}

function makeEvent(id: string, startAt: string, title: string): CalendarEvent {
  return {
    id,
    title,
    startAt,
    endAt: startAt,
    allDay: false,
    color: null,
    location: null,
    notes: null,
    source: 'manual',
    sourceRef: null,
    reminderMinutes: null,
    status: 'active',
    fingerprint: null,
    revision: 1,
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z'
  }
}

function makeTodo(id: string, title: string, dueAt: string): Todo {
  return {
    id,
    title,
    notes: null,
    dueAt,
    priority: 'normal',
    completedAt: null,
    linkedEventId: null,
    source: 'manual',
    sourceRef: null,
    fingerprint: null,
    revision: 1,
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z'
  }
}

function makeAgenda(date: string, eventCount: number, todoCount: number): DayAgenda {
  const events = Array.from({ length: eventCount }, (_, i) =>
    makeEvent(`ev-${date}-${i}`, `${date}T${pad2(8 + (i % 12))}:${pad2(i % 60)}`, `日程 ${date} #${i}`)
  )
  const todos = Array.from({ length: todoCount }, (_, i) =>
    makeTodo(`td-${date}-${i}`, `待办 ${date} #${i}`, `${date}T18:00`)
  )
  return { date, courses: [], events, todos, schoolEvents: [] }
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function installApi(opts: {
  /** date → 立即返回的 agenda(缺省返回空 agenda) */
  agendas?: Record<string, DayAgenda>
  /** listEvents 按调用次序取响应;缺项立即返回空 */
  listEventsQueue?: Array<Deferred<CalendarEvent[]> | CalendarEvent[]>
} = {}) {
  const handlers: Record<string, (...args: unknown[]) => void> = {}
  /** date → 待挂起的 getDayAgenda 响应队列:测试在特定时机注入,注入后下一次该日期调用被挂起 */
  const pendingAgendas: Record<string, Array<Deferred<DayAgenda>>> = {}
  let listEventsCall = 0
  const emptyAgenda = (date: string): DayAgenda => ({ date, courses: [], events: [], todos: [], schoolEvents: [] })
  const api = {
    listEvents: vi.fn((_from: string, _to: string) => {
      const item = opts.listEventsQueue?.[listEventsCall++]
      if (item && 'promise' in item) return item.promise
      return Promise.resolve(item ?? [])
    }),
    getDayAgenda: vi.fn((date: string) => {
      const queue = pendingAgendas[date]
      if (queue && queue.length > 0) return queue.shift()!.promise
      return Promise.resolve(opts.agendas?.[date] ?? emptyAgenda(date))
    }),
    createEvent: vi.fn(),
    updateEvent: vi.fn(async () => undefined),
    deleteEvent: vi.fn(async () => undefined),
    on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      handlers[channel] = handler
      return () => {
        delete handlers[channel]
      }
    })
  }
  ;(window as unknown as { api: Record<string, unknown> }).api = api
  return { api, handlers, pendingAgendas }
}

function detailPanel(): HTMLElement {
  return document.querySelector('[data-agenda-date]')!
}

it('晚到旧日期响应不得覆盖新日期(请求代号防显示回退)', async () => {
  const today = dayOffsetStr(0)
  const tomorrow = dayOffsetStr(1)
  const freshAgenda = makeAgenda(tomorrow, 3, 2)
  const { pendingAgendas } = installApi({ agendas: { [tomorrow]: freshAgenda } })
  const { rerender } = render(<CalendarPage refreshKey={0} petAction={null} />)
  await screen.findByText('这一天暂无安排')

  // 注入两个挂起闸门(refreshKey=1 会触发 reload 的逐日调用 + 日详情调用,今天各一次)
  // 之后触发同日刷新(refreshKey):今天的日详情请求被挂起
  const reloadGate = deferred<DayAgenda>()
  const detailGate = deferred<DayAgenda>()
  pendingAgendas[today] = [reloadGate, detailGate]
  rerender(<CalendarPage refreshKey={1} petAction={null} />)

  // 切到明天 → 新日期响应立即生效
  fireEvent.click(document.querySelector(`[data-date="${tomorrow}"]`)!)
  expect(await screen.findByText('日程 ' + tomorrow + ' #0')).toBeTruthy()
  expect(detailPanel().getAttribute('data-agenda-date')).toBe(tomorrow)

  // 旧日期(今天)响应晚到:必须被丢弃,详情仍是明天
  reloadGate.resolve(makeAgenda(today, 0, 0))
  detailGate.resolve(makeAgenda(today, 1, 0))
  await waitFor(() => {
    expect(detailPanel().getAttribute('data-agenda-date')).toBe(tomorrow)
    expect(screen.queryByText('日程 ' + today + ' #0')).toBeNull()
  })
  expect(detailPanel().querySelectorAll('.list-row')).toHaveLength(5)
})

it('晚到旧月份响应不得覆盖新月份网格数据', async () => {
  const today = dayOffsetStr(0)
  // 下月 15 日(下月网格内的一天)
  const [y, m] = today.split('-').map(Number)
  const nextMonthDay = m === 12 ? `${y + 1}-01-15` : `${y}-${pad2(m + 1)}-15`
  const freshEvent = makeEvent('m2-ev', `${nextMonthDay}T09:00`, '下月日程')
  const staleEvent = makeEvent('m1-ev', `${today}T10:00`, '旧月迟到响应')
  const firstMonthEvents = deferred<CalendarEvent[]>()
  const { container } = installApiAndRender({
    listEventsQueue: [firstMonthEvents, [freshEvent]]
  })

  // 首月请求挂起;切下月 → 新月份数据立即生效(格子出现下月日程 chip)
  fireEvent.click(screen.getByRole('button', { name: '→' }))
  await waitFor(() => {
    const cell = container.querySelector(`[data-date="${nextMonthDay}"] .chip.event`)
    expect(cell).not.toBeNull()
    expect(cell!.textContent).toContain('下月日程')
  })

  // 旧月份响应晚到:必须被丢弃——旧月日期格子不得出现旧月 chip,下月格子数据保持
  firstMonthEvents.resolve([staleEvent])
  await waitFor(() => {
    const staleCell = container.querySelector(`[data-date="${today}"] .chip.event`)
    expect(staleCell).toBeNull()
    const freshCell = container.querySelector(`[data-date="${nextMonthDay}"] .chip.event`)
    expect(freshCell).not.toBeNull()
    expect(freshCell!.textContent).toContain('下月日程')
  })
})

/** installApi + render 的组合(日历页所有月数据都走空 agenda,网格仅事件 chip 可断言) */
function installApiAndRender(opts: Parameters<typeof installApi>[0]) {
  const installed = installApi(opts)
  const rendered = render(<CalendarPage refreshKey={0} petAction={null} />)
  return { ...installed, container: rendered.container }
}

it('选中日详情事件/待办分区 50 条分页:显示总数、继续加载、当前日期', async () => {
  const today = dayOffsetStr(0)
  installApi({ agendas: { [today]: makeAgenda(today, 120, 80) } })
  const { container } = render(<CalendarPage refreshKey={0} petAction={null} />)

  await screen.findByText('日程 ' + today + ' #0')
  const panel = detailPanel()
  expect(panel.getAttribute('data-agenda-date')).toBe(today)
  // 完整总数锚点:120 事件 + 80 待办 = 200;可见 = 50 + 50
  expect(panel.getAttribute('data-agenda-total')).toBe('200')
  expect(panel.getAttribute('data-agenda-visible')).toBe('100')
  // 分区总数与继续加载入口可见
  expect(screen.getByText('日程 共 120 条,已显示 50 条')).toBeTruthy()
  expect(screen.getByText('显示更多日程(还有 70 条)')).toBeTruthy()
  expect(screen.getByText('当天截止的待办(80)')).toBeTruthy()
  expect(screen.getByText('显示更多待办(还有 30 条)')).toBeTruthy()
  expect(panel.querySelectorAll('.list-row')).toHaveLength(100)
  expect(container.querySelectorAll('.cal-cell')).toHaveLength(42)

  // 继续加载:事件 +50 → 100(剩余 20)
  fireEvent.click(screen.getByRole('button', { name: '显示更多日程(还有 70 条)' }))
  await waitFor(() => expect(panel.getAttribute('data-agenda-visible')).toBe('150'))
  expect(panel.querySelectorAll('.list-row')).toHaveLength(150)
  expect(screen.getByText('日程 共 120 条,已显示 100 条')).toBeTruthy()

  // 待办一次加载到全量(80)
  fireEvent.click(screen.getByRole('button', { name: '显示更多待办(还有 30 条)' }))
  await waitFor(() => expect(panel.getAttribute('data-agenda-visible')).toBe('180'))
  expect(panel.querySelectorAll('.list-row')).toHaveLength(180)
  expect(screen.queryByRole('button', { name: '显示更多待办(还有 30 条)' })).toBeNull()
})

it('切日重置分页上限;同日编辑关闭不折叠', async () => {
  const today = dayOffsetStr(0)
  const tomorrow = dayOffsetStr(1)
  installApi({
    agendas: {
      [today]: makeAgenda(today, 120, 10),
      [tomorrow]: makeAgenda(tomorrow, 120, 0)
    }
  })
  const { container } = render(<CalendarPage refreshKey={0} petAction={null} />)
  await screen.findByText('日程 ' + today + ' #0')

  // 扩到 100 后打开并取消编辑(同日):上限保留
  fireEvent.click(screen.getByRole('button', { name: '显示更多日程(还有 70 条)' }))
  await waitFor(() => expect(detailPanel().getAttribute('data-agenda-visible')).toBe('110'))
  fireEvent.click(screen.getByText('日程 ' + today + ' #0').closest('.list-row')!.querySelector('span[role="button"]')!)
  await screen.findByText('编辑日程')
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  await waitFor(() => expect(screen.queryByText('编辑日程')).toBeNull())
  expect(detailPanel().getAttribute('data-agenda-visible')).toBe('110')
  expect(screen.getByText('日程 共 120 条,已显示 100 条')).toBeTruthy()

  // 切日:上限重置为 50(若未重置将显示 100 条)
  fireEvent.click(container.querySelector(`[data-date="${tomorrow}"]`)!)
  await screen.findByText('日程 ' + tomorrow + ' #0')
  expect(detailPanel().getAttribute('data-agenda-date')).toBe(tomorrow)
  expect(detailPanel().getAttribute('data-agenda-total')).toBe('120')
  expect(detailPanel().getAttribute('data-agenda-visible')).toBe('50')
  expect(screen.getByText('日程 共 120 条,已显示 50 条')).toBeTruthy()
  expect(screen.getByText('显示更多日程(还有 70 条)')).toBeTruthy()
})
