// SEC-01 Phase A 探针 harness(在隔离 Electron 主进程内运行):
// 用本机 loopback 双服务器承载「被测页面 origin」与「外部攻击者 origin」,
// 把生产构建产物 HTML 原样注入探针与恶意正文夹具后加载到三个窗口,
// 采集 securitypolicyviolation、执行哨兵与出站记录。特权 Runtime.evaluate
// 仅用于读取页面脚本自己写好的报告,不作为"脚本被阻止"的证明来源。
//
// 用法:electron.exe scripts/acceptance/csp-probe-main.mjs --report <abs json> [--app-dir <root>]
// 退出码:0 正常;3 内部超时(60 秒)。

import { app, BrowserWindow, session } from 'electron'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { dirname, join, resolve, extname } from 'node:path'
import { tmpdir } from 'node:os'

const args = process.argv.slice(2)
function argOf(name, fallback = null) {
  const i = args.indexOf(name)
  return i !== -1 ? args[i + 1] : fallback
}

const reportPath = resolve(argOf('--report', 'csp-probe-report.json'))
const appDir = resolve(argOf('--app-dir', join(dirname(fileURL()), '..', '..')))
function fileURL() {
  // process.argv[1] 即本脚本路径
  return process.argv[1] ?? ''
}
const outRenderer = join(appDir, 'out', 'renderer')

const PAGES = ['workbench', 'pet', 'panel']
const PROBE_TIMEOUT_MS = 60_000

// ---------- 探针脚本(页面侧,受测 CSP 约束) ----------

// collector.js:注入在 CSP meta 之后、一切夹具之前,尽早登记违规采集器
const COLLECTOR_JS = `;(function () {
  window.__cspViolations = []
  window.addEventListener('securitypolicyviolation', function (e) {
    window.__cspViolations.push({
      directive: e.violatedDirective,
      blocked: String(e.blockedURL || ''),
      sample: String(e.sample || ''),
      target: String((e.target && (e.target.tagName || e.target.nodeName)) || '')
    })
  })
})()
`

// 恶意正文夹具:内联 script、事件属性、远程 script/img(指向受控攻击者 origin)
function fixtureHtml(beaconOrigin) {
  return `
<div id="csp-fixture" style="display:none" aria-hidden="true">
  <p>恶意正文夹具:以下内容应全部被 CSP 阻止。</p>
  <script>document.documentElement.dataset.cspInlineExecuted='1'<\/script>
  <img src="${beaconOrigin}/__csp_beacon/fixture-img.png" alt="">
  <script src="${beaconOrigin}/__csp_beacon/fixture-script.js"><\/script>
  <button id="csp-fixture-btn" onclick="document.documentElement.dataset.cspOnclickExecuted='1'">触发</button>
</div>
`
}

// probe.js:页面加载的本地探针( script-src 'self' 应放行),构造 DOM/网络违规尝试、
// 触发 Markdown blob 下载,并把报告写入 window.__cspProbeReport
function probeJs(beaconOrigin) {
  return `(async function () {
  var page = location.pathname.replace(/^\\//, '').replace(/\\.html$/, '')
  console.log('[probejs] start ' + page)
  var root = document.documentElement
  var report = {
    page: page,
    probeRan: true,
    sentinels: {
      inlineExecuted: root.dataset.cspInlineExecuted === '1',
      onclickExecuted: root.dataset.cspOnclickExecuted === '1',
      domInlineExecuted: false,
      domOnclickExecuted: false
    },
    violations: window.__cspViolations || [],
    fetchAttemptBlocked: null,
    fetchError: '',
    downloadTriggered: false
  }
  var BEACON = ${JSON.stringify(beaconOrigin)}
  try {
    var s1 = document.createElement('script')
    s1.textContent = "document.documentElement.dataset.cspDomInlineExecuted='1'"
    document.body.appendChild(s1)
    var s2 = document.createElement('script')
    s2.src = BEACON + '/__csp_beacon/dom-script.js'
    document.body.appendChild(s2)
    var img = document.createElement('img')
    img.src = BEACON + '/__csp_beacon/dom-img.png'
    document.body.appendChild(img)
    var fe = document.createElement('button')
    fe.setAttribute('onclick', "document.documentElement.dataset.cspDomOnclickExecuted='1'")
    document.body.appendChild(fe)
    fe.click()
  } catch (e) { report.probeError = String(e) }
  console.log('[probejs] before fetch')
  try {
    await fetch(BEACON + '/__csp_beacon/dom-fetch', { mode: 'no-cors' })
    report.fetchAttemptBlocked = false
  } catch (err) {
    report.fetchAttemptBlocked = true
    report.fetchError = String((err && err.message) || err)
  }
  console.log('[probejs] after fetch blocked=' + report.fetchAttemptBlocked)
  try {
    var blob = new Blob(['# CSP smoke export\\n\\nhello csp\\n'], { type: 'text/markdown;charset=utf-8' })
    var url = URL.createObjectURL(blob)
    var a = document.createElement('a')
    a.href = url
    a.download = 'csp-smoke-probe-export.md'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(function () { URL.revokeObjectURL(url) }, 2000)
    report.downloadTriggered = true
  } catch (err) {
    report.downloadTriggered = false
    report.downloadError = String((err && err.message) || err)
  }
  await new Promise(function (r) { setTimeout(r, 600) })
  console.log('[probejs] settle done')
  report.sentinels.domInlineExecuted = root.dataset.cspDomInlineExecuted === '1'
  report.sentinels.domOnclickExecuted = root.dataset.cspDomOnclickExecuted === '1'
  report.violations = window.__cspViolations || []
  window.__cspProbeReport = report
  console.log('CSP_PROBE_REPORT:' + JSON.stringify(report))
})().catch(function (e) { console.log('CSP_PROBE_FATAL:' + String(e)) })
`
}

// ---------- loopback 服务器 ----------

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function startServer(handler) {
  return new Promise((res) => {
    const srv = createServer(handler)
    srv.listen(0, '127.0.0.1', () => res(srv))
  })
}

const appServerRequests = []
let beaconLog = []
let appServer, beaconServer, beaconOrigin

async function startServers() {
  appServer = await startServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    appServerRequests.push({ path: url.pathname, ts: Date.now() })
    const name = url.pathname.replace(/^\//, '').replace(/\.html$/, '')
    if (PAGES.includes(name) && url.pathname.endsWith('.html')) {
      try {
        const raw = readFileSync(join(outRenderer, `${name}.html`), 'utf8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(injectProbe(raw, name))
      } catch (err) {
        res.writeHead(500)
        res.end(String(err))
      }
      return
    }
    if (url.pathname === '/__probe/collector.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' })
      res.end(COLLECTOR_JS)
      return
    }
    if (url.pathname === '/__probe/probe.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' })
      res.end(currentProbeJs.probe ?? '')
      return
    }
    if (url.pathname.startsWith('/assets/')) {
      try {
        const asset = readFileSync(join(outRenderer, url.pathname))
        const mime = extname(url.pathname) === '.css' ? 'text/css' : 'application/javascript'
        res.writeHead(200, { 'Content-Type': mime })
        res.end(asset)
      } catch {
        res.writeHead(404)
        res.end('asset not found')
      }
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  beaconServer = await startServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    beaconLog.push({
      ts: Date.now(),
      path: url.pathname,
      method: req.method,
      ua: req.headers['user-agent'] ?? ''
    })
    const body = url.pathname.endsWith('.png') ? PNG_1PX : '/* beacon */'
    res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.png') ? 'image/png' : 'text/javascript' })
    res.end(body)
  })
  const appAddr = appServer.address()
  const beaconAddr = beaconServer.address()
  appOrigin = `http://127.0.0.1:${appAddr.port}`
  beaconOrigin = `http://127.0.0.1:${beaconAddr.port}`
}

let appOrigin = ''
const currentProbeJs = {}

function injectProbe(html, page) {
  currentProbeJs.probe = probeJs(beaconOrigin)
  const collectorTag = '<script src="/__probe/collector.js"></script>'
  let out = html
  const metaMatch = out.match(/<meta\s[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i)
  if (metaMatch) {
    out = out.replace(metaMatch[0], metaMatch[0] + collectorTag)
  }
  const fixture =
    fixtureHtml(beaconOrigin) + `<script src="/__probe/probe.js"></script>`
  out = out.includes('</body>') ? out.replace('</body>', fixture + '</body>') : out + fixture
  return out
}

// ---------- 窗口与采集 ----------

// 全局异常兜底:任何未捕获错误/未处理拒绝都落盘,避免主进程静默退出无证据
process.on('uncaughtException', (err) => {
  try {
    writeFileSync(
      reportPath,
      JSON.stringify({ status: 'uncaught', error: String(err && err.stack || err), beacon: beaconLog, downloads: [] }, null, 2)
    )
  } catch { /* 尽力而为 */ }
  app.exit(5)
})
process.on('unhandledRejection', (reason) => {
  try {
    writeFileSync(
      reportPath,
      JSON.stringify({ status: 'unhandled-rejection', error: String(reason && reason.stack || reason), beacon: beaconLog, downloads: [] }, null, 2)
    )
  } catch { /* 尽力而为 */ }
  app.exit(6)
})

function collectConsole(win, sink) {
  win.webContents.on('console-message', (...args) => {
    const first = args[0]
    if (first && typeof first === 'object' && 'detail' in first) {
      sink.push(String(first.detail?.message ?? ''))
    } else {
      sink.push(String(args[2] ?? ''))
    }
  })
}

const pagesReport = {}
const consoleSink = {}

async function waitForReport(page, deadline) {
  const win = pagesReport[page].win
  while (Date.now() < deadline) {
    try {
      const got = await win.webContents.executeJavaScript('window.__cspProbeReport ?? null', true)
      if (got) return got
    } catch {
      // 页面尚未就绪,继续等待
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
}

async function main() {
  console.log('[probe] main 开始')
  // 隔离 userData:探针进程不复用任何真实目录
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'csp-probe-user-')))
  app.commandLine.appendSwitch('no-proxy-server')
  await app.whenReady()
  console.log('[probe] app ready')
  await startServers()
  console.log(`[probe] servers: app=${appOrigin} beacon=${beaconOrigin}`)

  const deadline = Date.now() + PROBE_TIMEOUT_MS
  const downloads = []
  session.defaultSession.on('will-download', (_e, item) => {
    const save = join(tmpdir(), `csp-probe-dl-${Date.now()}-${item.getFilename()}`)
    item.setSavePath(save)
    item.once('done', () => {
      try {
        downloads.push({ filename: item.getFilename(), savePath: save, size: item.getTotalBytes() })
      } catch {
        downloads.push({ filename: item.getFilename(), savePath: save, size: -1 })
      }
    })
  })

  for (const page of PAGES) {
    console.log(`[probe] 加载 ${page}`)
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    consoleSink[page] = []
    collectConsole(win, consoleSink[page])
    pagesReport[page] = { win, consoleText: consoleSink[page], report: null }
    await win.loadURL(`${appOrigin}/${page}.html`)
  }

  for (const page of PAGES) {
    console.log(`[probe] 等待报告 ${page}`)
    pagesReport[page].report = await waitForReport(page, deadline)
  }
  console.log('[probe] 报告齐备,写文件')

  const result = {
    status: PAGES.every((p) => pagesReport[p].report) ? 'ok' : 'timeout',
    appOrigin,
    beaconOrigin,
    pages: Object.fromEntries(
      PAGES.map((p) => [
        p,
        { report: pagesReport[p].report, consoleText: pagesReport[p].consoleText.join('\n') }
      ])
    ),
    appServerRequests,
    beacon: beaconLog,
    downloads
  }
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(result, null, 2))
  app.exit(result.status === 'ok' ? 0 : 3)
}

setTimeout(() => {
  try {
    writeFileSync(
      reportPath,
      JSON.stringify({ status: 'timeout', pages: {}, beacon: beaconLog, downloads: [] }, null, 2)
    )
  } catch {
    // 报告写不进也得退出
  }
  app.exit(3)
}, PROBE_TIMEOUT_MS + 5_000).unref()

main().catch(async (err) => {
  try {
    writeFileSync(
      reportPath,
      JSON.stringify({ status: 'error', error: String(err), beacon: beaconLog, downloads: [] }, null, 2)
    )
  } catch {
    // 同上
  }
  app.exit(4)
})
