// R-04 工作流测试:阶段链、澄清一轮、预算耗尽 partial/failed、受控重试、活动时限、
// 等待答案不占执行权、事件流按 seq 补发、重启恢复、队列争抢与取消。
// 覆盖执行清单步骤 16 的验收项(docs/ai-application-portfolio-execution-order.md 步骤 16)。
//
// harness 惯例参照 tests/agent/orchestrator.test.ts:FakeProvider 脚本 + 手动单调时钟
// + fixedClock;每次测试独立临时库,initSchema 从空库建全量表。
// 脚本一律按 request.system 分支(规划器/抽取器/审核员/组织员),不按 callIndex——
// 多运行共享 provider 时 callIndex 会漂移,按角色分支才与运行解耦。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openDatabase, type SqliteDb } from '../../src/main/db/connection'
import { initSchema } from '../../src/main/db/dao'
import { initWorkspaceEpoch, OperationError } from '../../src/main/db/operations'
import { fixedClock, systemClock, type Clock } from '../../src/shared/clock'
import { RunQueue } from '../../src/main/agent/runQueue'
import type { AgentRunView, TraceEvent } from '../../src/shared/agent'
import { FakeProvider } from '../../src/main/providers/fake'
import type { StructuredCompleteRequest } from '../../src/main/agent/llm'
import { recoverInterruptedRuns } from '../../src/main/agent/recovery'
import {
  ResearchWorkflow,
  parseExtractionOutput,
  parseResearchPlanOutput
} from '../../src/main/research/workflow'
import { createLedger, deserializeLedger, restoreLedger } from '../../src/main/research/budget'
import { getResearchTaskByRun, listSubQuestions, loadResearchCheckpoint } from '../../src/main/research/repository'
import { importResearchSources, type ImportedResearchSource } from '../../src/main/research/snapshots'
import { getRun, listTraceEvents, transitionRun } from '../../src/main/runs/repository'
import { saveResearchCheckpoint } from '../../src/main/research/repository'

const SQL_JS_DIST = join(process.cwd(), 'node_modules', 'sql.js', 'dist')
const FIXED_CLOCK = fixedClock('2026-09-27T08:00:00.000Z')
const CONTEXT_CLOCK = '2026-09-27T08:00:00.000Z'

const SAMPLE_JD = '岗位:数据工程师。\n要求:Python 熟练。\n地点:上海。\n'
const QUOTE_PYTHON = '要求:Python 熟练。'

// ---------- 手动单调时钟:now() 固定,monotonicMs 按推进量返回 ----------

function makeManualClock(): Clock & { advance(ms: number): void } {
  let monotonic = 0
  return {
    now: () => new Date('2026-09-27T08:00:00.000Z'),
    monotonicMs: () => monotonic,
    advance: (ms: number) => {
      expect(ms).toBeGreaterThanOrEqual(0)
      monotonic += ms
    }
  }
}

// ---------- 脚本工具 ----------

type FakeScript = (callIndex: number, request: StructuredCompleteRequest) => unknown

function planOf(
  subquestions: Array<{ question: string; query?: string }>,
  over: { clarifications?: Array<{ question_id: string; question: string; options?: string[]; required?: boolean }> } = {}
): unknown {
  return {
    subquestions,
    ...(over.clarifications ? { clarifications: over.clarifications } : {})
  }
}

/** 引用真实快照/块的抽取输出:quote-only(服务端唯一匹配补 offset) */
function extractionWithIds(snapshotId: string, chunkId: string, quote = QUOTE_PYTHON): unknown {
  return {
    evidence: [{ snapshot_id: snapshotId, chunk_id: chunkId, quote }],
    claims: [
      {
        text: '该岗位明确列出 Python 要求。',
        claim_type: 'fact',
        subject: { entity: '数据工程师', attribute: 'Python 要求' },
        supports: [0]
      }
    ]
  }
}

/** 审核分支:从审核 prompt 提取真实 claim ID,全部判 supported(片段直接支持) */
function supportedVerdictsFrom(prompt: string): unknown {
  const ids = Array.from(prompt.matchAll(/Claim\(([0-9a-f-]+)\)/g)).map((m) => m[1]!)
  return { verdicts: ids.map((id) => ({ claim_id: id, status: 'supported', reason: '片段直接支持命题' })) }
}

/** 标准成功脚本:规划 1 题 → 抽取(真实 ID)→ 审核(supported)→ 组织 */
function successScript(ids: { snapshotId: string; chunkId: string }, subquestions: Array<{ question: string; query?: string }> = [{ question: '该岗位要求什么编程语言?' }]): FakeScript {
  return (_callIndex, request) => {
    if (request.system.includes('研究规划器')) return planOf(subquestions)
    if (request.system.includes('证据抽取器')) return extractionWithIds(ids.snapshotId, ids.chunkId)
    if (request.system.includes('证据审核员')) return supportedVerdictsFrom(request.prompt)
    return { sections: ['core_findings'], claim_order: [] }
  }
}

// ---------- harness ----------

interface Harness {
  db: SqliteDb
  clock: ReturnType<typeof makeManualClock>
  queue: RunQueue
  provider: FakeProvider
  workflow: ResearchWorkflow
  /** 已广播的事件(TraceEvent + 运行快照),按到达序 */
  emitted: Array<{ event: TraceEvent; run: AgentRunView }>
  snapshots: ImportedResearchSource[]
  ids: { snapshotId: string; chunkId: string }
}

async function makeHarness(scriptFactory?: (ids: { snapshotId: string; chunkId: string }) => FakeScript): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'research-workflow-'))
  const { db } = await openDatabase(join(dir, 'test.sqlite'), SQL_JS_DIST)
  initSchema(db)
  initWorkspaceEpoch()

  // 一份可检索的样例 JD(经 importResearchSources 全链路:规范化/分块/FTS 索引)
  const outcomes = importResearchSources(db, {
    sources: [{ sourceName: 'jd-a.md', sourceType: 'markdown', bytes: Buffer.from(SAMPLE_JD, 'utf-8'), sample: true }],
    clock: FIXED_CLOCK
  })
  const first = outcomes[0]!
  expect(first.ok, JSON.stringify(first.ok ? '' : first.error)).toBe(true)
  const snapshots = [first as ImportedResearchSource]
  const snapshotId = snapshots[0]!.documentId
  const chunkId = db.get<{ chunk_id: string }>(
    'SELECT chunk_id FROM retrieval_chunks WHERE document_id = ? ORDER BY chunk_index LIMIT 1',
    [snapshotId]
  )!.chunk_id
  const ids = { snapshotId, chunkId }

  const clock = makeManualClock()
  const queue = new RunQueue(db)
  const provider = new FakeProvider({
    script: scriptFactory ? scriptFactory(ids) : successScript(ids)
  })
  const emitted: Array<{ event: TraceEvent; run: AgentRunView }> = []
  const workflow = new ResearchWorkflow({
    db,
    queue,
    completer: provider,
    clock,
    events: { emit: (event, run) => emitted.push({ event, run }) }
  })
  return { db, clock, queue, provider, workflow, emitted, snapshots, ids }
}

/** 创建运行并同步驱动到终态/等待点 */
async function createAndDrive(
  h: Harness,
  requestOverrides: Record<string, unknown> = {},
  operationId = `op-${Math.random().toString(36).slice(2)}`
): Promise<string> {
  const budget = (requestOverrides.budget as Record<string, unknown> | undefined) ?? {}
  const rest = { ...requestOverrides }
  delete rest.budget
  const { value } = h.workflow.createRun(
    {
      request: {
        question: '该岗位要求什么编程语言?',
        snapshot_ids: h.snapshots.map((s) => s.documentId),
        snapshot_policy: 'fixed',
        budget,
        ...rest
      }
    },
    operationId
  )
  await h.workflow.driveResearch(value.run.runId)
  return value.run.runId
}

function eventPayloads(h: Harness, runId: string): Array<Record<string, unknown>> {
  return listTraceEvents(h.db, runId).map((e) => e.payload)
}

function researchEvents(h: Harness, runId: string, name: string): Array<Record<string, unknown>> {
  return eventPayloads(h, runId).filter((p) => p.event === name)
}

function clarifySetIdOf(h: Harness, runId: string): string {
  return (researchEvents(h, runId, 'research.clarification_required')[0] as { question_set_id: string }).question_set_id
}

function checkpointLedger(h: Harness, runId: string): ReturnType<typeof deserializeLedger> {
  const task = getResearchTaskByRun(h.db, runId)!
  const ckpt = loadResearchCheckpoint(h.db, task.researchTaskId) as { ledger?: unknown } | null
  expect(ckpt?.ledger).toBeDefined()
  return deserializeLedger(ckpt!.ledger)
}

// ---------- 解析器单测(形状契约) ----------

describe('模型输出解析器(未知字段拒绝)', () => {
  it('规划输出:未知字段/子问题超限/澄清超 3 项拒绝;合法形状通过', () => {
    expect(() => parseResearchPlanOutput({ subquestions: [{ question: 'q' }], extra: 1 }, 3)).toThrow(/未知字段/)
    expect(() => parseResearchPlanOutput({ subquestions: [] }, 3)).toThrow(/subquestions/)
    expect(() =>
      parseResearchPlanOutput({ subquestions: [{ question: '1' }, { question: '2' }, { question: '3' }, { question: '4' }] }, 3)
    ).toThrow(/max_subqueries/)
    expect(() =>
      parseResearchPlanOutput(
        { subquestions: [{ question: 'q' }], clarifications: Array.from({ length: 4 }, (_, i) => ({ question_id: `q${i}`, question: 'x' })) },
        3
      )
    ).toThrow(/最多 3 个/)
    const ok = parseResearchPlanOutput(
      {
        subquestions: [{ question: '该岗位要求什么语言?', query: '编程语言 要求', goal_fields: ['语言'], entity_scope: ['数据工程师'], compare_dimensions: ['级别'] }],
        clarifications: [{ question_id: 'target', question: '目标岗位?', options: ['数据工程师', '算法工程师'], required: true }]
      },
      3
    )
    expect(ok.subquestions).toHaveLength(1)
    expect(ok.clarifications[0]!.required).toBe(true)
  })

  it('抽取输出:未知字段/非法下标/非法 claim_type 拒绝;quote-only 证据通过', () => {
    expect(() => parseExtractionOutput({ evidence: [], claims: [], extra: 1 })).toThrow(/未知字段/)
    expect(() => parseExtractionOutput({ evidence: [{ snapshot_id: 's', chunk_id: 'c', quote: 'q', bad: 1 }], claims: [] })).toThrow(/未知字段/)
    expect(() =>
      parseExtractionOutput({ evidence: [], claims: [{ text: 't', claim_type: 'guess', supports: [] }] })
    ).toThrow(/claim_type/)
    expect(() =>
      parseExtractionOutput({ evidence: [], claims: [{ text: 't', claim_type: 'fact', supports: [-1] }] })
    ).toThrow(/下标/)
    const ok = parseExtractionOutput({
      evidence: [{ snapshot_id: 's', chunk_id: 'c', quote: '要求:Python。' }],
      claims: [{ text: '要求 Python', claim_type: 'fact', supports: [0], all_of: true }]
    })
    expect(ok.evidence[0]!.start_offset).toBeUndefined()
    expect(ok.claims[0]!.all_of).toBe(true)
  })
})

// ---------- 阶段链:规划 → 抽取 → 审核 → 组织 → succeeded ----------

describe('完整成功路径', () => {
  it('规划(≤3 子问题)→ 逐题检索/抽取 → 审核 → 组织 → succeeded + report_saved', async () => {
    const h = await makeHarness((ids) =>
      successScript(ids, [
        { question: '该岗位要求什么编程语言?', query: '编程语言 要求' },
        { question: '该岗位的工作地点?' }
      ])
    )
    const runId = await createAndDrive(h)

    expect(getRun(h.db, runId)?.status).toBe('succeeded')
    const task = getResearchTaskByRun(h.db, runId)!
    const subs = listSubQuestions(h.db, task.researchTaskId)
    expect(subs).toHaveLength(2) // 规划最多 3 个;本例 2 个全部落库
    expect(subs.map((s) => s.ordinal)).toEqual([1, 2])
    expect(subs.every((s) => s.status === 'answered')).toBe(true) // 审核通过 → answered

    // 事件链:冻结 → 计划 → 检索×2 → 证据检查 → 报告保存,seq 从 1 连续
    const events = listTraceEvents(h.db, runId)
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1))
    const names = eventPayloads(h, runId).map((p) => p.event)
    expect(names[0]).toBe('research.snapshot_frozen')
    expect(names).toContain('research.plan_created')
    expect(names.filter((n) => n === 'research.retrieval_completed')).toHaveLength(2)
    expect(names).toContain('research.evidence_checked')
    expect(names).toContain('research.report_saved')
    // 广播:公共终态经 AgentEventStream(updated + finished)
    expect(h.emitted.some((e) => e.run.runId === runId && e.run.status === 'succeeded')).toBe(true)
    // 完整报告:全部子问题 answered → final
    const report = h.db.get<{ report_state: string; version: number }>(
      'SELECT report_state, version FROM research_reports WHERE research_task_id = ?',
      [task.researchTaskId]
    )
    expect(report?.report_state).toBe('final')
    expect(report?.version).toBe(1)
  })

  it('模型给出的 offset 错误时拒绝该证据(服务端重验,不采信模型坐标)', async () => {
    const h = await makeHarness((ids) => (_callIndex, request) => {
      if (request.system.includes('研究规划器')) return planOf([{ question: '该岗位要求什么编程语言?' }])
      if (request.system.includes('证据抽取器')) {
        // offset 指向错误位置:切片与 quote 不一致 → 服务端拒绝该证据
        return {
          evidence: [{ snapshot_id: ids.snapshotId, chunk_id: ids.chunkId, quote: QUOTE_PYTHON, start_offset: 0, end_offset: 5 }],
          claims: [{ text: '要求 Python', claim_type: 'fact', supports: [0] }]
        }
      }
      if (request.system.includes('证据审核员')) return supportedVerdictsFrom(request.prompt)
      return { sections: ['core_findings'], claim_order: [] }
    })
    const runId = await createAndDrive(h)

    expect(getRun(h.db, runId)?.status).toBe('succeeded')
    // 错误 offset 的证据被拒:无证据落库,claim 无引用 → 结构检查落 unsupported
    const task = getResearchTaskByRun(h.db, runId)!
    expect(
      h.db.all('SELECT * FROM research_evidence_spans WHERE subquestion_id = ?', [
        listSubQuestions(h.db, task.researchTaskId)[0]!.subquestionId
      ])
    ).toHaveLength(0)
    const claims = h.db.all<{ support_status: string }>('SELECT support_status FROM research_claims')
    expect(claims.length).toBeGreaterThan(0)
    expect(claims.every((c) => c.support_status === 'unsupported')).toBe(true)
  })

  it('quote-only 证据:限定 chunk 内唯一精确匹配由服务端补 offset 且 span 有效', async () => {
    const h = await makeHarness()
    const runId = await createAndDrive(h)

    expect(getRun(h.db, runId)?.status).toBe('succeeded')
    const task = getResearchTaskByRun(h.db, runId)!
    const spans = h.db.all<{ quote: string; start_offset: number; end_offset: number; validation_status: string }>(
      'SELECT quote, start_offset, end_offset, validation_status FROM research_evidence_spans WHERE subquestion_id = ?',
      [listSubQuestions(h.db, task.researchTaskId)[0]!.subquestionId]
    )
    expect(spans).toHaveLength(1)
    expect(spans[0]!.quote).toBe(QUOTE_PYTHON)
    // 服务端在限定 chunk 内唯一匹配定位:offset 是规范化全文的码点坐标
    const cps = Array.from(
      h.db.get<{ normalized_text: string }>('SELECT normalized_text FROM retrieval_documents WHERE document_id = ?', [
        h.ids.snapshotId
      ])!.normalized_text
    )
    const needle = Array.from(QUOTE_PYTHON)
    let start = -1
    for (let i = 0; i + needle.length <= cps.length; i += 1) {
      if (needle.every((ch, j) => cps[i + j] === ch)) {
        start = i
        break
      }
    }
    expect(spans[0]!.start_offset).toBe(start)
    expect(spans[0]!.end_offset).toBe(start + needle.length)
    expect(spans[0]!.validation_status).toBe('valid')
  })

  it('同 quote 多处命中:拒绝该证据(不猜 offset);候选外 chunk 拒绝', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'research-workflow-dup-'))
    const { db } = await openDatabase(join(dir, 'test.sqlite'), SQL_JS_DIST)
    initSchema(db)
    initWorkspaceEpoch()
    const outcomes = importResearchSources(db, {
      sources: [{ sourceName: 'jd-dup.md', sourceType: 'markdown', bytes: Buffer.from('要求:Python。\n中间段。\n要求:Python。\n', 'utf-8') }],
      clock: FIXED_CLOCK
    })
    const doc = outcomes[0] as ImportedResearchSource
    expect(doc.ok).toBe(true)
    const snapshotId = doc.documentId
    const chunkId = db.get<{ chunk_id: string }>('SELECT chunk_id FROM retrieval_chunks WHERE document_id = ? LIMIT 1', [snapshotId])!.chunk_id
    const provider = new FakeProvider({
      script: (_callIndex, request) => {
        if (request.system.includes('研究规划器')) return planOf([{ question: '要求什么?' }])
        if (request.system.includes('证据抽取器')) return extractionWithIds(snapshotId, chunkId, '要求:Python。')
        if (request.system.includes('证据审核员')) return supportedVerdictsFrom(request.prompt)
        return { sections: ['core_findings'], claim_order: [] }
      }
    })
    const workflow = new ResearchWorkflow({ db, queue: new RunQueue(db), completer: provider, clock: makeManualClock() })
    const { value } = workflow.createRun(
      { request: { question: '要求什么?', snapshot_ids: [snapshotId], snapshot_policy: 'fixed', budget: {} } },
      'op-dup'
    )
    await workflow.driveResearch(value.run.runId)
    expect(getRun(db, value.run.runId)?.status).toBe('succeeded')
    // 同 quote 多处命中:全部拒绝,无证据落库;claim 无引用 → 结构检查落 unsupported
    expect(db.all('SELECT * FROM research_evidence_spans')).toHaveLength(0)
    const claims = db.all<{ support_status: string }>('SELECT support_status FROM research_claims')
    expect(claims.length).toBeGreaterThan(0)
    expect(claims.every((c) => c.support_status === 'unsupported')).toBe(true)
  })
})

// ---------- 澄清:最多一轮 3 项、等待不占执行权、答案不改冻结集合 ----------

describe('澄清轮', () => {
  it('需要澄清进入 awaiting_input,等待答案时 RunQueue.isBusy 为 false;答案后继续同一运行', async () => {
    const h = await makeHarness((ids) => (_callIndex, request) => {
      if (request.system.includes('研究规划器')) {
        // 本用例的规划只发生一次(澄清后不重新规划):带 3 项澄清
        return planOf([{ question: '该岗位要求什么编程语言?' }], {
          clarifications: [
            { question_id: 'target', question: '目标岗位是什么?', options: ['数据工程师', '算法工程师'], required: true },
            { question_id: 'city', question: '关注哪个城市?' },
            { question_id: 'level', question: '关注什么级别?' }
          ]
        })
      }
      if (request.system.includes('证据抽取器')) return extractionWithIds(ids.snapshotId, ids.chunkId)
      if (request.system.includes('证据审核员')) return supportedVerdictsFrom(request.prompt)
      return { sections: ['core_findings'], claim_order: [] }
    })
    const runId = await createAndDrive(h)

    // 等待澄清:awaiting_input,执行权已释放
    expect(getRun(h.db, runId)?.status).toBe('awaiting_input')
    expect(h.queue.isBusy()).toBe(false)
    const names = eventPayloads(h, runId).map((p) => p.event)
    expect(names).toContain('research.clarification_required')
    expect(researchEvents(h, runId, 'research.clarification_required')[0]!.questions).toHaveLength(3) // 最多 3 项
    const setId = clarifySetIdOf(h, runId)

    const taskBefore = getResearchTaskByRun(h.db, runId)!
    const manifestBefore = h.db.get<{ entries_json: string }>(
      'SELECT entries_json FROM research_snapshot_manifests WHERE manifest_id = ?',
      [taskBefore.snapshotManifestId]
    )!.entries_json

    // 过期题组拒绝(STALE_QUESTION_SET)
    expect(() =>
      h.workflow.acceptResearchAnswers(runId, {
        question_set_id: 'stale-set',
        answers: [{ question_id: 'target', value: '数据工程师' }]
      })
    ).toThrow(/STALE_QUESTION_SET/)

    // 答案通道只接受 {question_id, value}:夹带其他形状的答案项直接拒绝
    expect(() =>
      h.workflow.acceptResearchAnswers(runId, {
        question_set_id: setId,
        answers: [{ question_id: 'target', value: '数据工程师', snapshot_ids: [] } as never]
      })
    ).toThrow(/未知字段/)

    // 正确受理 → 重新入队并驱动;冻结清单不变,无第二次规划调用
    await h.workflow.submitResearchAnswers(runId, {
      question_set_id: setId,
      answers: [
        { question_id: 'target', value: '数据工程师' },
        { question_id: 'city', value: '上海' },
        { question_id: 'level', value: '实习' }
      ]
    })
    expect(getRun(h.db, runId)?.status).toBe('succeeded')

    const manifestAfter = h.db.get<{ entries_json: string }>(
      'SELECT entries_json FROM research_snapshot_manifests WHERE manifest_id = ?',
      [taskBefore.snapshotManifestId]
    )!.entries_json
    expect(manifestAfter).toBe(manifestBefore) // 答案不改冻结来源集合
    // 规划模型只调了 1 次(澄清后不重新规划):规划1 + 抽取1 + 审核1 + 组织1 = 4
    expect(h.provider.callTotal).toBe(4)
  })

  it('澄清答案不在枚举内/空回答/超长拒绝', async () => {
    const h = await makeHarness((ids) => (_callIndex, request) => {
      if (request.system.includes('研究规划器')) {
        return planOf([{ question: 'q' }], {
          clarifications: [{ question_id: 'target', question: '目标?', options: ['A', 'B'], required: true }]
        })
      }
      if (request.system.includes('证据抽取器')) return extractionWithIds(ids.snapshotId, ids.chunkId)
      if (request.system.includes('证据审核员')) return supportedVerdictsFrom(request.prompt)
      return { sections: ['core_findings'], claim_order: [] }
    })
    const runId = await createAndDrive(h)
    expect(getRun(h.db, runId)?.status).toBe('awaiting_input')
    const setId = clarifySetIdOf(h, runId)

    expect(() => h.workflow.acceptResearchAnswers(runId, { question_set_id: setId, answers: [{ question_id: 'target', value: 'C' }] }))
      .toThrow(/枚举/)
    expect(() => h.workflow.acceptResearchAnswers(runId, { question_set_id: setId, answers: [] })).toThrow(/不能为空/)
    expect(() =>
      h.workflow.acceptResearchAnswers(runId, { question_set_id: setId, answers: [{ question_id: 'target', value: '长'.repeat(1001) }] })
    ).toThrow(/码点/)
  })
})

// ---------- 预算耗尽:partial + BUDGET_EXHAUSTED + skipped / 无产物 failed ----------

describe('预算耗尽与收尾', () => {
  it('六次调用用尽(含重试)→ partial + BUDGET_EXHAUSTED + skipped 列表', async () => {
    // 预算 5:规划1 + 审核1(预留)+ 抽取1、2(成功)+ 抽取3(429)→ 重试 reserve 时
    // 总额耗尽 → BudgetExhaustedError → 收尾;第 3 题未判定 → skipped。
    const h = await makeHarness((ids) => (_callIndex, request) => {
      if (request.system.includes('研究规划器')) {
        return planOf([
          { question: '该岗位要求什么编程语言?' },
          { question: '该岗位的工作地点?' },
          { question: '该岗位的薪资范围?' }
        ])
      }
      if (request.system.includes('证据抽取器')) {
        if (extractionCalls++ === 2) throw new Error('429: too many requests') // 第 3 题基础调用失败
        return extractionWithIds(ids.snapshotId, ids.chunkId)
      }
      if (request.system.includes('证据审核员')) return supportedVerdictsFrom(request.prompt)
      return { sections: ['core_findings'], claim_order: [] }
    })
    let extractionCalls = 0
    const runId = await createAndDrive(h, { budget: { max_model_calls: 5 } }, 'op-exhaust')

    const after = getRun(h.db, runId)
    expect(after?.status).toBe('partial')
    expect(after?.errorCode).toBe('BUDGET_EXHAUSTED')
    const task = getResearchTaskByRun(h.db, runId)!
    const subs = listSubQuestions(h.db, task.researchTaskId)
    expect(subs.map((s) => s.status)).toContain('skipped')
    // 被跳过的子问题在收尾事件中列出
    const finals = eventPayloads(h, runId).filter((p) => p.status !== undefined && p.skipped_subquestions !== undefined)
    expect(finals.length).toBeGreaterThan(0)
    expect((finals[0] as { status: string }).status).toBe('partial')
    expect((finals[0] as { reason: string }).reason).toBe('BUDGET_EXHAUSTED')
    expect((finals[0] as { skipped_subquestions: string[] }).skipped_subquestions.length).toBeGreaterThan(0)
    // partial 报告:模板输出(无组织预算),版本 1
    const report = h.db.get<{ report_state: string }>(
      'SELECT report_state FROM research_reports WHERE research_task_id = ?',
      [task.researchTaskId]
    )
    expect(report?.report_state).toBe('partial')
    // 预算耗尽事件落库;全部实际模型调用(含重试)不超预算
    expect(eventPayloads(h, runId).map((p) => p.event)).toContain('research.budget_exhausted')
    expect(h.provider.callTotal).toBeLessThanOrEqual(5)
  })

  it('完全无产物时预算耗尽 → failed(BUDGET_EXHAUSTED)', async () => {
    // 预算 3:规划1 + 审核1(预留)+ 抽取1(429)→ 重试 reserve 时总额耗尽 →
    // BudgetExhaustedError;该题未判定 → skipped;无任何产物 → failed。
    const h = await makeHarness((_ids) => (_callIndex, request) => {
      if (request.system.includes('研究规划器')) return planOf([{ question: '该岗位要求什么?' }])
      if (request.system.includes('证据抽取器')) throw new Error('429: rate limited')
      return { verdicts: [] }
    })
    const runId = await createAndDrive(h, { budget: { max_model_calls: 3 } }, 'op-failed')

    const after = getRun(h.db, runId)
    expect(after?.status).toBe('failed')
    expect(after?.errorCode).toBe('BUDGET_EXHAUSTED')
    expect(h.provider.callTotal).toBeLessThanOrEqual(3)
  })

  it('活动时间到达(可控单调时钟)→ 终止检索与模型请求,以收尾段保存 partial', async () => {
    // max_active_seconds=10;第 1 题抽取在途时推进时钟越过时限 → 第 2 题前 DEADLINE
    let clockRef: ReturnType<typeof makeManualClock> | null = null
    const h = await makeHarness((ids) => (callIndex, request) => {
      if (request.system.includes('研究规划器')) {
        return planOf([
          { question: '该岗位要求什么编程语言?' },
          { question: '该岗位的工作地点?' }
        ])
      }
      if (request.system.includes('证据抽取器')) {
        if (callIndex === 1) {
          clockRef!.advance(15000) // 抽取在途:时限到达
          return extractionWithIds(ids.snapshotId, ids.chunkId)
        }
        throw new Error('时限后不应再有抽取调用')
      }
      if (request.system.includes('证据审核员')) throw new Error('时限后不应有审核调用')
      return { sections: ['core_findings'], claim_order: [] }
    })
    clockRef = h.clock
    const runId = await createAndDrive(h, { budget: { max_active_seconds: 10 } }, 'op-deadline')

    const after = getRun(h.db, runId)
    expect(after?.status).toBe('partial')
    // 错误码词表对齐 R-01:DEADLINE_REACHED 归并为 BUDGET_EXHAUSTED(细分原因在 trace)
    expect(after?.errorCode).toBe('BUDGET_EXHAUSTED')
    const ledger = checkpointLedger(h, runId)
    expect(ledger.deadlineReached).toBe(true)
    // 收尾段单独计时并落账
    expect(ledger.activity.finalizeMs).toBeGreaterThanOrEqual(0)
    // 时限后不再有第 2 题的检索/抽取:子问题 2 被跳过
    const task = getResearchTaskByRun(h.db, runId)!
    const subs = listSubQuestions(h.db, task.researchTaskId)
    expect(subs[1]!.status).toBe('skipped')
    // 终止后不发起模型请求:只有规划 + 第 1 题抽取
    expect(h.provider.callTotal).toBe(2)
  })
})

// ---------- 受控重试:429/无效输出占预算且最多一次 ----------

describe('受控重试', () => {
  it('模型 429 → 重试占预算且成功;重试额度与总额不超', async () => {
    const h = await makeHarness((ids) => (_callIndex, request) => {
      if (request.system.includes('研究规划器')) return planOf([{ question: '该岗位要求什么编程语言?' }])
      if (request.system.includes('证据抽取器')) {
        // 同步 throw(异步 rejection 会脱离脚本语义);首次 429,重试成功
        if (extractionAttempts++ === 0) throw new Error('429: rate limited')
        return extractionWithIds(ids.snapshotId, ids.chunkId)
      }
      if (request.system.includes('证据审核员')) return supportedVerdictsFrom(request.prompt)
      return { sections: ['core_findings'], claim_order: [] }
    })
    let extractionAttempts = 0
    const runId = await createAndDrive(h)
    expect(getRun(h.db, runId)?.status).toBe('succeeded')
    const ledger = checkpointLedger(h, runId)
    // 重试占预算:抽取 1 基础 + 1 重试;规划/审核/组织各 1
    expect(ledger.slots.extraction.retries).toBe(1)
    expect(ledger.slots.planning.used + ledger.slots.review.used + ledger.slots.synthesis.used).toBe(3)
    expect(h.provider.callTotal).toBe(5) // 规划1 + 抽取1 + 重试1 + 审核1 + 组织1
  })

  it('重试后仍失败:运行错误 MODEL_OUTPUT_INVALID,已扣预算如实保留', async () => {
    const h = await makeHarness((_ids) => (_callIndex, request) => {
      if (request.system.includes('研究规划器')) return planOf([{ question: '该岗位要求什么?' }])
      if (request.system.includes('证据抽取器')) throw new Error('429')
      return { verdicts: [] }
    })
    const runId = await createAndDrive(h)
    const after = getRun(h.db, runId)
    expect(after?.status).toBe('failed')
    expect(after?.errorCode).toBe('MODEL_OUTPUT_INVALID')
    // 重试不能逃过预算:基础 + 重试都已扣
    const ledger = checkpointLedger(h, runId)
    expect(ledger.slots.extraction.used).toBe(1)
    expect(ledger.slots.extraction.retries).toBe(1)
    expect(h.provider.callTotal).toBe(3) // 规划1 + 基础1 + 重试1
  })
})

// ---------- 等待答案不占执行权 + 队列争抢 ----------

describe('队列与执行权', () => {
  it('同一时刻两个运行争抢执行权:后到者排队;先到者收尾后驱动后到者', async () => {
    const h = await makeHarness((ids) => successScript(ids)) // 两运行共用同一脚本(按角色分支,与 callIndex 解耦)
    const first = h.workflow.createRun(
      { request: { question: '第一个问题?', snapshot_ids: h.snapshots.map((s) => s.documentId), snapshot_policy: 'fixed', budget: {} } },
      'op-q1'
    ).value
    const second = h.workflow.createRun(
      { request: { question: '第二个问题?', snapshot_ids: h.snapshots.map((s) => s.documentId), snapshot_policy: 'fixed', budget: {} } },
      'op-q2'
    ).value

    // 先驱动 A:A 占执行权;B 尝试驱动失败(排队)
    const driveA = h.workflow.driveResearch(first.run.runId)
    await h.workflow.driveResearch(second.run.runId)
    expect(getRun(h.db, second.run.runId)?.status).toBe('queued')
    await driveA
    expect(getRun(h.db, first.run.runId)?.status).toBe('succeeded')
    // A 收尾释放执行权后,B 由 driveNextQueued 异步驱动到终态(void 链,轮询等待)
    await vi.waitFor(
      () => {
        const status = getRun(h.db, second.run.runId)?.status
        if (status !== 'succeeded') throw new Error(`B 仍在 ${status ?? '未知'} 状态`)
      },
      { timeout: 2000, interval: 20 }
    )
    expect(getRun(h.db, second.run.runId)?.status).toBe('succeeded')
    // 执行实例唯一:全程收尾后无运行占用执行权(isBusy 读取 SLOT_HOLDING 状态)
    expect(h.queue.isBusy()).toBe(false)
  })

  it('等待答案的运行不占执行权:排队中的下一个运行可被驱动', async () => {
    const h = await makeHarness((ids) => (_callIndex, request) => {
      if (request.system.includes('研究规划器')) {
        // A 的问题带澄清,B 的问题不带——用问题文本区分(与 callIndex 解耦)
        if (request.prompt.includes('A 问题')) {
          return planOf([{ question: 'q?' }], { clarifications: [{ question_id: 'c1', question: '缺信息' }] })
        }
        return planOf([{ question: 'q2?' }])
      }
      if (request.system.includes('证据抽取器')) return extractionWithIds(ids.snapshotId, ids.chunkId)
      if (request.system.includes('证据审核员')) return supportedVerdictsFrom(request.prompt)
      return { sections: ['core_findings'], claim_order: [] }
    })
    const a = h.workflow.createRun(
      { request: { question: 'A 问题', snapshot_ids: h.snapshots.map((s) => s.documentId), snapshot_policy: 'fixed', budget: {} } },
      'op-wait-a'
    ).value
    const b = h.workflow.createRun(
      { request: { question: 'B 问题', snapshot_ids: h.snapshots.map((s) => s.documentId), snapshot_policy: 'fixed', budget: {} } },
      'op-wait-b'
    ).value

    await h.workflow.driveResearch(a.run.runId)
    expect(getRun(h.db, a.run.runId)?.status).toBe('awaiting_input')
    expect(h.queue.isBusy()).toBe(false) // 等待答案不占执行权

    await h.workflow.driveResearch(b.run.runId)
    expect(getRun(h.db, b.run.runId)?.status).toBe('succeeded') // B 不被 A 阻塞
  })
})

// ---------- 取消:始终 cancelled,不伪装 partial ----------

describe('取消', () => {
  it('取消场景:规划后立即取消,阶段边界检查中断;终态 cancelled 无报告', async () => {
    const h = await makeHarness((ids) =>
      successScript(ids, [
        { question: '该岗位要求什么编程语言?' },
        { question: '该岗位的工作地点?' }
      ])
    )
    const { value } = h.workflow.createRun(
      { request: { question: '该岗位要求什么编程语言?', snapshot_ids: h.snapshots.map((s) => s.documentId), snapshot_policy: 'fixed', budget: {} } },
      'op-cancel-2'
    )
    // 在规划完成前取消:driveResearch 的阶段边界检查发现取消即中断
    const drivePromise = h.workflow.driveResearch(value.run.runId)
    h.workflow.requestCancel(value.run.runId)
    await drivePromise

    const after = getRun(h.db, value.run.runId)
    expect(after?.status).toBe('cancelled')
    expect(after?.errorCode).toBe('CANCELLED')
    const task = getResearchTaskByRun(h.db, value.run.runId)!
    // 即使抽取产物已落库,也不生成报告版本、不改记 partial
    expect(
      h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM research_reports WHERE research_task_id = ?', [task.researchTaskId])!.n
    ).toBe(0)
    // 取消后运行释放执行权;已是 cancelled:幂等返回
    expect(h.queue.isBusy()).toBe(false)
    expect(h.workflow.requestCancel(value.run.runId).status).toBe('cancelled')
  })

  it('等待澄清时取消:cancelled(不伪装 partial)', async () => {
    const h = await makeHarness((ids) => (_callIndex, request) => {
      if (request.system.includes('研究规划器')) {
        return planOf([{ question: 'q' }], { clarifications: [{ question_id: 'c1', question: '缺信息' }] })
      }
      if (request.system.includes('证据抽取器')) return extractionWithIds(ids.snapshotId, ids.chunkId)
      return { verdicts: [] }
    })
    const { value } = h.workflow.createRun(
      { request: { question: 'q?', snapshot_ids: h.snapshots.map((s) => s.documentId), snapshot_policy: 'fixed', budget: {} } },
      'op-cancel-3'
    )
    await h.workflow.driveResearch(value.run.runId)
    expect(getRun(h.db, value.run.runId)?.status).toBe('awaiting_input')
    h.workflow.requestCancel(value.run.runId)
    expect(getRun(h.db, value.run.runId)?.status).toBe('cancelled')
  })
})

// ---------- 重启恢复:recovery 语义不变,awaiting_input 带 checkpoint 续跑 ----------

describe('重启恢复', () => {
  it('进程重启:recovery 把 planning/executing 标 failed/WORKER_INTERRUPTED,预算不复活', async () => {
    const h = await makeHarness()
    const { value } = h.workflow.createRun(
      { request: { question: '该岗位要求什么编程语言?', snapshot_ids: h.snapshots.map((s) => s.documentId), snapshot_policy: 'fixed', budget: {} } },
      'op-recover'
    )
    // 手动把运行推进到 executing(模拟执行中进程崩溃)
    const db = h.db
    transitionRun(db, value.run.runId, 'planning')
    const task = getResearchTaskByRun(db, value.run.runId)!
    // 预扣三次调用并落 checkpoint(模拟崩溃前已扣不复活)
    const ledger = createLedger({ budget: task.budget, clock: h.clock })
    ledger.activity.start()
    ledger.reserve('planning')
    ledger.sealPlan(1)
    ledger.reserve('review')
    ledger.reserve('extraction')
    saveResearchCheckpoint(db, task.researchTaskId, {
      workflowPhase: 'extracting',
      ledger: ledger.serializeLedger(),
      clarifications: null,
      answers: {},
      reviewCompleted: false,
      determinedSubIds: []
    })
    transitionRun(db, value.run.runId, 'executing')

    // 重启:既有 recovery 语义保持不变
    const recovered = recoverInterruptedRuns(db)
    expect(recovered.map((r) => r.runId)).toContain(value.run.runId)
    const after = getRun(db, value.run.runId)
    expect(after?.status).toBe('failed')
    expect(after?.errorCode).toBe('WORKER_INTERRUPTED')

    // 账本恢复逻辑可测:restoreLedger 恢复后预算不复活——剩余额度 = 6 - 3(已扣)
    const restoredLedger = restoreLedger({
      serialized: (loadResearchCheckpoint(db, task.researchTaskId) as { ledger: unknown }).ledger,
      clock: h.clock
    })
    expect(restoredLedger.remainingModelCalls).toBe(3) // 6 - 规划1 - 审核1 - 抽取1
    expect(() => restoredLedger.reserve('planning')).toThrow(/规划/) // 已消耗槽位不复活
    // 新驱动不会再运行(已终态):driveResearch 对非 queued 运行是空操作
    await h.workflow.driveResearch(value.run.runId)
    expect(getRun(db, value.run.runId)?.status).toBe('failed')
  })

  it('awaiting_input 重启后带 checkpoint 续跑:已扣的规划槽位不复活,继续抽取', async () => {
    const h = await makeHarness((ids) => (_callIndex, request) => {
      if (request.system.includes('研究规划器')) {
        return planOf([{ question: '该岗位要求什么编程语言?' }], {
          clarifications: [{ question_id: 'c1', question: '关注哪个城市?' }]
        })
      }
      if (request.system.includes('证据抽取器')) return extractionWithIds(ids.snapshotId, ids.chunkId)
      if (request.system.includes('证据审核员')) return supportedVerdictsFrom(request.prompt)
      return { sections: ['core_findings'], claim_order: [] }
    })
    const { value } = h.workflow.createRun(
      { request: { question: '该岗位要求什么编程语言?', snapshot_ids: h.snapshots.map((s) => s.documentId), snapshot_policy: 'fixed', budget: {} } },
      'op-resume'
    )
    await h.workflow.driveResearch(value.run.runId)
    expect(getRun(h.db, value.run.runId)?.status).toBe('awaiting_input')

    // 模拟重启:全新 workflow 实例(同库、无内存状态)
    const ids = h.ids
    const revivedProvider = new FakeProvider({
      script: (_callIndex, request) => {
        if (request.system.includes('证据抽取器')) return extractionWithIds(ids.snapshotId, ids.chunkId)
        if (request.system.includes('证据审核员')) return supportedVerdictsFrom(request.prompt)
        return { sections: ['core_findings'], claim_order: [] }
      }
    })
    const revived = new ResearchWorkflow({
      db: h.db,
      queue: h.queue,
      completer: revivedProvider,
      clock: h.clock
    })
    await revived.submitResearchAnswers(value.run.runId, {
      question_set_id: clarifySetIdOf(h, value.run.runId),
      answers: [{ question_id: 'c1', value: '上海' }]
    })
    expect(getRun(h.db, value.run.runId)?.status).toBe('succeeded')
    // 恢复后的规划槽位不复活:重启后只剩 抽取1 + 审核1 + 组织1 = 3 次调用
    expect(revivedProvider.callTotal).toBe(3)
    const ledger = checkpointLedger(h, value.run.runId)
    expect(ledger.slots.planning.used).toBe(1)
    expect(ledger.slots.review.used + ledger.slots.review.retries).toBe(1)
    expect(ledger.slots.synthesis.used).toBe(1)
  })
})

// ---------- 事件流:按 seq 补发不重不漏 ----------

describe('事件流', () => {
  it('全部事件 seq 从 1 连续;按 seq 补发(重放 afterSeq)不重不漏;广播与库一致', async () => {
    const h = await makeHarness()
    const runId = await createAndDrive(h)

    const events = listTraceEvents(h.db, runId)
    expect(events.length).toBeGreaterThan(3)
    // seq 从 1 连续递增,不重不漏
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: events.length }, (_, i) => i + 1))
    // afterSeq 补发语义(与共享 listTraceEvents 的 afterSeq 一致)
    const replayed = listTraceEvents(h.db, runId, Math.floor(events.length / 2))
    expect(replayed[0]!.seq).toBe(Math.floor(events.length / 2) + 1)
    expect(replayed).toHaveLength(events.length - Math.floor(events.length / 2))
    // 广播事件与库中事件一一对应(广播无重复 seq)
    const emittedSeqs = h.emitted.filter((e) => e.event.runId === runId).map((e) => e.event.seq)
    expect(new Set(emittedSeqs).size).toBe(emittedSeqs.length)
    expect(emittedSeqs).toEqual(events.map((e) => e.seq))
    // 公共终态广播:updated 先于 finished
    expect(h.emitted.some((e) => e.run.runId === runId && e.run.status === 'succeeded')).toBe(true)
    // payload 不含完整私有资料:任何事件 payload 都不带 JD 全文
    for (const event of events) {
      expect(JSON.stringify(event.payload)).not.toContain(SAMPLE_JD)
    }
  })
})

// ---------- 无 completer 与 mode 防护 ----------

describe('边界', () => {
  it('无 completer:规划以 MODEL_UNAVAILABLE 失败', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'research-workflow-noc-'))
    const { db } = await openDatabase(join(dir, 'test.sqlite'), SQL_JS_DIST)
    initSchema(db)
    initWorkspaceEpoch()
    const outcomes = importResearchSources(db, {
      sources: [{ sourceName: 'jd-a.md', sourceType: 'markdown', bytes: Buffer.from(SAMPLE_JD, 'utf-8') }],
      clock: FIXED_CLOCK
    })
    const doc = outcomes[0] as ImportedResearchSource
    const workflow = new ResearchWorkflow({ db, queue: new RunQueue(db), clock: systemClock })
    const { value } = workflow.createRun(
      { request: { question: '要求什么?', snapshot_ids: [doc.documentId], snapshot_policy: 'fixed', budget: {} } },
      'op-noc'
    )
    await workflow.driveResearch(value.run.runId)
    const after = getRun(db, value.run.runId)
    expect(after?.status).toBe('failed')
    expect(after?.errorCode).toBe('MODEL_UNAVAILABLE')
  })

  it('MODE_MISMATCH:研究操作拒绝 personal_ops 运行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'research-workflow-mode-'))
    const { db } = await openDatabase(join(dir, 'test.sqlite'), SQL_JS_DIST)
    initSchema(db)
    initWorkspaceEpoch()
    const { createRun } = await import('../../src/main/runs/repository')
    const run = createRun(db, { mode: 'personal_ops', input: '个人事务', contextClock: CONTEXT_CLOCK })
    const workflow = new ResearchWorkflow({ db, queue: new RunQueue(db), clock: systemClock })
    // requestCancel 走 assertResearchRun 守卫(MODE_MISMATCH / 运行不存在均拒绝)
    expect(() => workflow.requestCancel(run.runId)).toThrow(OperationError)
  })
})
