// R-01 研究契约测试:请求/实体校验、预算边界、幂等创建、跨运行引用、迁移与 offset 约束。
// 覆盖执行清单步骤 13 的验收项:
// 未知字段、空资料、跨运行引用、非法预算、重复 report version、mode 不匹配分别被拒绝;
// 正确请求转交同一个 RunService(createRun);迁移可从空库执行且不建重复共享表。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase, type SqliteDb } from '../../src/main/db/connection'
import { initSchema } from '../../src/main/db/dao'
import { SCHEMA_VERSION } from '../../src/main/db/schema'
import {
  MIGRATIONS,
  REGISTRY_VERSION,
  applyPending,
  rollbackTo
} from '../../src/main/db/migrations/registry'
import { initWorkspaceEpoch, OperationError, runOperation } from '../../src/main/db/operations'
import { createRun } from '../../src/main/runs/repository'
import {
  DEFAULT_RESEARCH_BUDGET,
  MIN_ACTIVE_SECONDS,
  QUESTION_MAX_CODE_POINTS,
  SPAN_MAX_CODE_POINTS,
  parseClaimInput,
  parseCitationInput,
  parseEvidenceSpanInput,
  parseResearchRequest,
  parseSubQuestionInput,
  resolveResearchBudget
} from '../../src/main/research/schemas'
import {
  assertResearchRun,
  createClaim,
  createCitation,
  createEvidenceSpan,
  createReport,
  createResearchRun,
  createSubQuestion,
  getResearchTaskByRun,
  latestReport,
  verifySnapshotManifest
} from '../../src/main/research/repository'
import { fixedClock } from '../../src/shared/clock'

const SQL_JS_DIST = join(process.cwd(), 'node_modules', 'sql.js', 'dist')
const FIXED_CLOCK = fixedClock('2026-09-27T08:00:00.000Z')
const CONTEXT_CLOCK = '2026-09-27T08:00:00.000Z'

/** 与 makeTestDb 相同的真实文件库,供迁移测试直接控制 registry 执行 */
async function openEmptyDb(): Promise<SqliteDb> {
  const dir = mkdtempSync(join(tmpdir(), 'research-contract-'))
  const { db } = await openDatabase(join(dir, 'test.sqlite'), SQL_JS_DIST)
  return db
}

async function makeTestDb(): Promise<SqliteDb> {
  const db = await openEmptyDb()
  initSchema(db)
  return db
}

function tableNames(db: SqliteDb): string[] {
  return db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name)
}

function appErrorCode(err: unknown): string | undefined {
  if (err instanceof OperationError) return err.appError.code
  return undefined
}

/** 向 retrieval_documents 写入一份最小快照(SourceSnapshot 即该共享表);已存在则跳过 */
function seedSnapshot(db: SqliteDb, id: string, text: string): void {
  const exists = db.get<{ document_id: string }>(
    'SELECT document_id FROM retrieval_documents WHERE document_id = ?',
    [id]
  )
  if (exists) return
  db.run(
    `INSERT INTO retrieval_documents
       (document_id, source_name, source_type, raw_sha256, text_sha256, normalized_text, size_bytes, created_at)
     VALUES (?, ?, 'txt', 'raw', 'text', ?, ?, ?)`,
    [id, `jd-${id}.txt`, text, text.length, FIXED_CLOCK.now().toISOString()]
  )
}

/** 向 retrieval_chunks 写入一个覆盖全篇的分块(chunk 表即共享 DocumentChunk) */
function seedChunk(db: SqliteDb, chunkId: string, documentId: string, textLength: number): void {
  db.run(
    `INSERT INTO retrieval_chunks
       (chunk_id, document_id, chunk_index, start_offset, end_offset, content, search_text, search_version)
     VALUES (?, ?, 0, 0, ?, '全文', 'search', 1)`,
    [chunkId, documentId, textLength]
  )
}

function validRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    question: '比较这些岗位的 Python 要求。',
    snapshot_ids: ['snap-1'],
    snapshot_policy: 'fixed',
    budget: { max_model_calls: 6 },
    ...overrides
  }
}

/** 建一个带 research 任务的最小运行,返回 runId */
function seedResearchRun(db: SqliteDb, snapshotText = '要求:Python。\n地点:上海。\n'): { runId: string; snapshotId: string } {
  seedSnapshot(db, 'snap-1', snapshotText)
  initWorkspaceEpoch()
  const { value } = createResearchRun(db, { request: validRequest(), contextClock: CONTEXT_CLOCK, clock: FIXED_CLOCK }, 'op-seed')
  return { runId: value.run.runId, snapshotId: 'snap-1' }
}

// ---------- 请求 schema ----------

describe('研究请求校验', () => {
  it('合法请求通过并归一预算默认值', () => {
    const parsed = parseResearchRequest(validRequest({ budget: { max_model_calls: 4 } }))
    expect(parsed.snapshot_ids).toEqual(['snap-1'])
    expect(parsed.snapshot_policy).toBe('fixed')
    expect(parsed.budget).toEqual({ ...DEFAULT_RESEARCH_BUDGET, max_model_calls: 4 })
  })

  it('未知字段被拒绝(顶层与 budget、constraints)', () => {
    expect(() => parseResearchRequest(validRequest({ extra: 1 }))).toThrow(/未知字段/)
    expect(() => parseResearchRequest(validRequest({ budget: { max_model_calls: 6, nope: 1 } }))).toThrow(/未知字段/)
  })

  it('snapshot_ids 空清单拒绝,重复去重,超上限拒绝', () => {
    expect(() => parseResearchRequest(validRequest({ snapshot_ids: [] }))).toThrow(/资料清单为空/)
    const deduped = parseResearchRequest(validRequest({ snapshot_ids: ['a', 'a', 'b'] }))
    expect(deduped.snapshot_ids).toEqual(['a', 'b'])
    expect(() =>
      parseResearchRequest(validRequest({ snapshot_ids: Array.from({ length: 101 }, (_, i) => `s${i}`) }))
    ).toThrow(/上限/)
  })

  it('snapshot_policy 仅接受 fixed', () => {
    expect(() => parseResearchRequest(validRequest({ snapshot_policy: 'refresh' }))).toThrow(/fixed/)
  })

  it('超长 question 按码点拒绝;emoji 计 1 码点', () => {
    expect(() => parseResearchRequest(validRequest({ question: '长'.repeat(QUESTION_MAX_CODE_POINTS + 1) })))
      .toThrow(/码点/)
    expect(parseResearchRequest(validRequest({ question: '👩‍👩‍👧'.repeat(10) })).question.length).toBeLessThanOrEqual(QUESTION_MAX_CODE_POINTS)
  })
})

// ---------- 预算契约 ----------

describe('研究预算契约', () => {
  it('默认 3/8/6/120;客户端只能下调不能上调', () => {
    expect(DEFAULT_RESEARCH_BUDGET).toEqual({ max_subqueries: 3, max_chunks_per_subquery: 8, max_model_calls: 6, max_active_seconds: 120 })
    expect(resolveResearchBudget({ max_subqueries: 1 }).max_subqueries).toBe(1)
    for (const key of ['max_subqueries', 'max_chunks_per_subquery', 'max_model_calls', 'max_active_seconds'] as const) {
      const over: Record<string, number> = {}
      over[key] = DEFAULT_RESEARCH_BUDGET[key] + 1
      expect(() => resolveResearchBudget(over)).toThrow(/不允许高于默认上限/)
    }
  })

  it('0、负数、非整数、低于 active 下限均拒绝;未知字段拒绝', () => {
    expect(() => resolveResearchBudget({ max_model_calls: 0 })).toThrow(/不小于 1/)
    expect(() => resolveResearchBudget({ max_model_calls: -2 })).toThrow(/不小于 1/)
    expect(() => resolveResearchBudget({ max_model_calls: 1.5 })).toThrow(/整数/)
    expect(() => resolveResearchBudget({ max_active_seconds: MIN_ACTIVE_SECONDS - 1 })).toThrow(/不得低于/)
    expect(() => resolveResearchBudget({ whatever: 1 })).toThrow(/未知字段/)
    expect(resolveResearchBudget({ max_active_seconds: MIN_ACTIVE_SECONDS }).max_active_seconds).toBe(MIN_ACTIVE_SECONDS)
  })

  it('预算整体缺失或非对象拒绝(请求内)', () => {
    // budget 显式给非法形状时拒绝;省略时归一为完整默认预算
    expect(() => parseResearchRequest(validRequest({ budget: 'fast' }))).toThrow(/budget 必须是对象/)
    expect(() => parseResearchRequest(validRequest({ budget: [1] }))).toThrow(/budget 必须是对象/)
    expect(parseResearchRequest({ question: 'q', snapshot_ids: ['a'] }).budget).toEqual(DEFAULT_RESEARCH_BUDGET)
  })
})

// ---------- 实体载荷校验 ----------

describe('研究实体载荷校验(未知字段双向拒绝)', () => {
  it('子问题:未知字段拒绝、ordinal 1~3、question 必填', () => {
    expect(() => parseSubQuestionInput({ ordinal: 1, question: 'q', extra: 1 })).toThrow(/未知字段/)
    expect(() => parseSubQuestionInput({ ordinal: 0, question: 'q' })).toThrow(/ordinal/)
    expect(() => parseSubQuestionInput({ ordinal: 4, question: 'q' })).toThrow(/ordinal/)
    expect(() => parseSubQuestionInput({ ordinal: 1 })).toThrow(/question/)
    expect(parseSubQuestionInput({ ordinal: 2, question: 'q' }).ordinal).toBe(2)
  })

  it('证据片段:未知字段拒绝、offset 整数与顺序、quote 码点上限', () => {
    expect(() => parseEvidenceSpanInput({ snapshot_id: 's', chunk_id: 'c', start_offset: 0, end_offset: 2, quote: 'x', rel: 1 })).toThrow(/未知字段/)
    expect(() => parseEvidenceSpanInput({ snapshot_id: 's', chunk_id: 'c', start_offset: 2, end_offset: 2, quote: 'x' })).toThrow(/end_offset/)
    expect(() => parseEvidenceSpanInput({ snapshot_id: 's', chunk_id: 'c', start_offset: 3, end_offset: 2, quote: 'x' })).toThrow(/end_offset/)
    expect(() => parseEvidenceSpanInput({ snapshot_id: 's', chunk_id: 'c', start_offset: -1, end_offset: 2, quote: 'x' })).toThrow(/start_offset/)
    expect(() => parseEvidenceSpanInput({ snapshot_id: 's', chunk_id: 'c', start_offset: 0, end_offset: 2, quote: '长'.repeat(SPAN_MAX_CODE_POINTS + 1) })).toThrow(/码点/)
  })

  it('Claim 与 Citation:未知字段与枚举拒绝', () => {
    expect(() => parseClaimInput({ text: 't', claim_type: 'fact', surprise: true })).toThrow(/未知字段/)
    expect(() => parseClaimInput({ text: 't', claim_type: 'opinion' })).toThrow(/claim_type/)
    expect(() => parseCitationInput({ claim_id: 'c', evidence_id: 'e', relation: 'equals' })).toThrow(/relation/)
    expect(() => parseCitationInput({ claim_id: 'c', evidence_id: 'e', relation: 'supports', group_operator: 'any_of' })).toThrow(/all_of/)
    expect(parseCitationInput({ claim_id: 'c', evidence_id: 'e', relation: 'context', group_operator: 'all_of' }).relation).toBe('context')
  })
})

// ---------- createResearchRun:RunService 转交、冻结清单、幂等、mode 守卫 ----------

describe('createResearchRun', () => {
  it('正确请求转交同一个 RunService:agent_runs 出现 mode=research 行,research_tasks 关联其 run_id,初始 queued', async () => {
    const db = await makeTestDb()
    seedSnapshot(db, 'snap-1', '要求:Python。')
    initWorkspaceEpoch()

    const { value, replayed } = createResearchRun(
      db,
      { request: validRequest(), contextClock: CONTEXT_CLOCK, clock: FIXED_CLOCK },
      'op-create-1'
    )
    expect(replayed).toBe(false)

    const runRow = db.get<{ run_id: string; mode: string; status: string }>(
      'SELECT run_id, mode, status FROM agent_runs WHERE run_id = ?',
      [value.run.runId]
    )
    expect(runRow).toMatchObject({ mode: 'research', status: 'queued' })

    const taskRow = db.get<{ research_task_id: string; run_id: string; phase: string }>(
      'SELECT research_task_id, run_id, phase FROM research_tasks WHERE run_id = ?',
      [value.run.runId]
    )
    expect(taskRow).toMatchObject({ research_task_id: value.task.researchTaskId, phase: 'queued' })
    expect(value.task.snapshotManifestId).toBe(value.manifest.manifestId)

    // 冻结清单内容:有序快照 ID 与 hash;复核对一致快照通过
    expect(value.manifest.entries).toHaveLength(1)
    expect(value.manifest.entries[0]!.snapshot_id).toBe('snap-1')
    expect(verifySnapshotManifest(db, value.manifest.manifestId).manifestSha256).toBe(value.manifest.manifestSha256)
  })

  it('幂等:同 operationId 同请求返回原运行不新建;不同请求 CONFLICT', async () => {
    const db = await makeTestDb()
    seedSnapshot(db, 'snap-1', '要求:Python。')
    initWorkspaceEpoch()

    const first = createResearchRun(db, { request: validRequest(), contextClock: CONTEXT_CLOCK, clock: FIXED_CLOCK }, 'op-dup')
    const replay = createResearchRun(db, { request: validRequest(), contextClock: CONTEXT_CLOCK, clock: FIXED_CLOCK }, 'op-dup')
    expect(replay.replayed).toBe(true)
    expect(replay.value.run.runId).toBe(first.value.run.runId)
    expect(replay.value.task.researchTaskId).toBe(first.value.task.researchTaskId)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agent_runs')!.n).toBe(1)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM research_tasks')!.n).toBe(1)

    expect(() =>
      createResearchRun(db, { request: validRequest({ question: '另一个问题?' }), contextClock: CONTEXT_CLOCK, clock: FIXED_CLOCK }, 'op-dup')
    ).toThrow(/不同的请求内容/)
  })

  it('快照不存在时拒绝且不留下运行或任务行(单事务回滚)', async () => {
    const db = await makeTestDb()
    initWorkspaceEpoch()
    expect(() =>
      createResearchRun(db, { request: validRequest({ snapshot_ids: ['ghost'] }), contextClock: CONTEXT_CLOCK, clock: FIXED_CLOCK }, 'op-ghost')
    ).toThrow(/SNAPSHOT_NOT_FOUND/)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agent_runs')!.n).toBe(0)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM research_snapshot_manifests')!.n).toBe(0)
  })

  it('mode 不匹配:对 personal_ops 运行做研究操作抛 CONFLICT/MODE_MISMATCH', async () => {
    const db = await makeTestDb()
    initWorkspaceEpoch()
    const personal = createRun(db, { mode: 'personal_ops', input: '整理待办', contextClock: CONTEXT_CLOCK })
    expect(() => assertResearchRun(db, personal.runId)).toThrow(/MODE_MISMATCH/)
    try {
      assertResearchRun(db, personal.runId)
    } catch (err) {
      expect(appErrorCode(err)).toBe('CONFLICT')
    }
  })
})

// ---------- 跨运行引用与 offset 约束 ----------

describe('跨运行引用与 offset 约束', () => {
  function setupTwoRuns(db: SqliteDb): { runA: string; runB: string } {
    seedSnapshot(db, 'snap-1', '要求:Python。\n地点:上海。\n')
    seedChunk(db, 'chunk-a', 'snap-1', 15)
    seedSnapshot(db, 'snap-2', '地点:北京。\n')
    seedChunk(db, 'chunk-b', 'snap-2', 7)
    initWorkspaceEpoch()
    const a = createResearchRun(db, { request: validRequest(), contextClock: CONTEXT_CLOCK, clock: FIXED_CLOCK }, 'op-run-a')
    const b = createResearchRun(db, { request: validRequest({ snapshot_ids: ['snap-2'] }), contextClock: CONTEXT_CLOCK, clock: FIXED_CLOCK }, 'op-run-b')
    return { runA: a.value.run.runId, runB: b.value.run.runId }
  }

  it('evidence/claim 挂到别的 run 的 subquestion 被拒绝', async () => {
    const db = await makeTestDb()
    const { runA, runB } = setupTwoRuns(db)
    const subA = createSubQuestion(db, runA, { ordinal: 1, question: 'A 的子问题' })
    const subB = createSubQuestion(db, runB, { ordinal: 1, question: 'B 的子问题' })

    // B 运行的 evidence 引用 A 运行的子问题 → 拒绝(即便 chunk 真实存在)
    expect(() =>
      createEvidenceSpan(db, runB, subA.subquestionId, { snapshot_id: 'snap-2', chunk_id: 'chunk-b', start_offset: 0, end_offset: 2, quote: '地点' })
    ).toThrow(/拒绝跨运行引用/)

    // B 运行的 claim 引用 A 运行的子问题 → 拒绝
    expect(() => createClaim(db, runB, { subquestionId: subA.subquestionId, claim: { text: 'x', claim_type: 'fact' } })).toThrow(/拒绝跨运行引用/)

    // A 运行正常建 claim;B 运行的 citation 引用 A 的 claim → 拒绝
    const claimA = createClaim(db, runA, { subquestionId: subA.subquestionId, claim: { text: '该岗位要求 Python', claim_type: 'fact' } })
    expect(() =>
      createCitation(db, runB, { claim_id: claimA.claimId, evidence_id: 'any', relation: 'supports' })
    ).toThrow(/拒绝跨运行引用/)

    // A 运行内部正常链路:span → citation 引用自己的 evidence 通过;引用他 run evidence 拒绝
    const spanA = createEvidenceSpan(db, runA, subA.subquestionId, { snapshot_id: 'snap-1', chunk_id: 'chunk-a', start_offset: 0, end_offset: 10, quote: '要求:Python。' })
    const citation = createCitation(db, runA, { claim_id: claimA.claimId, evidence_id: spanA.evidenceId, relation: 'supports' })
    expect(citation.relation).toBe('supports')
    const spanB = createEvidenceSpan(db, runB, subB.subquestionId, { snapshot_id: 'snap-2', chunk_id: 'chunk-b', start_offset: 0, end_offset: 2, quote: '地点' })
    expect(() =>
      createCitation(db, runA, { claim_id: claimA.claimId, evidence_id: spanB.evidenceId, relation: 'supports' })
    ).toThrow(/拒绝跨运行引用/)
  })

  it('offset 约束:start≥end、负数、超出快照长度被拒绝(码点语义)', async () => {
    const db = await makeTestDb()
    // 快照 10 码点;seedResearchRun 复用 snap-1 的已有快照
    seedSnapshot(db, 'snap-1', '要求:Python。')
    seedChunk(db, 'chunk-a', 'snap-1', 10)
    initWorkspaceEpoch()
    const { runId } = seedResearchRun(db)
    const sub = createSubQuestion(db, runId, { ordinal: 1, question: '要求什么语言?' })

    const ok = createEvidenceSpan(db, runId, sub.subquestionId, { snapshot_id: 'snap-1', chunk_id: 'chunk-a', start_offset: 0, end_offset: 10, quote: '要求:Python。' })
    expect(ok.endOffset).toBe(10)

    expect(() =>
      createEvidenceSpan(db, runId, sub.subquestionId, { snapshot_id: 'snap-1', chunk_id: 'chunk-a', start_offset: 5, end_offset: 5, quote: '点' })
    ).toThrow(/end_offset/)
    expect(() =>
      createEvidenceSpan(db, runId, sub.subquestionId, { snapshot_id: 'snap-1', chunk_id: 'chunk-a', start_offset: -1, end_offset: 3, quote: '求' })
    ).toThrow(/start_offset/)
    expect(() =>
      createEvidenceSpan(db, runId, sub.subquestionId, { snapshot_id: 'snap-1', chunk_id: 'chunk-a', start_offset: 0, end_offset: 11, quote: '要求:Python。' })
    ).toThrow(/超出快照范围/)
  })

  it('快照在运行创建后被改动 → verifySnapshotManifest 抛 SNAPSHOT_HASH_MISMATCH', async () => {
    const db = await makeTestDb()
    const { runId } = seedResearchRun(db)
    db.run("UPDATE retrieval_documents SET normalized_text = '被替换的文本', text_sha256 = 'tampered' WHERE document_id = 'snap-1'")
    const task = getResearchTaskByRun(db, runId)!
    try {
      verifySnapshotManifest(db, task.snapshotManifestId)
      expect.unreachable('应当抛出 SNAPSHOT_HASH_MISMATCH')
    } catch (err) {
      expect(appErrorCode(err)).toBe('CONFLICT')
      expect((err as OperationError).message).toMatch(/SNAPSHOT_HASH_MISMATCH/)
    }
  })
})

// ---------- 报告版本与子问题序号 ----------

describe('报告版本与子问题约束', () => {
  it('重复 report version 拒绝;latestReport 返回最大版本', async () => {
    const db = await makeTestDb()
    const { runId } = seedResearchRun(db)

    createReport(db, runId, { version: 1, reportState: 'draft', markdown: '# v1' })
    expect(() => createReport(db, runId, { version: 1, reportState: 'final', markdown: '# v1 again' })).toThrow(/报告版本已存在/)
    expect(appErrorCodeOf(() => createReport(db, runId, { version: 1, reportState: 'final', markdown: '# x' }))).toBe('CONFLICT')

    createReport(db, runId, { version: 2, reportState: 'final', markdown: '# v2' })
    const latest = latestReport(db, getResearchTaskByRun(db, runId)!.researchTaskId)
    expect(latest?.version).toBe(2)
    expect(latest?.reportState).toBe('final')
  })

  it('重复 ordinal 拒绝;非 research 模式经库层外键/守卫拒绝', async () => {
    const db = await makeTestDb()
    const { runId } = seedResearchRun(db)
    createSubQuestion(db, runId, { ordinal: 1, question: '一' })
    expect(() => createSubQuestion(db, runId, { ordinal: 1, question: '一再' })).toThrow(/序号已存在/)

    // 直接对 personal_ops 运行建子问题:模式守卫在写入前拒绝
    initWorkspaceEpoch()
    const personal = createRun(db, { mode: 'personal_ops', input: 'x', contextClock: CONTEXT_CLOCK })
    expect(() => createSubQuestion(db, personal.runId, { ordinal: 1, question: 'q' })).toThrow(/MODE_MISMATCH/)
  })
})

function appErrorCodeOf(fn: () => void): string | undefined {
  try {
    fn()
    return undefined
  } catch (err) {
    return appErrorCode(err)
  }
}

// ---------- 迁移:空库 up / down ----------

describe('研究迁移 v8', () => {
  it('REGISTRY_VERSION 与 SCHEMA_VERSION 一致且包含 v8 条目', () => {
    expect(REGISTRY_VERSION).toBe(SCHEMA_VERSION)
    expect(MIGRATIONS.map((m) => m.version)).toContain(8)
  })

  it('从空库 up 后 7 张研究表就位,不新建重复共享表', async () => {
    const db = await openEmptyDb()
    db.transaction(() => applyPending(db))
    const names = tableNames(db)
    for (const table of [
      'research_tasks',
      'research_subquestions',
      'research_evidence_spans',
      'research_claims',
      'research_citations',
      'research_reports',
      'research_snapshot_manifests'
    ]) {
      expect(names).toContain(table)
    }
    // 不新建重复的运行/文档/队列表:运行仍只有 agent_runs,文档表仍是 retrieval_* 系列(FTS 派生表含内部影子表)
    expect(names.filter((n) => n.includes('run')).sort()).toEqual(['agent_runs'])
    expect(names.filter((n) => n.startsWith('retrieval')).sort()).toEqual([
      'retrieval_chunks',
      'retrieval_documents',
      'retrieval_fts',
      'retrieval_fts_docsize',
      'retrieval_fts_segdir',
      'retrieval_fts_segments',
      'retrieval_fts_stat'
    ])
    expect(names.filter((n) => n.includes('queue') || n.includes('job'))).toEqual([])
  })

  it('down 可回滚到无研究表状态,再 up 可重建', async () => {
    const db = await openEmptyDb()
    db.transaction(() => applyPending(db))
    db.transaction(() => rollbackTo(db, 7))
    const afterDown = tableNames(db)
    for (const table of [
      'research_tasks',
      'research_subquestions',
      'research_evidence_spans',
      'research_claims',
      'research_citations',
      'research_reports',
      'research_snapshot_manifests'
    ]) {
      expect(afterDown).not.toContain(table)
    }
    // v7 及更低版本的结构保留
    expect(afterDown).toContain('agent_runs')
    expect(afterDown).toContain('retrieval_documents')

    db.transaction(() => {
      expect(applyPending(db)).toBe(SCHEMA_VERSION)
    })
    expect(tableNames(db)).toContain('research_tasks')
  })

  it('研究表外键生效:research_tasks.run_id 必须指向存在的 agent_runs 行', async () => {
    const db = await makeTestDb()
    const manifest = FIXED_CLOCK.now().toISOString()
    db.run(
      'INSERT INTO research_snapshot_manifests (manifest_id, schema_version, entries_json, manifest_sha256, created_at) VALUES (?, 1, ?, ?, ?)',
      ['m-1', '[]', 'sha', manifest]
    )
    expect(() =>
      db.run(
        `INSERT INTO research_tasks
           (research_task_id, run_id, question, constraints_json, snapshot_manifest_id, budget_json, phase, config_json, parent_run_id, created_at)
         VALUES ('t-1', 'no-such-run', 'q', NULL, 'm-1', '{}', 'queued', NULL, NULL, ?)`,
        [manifest]
      )
    ).toThrow(/FOREIGN KEY/)
  })

  it('研究表 CHECK 生效:phase/ordinal/status/claim_type/relation 越界即失败', async () => {
    const db = await makeTestDb()
    const { runId } = seedResearchRun(db)
    const task = getResearchTaskByRun(db, runId)!
    expect(() => db.run("UPDATE research_tasks SET phase = 'flying' WHERE research_task_id = ?", [task.researchTaskId])).toThrow(/CHECK/)
    expect(() =>
      db.run("INSERT INTO research_subquestions (subquestion_id, research_task_id, ordinal, question, status) VALUES ('s-9', ?, 9, 'q', 'pending')", [task.researchTaskId])
    ).toThrow(/CHECK/)
    expect(() =>
      db.run("INSERT INTO research_evidence_spans (evidence_id, subquestion_id, snapshot_id, chunk_id, start_offset, end_offset, quote, span_sha256, validation_status) VALUES ('e-9', 's-x', 'd', 'c', 5, 3, 'q', 'sha', 'candidate')")
    ).toThrow(/CHECK/)
  })
})

// ---------- runOperation 集成:研究创建在既有幂等回执体系内 ----------

describe('runOperation 集成', () => {
  it('createResearchRun 的回执进入既有幂等体系:同 ID 不同摘要 CONFLICT', async () => {
    const db = await makeTestDb()
    seedSnapshot(db, 'snap-1', '要求:Python。')
    initWorkspaceEpoch()
    createResearchRun(db, { request: validRequest(), contextClock: CONTEXT_CLOCK, clock: FIXED_CLOCK }, 'op-receipt')
    // 回执已登记:同 ID 不同 requestHash 的 runOperation 直接 CONFLICT(不再执行 apply)
    expect(() =>
      runOperation(db, { operationId: 'op-receipt', command: 'research:create-run', requestHash: 'different', workspaceEpoch: 'epoch' }, () => null)
    ).toThrow(/不同的请求内容/)
    // 全库恰好一次创建:1 个运行、1 个任务
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agent_runs')!.n).toBe(1)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM research_tasks')!.n).toBe(1)
  })
})
