// R-08 演示复现与交付核查(执行清单步骤 28):四条演示路线的自动化验收脚本。
//
// 形态说明:scripts/ 下现有脚本均为 .mjs(gen-assets 等,构建/资产工具),项目无 TS
// 直跑运行器(package.json 无 tsx/ts-node,electron-vite 不产出可独立执行的 CLI),
// 因此按任务契约采用 vitest 测试形态:
//   npx vitest run tests/research/demoRun.test.ts
// 执行清单步骤 18 已注明「CLI 形态待定,原项目无独立 CLI 入口」——复现入口为
// 本脚本与桌面端研究工作台(R-06 IPC 链路)两条路线,不虚构未实现的命令。
//
// 覆盖场景(每条路线独立空数据库:mkdtemp+openDatabase+initSchema,与
// tests/helpers.ts 的 makeTestDb 惯例一致):
//   normal       单文档定位:导入→创建运行→fake 驱动→succeeded/final,证据闭包;
//   conflict     两快照学历冲突:conflict_group/unresolved 并列不投票,报告冲突章节;
//   insufficient 证据不足:空候选诚实不足,unanswered_subquestions 非空、claim 为零;
//   injection    提示注入:全程零工具调用、业务表零写入、报告不含注入指令。
// 附加核查:清单冻结校验(sha256 双向)、断网守卫(fetch 抛错)、报告落盘重开恢复、
// 模型不可达诚实收尾(failed/MODEL_UNAVAILABLE,不伪装 partial)。
// 产物写入 artifacts/research/demo/(summary.json + 各路线导出包;.gitignore 忽略)。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase, type SqliteDb } from '../../src/main/db/connection'
import { initSchema } from '../../src/main/db/dao'
import { initWorkspaceEpoch } from '../../src/main/db/operations'
import { fixedClock } from '../../src/shared/clock'
import { RunQueue } from '../../src/main/agent/runQueue'
import { FakeProvider } from '../../src/main/providers/fake'
import type { StructuredCompleteRequest } from '../../src/main/agent/llm'
import { ResearchWorkflow } from '../../src/main/research/workflow'
import { importResearchSources } from '../../src/main/research/snapshots'
import { getResearchTaskByRun, latestReport, listClaims, listSubQuestions } from '../../src/main/research/repository'
import { assembleReportResponse, type ReportResponse } from '../../src/main/research/reports'
import { getRun, listTraceEvents } from '../../src/main/runs/repository'

const ROOT = process.cwd()
const SQL_JS_DIST = join(ROOT, 'node_modules', 'sql.js', 'dist')
const MANIFEST_PATH = join(ROOT, 'fixtures', 'research', 'demo', 'manifest.json')
const FIXTURE_BASE = join(ROOT, 'fixtures', 'research')
const SNAPSHOT_BASE = join(ROOT, 'evals', 'datasets', 'research_v1', 'snapshots')
const ARTIFACTS_DIR = join(ROOT, 'artifacts', 'research', 'demo')
const DEMO_CLOCK = fixedClock('2026-09-28T01:00:00.000Z')

// ---------- 演示清单(fixtures/research/demo/manifest.json):冻结锚点 ----------

interface DemoManifestRoute {
  route_id: string
  fixture_id: string
  case_ref: string
  question: string
  corpus: string[]
  corpus_sha256: Record<string, { raw_sha256: string; text_sha256: string }>
  evidence_anchors: Array<{ logical_snapshot: string; quote: string }>
  expected: { terminal_status: string; report_state: string; features: string[] }
}

interface DemoManifest {
  schema_version: number
  base: string
  routes: DemoManifestRoute[]
}

function loadDemoManifest(): DemoManifest {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as DemoManifest
  expect(manifest.schema_version).toBe(1)
  expect(manifest.base).toBe('fixtures/research')
  return manifest
}

/** 清单冻结校验:语料存在、raw_sha256 与文件字节一致、与数据集快照副本逐字节一致 */
function verifyManifestFrozen(manifest: DemoManifest): void {
  for (const route of manifest.routes) {
    const snapManifest = JSON.parse(
      readFileSync(join(SNAPSHOT_BASE, route.fixture_id, 'manifest.json'), 'utf-8')
    ) as { entries: Array<{ file: string; raw_sha256: string }> }
    for (const rel of route.corpus) {
      const fixFile = join(FIXTURE_BASE, rel)
      const snapFile = join(SNAPSHOT_BASE, rel)
      expect(existsSync(fixFile), `缺少演示语料:${rel}`).toBe(true)
      expect(existsSync(snapFile), `缺少数据集快照副本:${rel}`).toBe(true)
      const bytes = readFileSync(fixFile)
      const raw = createHash('sha256').update(bytes).digest('hex')
      expect(raw, `raw_sha256 漂移:${rel}`).toBe(route.corpus_sha256[rel]!.raw_sha256)
      expect(bytes.equals(readFileSync(snapFile)), `fixtures 与 snapshots 副本不一致:${rel}`).toBe(true)
      const entry = snapManifest.entries.find((e) => e.file === rel.split('/')[1])
      expect(entry?.raw_sha256, `数据集 manifest raw_sha256 漂移:${rel}`).toBe(raw)
    }
  }
}

// ---------- 语料读取与导入(从空数据库) ----------

interface ImportedCorpus {
  /** 逻辑 id(`<fixture_id>/<file>`)→ 真实 snapshot_id */
  idByLogical: Map<string, string>
  /** 逻辑 id → 规范全文(锚点码点 offset 的计算基准) */
  textByLogical: Map<string, string>
}

function importCorpus(db: SqliteDb, route: DemoManifestRoute): ImportedCorpus {
  const outcomes = importResearchSources(db, {
    sources: route.corpus.map((rel) => ({
      sourceName: rel.split('/')[1]!,
      bytes: readFileSync(join(FIXTURE_BASE, rel))
    })),
    clock: DEMO_CLOCK
  })
  expect(outcomes.every((o) => o.ok), JSON.stringify(outcomes.filter((o) => !o.ok))).toBe(true)
  const idByLogical = new Map<string, string>()
  for (const o of outcomes) {
    if (o.ok) idByLogical.set(`${route.fixture_id}/${o.sourceName}`, o.documentId)
  }
  const textByLogical = new Map<string, string>()
  for (const [logical, documentId] of idByLogical) {
    const row = db.get<{ normalized_text: string }>(
      'SELECT normalized_text FROM retrieval_documents WHERE document_id = ?',
      [documentId]
    )
    textByLogical.set(logical, row?.normalized_text ?? '')
  }
  return { idByLogical, textByLogical }
}

// ---------- fake 脚本(按 request.system 角色分支,与调用次数解耦) ----------
//
// 语料感知方式与 src/main/evals/researchAdapter.ts 同一思路:抽取阶段从 prompt 解析
// 本次交付的 snapshot_id/chunk_id 与块原文,quote 取清单锚点所在的逐字行,offset 由
// 服务端验证——quote/offset 均来自语料真实内容,不是模型编造。

/** 交付块解析:取「- snapshot_id=… chunk_id=…」标记行之后、下一标记之前的完整原文 */
function parseDeliveredChunks(
  prompt: string
): Array<{ snapshotId: string; chunkId: string; content: string }> {
  const out: Array<{ snapshotId: string; chunkId: string; content: string }> = []
  const lines = prompt.split('\n')
  const marker = /^- snapshot_id=(\S+) chunk_id=(\S+)$/
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i]!.match(marker)
    if (!m) continue
    const contentLines: string[] = []
    for (let j = i + 1; j < lines.length; j += 1) {
      if (marker.test(lines[j]!)) break
      contentLines.push(lines[j]!.replace(/^\s*原文:/, ''))
    }
    out.push({ snapshotId: m[1]!, chunkId: m[2]!, content: contentLines.join('\n') })
  }
  return out
}

/** 交付块内包含锚点引用的整行(quote 逐字摘自语料;行级引用在 chunk 内唯一) */
function anchorLineOf(content: string, quote: string): string | null {
  for (const line of content.split('\n').map((l) => l.trim())) {
    if (line.length >= 4 && line.includes(quote)) return line
  }
  return null
}

/** 清单锚点所在整行在语料规范全文中的码点 offset(演示语料固定,找不到即失败) */
function lineOffsetIn(text: string, line: string): { start: number; end: number } {
  const cps = Array.from(text)
  const q = Array.from(line)
  for (let i = 0; i + q.length <= cps.length; i += 1) {
    let ok = true
    for (let j = 0; j < q.length; j += 1) {
      if (cps[i + j] !== q[j]) {
        ok = false
        break
      }
    }
    if (ok) return { start: i, end: i + q.length }
  }
  throw new Error(`演示锚点在语料全文中找不到:${JSON.stringify(line)}`)
}

interface ExtractionClaim {
  text: string
  claim_type: 'fact' | 'comparison' | 'recommendation'
  subject: Record<string, unknown>
  supports: number[]
  contradicts?: number[]
}

/** 各路线的抽取产物:锚点 → evidence/claims(冲突路线额外给 contradicts 引用) */
function extractionFor(
  route: DemoManifestRoute,
  delivered: ReturnType<typeof parseDeliveredChunks>,
  corpusTexts: ImportedCorpus['textByLogical']
): unknown {
  const evidence: Array<{
    snapshot_id: string
    chunk_id: string
    quote: string
    start_offset: number
    end_offset: number
  }> = []
  for (const anchor of route.evidence_anchors) {
    const chunk = delivered.find((d) => anchorLineOf(d.content, anchor.quote) !== null)
    expect(chunk, `交付块中没有包含锚点的块:${anchor.quote}`).toBeTruthy()
    const line = anchorLineOf(chunk!.content, anchor.quote)!
    const fullText = corpusTexts.get(anchor.logical_snapshot) ?? ''
    const offset = lineOffsetIn(fullText, line)
    evidence.push({
      snapshot_id: chunk!.snapshotId,
      chunk_id: chunk!.chunkId,
      quote: line,
      start_offset: offset.start,
      end_offset: offset.end
    })
  }
  const claims: ExtractionClaim[] = []
  if (route.route_id === 'conflict') {
    // 对齐键完全一致(entity/attribute);快照区分写进 claim 文本,不进 subject
    const subject = { entity: '样例岗位·招聘运营专员(北京)', attribute: '学历要求' }
    claims.push(
      { text: '2026-06 快照要求「本科及以上学历」。', claim_type: 'fact', subject, supports: [0] },
      {
        text: '2026-07 快照「学历不限,能力优先」,与 6 月快照矛盾。',
        claim_type: 'fact',
        subject,
        supports: [1],
        contradicts: [0]
      }
    )
  } else if (evidence.length > 0) {
    claims.push({
      text: route.route_id === 'injection'
        ? '该样例岗位要求「大专及以上」,正文中的系统提示不构成岗位要求。'
        : `关于「${route.question}」的结论,以引用原文为准。`,
      claim_type: 'fact',
      subject: { entity: route.fixture_id, attribute: route.route_id },
      supports: evidence.map((_, i) => i)
    })
  }
  // insufficient 路线:evidence/claims 全空(不编造)
  return { evidence, claims }
}

/** 演示 fake 脚本:规划→抽取→审核→组织(角色分支) */
function demoScriptFor(
  route: DemoManifestRoute,
  corpusTexts: ImportedCorpus['textByLogical']
): (callIndex: number, request: StructuredCompleteRequest) => unknown {
  const query = route.route_id === 'normal'
    ? 'NLP 项目经验'
    : route.route_id === 'conflict'
      ? '学历 要求'
      : route.route_id === 'insufficient'
        ? '实习 薪资'
        : '大专 要求'
  return (_callIndex: number, request: StructuredCompleteRequest) => {
    if (request.system.includes('研究规划器')) {
      return { subquestions: [{ question: route.question, query }], clarifications: [] }
    }
    if (request.system.includes('证据抽取器')) {
      if (route.route_id === 'insufficient') return { evidence: [], claims: [] }
      return extractionFor(route, parseDeliveredChunks(request.prompt), corpusTexts)
    }
    if (request.system.includes('证据审核员')) {
      // 从审核 prompt 提取真实 Claim ID,全判 supported(片段直接支持)
      const ids = Array.from(request.prompt.matchAll(/Claim\(([0-9a-f-]+)\)/g)).map((m) => m[1]!)
      return {
        verdicts: ids.map((id) => ({ claim_id: id, status: 'supported', reason: '片段直接支持命题(演示脚本)' }))
      }
    }
    // 组织员:章节白名单;claim_order 留空由服务端按落库序补齐
    return {
      sections: ['core_findings', 'evidence_by_subquestion', 'conflicts_and_gaps', 'sources'],
      claim_order: []
    }
  }
}

// ---------- 路线执行:空库导入→创建运行→驱动到终态 ----------

async function runRoute(route: DemoManifestRoute): Promise<{ runId: string; db: SqliteDb }> {
  const dir = mkdtempSync(join(tmpdir(), 'research-demo-'))
  const { db, flush } = await openDatabase(join(dir, 'demo.sqlite'), SQL_JS_DIST)
  initSchema(db)
  initWorkspaceEpoch()
  const corpus = importCorpus(db, route)
  const provider = new FakeProvider({ script: demoScriptFor(route, corpus.textByLogical), model: 'demo-fake-model' })
  const workflow = new ResearchWorkflow({
    db,
    queue: new RunQueue(db),
    completer: provider,
    clock: DEMO_CLOCK,
    events: { emit: () => {} }
  })
  const { value } = workflow.createRun(
    {
      request: {
        question: route.question,
        snapshot_ids: [...new Set(corpus.idByLogical.values())],
        snapshot_policy: 'fixed',
        budget: {}
      },
      timezone: 'Asia/Shanghai'
    },
    `demo-${route.route_id}-${Math.random().toString(36).slice(2, 8)}`
  )
  await workflow.driveResearch(value.run.runId)
  flush()
  return { runId: value.run.runId, db }
}

function tracePayloads(db: SqliteDb, runId: string): Array<Record<string, unknown>> {
  return listTraceEvents(db, runId).map((e) => e.payload)
}

function eventsOf(db: SqliteDb, runId: string, name: string): Array<Record<string, unknown>> {
  return tracePayloads(db, runId).filter((p) => p.event === name)
}

function reportResponseOf(db: SqliteDb, runId: string): ReportResponse {
  const task = getResearchTaskByRun(db, runId)!
  const report = latestReport(db, task.researchTaskId)!
  return assembleReportResponse(db, runId, report, { runStatus: getRun(db, runId)!.status })
}

function sectionOf(response: ReportResponse, section: string): string {
  return response.sections.find((s) => s.section === section)?.markdown ?? ''
}

// ---------- 产物聚合(artifacts/research/demo/) ----------

interface DemoResult {
  route_id: string
  fixture_id: string
  run_id: string
  terminal_status: string
  report_state: string
  report_version: number
  manifest_sha256: string
  unanswered_subquestions: number
  claims: number
  conflict_group: string | null
  exported_markdown_bytes: number
}

function toResult(route: DemoManifestRoute, db: SqliteDb, runId: string, response: ReportResponse): DemoResult {
  // 各路线导出包:<route_id>/report.md + meta.json(本地 artifacts,gitignore 忽略)
  const dir = join(ARTIFACTS_DIR, route.route_id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'report.md'), response.markdown, 'utf-8')
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify(
      {
        route_id: route.route_id,
        run_id: runId,
        report_id: response.report_id,
        version: response.version,
        report_state: response.report_state,
        manifest_sha256: response.manifest_sha256,
        corpus: route.corpus,
        corpus_sha256: route.corpus_sha256
      },
      null,
      2
    ),
    'utf-8'
  )
  const task = getResearchTaskByRun(db, runId)!
  const claims = listClaims(db, task.researchTaskId)
  return {
    route_id: route.route_id,
    fixture_id: route.fixture_id,
    run_id: runId,
    terminal_status: getRun(db, runId)!.status,
    report_state: response.report_state,
    report_version: response.version,
    manifest_sha256: response.manifest_sha256,
    unanswered_subquestions: response.unanswered_subquestions.length,
    claims: claims.length,
    conflict_group: claims.find((c) => c.conflictGroup)?.conflictGroup ?? null,
    exported_markdown_bytes: Buffer.byteLength(response.markdown, 'utf-8')
  }
}

const results: DemoResult[] = []

beforeAll(() => {
  verifyManifestFrozen(loadDemoManifest())
  rmSync(ARTIFACTS_DIR, { recursive: true, force: true })
  mkdirSync(ARTIFACTS_DIR, { recursive: true })
})

afterAll(() => {
  // summary.json:run_id 可追溯 + 明示用量为未知值(FakeProvider usage 全 null,不记 0)
  writeFileSync(
    join(ARTIFACTS_DIR, 'summary.json'),
    JSON.stringify(
      {
        generated_at: '2026-09-28T01:00:00.000Z',
        manifest: 'fixtures/research/demo/manifest.json',
        execution: 'FakeProvider 脚本驱动(fake 模式,断网守卫下执行);模型用量四字段全为 null(未知值,不记 0)',
        results
      },
      null,
      2
    ),
    'utf-8'
  )
})

// ---------- 断网守卫:全程替换 globalThis.fetch 为抛错 ----------

function installOfflineGuard(): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new Error('演示核查守卫:演示全程断网,禁止网络访问'))) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

// ---------- 四条演示路线 ----------

describe('R-08 演示路线:从空数据库导入到报告(fake 驱动)', () => {
  const restoreOffline = installOfflineGuard()
  afterAll(() => restoreOffline())

  it('normal 单文档定位:succeeded/final,证据闭包,unanswered 为空', async () => {
    const route = loadDemoManifest().routes.find((r) => r.route_id === 'normal')!
    const { runId, db } = await runRoute(route)
    expect(runId, 'run_id 存在(可追溯)').toBeTruthy()
    expect(getRun(db, runId)!.status).toBe('succeeded')

    const response = reportResponseOf(db, runId)
    expect(response.report_state).toBe('final')
    expect(response.version).toBe(1)
    expect(response.manifest_sha256).toBeTruthy()
    // 期望特征:至少 1 条 supported claim + unanswered 为空 + 事实区非空
    expect(response.claims.length).toBeGreaterThan(0)
    expect(response.claims.every((c) => c.support_status === 'supported')).toBe(true)
    expect(response.unanswered_subquestions).toHaveLength(0)
    expect(sectionOf(response, 'core_findings')).not.toBe('')
    // 子问题全部 answered
    const task = getResearchTaskByRun(db, runId)!
    for (const sub of listSubQuestions(db, task.researchTaskId)) {
      expect(sub.status).toBe('answered')
    }
    // 导出 markdown 非空
    expect(response.markdown.length).toBeGreaterThan(0)
    results.push(toResult(route, db, runId, response))
  })

  it('conflict 两快照学历冲突:conflict_group 并列 unresolved,报告含冲突章节', async () => {
    const route = loadDemoManifest().routes.find((r) => r.route_id === 'conflict')!
    const { runId, db } = await runRoute(route)
    expect(getRun(db, runId)!.status).toBe('succeeded')

    // trace 冲突事件:1 组、双方 unresolved
    const conflictEvents = eventsOf(db, runId, 'research.conflict_detected')
    expect(conflictEvents).toHaveLength(1)
    expect(conflictEvents[0]!.groups).toBe(1)
    expect(conflictEvents[0]!.unresolved_claim_ids as string[]).toHaveLength(2)

    // conflict_group/unresolved 断言(并列不投票)
    const task = getResearchTaskByRun(db, runId)!
    const claims = listClaims(db, task.researchTaskId)
    const groupIds = new Set(claims.map((c) => c.conflictGroup).filter((g): g is string => g !== null))
    expect(groupIds.size).toBe(1)
    for (const claim of claims) {
      expect(claim.conflictGroup).toBe([...groupIds][0])
      const conflict = (claim.review as Record<string, Record<string, unknown>>).conflict!
      expect(conflict.status).toBe('unresolved')
      expect(String(conflict.resolution)).toContain('不按多数副本投票')
    }

    const response = reportResponseOf(db, runId)
    expect(response.report_state).toBe('final')
    // 两条矛盾 claim 均进入事实区(supported 或 uncertain+conflict_group 皆合格)
    expect(response.claims).toHaveLength(2)
    expect(
      response.claims.every((c) => c.support_status === 'supported' || c.support_status === 'uncertain')
    ).toBe(true)
    const conflictsSection = sectionOf(response, 'conflicts_and_gaps')
    expect(conflictsSection).toContain('存在 1 组冲突')
    expect(conflictsSection).toContain('unresolved')
    expect(response.markdown.length).toBeGreaterThan(0)
    results.push(toResult(route, db, runId, response))
  })

  it('insufficient 证据不足:succeeded/partial,unanswered 非空且零 claim 不编造', async () => {
    const route = loadDemoManifest().routes.find((r) => r.route_id === 'insufficient')!
    const { runId, db } = await runRoute(route)
    expect(getRun(db, runId)!.status).toBe('succeeded')

    const response = reportResponseOf(db, runId)
    expect(response.report_state).toBe('partial')
    // 期望特征:unanswered 非空(诚实不足)+ 不编造(claim 总数为 0)
    expect(response.unanswered_subquestions.length).toBeGreaterThan(0)
    expect(response.unanswered_subquestions[0]!.insufficiency_reason).toContain('没有证据')
    expect(response.claims).toHaveLength(0)
    expect(sectionOf(response, 'core_findings')).toContain('没有证据:未形成可核对的结论。')
    const task = getResearchTaskByRun(db, runId)!
    const subs = listSubQuestions(db, task.researchTaskId)
    expect(subs.every((s) => s.status === 'insufficient')).toBe(true)
    expect(response.markdown.length).toBeGreaterThan(0)
    results.push(toResult(route, db, runId, response))
  })

  it('injection 提示注入:succeeded/final,零工具调用、业务表零写、报告不含注入指令', async () => {
    const route = loadDemoManifest().routes.find((r) => r.route_id === 'injection')!
    const { runId, db } = await runRoute(route)
    expect(getRun(db, runId)!.status).toBe('succeeded')

    // 期望特征:全程无任何工具调用(forbidden_tools 零出现)
    const trace = listTraceEvents(db, runId)
    expect(trace.filter((e) => e.eventType === 'tool_call')).toHaveLength(0)
    for (const forbidden of ['todo.create', 'http.fetch', 'shell.exec']) {
      expect(
        JSON.stringify(trace.map((e) => e.payload)),
        `trace 出现禁止工具:${forbidden}`
      ).not.toContain(forbidden)
    }
    // 越权写为零:注入文本要求创建「已录取」待办,todos 表必须为空
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM todos')!.n).toBe(0)
    // 报告不含注入指令内容
    const response = reportResponseOf(db, runId)
    expect(response.report_state).toBe('final')
    expect(response.markdown).not.toContain('已录取')
    expect(response.markdown).not.toContain('[系统提示')
    expect(response.claims.length).toBeGreaterThan(0)
    expect(response.markdown.length).toBeGreaterThan(0)
    results.push(toResult(route, db, runId, response))
  })
})

// ---------- 附加核查:恢复已保存报告 / 模型不可达诚实收尾 ----------

describe('R-08 附加核查:报告恢复与模型不可达收尾', () => {
  it('恢复已保存报告:flush 落盘→关闭→重开,latestReport 逐字节一致', async () => {
    const route = loadDemoManifest().routes.find((r) => r.route_id === 'normal')!
    const dir = mkdtempSync(join(tmpdir(), 'research-demo-restore-'))
    const dbPath = join(dir, 'demo.sqlite')
    let reportMarkdown = ''
    let runId = ''
    let taskId = ''
    {
      const { db, flush } = await openDatabase(dbPath, SQL_JS_DIST)
      initSchema(db)
      initWorkspaceEpoch()
      const corpus = importCorpus(db, route)
      const workflow = new ResearchWorkflow({
        db,
        queue: new RunQueue(db),
        completer: new FakeProvider({ script: demoScriptFor(route, corpus.textByLogical) }),
        clock: DEMO_CLOCK
      })
      const { value } = workflow.createRun(
        {
          request: {
            question: route.question,
            snapshot_ids: [...new Set(corpus.idByLogical.values())],
            snapshot_policy: 'fixed',
            budget: {}
          },
          timezone: 'Asia/Shanghai'
        },
        `demo-restore-${Math.random().toString(36).slice(2, 8)}`
      )
      runId = value.run.runId
      taskId = value.task.researchTaskId
      await workflow.driveResearch(runId)
      reportMarkdown = latestReport(db, taskId)!.markdown
      expect(reportMarkdown).not.toBe('')
      flush() // 显式落盘后关闭
      db.close()
    }
    // 重新打开同一数据库文件:已保存报告直接恢复(版本化读取)
    const reopened = await openDatabase(dbPath, SQL_JS_DIST)
    const restored = latestReport(reopened.db, taskId)
    expect(restored, '重开后报告丢失').toBeTruthy()
    expect(restored!.markdown).toBe(reportMarkdown)
    expect(restored!.version).toBe(1)
    expect(getRun(reopened.db, runId)!.status).toBe('succeeded')
    reopened.flush()
    reopened.db.close()
  })

  it('模型不可达诚实收尾:completer 缺省 → failed + MODEL_UNAVAILABLE,无报告不伪装 partial', async () => {
    const route = loadDemoManifest().routes.find((r) => r.route_id === 'normal')!
    const dir = mkdtempSync(join(tmpdir(), 'research-demo-nomodel-'))
    const { db, flush } = await openDatabase(join(dir, 'demo.sqlite'), SQL_JS_DIST)
    initSchema(db)
    initWorkspaceEpoch()
    const corpus = importCorpus(db, route)
    const workflow = new ResearchWorkflow({
      db,
      queue: new RunQueue(db),
      completer: null,
      clock: DEMO_CLOCK
    })
    const { value } = workflow.createRun(
      {
        request: {
          question: route.question,
          snapshot_ids: [...new Set(corpus.idByLogical.values())],
          snapshot_policy: 'fixed',
          budget: {}
        },
        timezone: 'Asia/Shanghai'
      },
      `demo-nomodel-${Math.random().toString(36).slice(2, 8)}`
    )
    await workflow.driveResearch(value.run.runId)
    const run = getRun(db, value.run.runId)!
    expect(run.status).toBe('failed')
    expect(run.errorCode).toBe('MODEL_UNAVAILABLE')
    expect(latestReport(db, value.task.researchTaskId)).toBeNull()
    expect(tracePayloads(db, value.run.runId).some((p) => p.code === 'MODEL_UNAVAILABLE')).toBe(true)
    flush()
    db.close()
  })
})

// ---------- 演示清单冻结校验(独立于路线执行) ----------

describe('R-08 演示清单冻结校验', () => {
  it('四路线清单:语料存在、raw_sha256 一致、与数据集快照副本逐字节一致', () => {
    const manifest = loadDemoManifest()
    expect(manifest.routes.map((r) => r.route_id)).toEqual(['normal', 'conflict', 'insufficient', 'injection'])
    verifyManifestFrozen(manifest)
  })

  it('演示语料目录只含清单声明的文件(无多余文件混入)', () => {
    const manifest = loadDemoManifest()
    for (const route of manifest.routes) {
      const files = readdirSync(join(FIXTURE_BASE, route.fixture_id)).sort()
      expect(files).toEqual(route.corpus.map((rel) => rel.split('/')[1]).sort())
    }
  })
})
