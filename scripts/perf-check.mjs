// PKG-01 验收性能基准(delivery.md PKG-01):Node 进程内直接用 sql.js 构造数据执行。
//
// 环境口径(如实记录,不冒充):本脚本为 Node 基准,测量 sql.js 查询本身
// (SQL 与生产 dao/search 完全同形,行读取方式与 SqliteDb.all 一致);
// Electron 真实 IPC/runtime 环境的暖态查询由桌面验收补测。
//
// 场景与阈值:
// - 场景 1:1000 条合成任务,暖态只读查询 100 次,p95 ≤ 500ms;
//   查询与 src/main/db/dao.ts listTodos 同形(含 20% 行的 linked event 回查,
//   对应 attachLinkedEvent 的真实负载);
// - 场景 2:200 文档、共 2400 chunk(≥2000),固定 MATCH 查询 100 次,热查询 p95 ≤ 1s;
//   查询与 src/main/retrieval/search.ts 的无冻结集合路径同形(候选 LIMIT → JOIN),
//   外加与生产一致的应用层词频计分循环(search_text 空格分词)。
//
// 结果写入 artifacts/build/perf-report.json;任一场景超标如实记录 FAIL 并以
// 退出码 1 结束,不通过调整数据或计时方式掩盖。

import { createHash } from 'node:crypto'
import { availableParallelism } from 'node:os'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ITERATIONS = 100
const WARMUP = 5

// ---------- sql.js 初始化(与 src/main/db/connection.ts 相同的 wasm 加载方式) ----------
const initSqlJs = (await import('sql.js')).default
const wasmBinary = readFileSync(join(root, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'))
const SQL = await initSqlJs({ wasmBinary })
const raw = new SQL.Database()

/** 与 SqliteDb.all 同形的行读取:prepare → bind → step → getAsObject */
function all(sql, params = []) {
  const stmt = raw.prepare(sql)
  try {
    if (params.length > 0) stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    return rows
  } finally {
    stmt.free()
  }
}
function run(sql, params = []) {
  raw.run(sql, params.length > 0 ? params : undefined)
}

// ---------- 计时工具:p50/p95/max ----------
function percentile(sorted, p) {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

async function measure(scenarioName, { warmup, iterations, thresholdMs, body }) {
  for (let i = 0; i < warmup; i++) body() // 暖态:不计入
  const samples = []
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint()
    body()
    const t1 = process.hrtime.bigint()
    samples.push(Number(t1 - t0) / 1e6)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const p95 = percentile(sorted, 95)
  const result = {
    name: scenarioName,
    warmupRuns: warmup,
    iterations,
    p50Ms: round2(percentile(sorted, 50)),
    p95Ms: round2(p95),
    maxMs: round2(sorted[sorted.length - 1]),
    thresholdMs,
    pass: p95 <= thresholdMs
  }
  console.log(
    `[perf] ${scenarioName}: p50=${result.p50Ms}ms p95=${result.p95Ms}ms max=${result.maxMs}ms ` +
      `阈值=${thresholdMs}ms → ${result.pass ? 'PASS' : 'FAIL'}`
  )
  return result
}
function round2(n) {
  return Math.round(n * 100) / 100
}

// ---------- 场景 1:1000 合成任务,暖态只读查询 ----------
const TODO_COLS =
  'id, title, notes, due_at AS dueAt, priority, completed_at AS completedAt, linked_event_id AS linkedEventId, source, source_ref AS sourceRef, fingerprint, revision, created_at AS createdAt, updated_at AS updatedAt'
// events 表结构与 src/main/db/schema.ts 一致(attachLinkedEvent 回查目标)
run(`
CREATE TABLE events (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0, color TEXT, location TEXT, notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual', source_ref TEXT, reminder_minutes INTEGER,
  status TEXT NOT NULL DEFAULT 'active', fingerprint TEXT, revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)`)
run(`
CREATE TABLE todos (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT, due_at TEXT,
  priority TEXT NOT NULL DEFAULT 'normal', completed_at TEXT, linked_event_id TEXT,
  source TEXT NOT NULL DEFAULT 'manual', source_ref TEXT, fingerprint TEXT,
  revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)`)

const TODO_COUNT = 1000
raw.exec('BEGIN')
for (let i = 0; i < TODO_COUNT; i++) {
  const id = `todo-${String(i).padStart(5, '0')}`
  // 20% 行挂接事件,对应 attachLinkedEvent 的每行回查负载
  const linked = i % 5 === 0 ? `event-${String(i).padStart(5, '0')}` : null
  if (linked) {
    run('INSERT INTO events (id, title, start_at, end_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
      linked,
      `合成日程 ${i}`,
      '2026-10-10T09:00:00.000Z',
      '2026-10-10T10:00:00.000Z',
      '2026-09-30T00:00:00.000Z',
      '2026-09-30T00:00:00.000Z'
    ])
  }
  run(
    'INSERT INTO todos (id, title, notes, due_at, priority, completed_at, linked_event_id, source, fingerprint, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      `合成待办 ${i}`,
      `第 ${i} 项合成任务说明,用于打包验收性能基准`,
      i % 3 === 0 ? null : `2026-10-${String((i % 28) + 1).padStart(2, '0')}T08:00:00.000Z`,
      ['low', 'normal', 'high'][i % 3],
      null,
      linked,
      'manual',
      `fp-${createHash('sha256').update(id).digest('hex').slice(0, 16)}`,
      1,
      '2026-09-30T00:00:00.000Z',
      '2026-09-30T00:00:00.000Z'
    ]
  )
}
raw.exec('COMMIT')

function listTodosEquivalent() {
  // 与 listTodos 同形:主查询 + 每行 linked event 回查(仅 linkedEventId 非空时)
  const rows = all(`SELECT ${TODO_COLS} FROM todos ORDER BY (due_at IS NULL), due_at, created_at`)
  const events = new Map()
  for (const t of rows) {
    if (t.linkedEventId) {
      if (!events.has(t.linkedEventId)) {
        events.set(t.linkedEventId, all('SELECT * FROM events WHERE id = ? LIMIT 1', [t.linkedEventId])[0] ?? null)
      }
      t.linkedEvent = events.get(t.linkedEventId)
    }
  }
  return rows
}

const todoCount = all('SELECT count(*) AS n FROM todos')[0].n
const scenario1 = await measure('todos-1000-warm-readonly', {
  warmup: WARMUP,
  iterations: ITERATIONS,
  thresholdMs: 500,
  body: listTodosEquivalent
})
console.log(`[perf] 场景 1 数据量:todos=${todoCount}, events=${all('SELECT count(*) AS n FROM events')[0].n}`)

// ---------- 场景 2:200 文档 ≥2000 chunk,固定 MATCH 查询 ----------
run(`
CREATE TABLE retrieval_documents (
  document_id TEXT PRIMARY KEY, source_name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('markdown', 'txt', 'json', 'csv')),
  raw_sha256 TEXT NOT NULL, text_sha256 TEXT NOT NULL, normalized_text TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0), created_at TEXT NOT NULL
)`)
run(`
CREATE TABLE retrieval_chunks (
  chunk_id TEXT PRIMARY KEY, document_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset >= start_offset),
  content TEXT NOT NULL, search_text TEXT NOT NULL,
  search_version INTEGER NOT NULL CHECK (search_version >= 1)
)`)
run('CREATE INDEX idx_retrieval_chunks_doc ON retrieval_chunks (document_id, chunk_index)')
run(`CREATE VIRTUAL TABLE retrieval_fts USING fts4(search_text, content="retrieval_chunks")`)

const DOC_COUNT = 200
const CHUNKS_PER_DOC = 12 // 200 × 12 = 2400 chunks ≥ 2000
const VOCAB = ['会议', '日程', '报告', '审批', '预算', '总结', '计划', '通知', '资料', '复查', '归档', '草稿']
const MATCH_TERM = '会议' // 固定查询词:每个 chunk 语料都含该词,命中候选上限 500

raw.exec('BEGIN')
for (let d = 0; d < DOC_COUNT; d++) {
  const documentId = `doc-${String(d).padStart(4, '0')}`
  const normalizedParts = []
  for (let c = 0; c < CHUNKS_PER_DOC; c++) {
    const tokens = []
    for (let k = 0; k < 40; k++) tokens.push(VOCAB[(d + c + k) % VOCAB.length])
    tokens[d % tokens.length] = MATCH_TERM // 保证命中
    const searchTokens = [...tokens, ...tokens.slice(0, 8)] // 词频有差异,计分非退化
    const content = `文档${d}分块${c}:${tokens.join('')}。`
    run(
      'INSERT INTO retrieval_chunks (chunk_id, document_id, chunk_index, start_offset, end_offset, content, search_text, search_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [`chunk-${d}-${c}`, documentId, c, c * 100, c * 100 + content.length, content, searchTokens.join(' '), 1]
    )
    normalizedParts.push(content)
  }
  const normalized = normalizedParts.join('\n')
  run(
    'INSERT INTO retrieval_documents (document_id, source_name, source_type, raw_sha256, text_sha256, normalized_text, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      documentId,
      `合成资料 ${d}.md`,
      'markdown',
      createHash('sha256').update(normalized).digest('hex'),
      createHash('sha256').update(normalized).digest('hex'),
      normalized,
      Buffer.byteLength(normalized, 'utf-8'),
      '2026-09-30T00:00:00.000Z'
    ]
  )
}
// fts4 external content 表:与 importer.ts 相同的手动 docid 写入
for (const row of all('SELECT rowid AS rid, search_text FROM retrieval_chunks')) {
  run('INSERT INTO retrieval_fts(docid, search_text) VALUES (?, ?)', [row.rid, row.search_text])
}
raw.exec('COMMIT')

const chunkTotal = all('SELECT count(*) AS n FROM retrieval_chunks')[0].n
const MATCH_CANDIDATE_LIMIT = 500 // 与 search.ts 常量一致

function searchEquivalent() {
  // 与 search.ts 无冻结集合路径同形:候选 LIMIT → JOIN 取行 → 应用层词频计分
  const candidates = all(`SELECT docid FROM retrieval_fts WHERE retrieval_fts MATCH ? LIMIT ${MATCH_CANDIDATE_LIMIT}`, [MATCH_TERM])
  if (candidates.length === 0) return []
  const placeholders = candidates.map(() => '?').join(', ')
  const rows = all(
    `SELECT c.chunk_id, c.document_id, c.chunk_index, c.start_offset, c.end_offset,
            c.content, c.search_text, d.source_name, d.source_type
       FROM retrieval_chunks c
       JOIN retrieval_documents d ON d.document_id = c.document_id
      WHERE c.rowid IN (${placeholders})`,
    candidates.map((c) => c.docid)
  )
  const distinct = [MATCH_TERM]
  return rows.map((row) => {
    const chunkTokens = row.search_text.length === 0 ? [] : row.search_text.split(' ')
    const counts = new Map()
    for (const token of chunkTokens) counts.set(token, (counts.get(token) ?? 0) + 1)
    let score = 0
    for (const token of distinct) score += counts.get(token) ?? 0
    return { chunkId: row.chunk_id, score }
  })
}

const scenario2 = await measure('retrieval-200docs-2400chunks-hot-query', {
  warmup: WARMUP,
  iterations: ITERATIONS,
  thresholdMs: 1000,
  body: searchEquivalent
})
console.log(`[perf] 场景 2 数据量:documents=${DOC_COUNT}, chunks=${chunkTotal};固定词 "${MATCH_TERM}" 命中候选上限 ${MATCH_CANDIDATE_LIMIT}`)

// ---------- 汇总输出 ----------
const report = {
  schemaVersion: 1,
  generatedAtUtc: new Date().toISOString(),
  environment: {
    kind: 'node-in-process (sql.js 直连;Electron 真实 IPC 环境由桌面验收补测)',
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    parallelism: availableParallelism(),
    sqlJsWasm: 'node_modules/sql.js/dist/sql-wasm.wasm'
  },
  dataset: {
    todos: todoCount,
    events: all('SELECT count(*) AS n FROM events')[0].n,
    documents: DOC_COUNT,
    chunks: chunkTotal
  },
  scenarios: [scenario1, scenario2],
  allPass: scenario1.pass && scenario2.pass
}

const outFile = join(root, 'artifacts', 'build', 'perf-report.json')
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
console.log(`[perf] 报告已写入 ${outFile}`)
process.exit(report.allPass ? 0 : 1)
