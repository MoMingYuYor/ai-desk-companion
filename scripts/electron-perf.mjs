// 离线验收：真实工作台 renderer → preload → IPC；只使用新建的隔离合成库。
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cpus, totalmem, platform, arch, release } from 'node:os'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const CHILD_LIMIT_MS = 60_000
const QUERY_LIMIT_MS = 2_000
const WARMUP = 5
const ITERATIONS = 100
const NOW = '2026-10-12T08:00:00.000Z'
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))

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
  if (existsSync(userData) && (!statSync(userData).isDirectory() || readdirSync(userData).length > 0)) throw new Error('--user-data 已有非空内容，拒绝读取或覆盖')
  const screenshots = values['--screenshots'] ? resolve(values['--screenshots']) : null
  if (screenshots && existsSync(screenshots) && readdirSync(screenshots).length > 0) throw new Error('截图目录非空，拒绝覆盖')
  return { userData, output: resolve(values['--output']), screenshots }
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
  // 使用项目已有 esbuild 打包纯数据库/检索模块，不导入 Electron 启动入口。
  const { build } = await import('esbuild')
  const result = await build({
    stdin: { contents: `export { openDatabase } from './src/main/db/connection'; export { initSchema } from './src/main/db/dao'; export { searchDocuments } from './src/main/retrieval/search'; export { tokenizeForSearch } from './src/main/retrieval/tokenize';`, resolveDir: root, sourcefile: 'electron-perf-fixture.ts' },
    bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent'
  })
  const path = join(dirname(output), 'electron-perf-runtime.cjs')
  writeFileSync(path, result.outputFiles[0].contents)
  return path
}

async function seed(runtime, userData, size) {
  mkdirSync(userData, { recursive: true })
  const dbPath = join(userData, 'data.sqlite')
  const { db, raw } = await runtime.openDatabase(dbPath, join(root, 'node_modules/sql.js/dist'))
  runtime.initSchema(db)
  // 全新空库直接填充，启动时跳过内置演示种子；不执行任何用户库清理。
  raw.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('agent:demo-seed-version','1')")
  const event = raw.prepare('INSERT INTO events (id,title,start_at,end_at,all_day,source,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
  const todo = raw.prepare('INSERT INTO todos (id,title,notes,due_at,priority,linked_event_id,source,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
  const document = raw.prepare('INSERT INTO retrieval_documents (document_id,source_name,source_type,raw_sha256,text_sha256,normalized_text,size_bytes,created_at) VALUES (?,?,?,?,?,?,?,?)')
  const chunk = raw.prepare('INSERT INTO retrieval_chunks (chunk_id,document_id,chunk_index,start_offset,end_offset,content,search_text,search_version) VALUES (?,?,?,?,?,?,?,?)')
  raw.run('BEGIN')
  try {
    for (let i = 0; i < size; i++) {
      event.run([`perf-event-${i}`, `合成日程 ${i}`, NOW, '2026-10-12T09:00:00.000Z', 0, 'manual', 1, NOW, NOW])
      todo.run([`perf-todo-${i}`, `合成待办 ${i}`, `固定负载 ${i}`, NOW, ['low', 'normal', 'high'][i % 3], i % 5 === 0 ? `perf-event-${i}` : null, 'manual', 1, NOW, NOW])
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
  return { counts, dbPath, sha256: createHash('sha256').update(readFileSync(dbPath)).digest('hex'), bytes: statSync(dbPath).size }
}

function rendererMeasure(config) {
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
    const measurements = {}
    async function once(name, call, phase, index) {
      const start = performance.now()
      let timer
      try {
        const rows = await Promise.race([call(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('IPC timeout')), config.queryLimitMs) })])
        if (!Array.isArray(rows) || rows.length !== config.expectedRows) throw new Error(`记录数不符：${rows?.length}/${config.expectedRows}`)
        const durationMs = performance.now() - start
        countNode.textContent = `${name}: ${rows.length}`
        await new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint)))
        return { index, phase, durationMs, renderReadyMs: performance.now() - start, rows: rows.length, error: null }
      } catch (error) {
        return { index, phase, durationMs: performance.now() - start, rows: null, error: error.message }
      } finally { clearTimeout(timer) }
    }
    try {
      for (const [name, call] of [
        ['todo', () => window.api.listTodos()],
        ['calendar', () => window.api.listEvents('2026-10-12T00:00:00.000Z', '2026-10-13T00:00:00.000Z')]
      ]) {
        const cold = await once(name, call, 'cold', 0)
        const warmup = []
        for (let i = 0; i < config.warmup; i++) warmup.push(await once(name, call, 'warmup', i))
        const samples = []
        for (let i = 0; i < config.iterations; i++) samples.push(await once(name, call, 'warm', i))
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

async function workload(runtimePath, userData, dataset, logs, screenshots) {
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
    // Electron 的 Node 内部模块须完成 bootstrap 后才能 require；合成库无 provider/账号。
    await mainCdp.send('Runtime.runIfWaitingForDebugger')
    await sleep(200)
    // 初始化后阻断业务网络，Chromium 会话只接受本地资源。
    await mainCdp.evaluate(`(() => {
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
    })()`)
    await until(() => browserPort, 10_000, 'Chromium inspector')
    const target = await until(async () => {
      const targets = await fetch(loopback(`http://127.0.0.1:${browserPort}/json/list`), { signal: AbortSignal.timeout(2_000) }).then(response => response.json())
      return targets.find(target => target.type === 'page' && target.url.includes('/workbench.html'))
    }, 10_000, '工作台窗口')
    rendererCdp = await Cdp.open(target.webSocketDebuggerUrl)
    await until(() => rendererCdp.evaluate('document.readyState === "complete" && typeof window.api?.listTodos === "function" && document.getElementById("root")?.childElementCount > 0'), 10_000, 'renderer ready')
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
    const renderer = await rendererCdp.evaluate(`(${rendererMeasure.toString()})(${JSON.stringify({ expectedRows: dataset.counts.todos, warmup: WARMUP, iterations: ITERATIONS, queryLimitMs: QUERY_LIMIT_MS })})`, 45_000)
    clearInterval(resourceInterval)
    if (resourceTask) await resourceTask
    await snapshot()
    const search = await mainCdp.evaluate(`(${searchMeasure.toString()})(${JSON.stringify({ runtimePath, dbPath: dataset.dbPath, wasmDir: join(root, 'node_modules/sql.js/dist') })})`)
    const environment = await mainCdp.evaluate(`({versions:process.versions,blockedNetwork:globalThis.__perfBlockedNetwork})`)
    const result = { dataset, renderer, resources: resourceSamples, localSearch: search, environment }
    if (screenshots) {
      mkdirSync(screenshots, { recursive: true })
      result.screenshots = []
      for (const [name, label] of [['overview', '今日概览'], ['agent', '事务 Agent'], ['research', '研究'], ['evals', '评测'], ['todos', '待办'], ['calendar', '日历']]) {
        await rendererCdp.evaluate(`(() => { const nav = [...document.querySelectorAll('.nav-item')].find(node => node.textContent.includes(${JSON.stringify(label)})); if (!nav) throw new Error('导航缺失'); nav.click(); return true })()`)
        await sleep(250)
        await rendererCdp.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        const capture = await rendererCdp.send('Page.captureScreenshot', { format: 'png' })
        const file = join(screenshots, `${name}.png`)
        writeFileSync(file, Buffer.from(capture.data, 'base64'), { flag: 'wx' })
        result.screenshots.push({ file, label, sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), proof: '合成数据界面渲染；不证明模型交互或真人全流程' })
      }
    }
    // 使用正常 app.quit 收尾，强制终止只作为失败超时兜底并如实记录。
    await mainCdp.evaluate(`setTimeout(() => globalThis.__perfRequire('electron').app.quit(), 50); true`)
    mainCdp.close(); rendererCdp.close()
    const exit = await Promise.race([closed, sleep(5_000).then(() => { throw new Error('正常 app.quit 收尾超时') })])
    result.process = { ...exit, forced: killed, limitMs: CHILD_LIMIT_MS, pid: child.pid }
    if (exit.exitCode !== 0 || killed) throw new Error(`Electron 收尾异常：${JSON.stringify(result.process)}`)
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
    logs.push({ userData, command: [electron, ...args], pid: child.pid, forced: killed, stdout, stderr })
  }
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') { console.log('node scripts/electron-perf.mjs --user-data <绝对新隔离目录> --output <JSON路径>'); return }
  const options = validateOptions(argv)
  const entry = join(root, 'out/main/index.js')
  const newest = dir => Math.max(0, ...readdirSync(dir, { withFileTypes: true }).map(item => item.isDirectory() ? newest(join(dir, item.name)) : statSync(join(dir, item.name)).mtimeMs))
  if (!existsSync(entry) || Math.max(newest(join(root, 'src')), newest(join(root, 'resources'))) > statSync(entry).mtimeMs) throw new Error('构建缺失或过期；请先 npm run build')
  mkdirSync(options.userData, { recursive: true })
  mkdirSync(dirname(options.output), { recursive: true })
  writeFileSync(join(options.userData, 'electron-perf-owner.json'), JSON.stringify({ synthetic: true, startedAt: new Date().toISOString(), root }))
  const logs = []
  const report = {
    reportVersion: 1, status: 'RUNNING', startedAt: new Date().toISOString(), options,
    environment: { platform: platform(), arch: arch(), osRelease: release(), controllerNode: process.version, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), appVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5_000, windowsHide: true }).stdout.trim(), dirty: true },
    build: Object.fromEntries(['out/main/index.js', 'out/preload/index.js', 'out/renderer/workbench.html'].map(path => [path, { sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex'), mtime: statSync(join(root, path)).mtime.toISOString() }])),
    configuration: { warmup: WARMUP, iterations: ITERATIONS, percentile: 'nearest-rank ceil(0.95*n)-1; no sample removed', childLimitMs: CHILD_LIMIT_MS, queryLimitMs: QUERY_LIMIT_MS, resourceCadenceMs: 250, rendererTimerMs: 10, sourceClock: NOW },
    workloads: [],
    notRun: {
      eventRecovery: { status: 'NOT_RUN', reason: '1000 seq 断订阅恢复及在线恢复 UI 交由集成验收' },
      realResearch: { status: 'NOT_RUN', reason: '离线验收不发送模型请求；wall/active/queue/approval 未采样' },
      streamingCancellation: { status: 'NOT_RUN', reason: 'T08 多轮流式成功/取消的 reader/listener 生命周期未采样' },
      rendererSearchIpc: { status: 'NOT_RUN', reason: '正式 preload 没有本地检索 IPC 入口，主进程检索单列' },
      fullPageRender: { status: 'NOT_RUN', reason: 'renderReadyMs 只代表结果计数节点的双 rAF，未验证生产列表全量渲染' }
    },
    logs
  }
  try {
    const runtimePath = await buildFixtureRuntime(options.output)
    const runtime = require(runtimePath)
    for (const size of [1_000, 10_000]) {
      console.log(`[electron-perf] 合成负载 ${size}，预热 ${WARMUP}，暖态 ${ITERATIONS} 次/接口`)
      const userData = join(options.userData, `records-${size}`)
      const dataset = await seed(runtime, userData, size)
      const result = await workload(runtimePath, userData, dataset, logs, size === 1_000 ? options.screenshots : null)
      result.statistics = {
        todo: summarizeSamples(result.renderer.measurements.todo.samples, 500),
        calendar: summarizeSamples(result.renderer.measurements.calendar.samples, 500),
        eventLoop: summarizeSamples(result.renderer.eventLoopSamples, 100),
        localSearchMain: summarizeSamples(result.localSearch.samples, 1_000),
        mainRssPeakBytes: Math.max(...result.resources.filter(sample => sample.main).map(sample => sample.main.rss)),
        rendererHeapPeakBytes: Math.max(...result.resources.filter(sample => sample.renderer).map(sample => sample.renderer.usedSize))
      }
      report.workloads.push(result)
      writeFileSync(options.output, JSON.stringify(report, null, 2))
      console.log(`[electron-perf] ${size}: todo p95=${result.statistics.todo.p95Ms}ms calendar p95=${result.statistics.calendar.p95Ms}ms eventloop p95=${result.statistics.eventLoop.p95Ms}ms`)
    }
    report.status = report.workloads.every(item => item.statistics.todo.pass && item.statistics.calendar.pass && item.statistics.eventLoop.pass && item.statistics.localSearchMain.pass) ? 'PASS' : 'FAIL'
    if (report.status === 'FAIL') process.exitCode = 1
  } catch (error) { report.status = 'FAIL'; report.error = error.stack; process.exitCode = 1; console.error(error.message) }
  finally { report.finishedAt = new Date().toISOString(); writeFileSync(options.output, JSON.stringify(report, null, 2)); console.log(`[electron-perf] ${report.status}: ${options.output}`) }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
