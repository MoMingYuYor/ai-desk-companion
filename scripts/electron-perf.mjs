// 离线验收:真实工作台 renderer → preload → IPC;只使用新建的隔离合成库。
// PERF-01(2026-10-08 六项改进):在保留原 IPC 计数口径的基础上,新增生产页面 CDP 测量:
//   1) data-* 观测锚点 + waitForDomReady(条件+双 rAF) 的页面就绪(pageReady),与
//      计数节点的 renderReadyMs 严格分列,后者不冒充页面测量;
//   2) CDP 点击驱动的交互就绪(interactionReady):切换待办页、打开/取消编辑、
//      完成待办并核对落库显示、切日、切月、滚动;
//   3) PerformanceObserver longtask、rAF 帧间隔、renderer heap、main/app 进程资源分列;
//   4) 均匀(uniform)/单日集中(concentrated)两类固定种子日程分别标识;
//   5) 每个 Electron 场景子进程 60 秒硬上限,单条流 105 次迭代按软预算自动分块,
//      超时/失败样本如实记账,不静默拉长、不删除失败或慢样本。
// 保留 scripts/perf-check.mjs、scripts/measure-baseline.mjs 的 Node 口径不动。
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cpus, totalmem, platform, arch, release } from 'node:os'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const CHILD_LIMIT_MS = 60_000            // 每个 Electron 场景子进程硬上限(规范:60 秒,不静默拉长)
const QUERY_LIMIT_MS = 2_000             // IPC 口径单次查询超时(保留原值)
const PAGE_READY_LIMIT_MS = 30_000       // 页面就绪 waitForDomReady 上限(场景显式传入,超时如实记 PAGE_READY_TIMEOUT)
const INTERACTION_LIMIT_MS = 2_000       // 轻交互 DOM 就绪上限(waitForDomReady 默认口径)
const HEAVY_INTERACTION_LIMIT_MS = 5_000 // 含落库后整表重渲染或整月重载的交互就绪上限
const SOFT_CHUNK_BUDGET_MS = 25_000      // 场景函数软预算:到点返回已完成样本,余量交还控制器重新分块
const MAX_ITERS_PER_SEGMENT = 105        // 每段每次 chunk 的迭代上限(竞速兜底下按预算自然分割,减少启动开销)
const WARMUP = 5
const ITERATIONS = 100                   // 每条测量流暖态目标次数(nearest-rank p95,不删样本)
const MEMORY_ROUND_TRIPS = 10            // 内存观测:10 次往返页面(第 0 次为初始到达采样)
const NOW = '2026-10-12T08:00:00.000Z'   // 合成记录 created_at/updated_at 固定时间戳
const INTERACTION_BUDGET_MS = 200        // 交互 p95 预算
const MAX_CHUNKS = 200                   // 分块循环保护上限
const pageReadyBudgetMs = size => (size >= 10_000 ? 1_000 : 500) // 首屏 p95 预算:1k≤500ms、10k≤1000ms
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))

// 单项统计:nearest-rank 百分位(ceil(q*n)-1),保留全部样本(含错误),pass 由阈值与错误数决定。
export function summarizeSamples(samples, thresholdMs) {
  const ordered = samples.map(sample => sample.durationMs).sort((a, b) => a - b)
  const errors = samples.filter(sample => sample.error != null).length
  const p95Ms = ordered.length ? ordered[Math.ceil(0.95 * ordered.length) - 1] : null
  return {
    samples, count: samples.length, errors,
    p50Ms: ordered.length ? ordered[Math.ceil(0.5 * ordered.length) - 1] : null,
    p95Ms, maxMs: ordered.length ? ordered.at(-1) : null,
    thresholdMs, pass: samples.length > 0 && errors === 0 && p95Ms <= thresholdMs
  }
}

export function validateOptions(argv) {
  const values = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--user-data', '--output', '--screenshots'].includes(argv[i]) || !argv[i + 1]) throw new Error('参数：--user-data <绝对新隔离目录> --output <JSON路径> [--screenshots <新目录>]')
    if (values[argv[i]]) throw new Error(`重复参数 ${argv[i]}`)
    values[argv[i]] = argv[i + 1]
  }
  if (!values['--user-data'] || !isAbsolute(values['--user-data'])) throw new Error('--user-data 必须是绝对隔离目录')
  if (!values['--output']) throw new Error('缺少 --output')
  const userData = resolve(values['--user-data'])
  // 非空目录仅当带有本脚本的 owner 标记(断点续跑)时才接受;否则拒绝读取或覆盖。
  if (existsSync(userData) && (!statSync(userData).isDirectory() || (readdirSync(userData).length > 0 && !existsSync(join(userData, 'electron-perf-owner.json'))))) throw new Error('--user-data 已有非空内容，拒绝读取或覆盖')
  const screenshots = values['--screenshots'] ? resolve(values['--screenshots']) : null
  if (screenshots && existsSync(screenshots) && readdirSync(screenshots).length > 0) throw new Error('截图目录非空，拒绝覆盖')
  return { userData, output: resolve(values['--output']), screenshots }
}

// ---------- PERF-01:完成条件与观测锚点(单元反例与页面场景共用同一实现) ----------
// 这些函数同时运行在 Node 单测(jsdom)与生产页面(CDP evaluate)中,只依赖 document/performance/rAF。

// 规范就绪判据:条件轮询 + 双 rAF 沉降;超时抛 PAGE_READY_TIMEOUT,条件异常如实上抛。
export async function waitForDomReady(condition, limitMs = 2_000) {
  const deadline = performance.now() + limitMs
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error('PAGE_READY_TIMEOUT')
    await new Promise(resolve => requestAnimationFrame(resolve))
  }
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

// 后台窗口不是性能结论,而是环境限制:单独标识,不得静默通过。
export function visibilityLimitation(state) {
  return state === 'visible' ? { limited: false, reason: null } : { limited: true, reason: 'BACKGROUND_WINDOW' }
}

export function collectTodosSnapshot(doc) {
  return {
    pageRootPresent: doc.querySelector('[data-page="todos"]') != null,
    recordIds: Array.from(doc.querySelectorAll('[data-record-id]'), node => node.getAttribute('data-record-id')),
    visibilityState: doc.visibilityState
  }
}

// 待办页完成条件:当前实现无分页(PERF-02 未做),要求种子全部 ID 与 DOM 渲染 ID 集合一致。
// IPC 返回 10000 条而页面只渲染 1 条 → RECORD_COUNT_MISMATCH;数量对但关键 ID 缺失 → MISSING_RECORD_IDS。
export function verifyTodosCompletion(snapshot, expected) {
  const limited = visibilityLimitation(snapshot.visibilityState)
  if (limited.limited) return { pass: false, reason: limited.reason, detail: { visibilityState: snapshot.visibilityState } }
  if (!snapshot.pageRootPresent) return { pass: false, reason: 'MISSING_PAGE_ROOT', detail: null }
  if (snapshot.recordIds.length !== expected.expectedIds.length) {
    return {
      pass: false,
      reason: 'RECORD_COUNT_MISMATCH',
      detail: { domRows: snapshot.recordIds.length, expectedRows: expected.expectedIds.length }
    }
  }
  const rendered = new Set(snapshot.recordIds)
  const missing = expected.expectedIds.filter(id => !rendered.has(id))
  if (missing.length > 0) {
    return { pass: false, reason: 'MISSING_RECORD_IDS', detail: { missingCount: missing.length, missingSample: missing.slice(0, 5) } }
  }
  return { pass: true, reason: 'OK', detail: { domRows: snapshot.recordIds.length } }
}

export function collectCalendarSnapshot(doc) {
  const detail = doc.querySelector('[data-agenda-date]')
  const grid = doc.querySelector('.cal-grid')
  return {
    pageRootPresent: doc.querySelector('[data-page="calendar"]') != null,
    cellDates: Array.from(doc.querySelectorAll('[data-date]'), node => node.getAttribute('data-date')),
    agendaDate: detail ? detail.getAttribute('data-agenda-date') : null,
    agendaRowCount: detail ? detail.querySelectorAll('.list-row').length : 0,
    agendaEmptyNote: detail != null && detail.textContent.includes('这一天暂无安排'),
    eventChipCount: grid ? grid.querySelectorAll('.chip.event').length : 0,
    visibilityState: doc.visibilityState
  }
}

// 日历完成条件:42 格且与期望月网格逐格一致、选中日一致、可见明细行数与种子期望一致
// (期望行数 = 该日 events + 未完成且当日截止 todos,与 buildDayAgenda 口径相同;0 行时要求空态可见)。
export function verifyCalendarCompletion(snapshot, expected) {
  const limited = visibilityLimitation(snapshot.visibilityState)
  if (limited.limited) return { pass: false, reason: limited.reason, detail: { visibilityState: snapshot.visibilityState } }
  if (!snapshot.pageRootPresent) return { pass: false, reason: 'MISSING_PAGE_ROOT', detail: null }
  const datesOk = snapshot.cellDates.length === 42 && new Set(snapshot.cellDates).size === 42 &&
    (expected.gridDates ? snapshot.cellDates.join('|') === expected.gridDates.join('|') : true)
  if (!datesOk) {
    return {
      pass: false,
      reason: 'CELL_COUNT_MISMATCH',
      detail: { cells: snapshot.cellDates.length, expectedFirst: expected.gridDates ? expected.gridDates[0] : null, actualFirst: snapshot.cellDates[0] ?? null }
    }
  }
  if (snapshot.agendaDate !== expected.selectedDate) {
    return { pass: false, reason: 'AGENDA_DATE_MISMATCH', detail: { agendaDate: snapshot.agendaDate, expected: expected.selectedDate } }
  }
  const rowsOk = expected.expectedAgendaRows > 0
    ? snapshot.agendaRowCount === expected.expectedAgendaRows
    : snapshot.agendaEmptyNote
  if (!rowsOk) {
    return { pass: false, reason: 'AGENDA_ROWS_MISMATCH', detail: { rows: snapshot.agendaRowCount, expected: expected.expectedAgendaRows, emptyNote: snapshot.agendaEmptyNote } }
  }
  if (expected.expectedEventChips != null && snapshot.eventChipCount !== expected.expectedEventChips) {
    return { pass: false, reason: 'EVENT_CHIPS_MISMATCH', detail: { chips: snapshot.eventChipCount, expected: expected.expectedEventChips } }
  }
  return { pass: true, reason: 'OK', detail: { rows: snapshot.agendaRowCount, chips: snapshot.eventChipCount } }
}

function loopback(url) {
  if (new URL(url).hostname !== '127.0.0.1') throw new Error(`只允许 loopback CDP 地址：${url}`)
  return url
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data))
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('CDP 已关闭')) }
      this.pending.clear()
    })
  }
  static async open(url) {
    const socket = new WebSocket(loopback(url))
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('CDP 连接超时')) }, 5_000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')) }, { once: true })
    })
    return new Cdp(socket)
  }
  send(method, params = {}, timeoutMs = 15_000) {
    const id = ++this.nextId
    return new Promise((resolveMessage, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} 超时`)) }, timeoutMs)
      this.pending.set(id, { resolve: resolveMessage, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression, timeoutMs = 30_000) {
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails))
    return response.result.value
  }
  close() { this.socket.close() }
}

async function until(body, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try { const value = await body(); if (value) return value } catch (error) { lastError = error }
    await sleep(50)
  }
  throw new Error(`${label} 超时${lastError ? `：${lastError.message}` : ''}`)
}

async function buildFixtureRuntime(output) {
  // 使用项目已有 esbuild 打包纯数据库/检索模块,不导入 Electron 启动入口。
  const { build } = await import('esbuild')
  const result = await build({
    stdin: { contents: `export { openDatabase } from './src/main/db/connection'; export { initSchema } from './src/main/db/dao'; export { searchDocuments } from './src/main/retrieval/search'; export { tokenizeForSearch } from './src/main/retrieval/tokenize';`, resolveDir: root, sourcefile: 'electron-perf-fixture.ts' },
    bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent'
  })
  const path = join(dirname(output), 'electron-perf-runtime.cjs')
  writeFileSync(path, result.outputFiles[0].contents)
  return path
}

// ---------- 合成种子:均匀(uniform)/单日集中(concentrated)两类固定分布 ----------
// 固定种子语义:同一锚定日(运行当日)下数据完全可复现;日程分布只改变 events 的日期铺法,
// 待办截止日在两类分布下保持同一方案(±10 天循环),待办页负载由条数决定,与日程分布无关。

const pad2 = n => String(n).padStart(2, '0')
function toDateStrLocal(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }
function addDaysStr(dateStr, days) { const d = new Date(`${dateStr}T00:00`); d.setDate(d.getDate() + days); return toDateStrLocal(d) }
function addMinutesStr(dateStr, minutes) { const d = new Date(dateStr); d.setMinutes(d.getMinutes() + minutes); return `${toDateStrLocal(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}` }

// 与 CalendarPage 的 cells useMemo 相同的 6x7 月网格(周一起头),保证期望网格与页面逐格一致。
function monthGridCells(dateStr) {
  const y = Number(dateStr.slice(0, 4))
  const m = Number(dateStr.slice(5, 7))
  const first = new Date(y, m - 1, 1)
  const lead = first.getDay() === 0 ? 6 : first.getDay() - 1
  const start = new Date(y, m - 1, 1 - lead)
  const out = []
  for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); out.push(toDateStrLocal(d)) }
  return out
}

function nextMonthFirst(dateStr) {
  const y = Number(dateStr.slice(0, 4))
  const m = Number(dateStr.slice(5, 7))
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad2(m + 1)}-01`
}

function distributionSchemes(size, distribution) {
  const today = toDateStrLocal(new Date())
  const anchorGrid = monthGridCells(today)
  const nextGrid = monthGridCells(nextMonthFirst(today))
  const startAtOf = i => {
    if (distribution === 'uniform') {
      // 均匀:日程铺满当前月 42 格网格(含跨月引子日),08:00-18:00 循环
      return `${anchorGrid[i % 42]}T${pad2(8 + (i % 11))}:${pad2(i % 60)}`
    }
    // 单日集中:全部日程压在锚定日(今天,即页面默认选中日),08:00-19:59 循环
    return `${today}T${pad2(8 + (i % 12))}:${pad2((i * 7) % 60)}`
  }
  const dueAtOf = i => `${addDaysStr(today, (i % 21) - 10)}T${['08:00', '12:00', '18:00'][i % 3]}`
  return { today, anchorGrid, nextGrid, startAtOf, dueAtOf }
}

function pageSeedFor(size, distribution) {
  const schemes = distributionSchemes(size, distribution)
  const eventsOnDay = new Map()
  const todosDueOn = new Map()
  for (let i = 0; i < size; i++) {
    const eventDay = schemes.startAtOf(i).slice(0, 10)
    eventsOnDay.set(eventDay, (eventsOnDay.get(eventDay) ?? 0) + 1)
    const todoDay = schemes.dueAtOf(i).slice(0, 10)
    todosDueOn.set(todoDay, (todosDueOn.get(todoDay) ?? 0) + 1)
  }
  const agendaRowsOn = day => (eventsOnDay.get(day) ?? 0) + (todosDueOn.get(day) ?? 0)
  const chipsIn = grid => grid.reduce((sum, day) => sum + Math.min(3, eventsOnDay.get(day) ?? 0), 0)
  const lightDay = addDaysStr(schemes.today, 1)
  return {
    anchorDate: schemes.today,
    anchorGridDates: schemes.anchorGrid,
    nextGridDates: schemes.nextGrid,
    dayTargets: { heavy: schemes.today, light: lightDay },
    agendaByDay: {
      [schemes.today]: agendaRowsOn(schemes.today),
      [lightDay]: agendaRowsOn(lightDay),
      [addDaysStr(schemes.today, -1)]: agendaRowsOn(addDaysStr(schemes.today, -1))
    },
    chips: { anchor: chipsIn(schemes.anchorGrid), next: chipsIn(schemes.nextGrid) },
    todoIds: Array.from({ length: size }, (_, i) => `perf-todo-${i}`),
    todoCount: size,
    eventCount: size,
    distribution
  }
}

async function seed(runtime, userData, size, distribution) {
  mkdirSync(userData, { recursive: true })
  const dbPath = join(userData, 'data.sqlite')
  const { db, raw } = await runtime.openDatabase(dbPath, join(root, 'node_modules/sql.js/dist'))
  runtime.initSchema(db)
  // 全新空库直接填充,启动时跳过内置演示种子;不执行任何用户库清理。
  raw.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('agent:demo-seed-version','1')")
  const schemes = distributionSchemes(size, distribution)
  const event = raw.prepare('INSERT INTO events (id,title,start_at,end_at,all_day,source,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
  const todo = raw.prepare('INSERT INTO todos (id,title,notes,due_at,priority,linked_event_id,source,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
  const document = raw.prepare('INSERT INTO retrieval_documents (document_id,source_name,source_type,raw_sha256,text_sha256,normalized_text,size_bytes,created_at) VALUES (?,?,?,?,?,?,?,?)')
  const chunk = raw.prepare('INSERT INTO retrieval_chunks (chunk_id,document_id,chunk_index,start_offset,end_offset,content,search_text,search_version) VALUES (?,?,?,?,?,?,?,?)')
  raw.run('BEGIN')
  try {
    for (let i = 0; i < size; i++) {
      const startAt = schemes.startAtOf(i)
      event.run([`perf-event-${i}`, `合成日程 ${i}`, startAt, addMinutesStr(startAt, 30), 0, 'manual', 1, NOW, NOW])
      todo.run([`perf-todo-${i}`, `合成待办 ${i}`, `固定负载 ${i}`, schemes.dueAtOf(i), ['low', 'normal', 'high'][i % 3], i % 5 === 0 ? `perf-event-${i}` : null, 'manual', 1, NOW, NOW])
    }
    const chunksPerDocument = size === 1_000 ? 12 : 50
    for (let d = 0; d < 200; d++) {
      const content = `meeting common budget token${d % 20} rare${d}`
      const text = Array.from({ length: chunksPerDocument }, () => content).join('\n')
      const hash = createHash('sha256').update(text).digest('hex')
      document.run([`perf-doc-${String(d).padStart(3, '0')}`, `合成文档 ${d}.txt`, 'txt', hash, hash, text, Buffer.byteLength(text), NOW])
      for (let c = 0; c < chunksPerDocument; c++) {
        const start = c * (content.length + 1)
        chunk.run([`perf-chunk-${d}-${c}`, `perf-doc-${String(d).padStart(3, '0')}`, c, start, start + content.length, content, runtime.tokenizeForSearch(content).join(' '), 1])
      }
    }
    raw.run("INSERT INTO retrieval_fts(retrieval_fts) VALUES('rebuild')")
    raw.run('COMMIT')
  } catch (error) { raw.run('ROLLBACK'); throw error }
  finally { event.free(); todo.free(); document.free(); chunk.free() }
  db.flush()
  const counts = Object.fromEntries(['todos', 'events', 'retrieval_documents', 'retrieval_chunks', 'providers', 'mail_accounts'].map(table => [table, db.get(`SELECT COUNT(*) AS n FROM ${table}`).n]))
  db.close()
  return {
    name: `records-${size}-${distribution}`,
    size,
    distribution,
    counts,
    dbPath,
    sha256: createHash('sha256').update(readFileSync(dbPath)).digest('hex'),
    bytes: statSync(dbPath).size,
    anchor: { today: schemes.today, gridStart: schemes.anchorGrid[0], gridEnd: schemes.anchorGrid[41] },
    pageSeed: pageSeedFor(size, distribution)
  }
}

// ---------- IPC 口径测量(保留原计数节点口径,renderReadyMs 不冒充页面测量) ----------

function rendererMeasure(config) {
  // 注意:本函数整体经 toString() 序列化后在页面内执行,只能依赖入参与页面全局,
  // 不得引用模块级标识符。
  const agendaRowCount = a => a.courses.length + a.events.length + a.todos.length + a.schoolEvents.length
  const makeIpcCheck = expected => {
    if (expected.kind === 'agenda') {
      return rows => {
        if (!rows || typeof rows !== 'object' || rows.date !== expected.date) return '日详情返回不符'
        const n = agendaRowCount(rows)
        return n === expected.rows ? null : `日详情行数不符：${n}/${expected.rows}`
      }
    }
    return rows => (Array.isArray(rows) && rows.length === expected.count ? null : `记录数不符：${rows?.length}/${expected.count}`)
  }
  return (async () => {
    const eventLoopSamples = []
    const longTasks = []
    let last = performance.now()
    const interval = setInterval(() => {
      const now = performance.now()
      eventLoopSamples.push({ atMs: now, durationMs: Math.max(0, now - last - 10), error: null })
      last = now
    }, 10)
    const supportsLongTasks = PerformanceObserver.supportedEntryTypes.includes('longtask')
    const observer = supportsLongTasks ? new PerformanceObserver(list => {
      for (const entry of list.getEntries()) longTasks.push({ startTimeMs: entry.startTime, durationMs: entry.duration })
    }) : null
    observer?.observe({ type: 'longtask', buffered: true })
    const countNode = document.createElement('output')
    countNode.style.cssText = 'position:fixed;bottom:0;right:0;z-index:99999;font-size:10px'
    document.body.append(countNode)
    const calls = {
      todo: () => window.api.listTodos(),
      calendar: () => window.api.listEvents(config.calendarFrom, config.calendarTo),
      dayAgenda: () => window.api.getDayAgenda(config.anchorDate)
    }
    const expecteds = {
      todo: { kind: 'array', count: config.expectedRows },
      calendar: { kind: 'array', count: config.expectedEvents },
      dayAgenda: { kind: 'agenda', date: config.anchorDate, rows: config.expectedAgendaRows }
    }
    const measurements = {}
    async function once(name, call, expected, phase, index) {
      const start = performance.now()
      const check = makeIpcCheck(expected)
      let timer
      try {
        const rows = await Promise.race([call(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('IPC timeout')), config.queryLimitMs) })])
        const problem = check(rows)
        if (problem) throw new Error(problem)
        const durationMs = performance.now() - start
        countNode.textContent = `${name}: ${expected.kind === 'agenda' ? agendaRowCount(rows) : rows.length}`
        await new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint)))
        return { index, phase, durationMs, renderReadyMs: performance.now() - start, rows: expected.kind === 'agenda' ? agendaRowCount(rows) : rows.length, error: null }
      } catch (error) {
        return { index, phase, durationMs: performance.now() - start, rows: null, error: error.message }
      } finally { clearTimeout(timer) }
    }
    try {
      for (const name of config.targets) {
        const call = calls[name]
        const expected = expecteds[name]
        const cold = await once(name, call, expected, 'cold', 0)
        const warmup = []
        for (let i = 0; i < config.warmup; i++) warmup.push(await once(name, call, expected, 'warmup', i))
        const samples = []
        for (let i = 0; i < config.iterations; i++) samples.push(await once(name, call, expected, 'warm', i))
        measurements[name] = { cold, warmup, samples }
      }
      await new Promise(resolveTail => setTimeout(resolveTail, 30))
      return { measurements, eventLoopSamples, longTasks, supportsLongTasks, environment: { userAgent: navigator.userAgent, url: location.href, timeOrigin: performance.timeOrigin, devicePixelRatio, visibilityState: document.visibilityState } }
    } finally { clearInterval(interval); observer?.disconnect(); countNode.remove() }
  })()
}

function searchMeasure(config) {
  return (async () => {
    const runtime = globalThis.__perfRequire(config.runtimePath)
    const { db } = await runtime.openDatabase(config.dbPath, config.wasmDir)
    const originalAll = db.all.bind(db)
    let returnedRows = 0
    let maxBatchRows = 0
    db.all = (...args) => { const rows = originalAll(...args); returnedRows += rows.length; maxBatchRows = Math.max(maxBatchRows, rows.length); return rows }
    const queries = Array.from({ length: 100 }, (_, i) => ({
      index: i,
      kind: ['frequent', 'rare', 'no-hit', 'frozen'][i % 4],
      query: i % 4 === 0 ? 'common meeting' : i % 4 === 1 ? `rare${i}` : i % 4 === 2 ? `absent${i}` : 'common',
      frozenSnapshotIds: i % 4 === 3 ? Array.from({ length: 20 }, (_, d) => `perf-doc-${String(d).padStart(3, '0')}`) : null
    }))
    const once = (query, phase) => {
      const start = performance.now()
      returnedRows = 0; maxBatchRows = 0
      try {
        const rows = runtime.searchDocuments(db, query.query, 8, query.frozenSnapshotIds ? { frozenSnapshotIds: query.frozenSnapshotIds } : undefined)
        return { ...query, phase, durationMs: performance.now() - start, rows: rows.length, dbReturnedRows: returnedRows, maxBatchRows, memory: process.memoryUsage(), error: null }
      } catch (error) { return { ...query, phase, durationMs: performance.now() - start, error: error.message } }
    }
    try {
      const cold = once(queries[0], 'cold')
      const warmup = queries.slice(0, 5).map(query => once(query, 'warmup'))
      const samples = queries.map(query => once(query, 'warm'))
      return { cold, warmup, samples, measurementOrigin: 'Electron main; source searchDocuments on an isolated second connection; renderer search IPC is NOT_RUN' }
    } finally { db.close() }
  })()
}

// ---------- PERF-01:生产页面场景(页面就绪 + 交互 + longtask + 帧间隔 + 内存往返) ----------

// 注入页面场景 IIFE 的共用完成条件源码(与 Node 单测共用同一实现)。
const pageHelperSources = () => [waitForDomReady, visibilityLimitation, collectTodosSnapshot, verifyTodosCompletion, collectCalendarSnapshot, verifyCalendarCompletion].map(fn => fn.toString()).join('\n')

function pageScenarioMeasure(config) {
  return (async () => {
    // 本函数经 toString() 序列化后在页面执行,只能依赖入参与页面全局,不得引用模块级标识符。
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
    const startedAt = performance.now()
    const softDeadline = startedAt + config.softBudgetMs
    const samples = []
    const segmentsResult = []
    const longTasks = []
    const frameIntervals = []
    const supportsLongTasks = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')
    const observer = supportsLongTasks ? new PerformanceObserver(list => {
      for (const entry of list.getEntries()) longTasks.push({ startTimeMs: Math.round(entry.startTime), durationMs: Math.round(entry.duration) })
    }) : null
    observer?.observe({ type: 'longtask', buffered: true })
    let lastFrameAt = performance.now()
    let framesRunning = true
    const frameLoop = () => {
      if (!framesRunning) return
      const now = performance.now()
      if (frameIntervals.length < 30_000) frameIntervals.push({ atMs: Math.round(now), intervalMs: Math.round((now - lastFrameAt) * 1000) / 1000 })
      lastFrameAt = now
      requestAnimationFrame(frameLoop)
    }
    requestAnimationFrame(frameLoop)
    const visibility = () => visibilityLimitation(document.visibilityState)
    const navClick = key => {
      const node = document.querySelector(`[data-nav="${key}"]`)
      if (!node) throw new Error(`NAV_MISSING:${key}`)
      node.click()
    }
    const pageRoot = page => document.querySelector(`[data-page="${page}"]`)
    const todoRow = () => document.querySelector(`[data-record-id="${config.todoTarget}"]`)
    const modal = () => document.querySelector('.modal')
    const todosReady = () => verifyTodosCompletion(collectTodosSnapshot(document), config.expected.todos).pass
    const calendarReady = expected => verifyCalendarCompletion(collectCalendarSnapshot(document), expected).pass
    const anchorCalendarExpected = () => ({
      gridDates: config.expected.calendar.anchorGridDates,
      selectedDate: config.expected.calendar.anchorDate,
      expectedAgendaRows: config.expected.calendar.agendaByDay[config.expected.calendar.anchorDate] ?? 0,
      expectedEventChips: config.expected.calendar.chips.anchor
    })
    const monthButton = label => {
      const button = [...document.querySelectorAll('[data-page="calendar"] button')].find(b => b.textContent.trim() === label)
      if (!button) throw new Error(`MONTH_BUTTON_MISSING:${label}`)
      return button
    }
    const states = { switchDay: { heavy: true }, scroll: { down: true }, completeTodo: { done: null } }

    async function ensureOnPage(page) {
      if (pageRoot(page)) return
      navClick(page)
      await waitForDomReady(page === 'todos' ? todosReady : () => calendarReady(anchorCalendarExpected()), config.limits.pageReadyMs)
    }
    async function ensureLeftPage(page) {
      if (!pageRoot(page)) return
      navClick(config.homeNav)
      await waitForDomReady(() => !pageRoot(page), config.limits.interactionMs)
    }
    async function ensureAnchorMonth() {
      const snapshot = collectCalendarSnapshot(document)
      if (snapshot.cellDates.join('|') === config.expected.calendar.anchorGridDates.join('|')) return
      // 切月不改 selected:保持当前选中日与对应明细期望,只要求网格回到锚定月。
      const selected = snapshot.agendaDate
      monthButton('←').click()
      await waitForDomReady(() => calendarReady({
        gridDates: config.expected.calendar.anchorGridDates,
        selectedDate: selected,
        expectedAgendaRows: config.expected.calendar.agendaByDay[selected] ?? 0,
        expectedEventChips: config.expected.calendar.chips.anchor
      }), config.limits.heavyMs)
    }
    async function ensureModalOpen() {
      if (modal()) return
      const row = todoRow()
      if (!row) throw new Error('TODO_ROW_MISSING')
      const title = row.querySelector('.title')
      if (!title) throw new Error('TODO_TITLE_MISSING')
      title.click()
      await waitForDomReady(() => modal() != null, config.limits.interactionMs)
    }
    async function ensureModalClosed() {
      if (!modal()) return
      const button = [...modal().querySelectorAll('button')].find(b => b.textContent.trim() === '取消')
      if (!button) throw new Error('CANCEL_BUTTON_MISSING')
      button.click()
      await waitForDomReady(() => modal() == null, config.limits.interactionMs)
    }

    async function pageReadyIteration(page) {
      await ensureLeftPage(page)
      const t0 = performance.now()
      navClick(page)
      await waitForDomReady(page === 'todos' ? todosReady : () => calendarReady(anchorCalendarExpected()), config.limits.pageReadyMs)
      return Math.round((performance.now() - t0) * 1000) / 1000
    }
    // 切换待办页:从日历页出发(先等日历就绪,统一计时起点),计时只覆盖待办页到达。
    async function switchToTodosIteration() {
      await ensureLeftPage('todos')
      await ensureOnPage('calendar')
      const t0 = performance.now()
      navClick('todos')
      await waitForDomReady(todosReady, config.limits.pageReadyMs)
      return Math.round((performance.now() - t0) * 1000) / 1000
    }
    async function editorOpenIteration() {
      await ensureOnPage('todos')
      await ensureModalClosed()
      const t0 = performance.now()
      const title = todoRow().querySelector('.title')
      if (!title) throw new Error('TODO_TITLE_MISSING')
      title.click()
      await waitForDomReady(() => modal() != null, config.limits.interactionMs)
      return Math.round((performance.now() - t0) * 1000) / 1000
    }
    async function editorCancelIteration() {
      await ensureOnPage('todos')
      await ensureModalOpen()
      const t0 = performance.now()
      const button = [...modal().querySelectorAll('button')].find(b => b.textContent.trim() === '取消')
      if (!button) throw new Error('CANCEL_BUTTON_MISSING')
      button.click()
      await waitForDomReady(() => modal() == null, config.limits.interactionMs)
      return Math.round((performance.now() - t0) * 1000) / 1000
    }
    // 完成一条待办并核对落库后的显示:行 class 与 checkbox 状态都翻转到期望值
    // (列表在 updateTodo 落库 + listTodos 重拉之后才重渲染,条件成立即落库显示已核对)。
    async function completeTodoIteration() {
      await ensureOnPage('todos')
      const row = todoRow()
      if (!row) throw new Error('TODO_ROW_MISSING')
      const checkbox = row.querySelector('input[type="checkbox"]')
      if (!checkbox) throw new Error('TODO_CHECKBOX_MISSING')
      if (states.completeTodo.done == null) states.completeTodo.done = row.classList.contains('done')
      const expectedDone = !states.completeTodo.done
      const t0 = performance.now()
      checkbox.click()
      await waitForDomReady(() => {
        const current = todoRow()
        return current != null && current.classList.contains('done') === expectedDone && current.querySelector('input[type="checkbox"]')?.checked === expectedDone
      }, config.limits.heavyMs)
      states.completeTodo.done = expectedDone
      return Math.round((performance.now() - t0) * 1000) / 1000
    }
    async function switchDayIteration() {
      await ensureOnPage('calendar')
      await ensureAnchorMonth()
      const target = states.switchDay.heavy ? config.expected.calendar.dayTargets.heavy : config.expected.calendar.dayTargets.light
      states.switchDay.heavy = !states.switchDay.heavy
      const cell = document.querySelector(`[data-date="${target}"]`)
      if (!cell) throw new Error(`DAY_CELL_MISSING:${target}`)
      const t0 = performance.now()
      cell.click()
      await waitForDomReady(() => calendarReady({
        gridDates: config.expected.calendar.anchorGridDates,
        selectedDate: target,
        expectedAgendaRows: config.expected.calendar.agendaByDay[target] ?? 0,
        expectedEventChips: config.expected.calendar.chips.anchor
      }), config.limits.heavyMs)
      return Math.round((performance.now() - t0) * 1000) / 1000
    }
    // 切月:在锚定月与下月之间往返;轻(空月)与重(锚定月重载)都按实际网格与 chips 核对,
    // 不以轻负载替换集中负载。切月不改 selected,选中日以当前 DOM 为准(switchDay 可能已切走)。
    async function switchMonthIteration() {
      await ensureOnPage('calendar')
      const snapshot = collectCalendarSnapshot(document)
      const selected = snapshot.agendaDate
      const expectedAgendaRows = config.expected.calendar.agendaByDay[selected] ?? 0
      const onAnchor = snapshot.cellDates.join('|') === config.expected.calendar.anchorGridDates.join('|')
      const targetGrid = onAnchor ? config.expected.calendar.nextGridDates : config.expected.calendar.anchorGridDates
      const expectedChips = onAnchor ? config.expected.calendar.chips.next : config.expected.calendar.chips.anchor
      const t0 = performance.now()
      monthButton(onAnchor ? '→' : '←').click()
      await waitForDomReady(() => calendarReady({
        gridDates: targetGrid,
        selectedDate: selected,
        expectedAgendaRows: expectedAgendaRows,
        expectedEventChips: expectedChips
      }), config.limits.heavyMs)
      return Math.round((performance.now() - t0) * 1000) / 1000
    }
    async function scrollIteration() {
      await ensureOnPage('todos')
      let node = todoRow()
      let container = null
      while (node && node !== document.body) {
        const style = getComputedStyle(node)
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) { container = node; break }
        node = node.parentElement
      }
      if (!container) {
        const doc = document.scrollingElement
        if (doc && doc.scrollHeight > doc.clientHeight + 1) container = doc
      }
      if (!container) return { durationMs: null, error: 'NO_SCROLLABLE_OVERFLOW', environmentLimited: true }
      const down = states.scroll.down
      states.scroll.down = !down
      // 最大可滚动位置是 scrollHeight - clientHeight;直接用 scrollHeight 会永远差一个视口高度。
      const to = down ? container.scrollHeight - container.clientHeight : 0
      const distancePx = Math.abs(to - container.scrollTop)
      const t0 = performance.now()
      container.scrollTop = to
      await waitForDomReady(() => Math.abs(container.scrollTop - to) <= 2, config.limits.interactionMs)
      return { durationMs: Math.round((performance.now() - t0) * 1000) / 1000, distancePx }
    }
    // 内存往返:第 0 次为初始到达采样,其后每次=离开→返回→采样(原始观测,不做泄漏判定)。
    async function memoryIteration(page, index) {
      let arriveMs = null
      if (index === 0) {
        await ensureOnPage(page)
      } else {
        await ensureLeftPage(page)
        const t0 = performance.now()
        navClick(page)
        await waitForDomReady(page === 'todos' ? todosReady : () => calendarReady(anchorCalendarExpected()), config.limits.pageReadyMs)
        arriveMs = Math.round((performance.now() - t0) * 1000) / 1000
      }
      const memory = performance.memory
      return { roundTrip: index, arriveMs, usedJSHeapSize: memory ? memory.usedJSHeapSize : null, totalJSHeapSize: memory ? memory.totalJSHeapSize : null }
    }

    async function runIteration(seg, index) {
      const iterStart = performance.now()
      const phase = index < config.warmup ? 'warmup' : 'warm'
      const warmIndex = Math.max(0, index - config.warmup)
      const base = { page: seg.page, stream: seg.stream, index, phase, warmIndex }
      const limited = visibility()
      if (limited.limited) return { ...base, durationMs: null, wallMs: 0, error: limited.reason, environmentLimited: true }
      let result
      if (seg.stream === 'memory') {
        const extra = await memoryIteration(seg.page, index)
        result = { ...base, ...extra, isMemory: true, wallMs: Math.round(performance.now() - iterStart) }
      } else {
        let durationMs
        let extra = {}
        if (seg.stream === 'pageReady') durationMs = await pageReadyIteration(seg.page)
        else if (seg.stream === 'switchToTodos') durationMs = await switchToTodosIteration()
        else if (seg.stream === 'editorOpen') durationMs = await editorOpenIteration()
        else if (seg.stream === 'editorCancel') durationMs = await editorCancelIteration()
        else if (seg.stream === 'completeTodo') durationMs = await completeTodoIteration()
        else if (seg.stream === 'switchDay') durationMs = await switchDayIteration()
        else if (seg.stream === 'switchMonth') durationMs = await switchMonthIteration()
        else if (seg.stream === 'scroll') extra = await scrollIteration()
        else throw new Error(`UNKNOWN_STREAM:${seg.stream}`)
        if (extra.durationMs === undefined) extra = { ...extra, durationMs }
        // wallMs = 迭代全程墙钟(含未计时的 ensure* 准备),供分块规划与失败诊断。
        result = { ...base, ...extra, wallMs: Math.round(performance.now() - iterStart) }
      }
      return result
    }

    for (const seg of config.segments) {
      // 软预算已过且本块已有产出时,跳过剩余段(只保证每块首段至少一次迭代,避免 evaluate 超时整块丢失)。
      if (samples.length > 0 && performance.now() > softDeadline) {
        segmentsResult.push({ page: seg.page, stream: seg.stream, from: seg.from, to: seg.from, interrupted: true, samples: [], wallMs: 0, iterations: 0 })
        continue
      }
      const segStart = performance.now()
      const segSamples = []
      let index = seg.from
      for (; index < seg.to; index++) {
        // 心跳:供控制器在 evaluate 超时后判断页面主线程与循环位置。
        window.__perfChunkHeartbeat = { stream: seg.stream, page: seg.page, index, samples: samples.length, atMs: Math.round(performance.now()) }
        // 竞速:每次迭代与剩余软预算赛跑,到点即弃(不记样本、不推进指针,由后续块重做),
        // 保证 chunk 恒在软预算内返回——单次迭代再慢(如 10k 日历挂载 6-12s)也不会拖爆 evaluate。
        const remainingMs = softDeadline - performance.now()
        const base = {
          page: seg.page, stream: seg.stream, index,
          phase: index < config.warmup ? 'warmup' : 'warm',
          warmIndex: Math.max(0, index - config.warmup)
        }
        const outcome = await Promise.race([
          runIteration(seg, index).then(
            value => ({ kind: 'done', value }),
            error => ({ kind: 'error', error })
          ),
          delay(Math.max(0, remainingMs)).then(() => ({ kind: 'budget' }))
        ])
        if (outcome.kind === 'budget') break
        let sample
        if (outcome.kind === 'error') {
          sample = { ...base, durationMs: null, wallMs: null, error: String(outcome.error && outcome.error.message ? outcome.error.message : outcome.error).slice(0, 300) }
        } else {
          sample = outcome.value
        }
        samples.push(sample)
        segSamples.push(sample)
      }
      segmentsResult.push({
        page: seg.page, stream: seg.stream, from: seg.from, to: index,
        interrupted: index < seg.to, samples: segSamples,
        wallMs: Math.round(performance.now() - segStart),
        iterations: index - seg.from
      })
    }
    framesRunning = false
    observer?.disconnect()
    return {
      samples,
      segments: segmentsResult,
      longTasks,
      frameIntervals,
      visibility: { state: document.visibilityState, ...visibility() },
      environment: { userAgent: navigator.userAgent, url: location.href, timeOrigin: performance.timeOrigin, devicePixelRatio, visibilityState: document.visibilityState, hardwareConcurrency: navigator.hardwareConcurrency },
      supportsLongTasks,
      chunkWallMs: Math.round(performance.now() - startedAt)
    }
  })()
}

function pageChunkConfig(dataset, segments) {
  const s = dataset.pageSeed
  return {
    warmup: WARMUP,
    softBudgetMs: SOFT_CHUNK_BUDGET_MS,
    homeNav: 'overview',
    todoTarget: 'perf-todo-0',
    limits: { pageReadyMs: PAGE_READY_LIMIT_MS, interactionMs: INTERACTION_LIMIT_MS, heavyMs: HEAVY_INTERACTION_LIMIT_MS },
    segments,
    expected: {
      todos: { expectedIds: s.todoIds },
      calendar: {
        anchorDate: s.anchorDate,
        anchorGridDates: s.anchorGridDates,
        nextGridDates: s.nextGridDates,
        dayTargets: s.dayTargets,
        agendaByDay: s.agendaByDay,
        chips: s.chips
      }
    }
  }
}

// ---------- 通用 Electron 场景子进程(spawn → CDP → 断网 → 资源采样 → 正常收尾) ----------

const NETWORK_BLOCK_SNIPPET = `(() => {
  globalThis.__perfRequire = process.getBuiltinModule('module').createRequire(${JSON.stringify(join(root, 'package.json'))});
  globalThis.__perfBlockedNetwork = [];
  const deny = () => { globalThis.__perfBlockedNetwork.push({ at: Date.now() }); throw new Error('OFFLINE_PERF_NETWORK_BLOCKED'); };
  globalThis.fetch = deny;
  for (const module of ['http','https']) { const value = globalThis.__perfRequire(module); value.request = deny; value.get = deny; }
  const tcp = globalThis.__perfRequire('net'); tcp.connect = deny; tcp.createConnection = deny;
  const electron = globalThis.__perfRequire('electron'); electron.net.request = deny;
  electron.app.whenReady().then(() => electron.session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    const local = /^(file:|devtools:|chrome-devtools:|data:|blob:)/.test(details.url);
    if (!local) globalThis.__perfBlockedNetwork.push({ at: Date.now(), url: details.url });
    done({ cancel: !local });
  }));
  return process.versions;
})()`

async function runScenario({ name, userData, logs, run }) {
  const electron = require('electron')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const args = ['.', '--user-data', userData, '--inspect-brk=127.0.0.1:0', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND', '--disable-component-update', '--disable-sync']
  const child = spawn(electron, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let mainEndpoint
  let browserPort
  let killed = false
  let mainCdp
  let rendererCdp
  const closed = new Promise(resolveClose => child.once('close', (exitCode, signal) => resolveClose({ exitCode, signal })))
  child.on('error', error => { stderr += `${error.stack}\n` })
  child.stdout.on('data', data => { stdout += data.toString('utf8') })
  child.stderr.on('data', data => {
    stderr += data.toString('utf8')
    mainEndpoint = stderr.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1]
    browserPort = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1]
  })
  const timer = setTimeout(() => {
    killed = true
    if (platform() === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 })
    else child.kill('SIGKILL')
  }, CHILD_LIMIT_MS)
  let resourceInterval
  let resourceTask
  const resourceSamples = []
  try {
    await until(() => mainEndpoint, 10_000, 'Node inspector')
    mainCdp = await Cdp.open(mainEndpoint)
    await mainCdp.send('Runtime.enable')
    // Electron 的 Node 内部模块须完成 bootstrap 后才能 require;合成库无 provider/账号。
    await mainCdp.send('Runtime.runIfWaitingForDebugger')
    await sleep(200)
    // 初始化后阻断业务网络,Chromium 会话只接受本地资源。
    await mainCdp.evaluate(NETWORK_BLOCK_SNIPPET)
    await until(() => browserPort, 10_000, 'Chromium inspector')
    const target = await until(async () => {
      const targets = await fetch(loopback(`http://127.0.0.1:${browserPort}/json/list`), { signal: AbortSignal.timeout(2_000) }).then(response => response.json())
      return targets.find(target => target.type === 'page' && target.url.includes('/workbench.html'))
    }, 10_000, '工作台窗口')
    rendererCdp = await Cdp.open(target.webSocketDebuggerUrl)
    await until(() => rendererCdp.evaluate('document.readyState === "complete" && typeof window.api?.listTodos === "function" && document.getElementById("root")?.childElementCount > 0'), 10_000, 'renderer ready')
    // 后台节流关闭;若窗口仍不可见,场景内以 BACKGROUND_WINDOW 环境限制如实记账。
    await mainCdp.evaluate(`globalThis.__perfRequire('electron').BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/workbench.html')).webContents.setBackgroundThrottling(false)`)
    const snapshot = async () => {
      const main = await mainCdp.evaluate(`(async () => ({ at: Date.now(), main: process.memoryUsage(), processes: globalThis.__perfRequire('electron').app.getAppMetrics(), memory: await process.getProcessMemoryInfo() }))()`)
      const renderer = await rendererCdp.send('Runtime.getHeapUsage')
      resourceSamples.push({ ...main, renderer })
    }
    await snapshot()
    resourceInterval = setInterval(() => {
      if (!resourceTask) resourceTask = snapshot().catch(error => resourceSamples.push({ error: error.message })).finally(() => { resourceTask = null })
    }, 250)
    const result = await run(rendererCdp, mainCdp, resourceSamples)
    clearInterval(resourceInterval)
    if (resourceTask) await resourceTask
    await snapshot()
    // 使用正常 app.quit 收尾,强制终止只作为失败超时兜底并如实记录。
    await mainCdp.evaluate(`setTimeout(() => globalThis.__perfRequire('electron').app.quit(), 50); true`)
    mainCdp.close(); rendererCdp.close()
    const exit = await Promise.race([closed, sleep(5_000).then(() => { throw new Error('正常 app.quit 收尾超时') })])
    result.process = { ...exit, forced: killed, limitMs: CHILD_LIMIT_MS, pid: child.pid }
    if (exit.exitCode !== 0 || killed) throw new Error(`Electron 收尾异常：${JSON.stringify(result.process)}`)
    result.resources = resourceSamples
    return result
  } finally {
    clearInterval(resourceInterval)
    mainCdp?.close(); rendererCdp?.close()
    if (child.exitCode === null && child.signalCode === null) {
      killed = true
      if (platform() === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 })
      else child.kill('SIGKILL')
      await closed
    }
    clearTimeout(timer)
    logs.push({ name, userData, command: [electron, ...args], pid: child.pid, forced: killed, stdout, stderr })
  }
}

async function captureScreenshots(rendererCdp, dir, logs) {
  mkdirSync(dir, { recursive: true })
  const screenshots = []
  for (const [key, label] of [['overview', '今日概览'], ['agent', '事务 Agent'], ['research', '研究'], ['evals', '评测'], ['todos', '待办'], ['calendar', '日历']]) {
    await rendererCdp.evaluate(`(() => { const nav = document.querySelector('[data-nav="${key}"]'); if (!nav) throw new Error('导航缺失:${key}'); nav.click(); return true })()`)
    await rendererCdp.evaluate(`(function(){ ${pageHelperSources()}\n return waitForDomReady(() => document.querySelector('[data-nav="${key}"].active') != null, 5000).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))) })()`)
    const capture = await rendererCdp.send('Page.captureScreenshot', { format: 'png' })
    const file = join(dir, `${key}.png`)
    writeFileSync(file, Buffer.from(capture.data, 'base64'), { flag: 'wx' })
    screenshots.push({ file, label, sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), proof: '合成数据界面渲染;不证明模型交互或真人全流程' })
  }
  logs.push({ name: 'screenshots', dir, count: screenshots.length })
  return screenshots
}

// IPC 口径:单接口一个子进程(todo / calendar / dayAgenda),避免 10k 全量三接口叠加逼近 60 秒硬上限。
async function runIpcTarget(dataset, target, logs, runtimePath, screenshots) {
  const from = `${dataset.anchor.gridStart}T00:00`
  const to = `${dataset.anchor.gridEnd}T23:59`
  return runScenario({
    name: `ipc-${target}-${dataset.name}`,
    userData: dataset.userData,
    logs,
    run: async (rendererCdp, mainCdp) => {
      const renderer = await rendererCdp.evaluate(`(${rendererMeasure.toString()})(${JSON.stringify({
        targets: [target],
        expectedRows: dataset.counts.todos,
        expectedEvents: dataset.counts.events,
        expectedAgendaRows: dataset.pageSeed.agendaByDay[dataset.pageSeed.anchorDate] ?? 0,
        anchorDate: dataset.pageSeed.anchorDate,
        calendarFrom: from,
        calendarTo: to,
        warmup: WARMUP,
        iterations: ITERATIONS,
        queryLimitMs: QUERY_LIMIT_MS
      })})`, 55_000)
      const result = { renderer }
      if (target === 'todo') {
        result.localSearch = await mainCdp.evaluate(`(${searchMeasure.toString()})(${JSON.stringify({ runtimePath, dbPath: dataset.dbPath, wasmDir: join(root, 'node_modules/sql.js/dist') })})`)
        result.environment = await mainCdp.evaluate(`({versions:process.versions,blockedNetwork:globalThis.__perfBlockedNetwork})`)
      }
      if (target === 'todo' && screenshots) result.screenshots = await captureScreenshots(rendererCdp, screenshots, logs)
      return result
    }
  })
}

// ---------- 页面场景流(pageReady / 交互 / 内存往返)与分块控制器 ----------

function pageStreamsFor(dataset) {
  const streams = []
  // 待办种子在两类分布下一致,待办页只在 uniform 档测量一次(见 report.configuration 说明)。
  if (dataset.distribution === 'uniform') {
    streams.push(
      { page: 'todos', stream: 'pageReady' },
      { page: 'todos', stream: 'switchToTodos' },
      { page: 'todos', stream: 'editorOpen' },
      { page: 'todos', stream: 'editorCancel' },
      { page: 'todos', stream: 'completeTodo' },
      { page: 'todos', stream: 'scroll' }
    )
  }
  streams.push(
    { page: 'calendar', stream: 'pageReady' },
    { page: 'calendar', stream: 'switchDay' },
    { page: 'calendar', stream: 'switchMonth' }
  )
  // 内存往返:待办页负载与日程分布无关,两类数据档各测一次可作一致性对照。
  streams.push({ page: 'todos', stream: 'memory' })
  streams.push({ page: 'calendar', stream: 'memory' })
  // 内存流:第 0 次=初始到达 + 10 次往返;其余流 105 次(5 预热 + 100 暖态)。
  return streams.map(s => ({ ...s, total: s.stream === 'memory' ? MEMORY_ROUND_TRIPS + 1 : WARMUP + ITERATIONS, done: 0, samples: [], chunks: [] }))
}

// 易饱和流的每 chunk 迭代上限:切日/切月每次触发 32 个 IPC reload,连续高频迭代会让
// renderer 主线程任务流不间断(setTimeout/rAF 饿死,竞速与预算检查失效,evaluate 死锁)。
const STREAM_CHUNK_CAPS = { switchMonth: 8, switchDay: 10, memory: 4 }

function planSegments(streams, estimates) {
  const segments = []
  let budget = SOFT_CHUNK_BUDGET_MS
  for (const stream of streams) {
    if (stream.done >= stream.total) continue
    if (segments.length >= 4 || budget <= 0) break
    const per = estimates.get(`${stream.page}/${stream.stream}`) ?? 800
    const remaining = stream.total - stream.done
    const cap = STREAM_CHUNK_CAPS[stream.stream] ?? MAX_ITERS_PER_SEGMENT
    const count = Math.min(remaining, cap, Math.max(1, Math.floor(budget / per)))
    segments.push({ page: stream.page, stream: stream.stream, from: stream.done, to: stream.done + count })
    budget -= count * per
  }
  return segments
}

async function runPageScenarios(dataset, logs) {
  const streams = pageStreamsFor(dataset)
  const estimates = new Map()
  const telemetry = { longTasks: [], frameIntervals: [], frameIntervalsTruncated: false, memoryRoundTrips: [], resources: [], visibilityLimited: [], environment: [] }
  let chunkIndex = 0
  while (streams.some(s => s.done < s.total)) {
    if (chunkIndex >= MAX_CHUNKS) throw new Error(`页面场景分块超过上限 ${MAX_CHUNKS},存在无进展循环`)
    const segments = planSegments(streams, estimates)
    const label = `pages-${dataset.name}-chunk${chunkIndex}`
    console.log(`[electron-perf] ${label}: ${segments.map(s => `${s.page}/${s.stream}[${s.from}-${s.to})`).join(', ')}`)
    let chunk
    try {
      chunk = await runScenario({
        name: label,
        userData: dataset.userData,
        logs,
        run: async rendererCdp => {
          const source = `(function(){\n${pageHelperSources()}\nreturn (${pageScenarioMeasure.toString()})(${JSON.stringify(pageChunkConfig(dataset, segments))});\n})()`
          try {
            // 38s evaluate 上限:软预算 25s + 单次迭代余量,且低于子进程 60s 硬限减启动/收尾。
            return { chunk: await rendererCdp.evaluate(source, 38_000) }
          } catch (error) {
            // 超时诊断:抓取页面心跳,区分"主线程卡死"与"循环未返回"。
            let heartbeat = null
            try { heartbeat = await rendererCdp.evaluate('window.__perfChunkHeartbeat ?? null', 3_000) } catch (e) { heartbeat = { heartbeatError: String(e && e.message ? e.message : e).slice(0, 120) } }
            throw new Error(`${error.message} | heartbeat=${JSON.stringify(heartbeat)}`)
          }
        }
      })
    } catch (error) {
      // 子进程失败/超时:未产出样本的迭代不伪造为迭代级错误,流指针不动,由后续 chunk 重做;
      // 块失败记录在 stream.chunks 账目中;同段连续失败达 3 次才降级为错误样本(防死循环)。
      console.error(`[electron-perf] ${label} 失败:${error.message}`)
      for (const seg of segments) {
        const stream = streams.find(s => s.page === seg.page && s.stream === seg.stream)
        stream.failedAttempts = (stream.failedAttempts ?? 0) + 1
        stream.chunks.push({ chunkIndex, from: seg.from, to: seg.to, planned: seg.to - seg.from, error: error.message.slice(0, 300) })
        if (stream.failedAttempts >= 3) {
          for (let index = seg.from; index < seg.to; index++) {
            stream.samples.push({
              page: seg.page, stream: seg.stream, index,
              phase: index < WARMUP ? 'warmup' : 'warm',
              warmIndex: Math.max(0, index - WARMUP),
              durationMs: null,
              wallMs: null,
              error: `CHUNK_PROCESS_FAILED×${stream.failedAttempts}: ${error.message}`.slice(0, 300),
              chunkIndex
            })
          }
          stream.done = seg.to
        }
      }
      chunkIndex++
      continue
    }
    for (const segResult of chunk.chunk.segments) {
      const stream = streams.find(s => s.page === segResult.page && s.stream === segResult.stream)
      for (const sample of segResult.samples) stream.samples.push({ ...sample, chunkIndex })
      stream.done = Math.max(stream.done, segResult.to)
      stream.failedAttempts = 0
      stream.chunks.push({ chunkIndex, from: segResult.from, to: segResult.to, interrupted: segResult.interrupted })
      // 估时用每迭代墙钟(含 switchToTodos 等流未计时的准备挂载),否则规划会系统性低估;
      // 取最近一次分段墙钟而非累积最大值,避免个别离群块永久抬高规划。
      if (segResult.iterations > 0 && segResult.wallMs > 0) {
        estimates.set(`${segResult.page}/${segResult.stream}`, segResult.wallMs / segResult.iterations)
      }
    }
    telemetry.longTasks.push(...chunk.chunk.longTasks)
    for (const frame of chunk.chunk.frameIntervals) {
      if (telemetry.frameIntervals.length >= FRAME_TELEMETRY_CAP) { telemetry.frameIntervalsTruncated = true; break }
      telemetry.frameIntervals.push(frame)
    }
    telemetry.memoryRoundTrips.push(...chunk.chunk.samples.filter(s => s.stream === 'memory'))
    telemetry.resources.push(...(chunk.resources ?? []))
    telemetry.environment.push(chunk.chunk.environment)
    if (chunk.chunk.visibility.limited) telemetry.visibilityLimited.push({ chunkIndex, state: chunk.chunk.visibility.state })
    chunkIndex++
  }
  return { streams, telemetry }
}

// ---------- 统计与报告装配 ----------

// 大数组求最大值禁止 Math.max(...spread)(十几万元素会触发 RangeError: Maximum call stack size exceeded)。
const maxOf = arr => arr.reduce((acc, value) => (value > acc ? value : acc), 0)

function percentileOf(values, q) {
  if (!values.length) return null
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.ceil(q * ordered.length) - 1]
}

const FRAME_TELEMETRY_CAP = 300_000 // 跨块聚合的帧间隔原始样本上限(辅助观测,超出部分截断并标记)

function buildLongTaskStats(telemetry) {
  const entries = telemetry.longTasks.map(entry => ({ startTimeMs: entry.startTimeMs, durationMs: entry.durationMs }))
  const durations = entries.map(entry => entry.durationMs)
  const maxEntryMs = durations.length ? maxOf(durations) : 0
  const over100Count = durations.filter(ms => ms > 100).length
  return {
    entries: entries.slice(0, 5000),
    entriesTruncated: entries.length > 5000,
    count: entries.length,
    maxEntryMs,
    over100Count,
    interpretation: 'longtask 单条 duration 即连续主线程阻塞时长;任一单条 >100ms 判 FAIL',
    pass: over100Count === 0
  }
}

function buildFrameStats(telemetry) {
  const intervals = telemetry.frameIntervals.map(sample => sample.intervalMs).filter(ms => Number.isFinite(ms) && ms >= 0)
  return {
    count: intervals.length,
    p95Ms: percentileOf(intervals, 0.95),
    maxMs: intervals.length ? maxOf(intervals) : null,
    over100Count: intervals.filter(ms => ms > 100).length,
    over250Count: intervals.filter(ms => ms > 250).length,
    truncated: telemetry.frameIntervalsTruncated === true,
    note: '帧间隔为辅助观测,预算门禁以 longtask 连续阻塞为准'
  }
}

function buildResourceStats(telemetry, memoryRoundTripSamples) {
  const mainRss = telemetry.resources.filter(sample => sample.main).map(sample => sample.main.rss)
  const rendererHeap = telemetry.resources.filter(sample => sample.renderer).map(sample => sample.renderer.usedSize)
  return {
    cadenceMs: 250,
    cadenceSamples: telemetry.resources.length,
    mainRssPeakBytes: mainRss.length ? maxOf(mainRss) : null,
    rendererHeapPeakBytes: rendererHeap.length ? maxOf(rendererHeap) : null,
    // 10 次往返页面的内存原始观测:只记录,一次 GC 波动不判泄漏;同等负载持续增长才需要调查。
    memoryRoundTrips: memoryRoundTripSamples.map(sample => ({
      page: sample.page, roundTrip: sample.roundTrip, arriveMs: sample.arriveMs,
      usedJSHeapSize: sample.usedJSHeapSize, totalJSHeapSize: sample.totalJSHeapSize
    }))
  }
}

function buildInteractionStats(streams) {
  const names = ['switchToTodos', 'editorOpen', 'editorCancel', 'completeTodo', 'scroll', 'switchDay', 'switchMonth']
  const out = {}
  for (const name of names) {
    const relevant = streams.filter(s => s.stream === name)
    // 统计只取暖态样本;冷启动/预热样本原始保留在流数据中,不删除。
    const warmSamples = relevant.flatMap(s => s.samples).filter(sample => sample.phase === 'warm')
    out[name] = relevant.length
      ? summarizeSamples(warmSamples, INTERACTION_BUDGET_MS)
      : { status: 'NOT_RUN', reason: '该流未在当前数据档运行(待办流仅在 uniform 档测量)' }
  }
  return out
}

function buildPageReadyStats(streams, dataset, todosSkippedReason) {
  const out = {}
  for (const page of ['todos', 'calendar']) {
    const relevant = streams.filter(s => s.stream === 'pageReady' && s.page === page)
    // 统计只取暖态样本(预热 5 次后的 100 次暖态),预热样本原始保留。
    const warmSamples = relevant.flatMap(s => s.samples).filter(sample => sample.phase === 'warm')
    out[page] = relevant.length
      ? summarizeSamples(warmSamples, pageReadyBudgetMs(dataset.size))
      : { status: 'NOT_RUN', reason: todosSkippedReason }
  }
  return out
}

function summarizeStreamAccounting(streams) {
  return streams.map(s => ({
    page: s.page,
    stream: s.stream,
    total: s.total,
    sampled: s.samples.length,
    errors: s.samples.filter(x => x.error != null).length,
    chunks: s.chunks.length
  }))
}

// PERF-02 定位输入:用 IPC 口径 p95 估计每次挂载的 IPC 成本,与 pageReady 总耗时对比得出 DOM/IPC 谁占大头。
function derivePerf02(report) {
  const budgetFailures = []
  const bottlenecks = []
  for (const workload of report.workloads) {
    const budget = pageReadyBudgetMs(workload.dataset.size)
    const scenarios = workload.scenarios ?? {}
    const ipc = scenarios.ipcQuery && scenarios.ipcQuery.statistics
    for (const page of ['todos', 'calendar']) {
      const stat = (scenarios.pageReady ?? {})[page]
      if (!stat || stat.status === 'NOT_RUN' || stat.pass) continue
      budgetFailures.push({ workload: workload.dataset.name, section: `pageReady.${page}`, p95Ms: stat.p95Ms, budgetMs: budget })
      if (!ipc) continue
      if (page === 'todos') {
        const ipcEstimate = ipc.todo ? ipc.todo.p95Ms : null
        if (ipcEstimate != null) {
          const domEstimate = stat.p95Ms - ipcEstimate
          bottlenecks.push({
            workload: workload.dataset.name, section: `pageReady.${page}`,
            pageReadyP95Ms: stat.p95Ms, ipcEstimateMs: ipcEstimate, domEstimateMs: domEstimate,
            dominant: domEstimate > ipcEstimate ? 'DOM_RENDER(分页/虚拟化为 PERF-02 首选)' : 'IPC_DAO(查询处理为 PERF-02 首选)'
          })
        }
      } else {
        const ipcEstimate = ipc.calendar && ipc.dayAgenda ? ipc.calendar.p95Ms + 32 * ipc.dayAgenda.p95Ms : null
        if (ipcEstimate != null) {
          const domEstimate = stat.p95Ms - ipcEstimate
          bottlenecks.push({
            workload: workload.dataset.name, section: `pageReady.${page}`,
            pageReadyP95Ms: stat.p95Ms, ipcEstimateMs: ipcEstimate, domEstimateMs: domEstimate,
            estimateNote: 'IPC 估计 = listEvents p95 + 32×getDayAgenda p95(月 31 天 + 选中日 1 次)',
            dominant: domEstimate > ipcEstimate ? 'DOM_RENDER(分页/缓存为 PERF-02 首选)' : 'IPC_DAO(查询处理为 PERF-02 首选)'
          })
        }
      }
    }
    for (const [name, stat] of Object.entries(workload.scenarios.interactionReady)) {
      if (!stat || stat.status === 'NOT_RUN' || stat.pass) continue
      budgetFailures.push({ workload: workload.dataset.name, section: `interactionReady.${name}`, p95Ms: stat.p95Ms, budgetMs: INTERACTION_BUDGET_MS })
    }
    if (!workload.scenarios.longTasks.pass) {
      budgetFailures.push({ workload: workload.dataset.name, section: 'longTasks', maxEntryMs: workload.scenarios.longTasks.maxEntryMs, budgetMs: 100 })
    }
  }
  return {
    status: report.status === 'PASS' ? 'NOT_NEEDED' : 'REQUIRED',
    budgetFailures,
    bottlenecks,
    note: '测量交付已完成;预算未达项按规范转 PERF-02,不以修改计时口径换取通过。'
  }
}

function workloadPass(workload) {
  const checks = []
  const ipc = workload.scenarios.ipcQuery
  if (ipc && ipc.statistics) {
    for (const key of ['todo', 'calendar', 'dayAgenda', 'eventLoop', 'localSearchMain']) {
      if (ipc.statistics[key]) checks.push(ipc.statistics[key].pass !== false)
    }
  }
  for (const stat of Object.values(workload.scenarios.pageReady)) {
    if (stat.status !== 'NOT_RUN') checks.push(stat.pass === true)
  }
  for (const stat of Object.values(workload.scenarios.interactionReady)) {
    if (stat.status !== 'NOT_RUN') checks.push(stat.pass === true)
  }
  checks.push(workload.scenarios.longTasks.pass === true)
  return checks.length > 0 && checks.every(Boolean)
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') { console.log('node scripts/electron-perf.mjs --user-data <绝对新隔离目录> --output <JSON路径> [--screenshots <新目录>]'); return }
  const options = validateOptions(argv)
  const entry = join(root, 'out/main/index.js')
  const newest = dir => Math.max(0, ...readdirSync(dir, { withFileTypes: true }).map(item => item.isDirectory() ? newest(join(dir, item.name)) : statSync(join(dir, item.name)).mtimeMs))
  if (!existsSync(entry) || Math.max(newest(join(root, 'src')), newest(join(root, 'resources'))) > statSync(entry).mtimeMs) throw new Error('构建缺失或过期；请先 npm run build')
  mkdirSync(options.userData, { recursive: true })
  mkdirSync(dirname(options.output), { recursive: true })
  writeFileSync(join(options.userData, 'electron-perf-owner.json'), JSON.stringify({ synthetic: true, startedAt: new Date().toISOString(), root }))
  const logs = []
  const workloadSidePath = name => join(dirname(options.output), `workload-${name}.json`)
  const report = {
    reportVersion: 2, status: 'RUNNING', startedAt: new Date().toISOString(), options,
    environment: { platform: platform(), arch: arch(), osRelease: release(), controllerNode: process.version, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), appVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5_000, windowsHide: true }).stdout.trim(), dirty: (() => { const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', timeout: 5_000, windowsHide: true }); return status.status === 0 ? status.stdout.trim().length > 0 : null })() },
    build: Object.fromEntries(['out/main/index.js', 'out/preload/index.js', 'out/renderer/workbench.html'].map(path => [path, { sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex'), mtime: statSync(join(root, path)).mtime.toISOString() }])),
    configuration: {
      warmup: WARMUP,
      warmIterationsPerStream: ITERATIONS,
      percentile: 'nearest-rank ceil(0.95*n)-1; no sample removed',
      childLimitMs: CHILD_LIMIT_MS,
      softChunkBudgetMs: SOFT_CHUNK_BUDGET_MS,
      maxItersPerSegment: MAX_ITERS_PER_SEGMENT,
      pageReadyLimitMs: PAGE_READY_LIMIT_MS,
      interactionLimitMs: INTERACTION_LIMIT_MS,
      heavyInteractionLimitMs: HEAVY_INTERACTION_LIMIT_MS,
      queryLimitMs: QUERY_LIMIT_MS,
      memoryRoundTrips: MEMORY_ROUND_TRIPS,
      budgets: { pageReady: '1k≤500ms, 10k≤1000ms (p95)', interaction: 'p95≤200ms', consecutiveBlocking: 'longtask 单条 ≤100ms' },
      distributions: ['uniform', 'concentrated'],
      distributionNote: 'uniform=日程铺满锚定月 42 格;concentrated=全部日程压在锚定日(页面默认选中日);待办截止日方案两类一致',
      todosSeedSharedAcrossDistributions: '待办页负载由条数决定,与日程分布无关,故待办流仅在 uniform 档测量;集中负载由日历场景承担,不被轻负载替换',
      resourceCadenceMs: 250,
      rendererTimerMs: 10,
      sourceClock: NOW
    },
    workloads: [],
    notRun: {
      eventRecovery: { status: 'NOT_RUN', reason: '1000 seq 断订阅恢复及在线恢复 UI 交由集成验收' },
      realResearch: { status: 'NOT_RUN', reason: '离线验收不发送模型请求；wall/active/queue/approval 未采样' },
      streamingCancellation: { status: 'NOT_RUN', reason: 'T08 多轮流式成功/取消的 reader/listener 生命周期未采样' },
      rendererSearchIpc: { status: 'NOT_RUN', reason: '正式 preload 没有本地检索 IPC 入口，主进程检索单列' }
    },
    logs
  }
  try {
    const runtimePath = await buildFixtureRuntime(options.output)
    const runtime = require(runtimePath)
    for (const { size, distribution } of [{ size: 1_000, distribution: 'uniform' }, { size: 1_000, distribution: 'concentrated' }, { size: 10_000, distribution: 'uniform' }, { size: 10_000, distribution: 'concentrated' }]) {
      // 断点续跑:已完成并落盘的数据档直接复用,不重测(仅同日 anchor 下有效,见 dataset.anchor)。
      const sidePath = workloadSidePath(`records-${size}-${distribution}`)
      if (existsSync(sidePath)) {
        const saved = JSON.parse(readFileSync(sidePath, 'utf8'))
        if (saved && saved.complete && saved.workload && saved.workload.pass !== undefined && saved.anchorToday === saved.workload.dataset.anchor.today) {
          report.workloads.push(saved.workload)
          console.log(`[electron-perf] 复用已完成数据档 ${saved.workload.dataset.name}(side file)`)
          continue
        }
      }
      const userData = join(options.userData, `records-${size}-${distribution}`)
      // 未完成的数据档重建合成库,避免向旧库重复插入。
      if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
      console.log(`[electron-perf] 合成负载 ${size}/${distribution},预热 ${WARMUP},暖态 ${ITERATIONS} 次/流`)
      const dataset = await seed(runtime, userData, size, distribution)
      dataset.userData = userData
      const workload = { dataset: { name: dataset.name, size, distribution, anchor: dataset.anchor, counts: dataset.counts, dbPath: dataset.dbPath, sha256: dataset.sha256, bytes: dataset.bytes }, scenarios: {} }
      report.workloads.push(workload)
      // IPC 口径:仅在 uniform 档测量(日程分布不改变 IPC 行数与载荷结构)。
      if (distribution === 'uniform') {
        const screenshots = size === 1_000 ? options.screenshots : null
        const ipc = { status: 'OK', runs: {} }
        const eventLoopSamples = []
        let search = null
        let ipcEnvironment = null
        for (const target of ['todo', 'calendar', 'dayAgenda']) {
          console.log(`[electron-perf] IPC 口径 ${target}(${size})`)
          const run = await runIpcTarget(dataset, target, logs, runtimePath, target === 'todo' ? screenshots : null)
          ipc.runs[target] = { renderer: run.renderer, process: run.process }
          eventLoopSamples.push(...run.renderer.eventLoopSamples)
          if (run.localSearch) search = run.localSearch
          if (run.environment) ipcEnvironment = run.environment
        }
        ipc.statistics = {
          todo: summarizeSamples(ipc.runs.todo.renderer.measurements.todo.samples, 500),
          calendar: summarizeSamples(ipc.runs.calendar.renderer.measurements.calendar.samples, 500),
          dayAgenda: summarizeSamples(ipc.runs.dayAgenda.renderer.measurements.dayAgenda.samples, 500),
          eventLoop: summarizeSamples(eventLoopSamples, 100),
          localSearchMain: search ? summarizeSamples(search.samples, 1_000) : null
        }
        ipc.environment = ipcEnvironment
        workload.scenarios.ipcQuery = ipc
      } else {
        workload.scenarios.ipcQuery = { status: 'NOT_RUN', reason: 'IPC 查询成本与日程分布无关,已在同规模 uniform 档测量' }
      }
      // 页面就绪 + 交互 + longtask + 帧间隔 + 内存往返(分块子进程)。
      const pages = await runPageScenarios(dataset, logs)
      const todosSkipped = '待办种子在两类分布下一致,待办流仅 uniform 档测量(见 configuration.todosSeedSharedAcrossDistributions)'
      workload.scenarios.pageReady = buildPageReadyStats(pages.streams, dataset, todosSkipped)
      workload.scenarios.interactionReady = buildInteractionStats(pages.streams)
      workload.scenarios.longTasks = buildLongTaskStats(pages.telemetry)
      workload.scenarios.frameIntervals = buildFrameStats(pages.telemetry)
      workload.scenarios.resources = buildResourceStats(pages.telemetry, pages.telemetry.memoryRoundTrips)
      workload.scenarios.streams = summarizeStreamAccounting(pages.streams)
      workload.scenarios.visibilityLimited = pages.telemetry.visibilityLimited
      workload.pass = workloadPass(workload)
      const pr = workload.scenarios.pageReady
      console.log(`[electron-perf] ${dataset.name}: pageReady todos=${pr.todos.status === 'NOT_RUN' ? 'NOT_RUN' : `${pr.todos.p95Ms}ms`} calendar=${pr.calendar.status === 'NOT_RUN' ? 'NOT_RUN' : `${pr.calendar.p95Ms}ms`} longtask=${workload.scenarios.longTasks.count}/${workload.scenarios.longTasks.maxEntryMs}ms pass=${workload.pass}`)
      writeFileSync(options.output, JSON.stringify(report, null, 2))
      // 数据档完成即落 side file,供断点续跑复用。
      writeFileSync(workloadSidePath(dataset.name), JSON.stringify({ complete: true, anchorToday: dataset.anchor.today, workload }, null, 2))
    }
    report.status = report.workloads.every(workload => workload.pass) ? 'PASS' : 'FAIL'
    if (report.status === 'FAIL') process.exitCode = 1
    report.perf02 = derivePerf02(report)
  } catch (error) {
    report.status = 'FAIL'; report.error = error.stack; process.exitCode = 1; console.error(error.message)
    report.perf02 = derivePerf02(report)
  } finally {
    report.finishedAt = new Date().toISOString()
    writeFileSync(options.output, JSON.stringify(report, null, 2))
    console.log(`[electron-perf] ${report.status}: ${options.output}`)
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
