// @vitest-environment jsdom
// PERF-01「生产页面和交互测量」:观测锚点守卫与完成条件反例(先于实现编写)。
// 规范:docs/superpowers/plans/2026-10-08-desk-companion-improvements/performance.md#perf-01
// - 完成条件必须锚定真实 DOM:IPC 返回 10000 条而页面只渲染 1 条时不能通过;
//   DOM 数量正确但关键 ID 缺失也不能通过(旧观测逻辑只比较 IPC 行数,会被拒绝)。
// - 空页、异常、超时和后台窗口分别得到明确错误或环境限制,不得静默通过。
// - 生产页面暴露稳定 data-* 观测锚点:不暴露数据库内容、不进用户文案、无测量开关。
// 边界说明:tsconfig.node(composite)不含 renderer .tsx,组件级渲染会把页面文件拉进
// node 工程图(TS6307),因此锚点在单测层用源码守卫;锚点的真实存在性与可点击性由
// scripts/electron-perf.mjs 的 CDP 场景在生产页面逐格/逐行核对(缺失即 NAV_MISSING /
// MISSING_PAGE_ROOT 等失败样本)。
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// electron-perf.mjs 为纯 ESM 脚本,tsconfig.node 未开 allowJs,无独立类型声明;
// 以 @ts-expect-error 标注后在测试内按结构类型收窄使用。
// @ts-expect-error electron-perf.mjs 无独立 d.ts(TS7016)
import * as perfModule from '../../scripts/electron-perf.mjs'

// ---------- electron-perf.mjs 导出契约(结构类型) ----------

interface Verdict {
  pass: boolean
  reason: string
  detail?: Record<string, unknown>
}
interface TodosSnapshot {
  pageRootPresent: boolean
  recordIds: string[]
  visibilityState: string
}
interface CalendarSnapshot {
  pageRootPresent: boolean
  cellDates: string[]
  agendaDate: string | null
  agendaRowCount: number
  agendaEmptyNote: boolean
  eventChipCount: number
  visibilityState: string
}
interface TodosExpectation {
  expectedIds: string[]
}
interface CalendarExpectation {
  gridDates: string[]
  selectedDate: string
  expectedAgendaRows: number
  expectedEventChips?: number | null
}
interface PerfContract {
  waitForDomReady: (condition: () => boolean, limitMs?: number) => Promise<void>
  visibilityLimitation: (state: string) => { limited: boolean; reason: string | null }
  collectTodosSnapshot: (doc: Document) => TodosSnapshot
  verifyTodosCompletion: (snapshot: TodosSnapshot, expected: TodosExpectation) => Verdict
  collectCalendarSnapshot: (doc: Document) => CalendarSnapshot
  verifyCalendarCompletion: (snapshot: CalendarSnapshot, expected: CalendarExpectation) => Verdict
}
const perf = perfModule as unknown as PerfContract

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const readSource = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8')

const pad2 = (n: number): string => String(n).padStart(2, '0')

// 单元测试用的 42 个不同日期(不必与真实月网格一致,完成条件按传入期望核对)
const CELL_DATES = Array.from({ length: 42 }, (_, i) => {
  const d = new Date(2026, 9, 1)
  d.setDate(d.getDate() + i)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
})

afterEach(() => {
  document.body.innerHTML = ''
})

// ---------- 观测锚点守卫(真实点击由 CDP 场景验证) ----------

describe('PERF-01 观测锚点', () => {
  it('App.tsx 导航项包含 data-nav={n.key} 观测锚点', () => {
    expect(readSource('src/renderer/workbench/App.tsx')).toContain('data-nav={n.key}')
  })

  it('TodosPage.tsx 包含 data-page="todos" 根锚点与 data-record-id={t.id} 行锚点', () => {
    const source = readSource('src/renderer/workbench/pages/TodosPage.tsx')
    expect(source).toContain('data-page="todos"')
    expect(source).toContain('data-record-id={t.id}')
  })

  it('CalendarPage.tsx 包含 data-page/data-date/data-agenda-date 观测锚点', () => {
    const source = readSource('src/renderer/workbench/pages/CalendarPage.tsx')
    expect(source).toContain('data-page="calendar"')
    expect(source).toContain('data-date={d}')
    expect(source).toContain('data-agenda-date={selected}')
  })

  it('观测锚点不引入测量开关,也不进入普通用户文案(仅作为 DOM 属性)', () => {
    for (const rel of [
      'src/renderer/workbench/App.tsx',
      'src/renderer/workbench/pages/TodosPage.tsx',
      'src/renderer/workbench/pages/CalendarPage.tsx'
    ]) {
      const source = readSource(rel)
      expect(source).not.toMatch(/(localStorage|sessionStorage|perf[-_]?mode|measure[-_]?on)/i)
    }
  })
})

// ---------- 完成条件反例 ----------

describe('PERF-01 完成条件反例', () => {
  const expectedIds10k = Array.from({ length: 10000 }, (_, i) => `perf-todo-${i}`)

  it('IPC 返回 10000 条而页面只渲染 1 条时不能通过(旧 IPC 行数逻辑会放行)', () => {
    document.body.innerHTML = '<div data-page="todos"><div data-record-id="perf-todo-0"></div></div>'
    const snapshot = perf.collectTodosSnapshot(document)
    // 旧观测逻辑:只比较 IPC 返回行数与期望行数,不看页面 DOM —— 该场景下会放行
    const ipcRowCount = 10000
    expect(ipcRowCount === expectedIds10k.length).toBe(true)
    const verdict = perf.verifyTodosCompletion(snapshot, { expectedIds: expectedIds10k })
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toBe('RECORD_COUNT_MISMATCH')
  })

  it('DOM 数量正确但关键 ID 缺失时不能通过', () => {
    const rows = Array.from({ length: 10000 }, (_, i) => `<div data-record-id="perf-fake-${i}"></div>`).join('')
    document.body.innerHTML = `<div data-page="todos">${rows}</div>`
    const verdict = perf.verifyTodosCompletion(perf.collectTodosSnapshot(document), { expectedIds: expectedIds10k })
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toBe('MISSING_RECORD_IDS')
    expect((verdict.detail as { missingSample?: string[] }).missingSample).toContain('perf-todo-0')
  })

  it('空页(无根锚点/零记录)不能通过', () => {
    document.body.innerHTML = '<div></div>'
    expect(
      perf.verifyTodosCompletion(perf.collectTodosSnapshot(document), { expectedIds: expectedIds10k }).reason
    ).toBe('MISSING_PAGE_ROOT')
    document.body.innerHTML = '<div data-page="todos"></div>'
    const verdict = perf.verifyTodosCompletion(perf.collectTodosSnapshot(document), { expectedIds: expectedIds10k })
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toBe('RECORD_COUNT_MISMATCH')
  })

  it('后台窗口记为环境限制 BACKGROUND_WINDOW,不判通过', () => {
    document.body.innerHTML = '<div data-page="todos"><div data-record-id="perf-todo-0"></div></div>'
    const snapshot: TodosSnapshot = { ...perf.collectTodosSnapshot(document), visibilityState: 'hidden' }
    const verdict = perf.verifyTodosCompletion(snapshot, { expectedIds: ['perf-todo-0'] })
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toBe('BACKGROUND_WINDOW')
    expect(perf.visibilityLimitation('hidden')).toEqual({ limited: true, reason: 'BACKGROUND_WINDOW' })
    expect(perf.visibilityLimitation('visible').limited).toBe(false)
  })

  it('完成条件通过路径:根锚点存在且 ID 全部渲染', () => {
    const rows = expectedIds10k
      .slice(0, 3)
      .map((id) => `<div data-record-id="${id}"></div>`)
      .join('')
    document.body.innerHTML = `<div data-page="todos">${rows}</div>`
    const verdict = perf.verifyTodosCompletion(perf.collectTodosSnapshot(document), {
      expectedIds: expectedIds10k.slice(0, 3)
    })
    expect(verdict).toMatchObject({ pass: true, reason: 'OK' })
  })

  it('日历 42 格缺失/选中日不符/明细行数不符分别拒绝', () => {
    const expectation: CalendarExpectation = { gridDates: CELL_DATES, selectedDate: '2026-10-08', expectedAgendaRows: 2 }
    const mk = (cells: string[], agendaDate: string | null, rows: number): CalendarSnapshot => ({
      pageRootPresent: true,
      cellDates: cells,
      agendaDate,
      agendaRowCount: rows,
      agendaEmptyNote: false,
      eventChipCount: 0,
      visibilityState: 'visible'
    })
    expect(perf.verifyCalendarCompletion(mk(CELL_DATES.slice(0, 41), '2026-10-08', 2), expectation)).toMatchObject({
      pass: false,
      reason: 'CELL_COUNT_MISMATCH'
    })
    expect(perf.verifyCalendarCompletion(mk(CELL_DATES, '2026-10-07', 2), expectation)).toMatchObject({
      pass: false,
      reason: 'AGENDA_DATE_MISMATCH'
    })
    expect(perf.verifyCalendarCompletion(mk(CELL_DATES, '2026-10-08', 3), expectation)).toMatchObject({
      pass: false,
      reason: 'AGENDA_ROWS_MISMATCH'
    })
    expect(perf.verifyCalendarCompletion(mk(CELL_DATES, '2026-10-08', 2), expectation)).toMatchObject({
      pass: true,
      reason: 'OK'
    })
  })

  it('日历完成条件支持网格日期精确匹配与事件 chip 总数核对', () => {
    const shuffled = [...CELL_DATES].reverse()
    const expectation: CalendarExpectation = {
      gridDates: CELL_DATES,
      selectedDate: '2026-10-08',
      expectedAgendaRows: 1,
      expectedEventChips: 3
    }
    const mk = (cells: string[], chips: number): CalendarSnapshot => ({
      pageRootPresent: true,
      cellDates: cells,
      agendaDate: '2026-10-08',
      agendaRowCount: 1,
      agendaEmptyNote: false,
      eventChipCount: chips,
      visibilityState: 'visible'
    })
    // 数量 42 但顺序不符(网格日期必须与期望月网格逐格一致)
    expect(perf.verifyCalendarCompletion(mk(shuffled, 3), expectation).reason).toBe('CELL_COUNT_MISMATCH')
    expect(perf.verifyCalendarCompletion(mk(CELL_DATES, 2), expectation).reason).toBe('EVENT_CHIPS_MISMATCH')
    expect(perf.verifyCalendarCompletion(mk(CELL_DATES, 3), expectation)).toMatchObject({ pass: true })
  })

  it('从真实 DOM 收集日历快照并通过完成条件(空日显示"暂无安排")', () => {
    const cells = CELL_DATES.map((d) => `<div data-date="${d}"></div>`).join('')
    document.body.innerHTML = `<div data-page="calendar"><div class="cal-grid">${cells}</div>` +
      '<div data-agenda-date="2026-10-08"><div class="empty">这一天暂无安排</div></div></div>'
    const snapshot = perf.collectCalendarSnapshot(document)
    expect(snapshot.cellDates).toHaveLength(42)
    const verdict = perf.verifyCalendarCompletion(snapshot, {
      gridDates: CELL_DATES,
      selectedDate: '2026-10-08',
      expectedAgendaRows: 0
    })
    expect(verdict).toMatchObject({ pass: true, reason: 'OK' })
  })
})

// ---------- 就绪判据 waitForDomReady ----------

describe('PERF-01 就绪判据 waitForDomReady', () => {
  it('条件满足后经双 rAF 完成', async () => {
    let calls = 0
    await perf.waitForDomReady(() => {
      calls++
      return true
    }, 500)
    expect(calls).toBe(1)
  })

  it('超时抛 PAGE_READY_TIMEOUT,由场景记录为错误样本', async () => {
    await expect(perf.waitForDomReady(() => false, 120)).rejects.toThrow('PAGE_READY_TIMEOUT')
  })

  it('条件异常如实抛出,不吞错', async () => {
    await expect(
      perf.waitForDomReady(() => {
        throw new Error('BOOM')
      }, 300)
    ).rejects.toThrow('BOOM')
  })
})
