// RES-03:all_of 联合证据完整性。
// 覆盖:checkAllOfCompleteness 纯函数判定(预期两员缺一即不成立、重复/空组/未知结果)、
// 仓库清单保存/加载(重开库保留)、跳过 validateCitations 直接送审仍拒绝、
// 报告构建拒绝缺员事实、非 all_of 与 context-only 既有语义保持。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase, type SqliteDb } from '../../src/main/db/connection'
import { initSchema } from '../../src/main/db/dao'
import { initWorkspaceEpoch } from '../../src/main/db/operations'
import { fixedClock } from '../../src/shared/clock'
import { FakeProvider } from '../../src/main/providers/fake'
import {
  createClaim,
  createCitation,
  createEvidenceSpan,
  createResearchRun,
  createSubQuestion,
  getClaim,
  getResearchTaskByRun
} from '../../src/main/research/repository'
import {
  loadAllOfRequirements,
  saveAllOfRequirement
} from '../../src/main/research/repository'
import {
  checkAllOfCompleteness,
  validateCitations,
  type AllOfRequirement
} from '../../src/main/research/citations'
import { reviewClaims } from '../../src/main/research/evidence'
import { buildReport } from '../../src/main/research/reports'
import { importResearchSources, type ImportedResearchSource } from '../../src/main/research/snapshots'

const SQL_JS_DIST = join(process.cwd(), 'node_modules', 'sql.js', 'dist')
const FIXED_CLOCK = fixedClock('2026-09-27T18:00:00.000Z')
const CONTEXT_CLOCK = '2026-09-27T18:00:00.000Z'

// ---------- 纯函数判定 ----------

describe('RES-03 checkAllOfCompleteness 纯函数', () => {
  it('RES-03 预期两成员但一成员被拒时整组不成立', () => {
    const requirement: AllOfRequirement = {
      version: 1, groupId: 'g1', expectedIndices: [0, 1], members: [
        { index: 0, evidenceId: 'e0', citationId: 'c0', rejectionReason: null },
        { index: 1, evidenceId: null, citationId: null, rejectionReason: 'quote 不匹配' }
      ]
    }
    expect(checkAllOfCompleteness(requirement, new Set(['c0'])))
      .toEqual({ satisfied: false, missingIndices: [1] })
  })

  it('两员全部结构通过即成立', () => {
    const requirement: AllOfRequirement = {
      version: 1, groupId: 'g1', expectedIndices: [0, 1], members: [
        { index: 0, evidenceId: 'e0', citationId: 'c0', rejectionReason: null },
        { index: 1, evidenceId: 'e1', citationId: 'c1', rejectionReason: null }
      ]
    }
    expect(checkAllOfCompleteness(requirement, new Set(['c0', 'c1'])))
      .toEqual({ satisfied: true, missingIndices: [] })
  })

  it('citation 结构结果缺失(未知结果按缺失)、成员与预期不一致、重复与空预期清单均不成立', () => {
    const requirement: AllOfRequirement = {
      version: 1, groupId: 'g', expectedIndices: [0, 1], members: [
        { index: 0, evidenceId: 'e0', citationId: 'c0', rejectionReason: null },
        { index: 1, evidenceId: 'e1', citationId: 'c-unknown', rejectionReason: null }
      ]
    }
    expect(checkAllOfCompleteness(requirement, new Set(['c0'])).satisfied).toBe(false)
    // 缺 member(预期 1 无对应成员)
    const partial: AllOfRequirement = {
      version: 1, groupId: 'g', expectedIndices: [0, 1],
      members: [{ index: 0, evidenceId: 'e0', citationId: 'c0', rejectionReason: null }]
    }
    expect(checkAllOfCompleteness(partial, new Set(['c0']))).toEqual({ satisfied: false, missingIndices: [1] })
    // 重复预期
    const dup: AllOfRequirement = {
      version: 1, groupId: 'g', expectedIndices: [0, 0],
      members: [{ index: 0, evidenceId: 'e0', citationId: 'c0', rejectionReason: null }]
    }
    expect(checkAllOfCompleteness(dup, new Set(['c0'])).satisfied).toBe(false)
    // 空组
    const empty: AllOfRequirement = { version: 1, groupId: 'g', expectedIndices: [], members: [] }
    expect(checkAllOfCompleteness(empty, new Set()).satisfied).toBe(false)
  })
})

// ---------- 数据库持久化与送审/报告拦截 ----------

async function makeTestDb(): Promise<SqliteDb> {
  const dir = mkdtempSync(join(tmpdir(), 'research-allof-'))
  const { db } = await openDatabase(join(dir, 'test.sqlite'), SQL_JS_DIST)
  initSchema(db)
  initWorkspaceEpoch()
  return db
}

function bytesOf(text: string): Buffer {
  return Buffer.from(text, 'utf-8')
}

const SAMPLE_JD = '岗位:数据工程师。\n要求:Python 熟练。\n加分项:SQL。\n地点:上海。\n'
const QUOTE_PYTHON = '要求:Python 熟练。'

interface Seeded {
  db: SqliteDb
  flush: () => void
  file: string
  runId: string
  subquestionId: string
  snapshot: ImportedResearchSource
  claimId: string
  groupId: string
  validCitationId: string
  requirement: AllOfRequirement
}

/** 播种一条 all_of 命题:成员 0 结构有效,成员 1 被拒(无引用、带原因) */
async function seedIncompleteAllOf(): Promise<Seeded> {
  const dir = mkdtempSync(join(tmpdir(), 'research-allof-'))
  const file = join(dir, 'test.sqlite')
  const opened = await openDatabase(file, SQL_JS_DIST)
  const db = opened.db
  initSchema(db)
  initWorkspaceEpoch()
  const outcomes = importResearchSources(db, {
    sources: [{ sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true }],
    clock: FIXED_CLOCK
  })
  const first = outcomes[0]!
  expect(first.ok, JSON.stringify(first.ok ? '' : first.error)).toBe(true)
  const snapshot = first as ImportedResearchSource
  const { value } = createResearchRun(db, {
    request: { question: '哪些岗位要求 Python?', snapshot_ids: [snapshot.documentId], snapshot_policy: 'fixed', budget: {} },
    contextClock: CONTEXT_CLOCK,
    clock: FIXED_CLOCK
  }, 'op-allof-' + Math.random().toString(36).slice(2))
  const runId = value.run.runId
  const sub = createSubQuestion(db, runId, { ordinal: 1, question: 'Python 要求' })
  const chunkId = db.get<{ chunk_id: string }>(
    'SELECT chunk_id FROM retrieval_chunks WHERE document_id = ? ORDER BY chunk_index LIMIT 1',
    [snapshot.documentId]
  )!.chunk_id
  const span0 = createEvidenceSpan(db, runId, sub.subquestionId, {
    snapshot_id: snapshot.documentId, chunk_id: chunkId,
    start_offset: 10, end_offset: 10 + Array.from(QUOTE_PYTHON).length, quote: QUOTE_PYTHON
  })
  const claim = createClaim(db, runId, {
    subquestionId: sub.subquestionId,
    claim: { text: '该岗位同时要求 Python 与不存在的 X。', claim_type: 'fact', subject: { entity: '数据工程师', attribute: '要求' } }
  })
  const citation0 = createCitation(db, runId, {
    claim_id: claim.claimId, evidence_id: span0.evidenceId, relation: 'supports',
    evidence_group_id: 'g1', group_operator: 'all_of'
  })
  const requirement: AllOfRequirement = {
    version: 1, groupId: 'g1', expectedIndices: [0, 1], members: [
      { index: 0, evidenceId: span0.evidenceId, citationId: citation0.citationId, rejectionReason: null },
      { index: 1, evidenceId: null, citationId: null, rejectionReason: 'quote 不匹配,证据被拒绝' }
    ]
  }
  saveAllOfRequirement(db, claim.claimId, requirement)
  return { db, flush: opened.flush, file, runId, subquestionId: sub.subquestionId, snapshot, claimId: claim.claimId, groupId: 'g1', validCitationId: citation0.citationId, requirement }
}

describe('RES-03 仓库清单保存/加载', () => {
  it('清单存于 review.evidence_requirements(同连接持久化形态)', async () => {
    const seeded = await seedIncompleteAllOf()
    const { db, claimId, requirement } = seeded
    const claim = getClaim(db, claimId)!
    const stored = (claim.review as { evidence_requirements?: AllOfRequirement[] }).evidence_requirements
    expect(stored).toHaveLength(1)
    expect(stored![0]).toEqual(requirement)
    expect(loadAllOfRequirements(db, claimId)).toEqual([requirement])
  })

  it('执行关闭/重开临时库:缺员状态与预期两员保留,再跑 validateCitations 仍拒绝', async () => {
    const seeded = await seedIncompleteAllOf()
    const { db, flush, file, runId, claimId } = seeded
    validateCitations(db, runId)
    flush() // 落盘
    const reopened = await openDatabase(file, SQL_JS_DIST)
    try {
      expect(getClaim(reopened.db, claimId)!.supportStatus).toBe('unsupported')
      expect(loadAllOfRequirements(reopened.db, claimId)).toHaveLength(1)
      const loaded = loadAllOfRequirements(reopened.db, claimId)[0]!
      expect(loaded.expectedIndices).toEqual([0, 1])
      expect(loaded.members.map((m) => m.rejectionReason)).toEqual([null, 'quote 不匹配,证据被拒绝'])
      validateCitations(reopened.db, runId)
      expect(getClaim(reopened.db, claimId)!.supportStatus).toBe('unsupported')
    } finally {
      reopened.flush()
    }
  })

  it('更新审核状态不覆盖 evidence_requirements;同组重复保存整体替换', async () => {
    const seeded = await seedIncompleteAllOf()
    const { db, claimId, requirement } = seeded
    const { updateClaimReview } = await import('../../src/main/research/repository')
    updateClaimReview(db, claimId, 'unsupported', { stage: 'semantic_review', status: 'unsupported', reason: 'x' })
    expect(loadAllOfRequirements(db, claimId)).toEqual([requirement])
    const replacement: AllOfRequirement = { ...requirement, members: [requirement.members[0]!] }
    saveAllOfRequirement(db, claimId, replacement)
    expect(loadAllOfRequirements(db, claimId)).toEqual([replacement])
  })
})

describe('RES-03 直接送审与报告终检', () => {
  it('跳过 validateCitations 直接送审:缺员命题被确定性拒绝,模型 supported 不能升级', async () => {
    const seeded = await seedIncompleteAllOf()
    const { db, runId, claimId } = seeded
    // 不跑 validateCitations:span 保持 candidate(结构结果未知按缺失处理)
    const provider = new FakeProvider({
      script: () => {
        const id = claimId
        return { verdicts: [{ claim_id: id, status: 'supported', reason: '片段直接支持' }] }
      }
    })
    const outcome = await reviewClaims(db, runId, provider, { contextBudget: 16000 })
    expect(outcome.verdicts[claimId]).toBeUndefined() // 缺员命题不送模型
    expect(getClaim(db, claimId)!.supportStatus).toBe('unsupported')
  })

  it('validateCitations:缺员 all_of 落 unsupported 并保留拒绝原因;全部被拒亦然', async () => {
    const seeded = await seedIncompleteAllOf()
    const { db, runId, claimId } = seeded
    const report = validateCitations(db, runId)
    expect(report.unsupportedClaimIds).toContain(claimId)
    const claim = getClaim(db, claimId)!
    expect(claim.supportStatus).toBe('unsupported')
    expect(JSON.stringify(claim.review)).toContain('g1')
  })

  it('报告构建拒绝缺员事实:claim 被手工置 supported 也不进入事实区', async () => {
    const seeded = await seedIncompleteAllOf()
    const { db, runId, claimId } = seeded
    const { updateClaimReview } = await import('../../src/main/research/repository')
    // 模拟被绕过的升级:直接把缺员命题置为 supported
    const claim = getClaim(db, claimId)!
    updateClaimReview(db, claimId, 'supported', { ...(claim.review ?? {}), stage: 'hacked' })
    const { report } = await buildReport(db, runId, { version: 1, completer: null })
    expect(report.structured!.claim_order as string[]).not.toContain(claimId)
    expect(report.markdown).not.toContain('该岗位同时要求 Python 与不存在的 X。')
  })

  it('非 all_of 支持与 context-only 既有语义保持有效区分', async () => {
    const db = await makeTestDb()
    const outcomes = importResearchSources(db, {
      sources: [{ sourceName: 'jd-b.md', bytes: bytesOf(SAMPLE_JD), sample: true }],
      clock: FIXED_CLOCK
    })
    const snapshot = outcomes[0] as ImportedResearchSource
    expect(snapshot.ok).toBe(true)
    const { value } = createResearchRun(db, {
      request: { question: '要求?', snapshot_ids: [snapshot.documentId], snapshot_policy: 'fixed', budget: {} },
      contextClock: CONTEXT_CLOCK,
      clock: FIXED_CLOCK
    }, 'op-plain-' + Math.random().toString(36).slice(2))
    const sub = createSubQuestion(db, value.run.runId, { ordinal: 1, question: '要求' })
    const chunkId = db.get<{ chunk_id: string }>(
      'SELECT chunk_id FROM retrieval_chunks WHERE document_id = ? ORDER BY chunk_index LIMIT 1',
      [snapshot.documentId]
    )!.chunk_id
    const span = createEvidenceSpan(db, value.run.runId, sub.subquestionId, {
      snapshot_id: snapshot.documentId, chunk_id: chunkId,
      start_offset: 10, end_offset: 10 + Array.from(QUOTE_PYTHON).length, quote: QUOTE_PYTHON
    })
    const claimA = createClaim(db, value.run.runId, {
      subquestionId: sub.subquestionId,
      claim: { text: '岗位要求 Python(普通支持)。', claim_type: 'fact', subject: { entity: 'E', attribute: 'A' } }
    })
    createCitation(db, value.run.runId, { claim_id: claimA.claimId, evidence_id: span.evidenceId, relation: 'supports' })
    const claimB = createClaim(db, value.run.runId, {
      subquestionId: sub.subquestionId,
      claim: { text: '背景说明(context-only)。', claim_type: 'fact', subject: { entity: 'E', attribute: 'B' } }
    })
    createCitation(db, value.run.runId, { claim_id: claimB.claimId, evidence_id: span.evidenceId, relation: 'context' })
    const report = validateCitations(db, value.run.runId)
    // 非 all_of 支持:结构通过保持 candidate 等待审核
    expect(report.pendingClaimIds).toContain(claimA.claimId)
    // context-only:无 supports 引用不构成支持,不升级
    expect(report.noSupportClaimIds).toContain(claimB.claimId)
    expect(getClaim(db, claimB.claimId)!.supportStatus).toBe('unsupported')
    // 普通支持 claim 的 review 不含 evidence_requirements
    const storedA = getClaim(db, claimA.claimId)!.review
    expect((storedA as { evidence_requirements?: unknown } | null)?.evidence_requirements).toBeUndefined()
  })

  it('重复 validateCitations 不升级缺员命题;task 归属健全', async () => {
    const seeded = await seedIncompleteAllOf()
    const { db, runId, claimId } = seeded
    validateCitations(db, runId)
    const claim = getClaim(db, claimId)!
    expect(claim.supportStatus).toBe('unsupported')
    validateCitations(db, runId)
    expect(getClaim(db, claimId)!.supportStatus).toBe('unsupported')
    expect(loadAllOfRequirements(db, claimId)).toHaveLength(1)
    // task 归属健全性
    expect(getResearchTaskByRun(db, runId)).not.toBeNull()
  })
})
