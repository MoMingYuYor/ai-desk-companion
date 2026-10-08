// @vitest-environment jsdom
// PERF-02「按瓶颈选择最小优化」:待办页分页反例(10000 条替身)。
// 规范:docs/superpowers/plans/2026-10-08-desk-companion-improvements/performance.md#perf-02
// - 初始每组最多 50 条但显示完整总数;继续加载后新增准确 50 条;
// - 已隐藏的最后一条可通过继续加载到达;
// - 完成/取消完成不出现重复、丢失或错误分组;
// - "显示更多"只改可见上限,不改业务记录;刷新后保留合理上限、重新进入页面默认 50;
// - 当前编辑条目保持可见。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import React from 'react'
import { TodosPage } from '../../src/renderer/workbench/pages/TodosPage'
import type { Todo } from '../../src/shared/types'
import { toDateStr } from '../../src/shared/dateUtils'

afterEach(cleanup)

const TOTAL = 10000

function dayOffsetStr(days: number): string {
  const d = new Date(toDateStr(new Date()))
  d.setDate(d.getDate() + days)
  return toDateStr(d)
}

/** 固定分桶替身:已逾期 100 / 今天 50 / 未来 9800 / 无截止 20 / 已完成 30(初始可见 200) */
function makeTodos(): Todo[] {
  const list: Todo[] = []
  const base = {
    notes: null,
    priority: 'normal' as const,
    linkedEventId: null,
    source: 'manual' as const,
    sourceRef: null,
    fingerprint: null,
    revision: 1,
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z'
  }
  for (let i = 0; i < TOTAL; i++) {
    let dueAt: string | null = null
    let completedAt: string | null = null
    if (i < 100) dueAt = `${dayOffsetStr(-1)}T08:00`
    else if (i < 150) dueAt = `${dayOffsetStr(0)}T12:00`
    else if (i < 9950) dueAt = `${dayOffsetStr(1)}T18:00`
    else if (i < 9970) dueAt = null
    else {
      dueAt = `${dayOffsetStr(-3)}T09:00`
      completedAt = `${dayOffsetStr(-2)}T10:00`
    }
    list.push({ id: `t-${i}`, title: `合成待办 ${i}`, dueAt, completedAt, ...base })
  }
  return list
}

type DataChangedHandler = () => void

/** 渲染句柄:测试用 refreshKey 递增模拟 App 对 evt:data-changed 的统一转发 */
interface RenderHandle {
  rerender: (ui: React.ReactElement) => void
}

function makeBumpRefresh(handle: RenderHandle): () => void {
  let key = 0
  return () => {
    key += 1
    handle.rerender(<TodosPage refreshKey={key} petAction={null} />)
  }
}

function installApi(todosList: Todo[]) {
  const handlers: Record<string, DataChangedHandler> = {}
  // 模拟主进程 writeNotify 语义:写入成功 → 广播 evt:data-changed(主进程仍广播,
  // 但 App 层负责把它转为 refreshKey;页面不再自行订阅)。测试用 bumpRefresh 模拟该转发。
  const notifyChanged = (): void => {
    handlers['evt:data-changed']?.()
  }
  const api = {
    listTodos: vi.fn(async () => todosList.map((t) => ({ ...t }))),
    updateTodo: vi.fn(async (id: string, patch: Partial<Todo>) => {
      const t = todosList.find((x) => x.id === id)
      if (t) Object.assign(t, patch)
      notifyChanged()
    }),
    deleteTodo: vi.fn(async () => undefined),
    on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      handlers[channel] = handler
      return () => {
        delete handlers[channel]
      }
    })
  }
  ;(window as unknown as { api: Record<string, unknown> }).api = api
  return { api, handlers }
}

function rowsInGroup(titleText: string): HTMLElement[] {
  const title = screen.getByText(titleText)
  const group = title.parentElement!
  return Array.from(group.querySelectorAll('[data-record-id]'))
}

function clickShowMore(fullName: string): void {
  fireEvent.click(screen.getByRole('button', { name: fullName }))
}

it('初始渲染:每组最多 50 条,组标题与 data-record-total 显示完整总数', async () => {
  const todosList = makeTodos()
  installApi(todosList)
  const { container } = render(<TodosPage refreshKey={0} petAction={null} />)

  await screen.findByText('未来(9800)')
  expect(screen.getByText('已逾期(100)')).toBeTruthy()
  expect(screen.getByText('今天(50)')).toBeTruthy()
  expect(screen.getByText('无截止时间(20)')).toBeTruthy()
  expect(screen.getByText('已完成(30)')).toBeTruthy()

  // 各组初始切片:100→50、9800→50、20/30 不裁剪
  expect(rowsInGroup('已逾期(100)')).toHaveLength(50)
  expect(rowsInGroup('未来(9800)')).toHaveLength(50)
  expect(rowsInGroup('无截止时间(20)')).toHaveLength(20)
  expect(rowsInGroup('已完成(30)')).toHaveLength(30)
  expect(container.querySelectorAll('[data-record-id]')).toHaveLength(200)

  // 完整总数锚点:业务记录总数 10000,可见 200
  const root = container.querySelector('[data-page="todos"]')!
  expect(root.getAttribute('data-record-total')).toBe('10000')
  expect(root.getAttribute('data-visible-count')).toBe('200')

  // 每组显示前缀顺序保持(已逾期前 50 为 t-0..t-49),t-99 尚不可见
  const overdue = rowsInGroup('已逾期(100)')
  expect(overdue[0].getAttribute('data-record-id')).toBe('t-0')
  expect(overdue[49].getAttribute('data-record-id')).toBe('t-49')
  expect(container.querySelector('[data-record-id="t-99"]')).toBeNull()
})

it('"显示更多"每次只新增准确 50 条,且不改业务记录总数', async () => {
  const todosList = makeTodos()
  const { container } = render(<TodosPage refreshKey={0} petAction={null} />)
  await screen.findByText('未来(9800)')

  // 已逾期组:50 → 100(全量),按钮因无隐藏项而消失
  clickShowMore('显示更多(还有 50 条)')
  await waitFor(() => expect(rowsInGroup('已逾期(100)')).toHaveLength(100))
  expect(container.querySelectorAll('[data-record-id]')).toHaveLength(250)
  expect(screen.queryByRole('button', { name: '显示更多(还有 50 条)' })).toBeNull()

  // 未来组:50 → 100,精确步进 50
  clickShowMore('显示更多(还有 9750 条)')
  await waitFor(() => expect(rowsInGroup('未来(9800)')).toHaveLength(100))
  expect(rowsInGroup('未来(9800)')[99].getAttribute('data-record-id')).toBe('t-249')
  expect(container.querySelectorAll('[data-record-id]')).toHaveLength(300)

  // 业务记录不裁剪:组标题计数与总数锚点不变
  expect(screen.getByText('已逾期(100)')).toBeTruthy()
  expect(screen.getByText('未来(9800)')).toBeTruthy()
  expect(container.querySelector('[data-page="todos"]')!.getAttribute('data-record-total')).toBe('10000')
})

it('已隐藏的最后一条可通过继续加载到达', async () => {
  const todosList = makeTodos()
  const { container } = render(<TodosPage refreshKey={0} petAction={null} />)
  await screen.findByText('已逾期(100)')

  expect(container.querySelector('[data-record-id="t-99"]')).toBeNull()
  clickShowMore('显示更多(还有 50 条)')
  await waitFor(() => {
    const last = container.querySelector('[data-record-id="t-99"]')
    expect(last).not.toBeNull()
    // 且是该组最后一行
    const rows = rowsInGroup('已逾期(100)')
    expect(rows[rows.length - 1].getAttribute('data-record-id')).toBe('t-99')
  })
})

it('完成/取消完成:不重复、不丢失、不错分组', async () => {
  const todosList = makeTodos()
  installApi(todosList)
  const rendered = render(<TodosPage refreshKey={0} petAction={null} />)
  const { container } = rendered
  const bumpRefresh = makeBumpRefresh(rendered)
  await screen.findByText('已逾期(100)')

  const row0 = () => container.querySelector('[data-record-id="t-0"]')!
  // 完成 t-0:写入 → App 转发广播(refreshKey+1)→ 重拉;t-0 从 已逾期 移入 已完成,且 DOM 中只出现一次
  fireEvent.click(row0().querySelector('input[type="checkbox"]')!)
  bumpRefresh()
  await screen.findByText('已逾期(99)')
  await screen.findByText('已完成(31)')
  expect(container.querySelectorAll('[data-record-id="t-0"]')).toHaveLength(1)
  expect(row0().classList.contains('done')).toBe(true)
  // 已完成组按截止时间排序:t-0(due -3 天)位于组首,仍在可见切片内
  expect(rowsInGroup('已完成(31)')[0].getAttribute('data-record-id')).toBe('t-0')

  // 取消完成:回到 已逾期 组,同样不重复不丢失
  fireEvent.click(row0().querySelector('input[type="checkbox"]')!)
  bumpRefresh()
  await screen.findByText('已逾期(100)')
  await screen.findByText('已完成(30)')
  expect(container.querySelectorAll('[data-record-id="t-0"]')).toHaveLength(1)
  expect(row0().classList.contains('done')).toBe(false)
  expect(rowsInGroup('已逾期(100)')[0].getAttribute('data-record-id')).toBe('t-0')
})

it('当前编辑条目在页内刷新后保持可见(即使落在新分组可见上限之外)', async () => {
  const todosList = makeTodos()
  installApi(todosList)
  const rendered = render(<TodosPage refreshKey={0} petAction={null} />)
  const { container } = rendered
  const bumpRefresh = makeBumpRefresh(rendered)
  await screen.findByText('未来(9800)')

  // 打开 t-160(未来组首屏可见)的编辑器
  fireEvent.click(screen.getByText('合成待办 160'))
  await screen.findByText('编辑待办')

  // 页内数据刷新:t-160 改截止为两天前 → 落入 已逾期 组第 101 位(默认 50 上限之外)
  const moved = todosList.find((t) => t.id === 't-160')!
  moved.dueAt = `${dayOffsetStr(-2)}T08:00`
  bumpRefresh()

  // 编辑器保持打开,条目因"当前编辑"钉住而保持可见
  await screen.findByText('已逾期(101)')
  expect(screen.getByText('编辑待办')).toBeTruthy()
  expect(container.querySelector('[data-record-id="t-160"]')).not.toBeNull()
})

it('刷新后保留已调大的可见上限;重新进入页面恢复默认 50', async () => {
  const todosList = makeTodos()
  installApi(todosList)
  const first = render(<TodosPage refreshKey={0} petAction={null} />)
  const bumpRefresh = makeBumpRefresh(first)
  await screen.findByText('已逾期(100)')

  clickShowMore('显示更多(还有 50 条)')
  await waitFor(() => expect(rowsInGroup('已逾期(100)')).toHaveLength(100))

  // 页内刷新(数据未变):上限保留,不折叠回 50
  bumpRefresh()
  await waitFor(() => {
    expect(first.container.querySelectorAll('[data-record-id]')).toHaveLength(250)
  })
  expect(rowsInGroup('已逾期(100)')).toHaveLength(100)

  // 卸载后重新进入:各组回到默认 50
  first.unmount()
  const second = render(<TodosPage refreshKey={0} petAction={null} />)
  await screen.findByText('已逾期(100)')
  expect(second.container.querySelectorAll('[data-record-id]')).toHaveLength(200)
  expect(rowsInGroup('已逾期(100)')).toHaveLength(50)
})
