// SEC-01 真实 Chromium 验证编排器(系统 Node 运行,不再改动被测产物):
//   Phase A:隔离 Electron 探针(csp-probe-main.mjs)——生产 HTML + 恶意正文夹具,
//            采集 securitypolicyviolation、执行哨兵、loopback 出站记录、Markdown blob 下载;
//   Phase B:真实应用启动(--user-data 隔离目录),验证三窗口 meta CSP、本地脚本/图片、
//            切主题、IPC(种子待办)、今日面板唤起、Markdown 下载与页面内违规计数;
//   Phase C:注入恶意邮件正文夹具(body_path 指向受控缓存文件),验证 sanitizer 输出、
//            正文显示、无执行哨兵、无出站请求;
//   Phase D:开发 server 真实转换——加载 electron.vite.config.ts 的 renderer 插件,
//            校验三个页面 dev meta = developmentCsp(实际 origin)、React Refresh 内联脚本
//            在开发放行、HMR WebSocket 可用。
//
// 用法:
//   node scripts/acceptance/csp-smoke.mjs --user-data <空目录> --output <csp.json> [--project <root>]
// 约束:--user-data 必须不存在或为空(拒绝复用非空目录);每个 Electron 子进程限时 60 秒;
//      全部网络仅本机 loopback 受控服务,数据不出机。

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createServer as netCreateServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { developmentCsp, PRODUCTION_RENDERER_CSP } from '../lib/renderer-csp.ts'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
function argOf(name, fallback = null) {
  const i = args.indexOf(name)
  return i !== -1 ? args[i + 1] : fallback
}

const projectRoot = resolve(argOf('--project', join(here, '..', '..')))
const userDataDir = resolve(argOf('--user-data'))
const outputPath = resolve(argOf('--output', join(projectRoot, 'artifacts', 'acceptance', 'csp.json')))
const electronExe = join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const probeScript = join(here, 'csp-probe-main.mjs')

const failures = []
const notes = []
function check(label, pass, detail = '') {
  const ok = pass === true
  if (!ok) failures.push(`${label}${detail ? ` —— ${detail}` : ''}`)
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` —— ${detail}` : ''}`)
  return ok
}

// ---------- 通用工具 ----------

function freePort() {
  return new Promise((res, rej) => {
    const srv = netCreateServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => res(port))
    })
    srv.on('error', rej)
  })
}

/** 杀掉整棵进程树(Windows) */
function killTree(pid) {
  try {
    spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
  } catch {
    // 尽力而为
  }
}

/** 运行一个 Electron 子进程,限时 60 秒,超时杀树 */
function runElectron(argv, label) {
  return new Promise((res) => {
    const proc = spawn(electronExe, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    proc.stdout.on('data', (d) => (stdout += d))
    proc.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => {
      timedOut = true
      killTree(proc.pid)
    }, 60_000)
    proc.on('exit', (code) => {
      clearTimeout(timer)
      res({ code, timedOut, stdout, stderr })
    })
    console.log(`[spawn] ${label}:pid=${proc.pid} argv=${JSON.stringify(argv.slice(0, 3))}...`)
  })
}

/** 起一个 loopback 记录服务器:全部请求入 beaconLog */
async function startBeacon() {
  const { createServer } = await import('node:http')
  const log = []
  const srv = await new Promise((res) => {
    const s = createServer((req, res2) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      log.push({ ts: Date.now(), path: url.pathname, method: req.method })
      res2.writeHead(200, { 'Content-Type': 'text/plain' })
      res2.end('beacon')
    })
    s.listen(0, '127.0.0.1', () => res(s))
  })
  return { log, srv, origin: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }
}

// ---------- 极简 CDP 客户端(页面级直连) ----------

class CdpPage {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) rej(new Error(`CDP ${msg.error.message}`))
        else res(msg.result)
      }
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error(`CDP 连接失败:${url}`)), { once: true })
    })
    return new CdpPage(ws)
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          rej(new Error(`CDP 超时:${method}`))
        }
      }, 15_000)
    })
  }

  /** 页面内求值(awaitPromise + returnByValue);页面异常显式抛出 */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    })
    if (r.exceptionDetails) {
      const text = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text
      throw new Error(`页面求值异常:${text}`)
    }
    return r.result?.value
  }

  close() {
    try {
      this.ws.close()
    } catch {
      // 忽略
    }
  }
}

function jsonVersionUrl(port) {
  return `http://127.0.0.1:${port}/json/version`
}

async function listPageTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  const list = await res.json()
  return list.filter((t) => t.type === 'page')
}

async function waitForPageTarget(port, urlSuffix, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const pages = await listPageTargets(port)
      const hit = pages.find((t) => t.url.replace(/\\/g, '/').endsWith(urlSuffix))
      if (hit) return hit
    } catch {
      // devtools 端口未就绪,继续轮询
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`等待页面目标超时:${urlSuffix}`)
}

/** 启动真实应用并等待 DevTools 端口可用 */
async function launchRealApp(label) {
  const port = await freePort()
  const argv = [
    projectRoot,
    '--user-data',
    userDataDir,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*'
  ]
  const proc = spawn(electronExe, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderrTail = ''
  proc.stderr.on('data', (d) => (stderrTail = (stderrTail + d).slice(-4000)))
  proc.stdout.on('data', () => {})
  const deadline = Date.now() + 30_000
  let ready = false
  while (Date.now() < deadline) {
    try {
      const res = await fetch(jsonVersionUrl(port))
      if (res.ok) {
        ready = true
        break
      }
    } catch {
      // 端口未就绪
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  if (!ready) {
    killTree(proc.pid)
    throw new Error(`${label}:DevTools 端口未就绪。stderr 尾部:${stderrTail}`)
  }
  console.log(`[spawn] ${label}:pid=${proc.pid} cdp=${port}`)
  return { proc, port, stderrTail: () => stderrTail }
}

/** 优雅退出真实应用:CDP Browser.close 失败则杀树 */
async function quitRealApp(app) {
  try {
    const ver = await (await fetch(jsonVersionUrl(app.port))).json()
    const ws = new WebSocket(ver.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    })
    const id = 1
    ws.send(JSON.stringify({ id, method: 'Browser.close', params: {} }))
    await new Promise((r) => setTimeout(r, 1500))
    try {
      ws.close()
    } catch {
      // 忽略
    }
  } catch {
    // 走杀树兜底
  }
  if (app.proc.exitCode === null && !app.proc.killed) {
    await new Promise((r) => setTimeout(r, 1000))
    if (app.proc.exitCode === null) {
      console.log('[quit] Browser.close 未生效,taskkill 兜底')
      killTree(app.proc.pid)
    }
  }
  await new Promise((r) => setTimeout(r, 800))
}

// ---------- 页面级检查 ----------

function installViolationCollectorExpr() {
  return `(() => {
    window.__smokeViol = window.__smokeViol || []
    if (!window.__smokeViolInstalled) {
      window.__smokeViolInstalled = true
      window.addEventListener('securitypolicyviolation', (e) => {
        window.__smokeViol.push(e.violatedDirective + ':' + e.blockedURL)
      })
    }
    return true
  })()`
}

async function attachAndCheckPage(port, urlSuffix, label) {
  const target = await waitForPageTarget(port, urlSuffix, 30_000)
  const conn = await CdpPage.connect(target.webSocketDebuggerUrl)
  const rootMounted = await pollUntil(
    () => conn.eval(`(() => {
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
      return {
        csp: meta ? meta.getAttribute('content') : null,
        rootChildren: document.querySelector('#root')?.childElementCount ?? -1
      }
    })()`),
    (v) => v && v.rootChildren > 0,
    30_000
  )
  check(
    `${label}:meta CSP 与生产常量逐字一致`,
    rootMounted.csp === PRODUCTION_RENDERER_CSP,
    rootMounted.csp === PRODUCTION_RENDERER_CSP ? '' : `实际:${rootMounted.csp}`
  )
  check(`${label}:React 已挂载(#root 有子节点,本地脚本被放行)`, rootMounted.rootChildren > 0)
  await conn.eval(installViolationCollectorExpr())
  return conn
}

async function pollUntil(fn, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (predicate(last)) return last
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`轮询超时:${lastErr ? String(lastErr) : JSON.stringify(last)?.slice(0, 200)}`)
}

// ---------- Phase B:真实应用功能验证 ----------

async function phaseB(port) {
  const workbench = await attachAndCheckPage(port, 'workbench.html', 'B/工作台')
  const pet = await attachAndCheckPage(port, 'pet.html', 'B/桌宠')

  // 本地图片:桌宠立绘 PNG 在 img-src 'self' 下应正常加载
  const petImg = await pet.eval(
    `(() => { const img = document.querySelector('img'); return { count: document.querySelectorAll('img').length, natural: img ? img.naturalWidth : 0 } })()`
  )
  check('B/桌宠:本地 PNG 图片加载(naturalWidth > 0)', petImg.natural > 0, JSON.stringify(petImg))

  // 切主题:appearance IPC 往返 + DOM 生效
  const theme = await workbench.eval(
    `(async () => {
      const r = await window.api.appearance.set('dark')
      const snap = await window.api.appearance.get()
      return { ok: r.ok, mode: snap.mode, domTheme: document.documentElement.dataset.theme }
    })()`
  )
  check('B/工作台:切主题 IPC(appearance.set dark)', theme.ok === true && theme.mode === 'dark', JSON.stringify(theme))
  check('B/工作台:主题写入 DOM(data-theme=dark)', theme.domTheme === 'dark', String(theme.domTheme))

  // IPC + 数据库:演示种子待办可列出
  const todos = await workbench.eval(`(async () => await window.api.listTodos())()`)
  check('B/工作台:listTodos IPC 返回种子数据', Array.isArray(todos) && todos.length > 0, `条数=${Array.isArray(todos) ? todos.length : '非数组'}`)

  // 今日面板:经桌宠 petAction IPC 唤起
  await pet.eval(`(async () => { await window.api.petAction('toggle-panel'); return true })()`)
  const panel = await attachAndCheckPage(port, 'panel.html', 'B/今日面板')

  // Markdown blob 下载(与 ResearchPage 导出同机制)
  const dlDir = join(userDataDir, 'smoke-downloads')
  mkdirSync(dlDir, { recursive: true })
  await workbench.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir })
  await workbench.eval(`(() => {
    const blob = new Blob(['# 测试导出\\n\\nCSP smoke markdown\\n'], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'csp-smoke-export.md'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    return true
  })()`)
  const dlFile = join(dlDir, 'csp-smoke-export.md')
  await pollUntil(
    () => (existsSync(dlFile) ? readFileSync(dlFile, 'utf8') : null),
    (c) => c !== null && c.includes('CSP smoke markdown'),
    10_000
  )
  check('B/工作台:Markdown blob 下载落盘且内容正确', true, dlFile)

  // 功能期违规计数应为 0(本地资源均被放行)
  for (const [name, conn] of [['工作台', workbench], ['桌宠', pet], ['今日面板', panel]]) {
    const viol = await conn.eval(`window.__smokeViol.join(' | ')`)
    check(`B/${name}:功能期 securitypolicyviolation 为 0`, viol === '', viol ? `违规:${viol}` : '')
  }

  for (const c of [workbench, pet, panel]) c.close()
}

// ---------- Phase C:恶意邮件正文夹具 ----------

function maliciousMailBody(beaconOrigin) {
  return [
    '<p>安全正文文本可见:这一段是正常内容。</p>',
    "<script>document.documentElement.dataset.mailInlineExecuted='1'<\/script>",
    '<p onclick="document.documentElement.dataset.mailOnclickExecuted=\'1\'">带事件属性的段落文本。</p>',
    `<img src="${beaconOrigin}/__csp_beacon/mail-img.png">`,
    `<script src="${beaconOrigin}/__csp_beacon/mail-script.js"><\/script>`,
    '<p>结尾段落,确认正文完整显示。</p>'
  ].join('\n')
}

async function phaseC(beacon) {
  // 注入邮件夹具:账号 + 消息行 + 受控正文缓存文件(body_path 存在即读缓存,不连 IMAP)
  const require = createRequire(import.meta.url)
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs({
    locateFile: (f) => join(projectRoot, 'node_modules', 'sql.js', 'dist', f)
  })
  const dbPath = join(userDataDir, 'data.sqlite')
  const db = new SQL.Database(readFileSync(dbPath))
  db.run(
    `INSERT INTO mail_accounts (id,label,email,provider,host,port,credential_enc,enabled,status,created_at)
     VALUES ('smoke-acct-1','CSP 冒烟账号','smoke@example.invalid','custom','127.0.0.1',993,'c3Bva2U=',1,'idle','2026-10-08T00:00:00.000Z')`
  )
  const bodyPath = join(userDataDir, 'mail', 'smoke-body', 'body-v1.html')
  mkdirSync(dirname(bodyPath), { recursive: true })
  // 正文缓存格式:首行 JSON 头(v + mime),随后为原始解码内容
  const bodyCache = Buffer.concat([
    Buffer.from(JSON.stringify({ v: 1, mime: 'text/html' }) + '\n', 'utf8'),
    Buffer.from(maliciousMailBody(beacon.origin), 'utf8')
  ])
  writeFileSync(bodyPath, bodyCache)
  db.run(
    `INSERT INTO mail_messages (id,account_id,mailbox,uid_validity,uid,remote_message_id,subject,sender,recipients,received_at,size,read_local,body_state,body_path,body_structure,remote_available)
     VALUES ('smoke-msg-1','smoke-acct-1','INBOX','1',1,'<smoke@csp.local>','CSP 冒烟:恶意正文夹具','attacker@127.0.0.1','victim@127.0.0.1','2026-10-08T00:00:00.000Z',1024,0,'ready',?,'{}',1)`,
    [bodyPath]
  )
  const data = db.export()
  writeFileSync(dbPath, Buffer.from(data))
  db.close()
  console.log('[phaseC] 邮件夹具已注入 data.sqlite 与正文缓存')

  // 重启真实应用(第二阶段启动)
  const app2 = await launchRealApp('C/重启应用')
  const workbench = await attachAndCheckPage(app2.port, 'workbench.html', 'C/工作台')
  await workbench.eval(installViolationCollectorExpr())

  // 正文经主进程 sanitizer → IPC 返回
  const listed = await workbench.eval(
    `(async () => await window.api.mail.list({}))()`
  )
  check(
    'C/工作台:mail.list IPC 成功且包含夹具邮件',
    listed?.ok === true && Array.isArray(listed.value?.items) && listed.value.items.some((m) => m.subject?.includes('恶意正文夹具')),
    JSON.stringify(listed)?.slice(0, 200)
  )
  const detail = await workbench.eval(
    `(async () => await window.api.mail.detail('smoke-msg-1'))()`
  )
  check('C/工作台:mail.detail IPC 成功', detail?.ok === true, JSON.stringify(detail)?.slice(0, 200))
  if (detail?.ok) {
    const safeHtml = detail.value.safeHtml ?? ''
    const text = detail.value.text ?? ''
    check('C/sanitizer:safeHtml 保留正常段落文本', safeHtml.includes('安全正文文本可见') && safeHtml.includes('结尾段落'))
    check('C/sanitizer:safeHtml 不含 script 标签', !/<script/i.test(safeHtml))
    check('C/sanitizer:safeHtml 不含事件属性与远程地址', !/onerror|onclick/i.test(safeHtml) && !safeHtml.includes('127.0.0.1'))
    check('C/sanitizer:纯文本视图包含正文文本', text.includes('安全正文文本可见'))

    // 正文显示:safeHtml 渲染进页面 DOM(与 MailDetailView 的 dangerouslySetInnerHTML 同路径)
    const render = await workbench.eval(
      `(() => {
        const c = document.createElement('div')
        c.id = 'csp-mail-render'
        c.innerHTML = ${JSON.stringify(safeHtml)}
        document.body.appendChild(c)
        return {
          shown: c.innerText.includes('安全正文文本可见') && c.innerText.includes('结尾段落'),
          inlineExecuted: document.documentElement.dataset.mailInlineExecuted === '1',
          onclickExecuted: document.documentElement.dataset.mailOnclickExecuted === '1'
        }
      })()`
    )
    check('C/正文显示:sanitized 正文在 DOM 中可见', render.shown === true, JSON.stringify(render))
    check('C/正文显示:无执行哨兵(inline/onclick 未运行)', !render.inlineExecuted && !render.onclickExecuted)
  }

  const viol = await workbench.eval(`(window.__smokeViol || []).join(' | ')`)
  check('C/工作台:正文渲染期 securitypolicyviolation 为 0', viol === '', viol ? `违规:${viol}` : '')
  check('C/出站记录:受控 beacon 全程零请求', beacon.log.length === 0, `请求数=${beacon.log.length}`)

  await workbench.close()
  await quitRealApp(app2)
  const alive = app2.proc.exitCode === null && !app2.proc.killed
  check('C/应用重启后正常退出', !alive)
}

// ---------- Phase A:探针 harness ----------

async function phaseA() {
  const reportA = join(dirname(outputPath), 'csp-probe-report.json')
  const r = await runElectron(
    [probeScript, '--report', reportA, '--app-dir', projectRoot],
    'A/探针 harness'
  )
  if (!existsSync(reportA)) {
    check('A/探针报告生成', false, `stdout=${r.stdout.slice(0, 300)} stderr=${r.stderr.slice(0, 300)}`)
    return
  }
  const rep = JSON.parse(readFileSync(reportA, 'utf8'))
  check('A/探针 harness 正常完成(未超时)', rep.status === 'ok' && !r.timedOut, rep.status)

  for (const page of ['workbench', 'pet', 'panel']) {
    const pr = rep.pages?.[page]?.report
    check(`A/${page}:探针报告存在`, Boolean(pr))
    if (!pr) continue
    check(`A/${page}:页面加载的本地探针脚本已执行(probeRan)`, pr.probeRan === true)
    const s = pr.sentinels ?? {}
    const sentinelKeys = Object.keys(s)
    check(
      `A/${page}:全部执行哨兵为 false(inline/onclick/DOM 变体未执行)`,
      sentinelKeys.length > 0 && sentinelKeys.every((k) => s[k] === false),
      JSON.stringify(s)
    )
    const directives = new Set((pr.violations ?? []).map((v) => v.directive))
    // Chromium 对元素/属性级脚本违规上报具体化指令(script-src-elem/attr),它们回退自 script-src
    const scriptBlocked =
      directives.has('script-src') || directives.has('script-src-elem') || directives.has('script-src-attr')
    check(
      `A/${page}:securitypolicyviolation 覆盖 script/img/connect 三类`,
      scriptBlocked && directives.has('img-src') && directives.has('connect-src'),
      `实际指令:[${[...directives].join(', ')}],事件数=${(pr.violations ?? []).length}`
    )
    check(`A/${page}:fetch 出站尝试被 connect-src 阻止`, pr.fetchAttemptBlocked === true, pr.fetchError)
    check(`A/${page}:Markdown blob 下载已触发`, pr.downloadTriggered === true, pr.downloadError ?? '')
  }

  check('A/出站记录:攻击者 beacon 服务器零请求', (rep.beacon ?? []).length === 0, `请求数=${(rep.beacon ?? []).length}`)
  const dl = (rep.downloads ?? []).find((d) => d.filename === 'csp-smoke-probe-export.md')
  check('A/Markdown blob 下载被 Electron 接收', Boolean(dl), JSON.stringify(rep.downloads))
}

// ---------- Phase D:开发 server 真实转换与 HMR ----------

async function phaseD() {
  const { loadConfigFromFile } = await import('electron-vite')
  const loaded = await loadConfigFromFile(
    { command: 'serve', mode: 'development', isSsrBuild: false },
    join(projectRoot, 'electron.vite.config.ts'),
    projectRoot
  )
  const userCfg = loaded?.config ?? loaded
  const rendererCfg = userCfg?.renderer
  if (!rendererCfg?.plugins?.length) {
    check('D/加载 electron.vite.config.ts renderer 插件', false)
    return
  }
  const vite = await import('vite')
  const server = await vite.createServer({
    root: join(projectRoot, 'src', 'renderer'),
    configFile: false,
    plugins: rendererCfg.plugins,
    resolve: rendererCfg.resolve,
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    logLevel: 'error',
    clearScreen: false
  })
  await server.listen()
  const origin = new URL(server.resolvedUrls.local[0]).origin
  console.log(`[phaseD] 开发 server:${origin}`)
  try {
    const expected = developmentCsp(origin)
    for (const page of ['workbench', 'pet', 'panel']) {
      const res = await fetch(`${origin}/${page}.html`)
      const html = await res.text()
      const m = html.match(/<meta\s[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i)
      const cm = m ? m[0].match(/content=(["'])([\s\S]*?)\1/i) : null
      check(`D/${page}.html:dev meta = developmentCsp(实际 origin)`, Boolean(cm && cm[2] === expected), cm ? cm[2].slice(0, 120) : '无 meta')
      check(`D/${page}.html:开发策略不含生产 connect-src 'none'`, cm ? !cm[2].includes("connect-src 'none'") : false)
    }
    const wb = await (await fetch(`${origin}/workbench.html`)).text()
    check('D/workbench.html:React Refresh 内联脚本仅在开发放行存在', /react-refresh|@vitejs\/plugin-react|__vite_plugin_react_preamble/i.test(wb))
    check('D/workbench.html:开发产物不含生产常量原样 meta', !wb.includes(PRODUCTION_RENDERER_CSP))

    // HMR WebSocket:需携带 vite-hmr 子协议(vite 服务端按此头识别 HMR 客户端),
    // 连接后应立即收到 connected 消息
    const wsOrigin = origin.replace(/^http/, 'ws')
    const hmr = await new Promise((res) => {
      const ws = new WebSocket(`${wsOrigin}/`, 'vite-hmr')
      const timer = setTimeout(() => {
        try { ws.close() } catch { /* 忽略 */ }
        res(null)
      }, 5000)
      ws.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.type === 'connected') {
            clearTimeout(timer)
            try { ws.close() } catch { /* 忽略 */ }
            res('connected')
          }
        } catch {
          // 非 JSON 消息忽略
        }
      })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        res(null)
      })
    })
    check('D/HMR:WebSocket 收到 connected 消息(热更新通道可用)', hmr === 'connected')
  } finally {
    await server.close()
  }
}

// ---------- 主流程 ----------

async function main() {
  const startedAt = new Date().toISOString()
  console.log(`[smoke] 开始:${startedAt}`)
  console.log(`[smoke] project=${projectRoot}`)
  console.log(`[smoke] user-data=${userDataDir}`)

  // 前置检查:构建产物存在
  for (const p of [
    join(projectRoot, 'out', 'main', 'index.js'),
    join(projectRoot, 'out', 'preload', 'index.js'),
    join(projectRoot, 'out', 'renderer', 'workbench.html'),
    join(projectRoot, 'out', 'renderer', 'pet.html'),
    join(projectRoot, 'out', 'renderer', 'panel.html'),
    electronExe
  ]) {
    if (!existsSync(p)) {
      console.error(`[smoke] 缺少构建产物:${p}\n请先运行 npm run build`)
      process.exit(2)
    }
  }
  // 产物静态一致性(与 check-build 相同口径,额外留档)
  for (const page of ['workbench', 'pet', 'panel']) {
    const html = readFileSync(join(projectRoot, 'out', 'renderer', `${page}.html`), 'utf8')
    const m = html.match(/<meta\s[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi) ?? []
    check(`静态/${page}.html:产物 CSP meta 唯一且等于生产常量`, m.length === 1 && html.includes(PRODUCTION_RENDERER_CSP), `meta数=${m.length}`)
  }

  // --user-data 必须为空(拒绝复用非空目录)
  if (existsSync(userDataDir)) {
    const empty = statSync(userDataDir).isDirectory() && readdirSync(userDataDir).length === 0
    if (!empty) {
      console.error(`[smoke] 拒绝复用非空 --user-data 目录:${userDataDir}`)
      process.exit(2)
    }
  } else {
    mkdirSync(userDataDir, { recursive: true })
  }

  // Phase A
  await phaseA()

  // 受控 beacon:编排器内启动,覆盖 B/C 两阶段全程出站记录
  const beacon = await startBeacon()
  try {
    // Phase B(真实应用第一启)
    const app1 = await launchRealApp('B/启动应用')
    try {
      await phaseB(app1.port)
    } finally {
      // 连接在 phaseB 内已关闭
    }
    await quitRealApp(app1)
    const stillAlive = app1.proc.exitCode === null && !app1.proc.killed
    check('B/应用第一启正常退出', !stillAlive)

    // Phase C(重启 + 邮件夹具)
    await phaseC(beacon)
  } finally {
    beacon.close()
  }

  // Phase D(开发 server)
  await phaseD()

  // 汇总
  const report = {
    generatedAt: new Date().toISOString(),
    startedAt,
    project: projectRoot,
    userData: userDataDir,
    productionCsp: PRODUCTION_RENDERER_CSP,
    overall: failures.length === 0 ? 'pass' : 'fail',
    failures,
    notes
  }
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(report, null, 2))
  console.log(`[smoke] 完成:overall=${report.overall},failures=${failures.length}`)
  console.log(`[smoke] 报告已写入:${outputPath}`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[smoke] 未预期异常:', err)
  process.exit(1)
})
