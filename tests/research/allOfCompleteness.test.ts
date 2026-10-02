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
  getResearchTaskByRun,
  listRunCitationsForClaim
} from '../../src/main/research/repository'
import {
  loadAllOfRequirements,
  saveAllOfRequirement
} from '../../src/main/research/repository'
import {
  checkAllOfCompleteness,
  allOfIncompleteClaimIds,
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
  const complete: AllOfRequirement = {
    version: 1, groupId: 'g', expectedIndices: [0, 1], members: [
      { index: 0, evidenceId: 'e0', citationId: 'c0', rejectionReason: null },
      { index: 1, evidenceId: 'e1', citationId: 'c1', rejectionReason: null }
    ]
  }
  it.each([
    { name: '重复成员', value: { ...complete, members: [...complete.members, complete.members[0]!] } },
    { name: '额外成员', value: { ...complete, members: [...complete.members, { ...complete.members[0]!, index: 99 }] } },
    { name: '复用 citation ID', value: { ...complete, members: [complete.members[0]!, { ...complete.members[1]!, citationId: 'c0' }] } },
    { name: '复用 evidence ID', value: { ...complete, members: [complete.members[0]!, { ...complete.members[1]!, evidenceId: 'e0' }] } },
    { name: '负数下标', value: { ...complete, expectedIndices: [-1], members: [{ ...complete.members[0]!, index: -1 }] } },
    { name: '小数下标', value: { ...complete, expectedIndices: [0.5], members: [{ ...complete.members[0]!, index: 0.5 }] } },
    { name: '空 ID', value: { ...complete, members: [{ ...complete.members[0]!, evidenceId: '' }, complete.members[1]!] } }
  ])('T09 $name 无法用存活成员伪装精确 set', ({ value }) => {
    expect(checkAllOfCompleteness(value, new Set(['c0', 'c1'])).satisfied).toBe(false)
  })

  it('T09 额外成员不成立且 missingIndices 不虚构缺失下标', () => {
    const extra = { ...complete, members: [...complete.members, { ...complete.members[0]!, index: 99 }] }
    expect(checkAllOfCompleteness(extra, new Set(['c0', 'c1']))).toEqual({ satisfied: false, missingIndices: [] })
  })

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

/** 先构造结构有效的单成员组,再通过合成库 UPDATE 注入历史损坏清单。 */
async function seedAllOfCase(kind: string): Promise<Seeded> {
  const seeded = await seedIncompleteAllOf()
  const { db, claimId, runId, validCitationId } = seeded
  const member = seeded.requirement.members[0]!
  const complete: AllOfRequirement = { version: 1, groupId: 'g1', expectedIndices: [0], members: [member] }
  saveAllOfRequirement(db, claimId, complete)
  validateCitations(db, runId)
  let requirements: unknown[] | undefined = [complete]
  if (kind === '缺清单') requirements = undefined
  if (kind === '空组') requirements = [{ ...complete, expectedIndices: [], members: [] }]
  if (kind === '重复预期') requirements = [{ ...complete, expectedIndices: [0, 0] }]
  if (kind === '重复成员') requirements = [{ ...complete, members: [member, member] }]
  if (kind === '额外成员') requirements = [{ ...complete, members: [member, { ...member, index: 99 }] }]
  if (kind === '错 evidence') requirements = [{ ...complete, members: [{ ...member, evidenceId: 'unrelated-evidence' }] }]
  if (kind === '同组重复清单') requirements = [complete, complete]
  if (kind === '损坏版本') requirements = [{ ...complete, version: 99 }]
  if (kind === '跨组' || kind === '额外 supports 引用') {
    const source = listRunCitationsForClaim(db, getClaim(db, claimId)!)[0]!.span
    const text = db.get<{ normalized_text: string }>('SELECT normalized_text FROM retrieval_documents WHERE document_id = ?', [seeded.snapshot.documentId])!.normalized_text
    const quote = '加分项:SQL。'
    const start = Array.from(text.slice(0, text.indexOf(quote))).length
    const span = createEvidenceSpan(db, runId, seeded.subquestionId, {
      snapshot_id: seeded.snapshot.documentId, chunk_id: source.chunkId,
      start_offset: start, end_offset: start + Array.from(quote).length, quote
    })
    const other = createCitation(db, runId, {
      claim_id: claimId, evidence_id: span.evidenceId, relation: 'supports', evidence_group_id: kind === '跨组' ? 'g2' : 'g1', group_operator: 'all_of'
    })
    db.run("UPDATE research_evidence_spans SET validation_status = 'valid' WHERE evidence_id = ?", [span.evidenceId])
    if (kind === '跨组') {
      const otherMember = { ...member, citationId: other.citationId, evidenceId: span.evidenceId }
      requirements = [{ ...complete, members: [otherMember] }, { ...complete, groupId: 'g2', members: [otherMember] }]
    }
  }
  if (kind === '引用全失') {
    const other = createClaim(db, runId, { subquestionId: seeded.subquestionId, claim: { text: '合成引用归属', claim_type: 'fact' } })
    db.run("UPDATE research_claims SET support_status = 'unsupported' WHERE claim_id = ?", [other.claimId])
    db.run('UPDATE research_citations SET claim_id = ? WHERE citation_id = ?', [other.claimId, validCitationId])
  }
  if (kind === '缺结构结果') db.run("UPDATE research_evidence_spans SET validation_status = 'candidate' WHERE evidence_id = ?", [member.evidenceId!])
  db.run("UPDATE research_claims SET support_status = 'candidate', review_json = ? WHERE claim_id = ?", [JSON.stringify(requirements === undefined ? {} : { evidence_requirements: requirements }), claimId])
  return seeded
}

const invalidAllOfCases = ['缺清单', '空组', '重复预期', '重复成员', '额外成员', '跨组', '错 evidence', '额外 supports 引用', '同组重复清单', '损坏版本', '引用全失', '缺结构结果']

describe('T09 all_of 每个入口采用完整清单和真实关联', () => {
  it.each(invalidAllOfCases)('T09 直接审核拒绝 $0,不发送模型', async (kind) => {
    const { db, runId, claimId } = await seedAllOfCase(kind)
    try {
      const provider = new FakeProvider({ responses: [{ verdicts: [{ claim_id: claimId, status: 'supported', reason: 'synthetic' }] }] })
      const outcome = await reviewClaims(db, runId, provider, { contextBudget: 16000 })
      expect(outcome.skipped).toBe(true)
      expect(provider.callTotal).toBe(0)
      expect(getClaim(db, claimId)!.supportStatus).toBe('unsupported')
    } finally { db.close() }
  })

  it.each(invalidAllOfCases)('T09 报告终检拒绝 $0,零事实区成员', async (kind) => {
    const { db, runId, claimId } = await seedAllOfCase(kind)
    try {
      db.run("UPDATE research_claims SET support_status = 'supported' WHERE claim_id = ?", [claimId])
      const { report } = await buildReport(db, runId, { version: 1, completer: null })
      expect(report.structured!.claim_order).not.toContain(claimId)
      expect(report.markdown).not.toContain('该岗位同时要求 Python 与不存在的 X。')
    } finally { db.close() }
  })

  it.each(invalidAllOfCases.filter((kind) => kind !== '缺结构结果'))('T09 结构检查拒绝 $0', async (kind) => {
    const { db, runId, claimId } = await seedAllOfCase(kind)
    try {
      expect(validateCitations(db, runId).unsupportedClaimIds).toContain(claimId)
    } finally { db.close() }
  })

  it('T09 正常完整组送审核模型并进入事实区,冻结后损坏清单只读排除', async () => {
    const { db, runId, claimId } = await seedAllOfCase('完整')
    try {
      const provider = new FakeProvider({ responses: [{ verdicts: [{ claim_id: claimId, status: 'supported', reason: '片段直接支持' }] }] })
      await reviewClaims(db, runId, provider, { contextBudget: 16000 })
      expect(provider.callTotal).toBe(1)
      const built = await buildReport(db, runId, { version: 1, completer: null })
      expect(built.report.structured!.claim_order).toContain(claimId)
      db.run('UPDATE research_claims SET review_json = ? WHERE claim_id = ?', [JSON.stringify({ evidence_requirements: [] }), claimId])
      const before = getClaim(db, claimId)!
      await reviewClaims(db, runId, provider, { contextBudget: 16000 })
      validateCitations(db, runId)
      expect(getClaim(db, claimId)).toEqual(before)
    } finally { db.close() }
  })

  it('T09 重开合成库后重复成员和拒绝原因完整保留,判定一致', async () => {
    const { db, file, claimId } = await seedAllOfCase('重复成员')
    const claim = getClaim(db, claimId)!
    expect(listRunCitationsForClaim(db, claim)).toHaveLength(1)
    const blocked = allOfIncompleteClaimIds(db, [claim])
    expect(blocked.has(claimId)).toBe(true)
    db.close()
    const reopened = await openDatabase(file, SQL_JS_DIST)
    try {
      expect(allOfIncompleteClaimIds(reopened.db, [getClaim(reopened.db, claimId)!])).toEqual(blocked)
      expect(loadAllOfRequirements(reopened.db, claimId)[0]!.members).toHaveLength(2)
    } finally { reopened.db.close() }
  })
})

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
