// REL-03 真实 renderer 恢复验收:生产 AgentPage/preload/IPC 上恢复 1000 seq 轨迹。
//
// 场景:fixture 主进程经真实仓库层落库 seq 1~1000 并按计划丢弃中段与最后 updated,
// 仅放行 finished;生产 AgentPage 的 finished 尾事件补拉负责完整恢复。
// 脚本只经 CDP 读取 DOM 与 fixture 状态做核对,不写 DOM、不伪造恢复。
//
// 用法:node scripts/acceptance/event-recovery.mjs --user-data <绝对新隔离目录> --output <JSON路径>
// 前置:npm run build(需 out/preload/index.js 与 out/renderer/workbench.html)。
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const CHILD_LIMIT_MS = 60_000
const TOTAL_SEQ = 1000
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function validateOptions(argv) {
  const values = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--user-data', '--output'].includes(argv[i]) || !argv[i + 1]) {
      throw fail('E_ARGS', '参数:--user-data <绝对新隔离目录> --output <JSON路径>')
    }
    if (values[argv[i]]) throw fail('E_ARGS', `重复参数 ${argv[i]}`)
    values[argv[i]] = argv[i + 1]
  }
  if (!values['--user-data'] || !isAbsolute(values['--user-data'])) throw fail('E_ARGS', '--user-data 必须是绝对隔离目录')
  if (!values['--output']) throw fail('E_ARGS', '缺少 --output')
  const userData = resolve(values['--user-data'])
  // 拒绝非空已有目录:防止读取或覆盖既有用户数据
  if (existsSync(userData) && (!statSync(userData).isDirectory() || readdirSync(userData).length > 0)) {
    throw fail('E_USERDATA_NOT_EMPTY', `--user-data 已有非空内容,拒绝读取或覆盖:${userData}`)
  }
  return { userData, output: resolve(values['--output']) }
}

function loopback(url) {
  if (new URL(url).hostname !== '127.0.0.1') throw fail('E_CDP_ENDPOINT', `只允许 loopback CDP 地址:${url}`)
  return url
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
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
      const timer = setTimeout(() => { socket.close(); reject(fail('E_CDP_CONNECT', 'CDP 连接超时')) }, 5_000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(fail('E_CDP_CONNECT', 'CDP 连接失败')) }, { once: true })
    })
    return new Cdp(socket)
  }
  send(method, params = {}, timeoutMs = 15_000) {
    const id = ++this.nextId
    return new Promise((resolveMessage, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(fail('E_CDP_TIMEOUT', `CDP ${method} 超时`)) }, timeoutMs)
      this.pending.set(id, { resolve: resolveMessage, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression, timeoutMs = 30_000) {
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
    if (response.exceptionDetails) throw fail('E_CDP_EVALUATE', JSON.stringify(response.exceptionDetails))
    return response.result.value
  }
  close() { this.socket.close() }
}

async function until(body, timeoutMs, label, code = 'E_TIMEOUT') {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try { const value = await body(); if (value) return value } catch (error) { lastError = error }
    await sleep(50)
  }
  const error = fail(code, `${label} 超时${lastError ? `:${lastError.message}` : ''}`)
  throw error
}

/** 用项目自带 esbuild 把 fixture 打包进 out/main,保证 __dirname 推导的 preload/renderer 路径成立。 */
async function buildFixture() {
  const entry = join(root, 'scripts/acceptance/fixtures/event-recovery-main.ts')
  const outPath = join(root, 'out/main/event-recovery-fixture.cjs')
  try {
    const { build } = await import('esbuild')
    const result = await build({
      entryPoints: [entry],
      outfile: outPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      // 与生产 electron-vite externalizeDepsPlugin 同语义:依赖运行时从 node_modules 解析
      packages: 'external',
      logLevel: 'silent',
      sourcemap: false
    })
    if (result.errors?.length) throw fail('E_ESBUILD', JSON.stringify(result.errors))
  } catch (error) {
    if (error.code) throw error
    throw fail('E_ESBUILD', `fixture 打包失败:${error.message}`)
  }
  return outPath
}

// 只读 DOM 快照:seq 集合、顺序与终态;脚本不借此写 DOM
function domSnapshot() {
  const timeline = document.querySelector('[data-testid="agent-timeline"]')
  if (!timeline) return null
  const seqs = [...timeline.querySelectorAll('span')]
    .map((node) => node.textContent)
    .filter((text) => /^#\d+$/.test(text ?? ''))
    .map((text) => Number(text.slice(1)))
  return {
    count: seqs.length,
    seqs,
    status: document.querySelector('[data-testid="agent-run-status"]')?.textContent ?? null,
    hasStep2: timeline.textContent.includes('step-2'),
    hasStep998: timeline.textContent.includes('step-998'),
    hasOutputLabel: timeline.textContent.includes('结果'),
    hasEventError: document.querySelector('[data-testid="agent-event-error"]') !== null,
    hasMainError: document.querySelector('[data-testid="agent-error"]') !== null
  }
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('node scripts/acceptance/event-recovery.mjs --user-data <绝对新隔离目录> --output <JSON路径>')
    return
  }
  const options = validateOptions(argv)
  const report = {
    reportVersion: 1,
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    options,
    plan: {
      totalSeq: TOTAL_SEQ,
      delivery: 'seq 1 经打开代 agent:run-events 补发到达;seq 2~1000 的 updated 广播由 fixture 计划丢弃(含最后 updated);仅 finished 放行',
      renderer: '生产 AgentPage(生产 preload + 生产 IPC),脚本不写 DOM'
    },
    build: {},
    fixture: null,
    dom: null,
    checks: [],
    process: null,
    error: null
  }
  let child = null
  let killed = false
  let mainCdp = null
  let rendererCdp = null
  let stdout = ''
  let stderr = ''
  try {
    // 构建前置:生产 preload/renderer 必须已构建
    for (const rel of ['out/preload/index.js', 'out/renderer/workbench.html', 'out/main']) {
      if (!existsSync(join(root, rel))) throw fail('E_BUILD_MISSING', `缺少构建产物 ${rel};请先 npm run build`)
    }
    for (const rel of ['out/preload/index.js', 'out/renderer/workbench.html']) {
      const file = join(root, rel)
      report.build[rel] = { sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), mtime: statSync(file).mtime.toISOString() }
    }
    const fixturePath = await buildFixture()
    report.build['out/main/event-recovery-fixture.cjs'] = { sha256: createHash('sha256').update(readFileSync(fixturePath)).digest('hex') }

    mkdirSync(options.userData, { recursive: true })
    mkdirSync(dirname(options.output), { recursive: true })
    writeFileSync(join(options.userData, 'event-recovery-owner.json'), JSON.stringify({ synthetic: true, startedAt: report.startedAt, root }))
    writeFileSync(options.output, JSON.stringify(report, null, 2))

    const electron = require('electron')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const args = [
      fixturePath,
      '--user-data', options.userData,
      '--inspect-brk=127.0.0.1:0',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND',
      '--disable-component-update', '--disable-sync'
    ]
    child = spawn(electron, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let mainEndpoint = null
    let browserPort = null
    child.on('error', (error) => { stderr += `${error.stack}\n` })
    child.stdout.on('data', (data) => { stdout += data.toString('utf8') })
    child.stderr.on('data', (data) => {
      stderr += data.toString('utf8')
      mainEndpoint = stderr.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1] ?? mainEndpoint
      browserPort = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1] ?? browserPort
    })
    const closed = new Promise((resolveClose) => child.once('close', (exitCode, signal) => resolveClose({ exitCode, signal })))
    const childTimer = setTimeout(() => {
      killed = true
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 })
      else child.kill('SIGKILL')
    }, CHILD_LIMIT_MS)

    try {
      await until(() => mainEndpoint, 10_000, 'Node inspector')
      mainCdp = await Cdp.open(mainEndpoint)
      await mainCdp.send('Runtime.enable')
      await mainCdp.send('Runtime.runIfWaitingForDebugger')
      // fixture 模块(及其依赖 imapflow→tls→https 的惰性编译)必须先完整加载,
      // 再篡改 http/https/net 内建模块,否则会打断内建模块编译
      await until(async () => (await mainCdp.evaluate('typeof globalThis.__rel03')) === 'object', 15_000, 'fixture 模块加载')
      // 初始化后关闭业务网络:Chromium 会话只放行本地资源,Node 侧 fetch/http/https/net 全部拒绝
      report.networkBlocked = await mainCdp.evaluate(`(() => {
        const req = process.getBuiltinModule('module').createRequire(${JSON.stringify(join(root, 'package.json'))});
        globalThis.__rel03Require = req;
        globalThis.__rel03BlockedNetwork = [];
        const deny = (url) => { globalThis.__rel03BlockedNetwork.push({ at: Date.now(), url: String(url) }); throw new Error('REL03_NETWORK_BLOCKED'); };
        globalThis.fetch = () => deny('globalThis.fetch');
        for (const name of ['http', 'https']) {
          const mod = req(name);
          mod.request = (a) => deny(name + ' request ' + (typeof a === 'string' ? a : a?.href ?? '')); mod.get = mod.request;
        }
        const tcp = req('net'); tcp.connect = () => deny('net.connect'); tcp.createConnection = () => deny('net.createConnection');
        const electronMod = req('electron'); electronMod.net.request = () => deny('electron.net.request');
        electronMod.app.whenReady().then(() => electronMod.session.defaultSession.webRequest.onBeforeRequest((details, done) => {
          const local = /^(file:|devtools:|chrome-devtools:|data:|blob:)/.test(details.url);
          if (!local) globalThis.__rel03BlockedNetwork.push({ at: Date.now(), url: details.url });
          done({ cancel: !local });
        }));
        return true;
      })()`)

      await until(() => browserPort, 10_000, 'Chromium inspector')
      const target = await until(async () => {
        const targets = await fetch(loopback(`http://127.0.0.1:${browserPort}/json/list`), { signal: AbortSignal.timeout(2_000) }).then((response) => response.json())
        return targets.find((t) => t.type === 'page' && t.url.includes('/workbench.html'))
      }, 10_000, '工作台窗口')
      rendererCdp = await Cdp.open(target.webSocketDebuggerUrl)
      await until(
        () => rendererCdp.evaluate('document.readyState === "complete" && typeof window.api?.getAgentRunEvents === "function" && document.getElementById("root")?.childElementCount > 0'),
        10_000,
        'renderer ready'
      )
      report.checks.push({ name: 'rendererReadyWithProductionApi', pass: true })

      // 生产导航:点击"事务 Agent"导航项(不注入页面逻辑)
      await until(async () =>
        rendererCdp.evaluate(`(() => {
          const nav = [...document.querySelectorAll('.nav-item')].find((node) => node.textContent.includes('事务 Agent'));
          if (!nav) return false; nav.click(); return true;
        })()`), 10_000, 'Agent 导航')
      await until(async () => {
        const snap = await rendererCdp.evaluate(`(${domSnapshot.toString()})()`)
        return snap && snap.count >= 1 && snap.seqs[0] === 1
      }, 15_000, '时间线渲染 seq 1')
      const beforeStage2 = await rendererCdp.evaluate(`(${domSnapshot.toString()})()`)
      report.checks.push({ name: 'seq1RenderedBeforeStage2', pass: beforeStage2.seqs.length === 1 && beforeStage2.seqs[0] === 1, detail: beforeStage2 })

      // 推进阶段 2:落库 seq 2~1000、按计划丢弃 updated、仅发送 finished
      const stage2Start = Date.now()
      report.fixture = await mainCdp.evaluate('globalThis.__rel03.stage2()')
      if (report.fixture.error) throw fail('E_STAGE2', `fixture stage2 失败:${report.fixture.error}`)
      if (report.fixture.stage !== 'finished-sent' || report.fixture.dbEventCount !== TOTAL_SEQ) {
        throw fail('E_STAGE2', `fixture 状态异常:${JSON.stringify(report.fixture)}`)
      }
      report.checks.push({
        name: 'fixturePlanApplied',
        pass: report.fixture.deliveredUpdatedSeqs.length === 1 && report.fixture.droppedUpdatedCount === TOTAL_SEQ - 1,
        detail: report.fixture
      })

      // 等待生产 AgentPage 自行完成 finished 尾事件补拉(只读轮询,不写 DOM)
      let lastSnap = null
      await until(async () => {
        const snap = await rendererCdp.evaluate(`(${domSnapshot.toString()})()`)
        if (snap && snap.count === TOTAL_SEQ) {
          if (lastSnap && lastSnap.count === TOTAL_SEQ && lastSnap.status === snap.status) return snap
          lastSnap = snap
        }
        return false
      }, 30_000, 'AgentPage 恢复 1000 seq')
      const recoveryMs = Date.now() - stage2Start
      const dom = await rendererCdp.evaluate(`(${domSnapshot.toString()})()`)
      report.dom = dom
      const seqs = dom.seqs
      const unique = new Set(seqs).size === TOTAL_SEQ
      const ascending = seqs.every((value, index) => value === index + 1)
      report.checks.push(
        { name: 'domSeqCount1000', pass: dom.count === TOTAL_SEQ, detail: { count: dom.count } },
        { name: 'domSeqUnique', pass: unique, detail: { uniqueCount: new Set(seqs).size } },
        { name: 'domSeqAscendingComplete1To1000', pass: ascending, detail: { first: seqs[0], last: seqs[seqs.length - 1] } },
        { name: 'terminalStatusAuthoritative', pass: dom.status === '已完成', detail: { status: dom.status } },
        { name: 'timelineContentSpansTail', pass: dom.hasStep2 && dom.hasStep998 && dom.hasOutputLabel, detail: { hasStep2: dom.hasStep2, hasStep998: dom.hasStep998, hasOutputLabel: dom.hasOutputLabel } },
        { name: 'noEventErrorAfterRecovery', pass: !dom.hasEventError && !dom.hasMainError },
        { name: 'recoveryPerformanceSample', pass: true, detail: { recoveryMs, note: '单列采样,供 PERF-01 口径使用;非判定项' } }
      )
      const blocked = await mainCdp.evaluate('globalThis.__rel03BlockedNetwork')
      report.networkBlockedAttempts = blocked
      report.checks.push({ name: 'noNetworkAttempts', pass: blocked.length === 0, detail: { attempts: blocked.length } })

      // 正常收尾:先断开调试器(inspector 附加时进程无法退出),再等待 app.quit 完成
      await mainCdp.evaluate(`setTimeout(() => globalThis.__rel03Require('electron').app.quit(), 50); true`)
      mainCdp.close()
      mainCdp = null
      rendererCdp.close()
      rendererCdp = null
      const exit = await Promise.race([
        closed,
        sleep(5_000).then(() => { throw fail('E_EXIT_TIMEOUT', '正常 app.quit 收尾超时') })
      ])
      report.process = { ...exit, forced: killed, limitMs: CHILD_LIMIT_MS, pid: child.pid }
      report.checks.push({ name: 'processExitClean', pass: exit.exitCode === 0 && !killed, detail: report.process })

      const failed = report.checks.filter((check) => !check.pass)
      report.status = failed.length === 0 ? 'PASS' : 'FAIL'
      if (failed.length > 0) throw fail('E_DOM_CHECK', `未通过的检查:${failed.map((check) => check.name).join(', ')}`)
    } finally {
      mainCdp?.close()
      rendererCdp?.close()
      if (child.exitCode === null && child.signalCode === null) {
        killed = true
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 })
        else child.kill('SIGKILL')
        await closed
      }
      clearTimeout(childTimer)
    }
  } catch (error) {
    report.status = 'FAIL'
    report.error = { code: error.code ?? 'E_UNKNOWN', message: error.message }
    report.logs = { stdoutTail: stdout.slice(-4_000), stderrTail: stderr.slice(-4_000) }
    process.exitCode = 1
  } finally {
    report.finishedAt = new Date().toISOString()
    report.logs = report.logs ?? { stdoutTail: stdout.slice(-2_000), stderrTail: stderr.slice(-2_000) }
    report.environment = {
      platform: process.platform,
      controllerNode: process.version,
      commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5_000, windowsHide: true }).stdout.trim()
    }
    writeFileSync(options.output, JSON.stringify(report, null, 2))
    console.log(`[event-recovery] ${report.status}${report.error ? ` (${report.error.code}: ${report.error.message})` : ''}: ${options.output}`)
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
