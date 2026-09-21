#!/usr/bin/env node
// O2 基线测量器:在 Node 中用 sql.js 建立固定种子合成数据集并测量典型查询耗时。
// 用法:node scripts/measure-baseline.mjs [--output <path>]
//   --output <path>  将基线 JSON 写入指定文件(自动创建父目录);缺省时打印到 stdout。
// 只生成内存合成数据,不读取真实 userData 或任何真实数据库文件。
// 本报告仅是 Node 中 sql.js 的查询基准,不代表 Electron 主进程延迟或 Windows 主线程阻塞指标。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { arch, cpus, platform } from 'node:os'
import { fileURLToPath } from 'node:url'
import initSqlJs from 'sql.js'

const FIXED_SEED = 20260920
const EVENTS_COUNT = 10_000
const TODOS_COUNT = 10_000
const MAILS_COUNT = 10_000
const WARMUP_RUNS = 3
const MEASURED_RUNS = 30

/** 固定种子 PRNG(mulberry32):同一种子每次运行生成完全相同的合成数据 */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 把 PRNG 输出映射为 [min, max) 的整数 */
function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min))
}

/** 从固定词表确定性拼出标题,避免随机文本影响可读性 */
const TITLE_WORDS = ['周报', '评审', '复盘', '采购', '面谈', '巡检', '还款', '体检', '培训', '交付']
function titleOf(rng, prefix) {
  const word = TITLE_WORDS[randInt(rng, 0, TITLE_WORDS.length)]
  return `${prefix}-${word}-${randInt(rng, 0, 1000)}`
}

/** 在固定时间跨度 [2025-01-01, 2028-01-01) 内取对齐到分钟的 UTC 毫秒 */
const SPAN_START_MS = Date.UTC(2025, 0, 1)
const SPAN_MS = Date.UTC(2028, 0, 1) - SPAN_START_MS
function timestampOf(rng, offsetMinutes = 0) {
  const ms = SPAN_START_MS + Math.floor((rng() * SPAN_MS) / 60_000) * 60_000 + offsetMinutes * 60_000
  return new Date(ms).toISOString()
}

// 镜像 src/main/db/schema.ts 与 src/main/mail/schema.ts 的表与索引,保证基准结构代表真实库
const SCHEMA_SQL = `
CREATE TABLE events (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0, color TEXT, location TEXT, notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual', source_ref TEXT, reminder_minutes INTEGER,
  status TEXT NOT NULL DEFAULT 'active', fingerprint TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_events_start ON events (start_at);
CREATE TABLE todos (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT, due_at TEXT,
  priority TEXT NOT NULL DEFAULT 'normal', completed_at TEXT, linked_event_id TEXT,
  source TEXT NOT NULL DEFAULT 'manual', source_ref TEXT, fingerprint TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE mail_accounts (
  id TEXT PRIMARY KEY, address TEXT NOT NULL, provider TEXT NOT NULL,
  display_name TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE mail_messages (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  mailbox TEXT NOT NULL, uid_validity TEXT, uid INTEGER, remote_message_id TEXT,
  subject TEXT NOT NULL, sender TEXT NOT NULL, recipients TEXT NOT NULL,
  received_at TEXT NOT NULL, size INTEGER NOT NULL, read_local INTEGER NOT NULL,
  body_state TEXT NOT NULL DEFAULT 'missing', body_path TEXT, body_structure TEXT NOT NULL,
  remote_available INTEGER NOT NULL DEFAULT 1,
  UNIQUE(account_id, mailbox, uid_validity, uid)
);
CREATE INDEX idx_mail_list ON mail_messages (account_id, received_at DESC, id DESC);
`

/** 生成固定种子的合成行数据(纯 JS 数组,尚未入库) */
function buildDataset() {
  const rng = mulberry32(FIXED_SEED)
  const pad = (n) => String(n).padStart(12, '0')
  const events = []
  const todos = []
  const mails = []
  for (let i = 0; i < EVENTS_COUNT; i += 1) {
    const startAt = timestampOf(rng)
    const endAt = timestampOf(rng, randInt(rng, 15, 121))
    const createdAt = timestampOf(rng)
    events.push([
      `evt-${pad(i)}`, titleOf(rng, '日程'), startAt, endAt,
      rng() < 0.05 ? 1 : 0, null, null, null,
      'manual', null, rng() < 0.4 ? [5, 10, 15, 30, 60][randInt(rng, 0, 5)] : null,
      rng() < 0.02 ? 'cancelled' : 'active', null, createdAt, createdAt
    ])
  }
  for (let i = 0; i < TODOS_COUNT; i += 1) {
    const createdAt = timestampOf(rng)
    todos.push([
      `todo-${pad(i)}`, titleOf(rng, '待办'), null, rng() < 0.7 ? timestampOf(rng) : null,
      ['low', 'normal', 'high'][randInt(rng, 0, 3)], rng() < 0.3 ? timestampOf(rng) : null, null,
      'manual', null, null, createdAt, createdAt
    ])
  }
  for (let i = 0; i < MAILS_COUNT; i += 1) {
    const receivedAt = timestampOf(rng)
    mails.push([
      `mail-${pad(i)}`, 'acc-baseline', 'INBOX', '1', i + 1, `remote-${i + 1}@baseline`,
      titleOf(rng, '邮件'), `sender${randInt(rng, 0, 50)}@example.com`, '["me@example.com"]',
      receivedAt, randInt(rng, 1_000, 500_000), rng() < 0.5 ? 1 : 0,
      'missing', null, '[]', 1
    ])
  }
  return { events, todos, mails }
}

/** 就绪的 sql.js 实例与版本号 */
async function openSqlJs() {
  // 通过 require.resolve 定位 sql.js 的 dist 目录,显式读取 WASM 二进制,避免运行时 locateFile 歧义
  const require = createRequire(import.meta.url)
  const sqlJsDistDir = dirname(require.resolve('sql.js'))
  const wasmBinary = readFileSync(join(sqlJsDistDir, 'sql-wasm.wasm'))
  const SQL = await initSqlJs({ wasmBinary })
  const sqlJsVersion = JSON.parse(readFileSync(join(sqlJsDistDir, '..', 'package.json'), 'utf8')).version
  return { SQL, sqlJsVersion }
}

/** 在单个事务内批量插入(准备语句 + 循环绑定) */
function insertRows(db, sql, rows) {
  const stmt = db.prepare(sql)
  db.run('BEGIN')
  try {
    for (const row of rows) stmt.run(row)
    db.run('COMMIT')
  } catch (error) {
    db.run('ROLLBACK')
    throw error
  } finally {
    stmt.free()
  }
}

/** 绑定参数并完整消费结果行(模拟真实读取) */
function drainQuery(db, sql, params) {
  const stmt = db.prepare(sql)
  try {
    stmt.bind(params)
    let rowCount = 0
    while (stmt.step()) rowCount += 1
    return rowCount
  } finally {
    stmt.free()
  }
}

/** 单表行数(用于把真实入库行数写入报告,而非仅报告配置值) */
function countRows(db, table) {
  const stmt = db.prepare(`SELECT COUNT(*) FROM ${table}`)
  try {
    stmt.step()
    return stmt.get()[0]
  } finally {
    stmt.free()
  }
}

/** 最近邻秩百分位:sorted 升序,index = floor(p * (n - 1)) */
function percentile(sortedAsc, p) {
  return sortedAsc[Math.floor(p * (sortedAsc.length - 1))]
}

/** 预热后重复计时同一查询,返回毫秒统计 */
function measureQuery(db, sql, params) {
  for (let i = 0; i < WARMUP_RUNS; i += 1) drainQuery(db, sql, params)
  const samples = []
  for (let i = 0; i < MEASURED_RUNS; i += 1) {
    const startedAt = performance.now()
    drainQuery(db, sql, params)
    samples.push(performance.now() - startedAt)
  }
  samples.sort((a, b) => a - b)
  return {
    p50Ms: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    minMs: Number(samples[0].toFixed(3)),
    maxMs: Number(samples[samples.length - 1].toFixed(3)),
    runs: MEASURED_RUNS,
    warmupRuns: WARMUP_RUNS
  }
}

// CLI 参数:目前仅支持 --output <path>
const args = process.argv.slice(2)
let outputPath
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--output') {
    outputPath = args[i + 1]
    i += 1
  }
}

const { SQL, sqlJsVersion } = await openSqlJs()
const db = new SQL.Database()

const { events, todos, mails } = buildDataset()
db.run(SCHEMA_SQL)
db.run("INSERT INTO mail_accounts (id, address, provider, display_name, enabled, created_at) VALUES ('acc-baseline', 'baseline@example.com', 'imap', '基线账号', 1, '2025-01-01T00:00:00.000Z')")
insertRows(db, 'INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', events)
insertRows(db, 'INSERT INTO todos VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', todos)
insertRows(db, 'INSERT INTO mail_messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', mails)

// 基准查询镜像典型页面读取:日历周视图区间、待办列表、邮件最近列表
const measurements = {
  eventsRange: measureQuery(
    db,
    "SELECT id, title, start_at, end_at FROM events WHERE status = 'active' AND start_at >= ? AND start_at < ? ORDER BY start_at",
    ['2026-06-01T00:00:00.000Z', '2026-06-08T00:00:00.000Z']
  ),
  todosOpen: measureQuery(
    db,
    'SELECT id, title, due_at FROM todos WHERE completed_at IS NULL ORDER BY updated_at DESC LIMIT 100',
    []
  ),
  mailsRecent: measureQuery(
    db,
    'SELECT id, subject, sender, received_at FROM mail_messages WHERE account_id = ? AND received_at >= ? ORDER BY received_at DESC LIMIT 50',
    ['acc-baseline', '2027-12-02T00:00:00.000Z']
  )
}

const report = {
  reportVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    sqljs: sqlJsVersion,
    platform: platform(),
    arch: arch(),
    cpuModel: cpus()[0]?.model ?? 'unknown',
    cpuCount: cpus().length,
    seed: FIXED_SEED
  },
  dataset: {
    events: countRows(db, 'events'),
    todos: countRows(db, 'todos'),
    mails: countRows(db, 'mail_messages'),
    warmupRuns: WARMUP_RUNS,
    measuredRuns: MEASURED_RUNS
  },
  measurements,
  notes: [
    '本报告仅是 Node 环境中 sql.js 的查询基准,不代表 Electron 主进程延迟或 Windows 主线程阻塞指标。',
    '暖态查询 P95 300ms 与交互连续阻塞 100ms 的验收需在真实 Windows/Electron runtime 单独采集环境、版本和 trace。',
    '数据集为固定种子(20260920)合成数据,不读取真实 userData 或任何真实数据库文件。'
  ]
}

db.close()
const json = JSON.stringify(report, null, 2)
if (outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, json, 'utf8')
  console.log(`基线报告已写入 ${outputPath}`)
  console.log(`dataset: events=${report.dataset.events} todos=${report.dataset.todos} mails=${report.dataset.mails}`)
  for (const [name, stat] of Object.entries(measurements)) {
    console.log(`${name}: p50=${stat.p50Ms}ms p95=${stat.p95Ms}ms runs=${stat.runs}`)
  }
} else {
  console.log(json)
}
