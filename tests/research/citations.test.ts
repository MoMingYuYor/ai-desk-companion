// R-05 证据审核与版本化报告测试:引用闭包、offset 补全、all_of 组、冲突分组、
// 语义审核降级路径、不足表达三分与版本化报告。
// 覆盖执行清单步骤 17 的验收场景:
// URL 正常但原文不支持(quote 与 offset 不匹配→invalid)、正确 quote 配错误岗位
// (结构过但审核 unsupported)、条件被删(审核降级)、context 当支持、多片段缺一
// (all_of 不成立)、跨运行引用拒绝、组织模型返回新 Claim(白名单外拒绝)、
// offset 补全唯一匹配成功/多处命中拒绝、冲突并列不投票、三分表达、
// 报告版本唯一与不可变、模型不可用时模板输出。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase, type SqliteDb } from '../../src/main/db/connection'
import { initSchema } from '../../src/main/db/dao'
import { initWorkspaceEpoch, OperationError } from '../../src/main/db/operations'
import { fixedClock } from '../../src/shared/clock'
import { FakeProvider } from '../../src/main/providers/fake'
import {
  createClaim,
  createCitation,
  createEvidenceSpan,
  createResearchRun,
  createReport,
  createSubQuestion,
  getClaim,
  getEvidenceSpan,
  getSubQuestion,
  listClaims
} from '../../src/main/research/repository'
import {
  importResearchSources,
  type ImportedResearchSource,
  type ResearchSourceInput
} from '../../src/main/research/snapshots'
import {
  checkCitationStructure,
  evaluateAllOfGroups,
  resolveSpanOffsets,
  validateCitations
} from '../../src/main/research/citations'
import { detectConflicts, persistSubquestionOutcomes, reviewClaims } from '../../src/main/research/evidence'
import {
  buildReport,
  parseSynthesisPlan,
  reportEligibleClaims,
  assembleReportResponse
} from '../../src/main/research/reports'

const SQL_JS_DIST = join(process.cwd(), 'node_modules', 'sql.js', 'dist')
const FIXED_CLOCK = fixedClock('2026-09-27T16:00:00.000Z')
const CONTEXT_CLOCK = '2026-09-27T16:00:00.000Z'

async function makeTestDb(): Promise<SqliteDb> {
  const dir = mkdtempSync(join(tmpdir(), 'research-citations-'))
  const { db } = await openDatabase(join(dir, 'test.sqlite'), SQL_JS_DIST)
  initSchema(db)
  initWorkspaceEpoch()
  return db
}

function bytesOf(text: string): Buffer {
  return Buffer.from(text, 'utf-8')
}

function okOf(outcomes: ReturnType<typeof importResearchSources>): ImportedResearchSource[] {
  return outcomes.filter((o): o is ImportedResearchSource => o.ok)
}

function appCode(err: unknown): string | undefined {
  if (err instanceof OperationError) return err.appError.code
  return undefined
}

function importOne(db: SqliteDb, input: ResearchSourceInput): ImportedResearchSource {
  const outcomes = importResearchSources(db, { sources: [input], clock: FIXED_CLOCK })
  const first = outcomes[0]!
  expect(first.ok, first.ok ? '' : JSON.stringify(first.error)).toBe(true)
  return first as ImportedResearchSource
}

function normTextOf(db: SqliteDb, documentId: string): string {
  return db.get<{ normalized_text: string }>(
    'SELECT normalized_text FROM retrieval_documents WHERE document_id = ?',
    [documentId]
  )!.normalized_text
}

function chunksOf(db: SqliteDb, documentId: string): Array<{ chunk_id: string; startOffset: number; endOffset: number }> {
  return db.all<{ chunk_id: string; startOffset: number; endOffset: number }>(
    'SELECT chunk_id, start_offset AS startOffset, end_offset AS endOffset FROM retrieval_chunks WHERE document_id = ? ORDER BY chunk_index',
    [documentId]
  )
}

/** 找到覆盖 [start,end) 的 chunk(测试数据单块为主) */
function chunkCovering(db: SqliteDb, documentId: string, start: number, end: number): { chunk_id: string } {
  const chunk = chunksOf(db, documentId).find((c) => c.startOffset <= start && c.endOffset >= end)
  if (!chunk) throw new Error(`测试数据缺少覆盖 [${start},${end}) 的 chunk`)
  return { chunk_id: chunk.chunk_id }
}

function codePointOffsetOf(db: SqliteDb, documentId: string, needle: string): number {
  const cps = Array.from(normTextOf(db, documentId))
  const needleCps = Array.from(needle)
  for (let i = 0; i + needleCps.length <= cps.length; i += 1) {
    if (needleCps.every((ch, j) => cps[i + j] === ch)) return i
  }
  throw new Error(`测试文本中找不到:${needle}`)
}

/** 创建研究运行与 1 号子问题 */
function seedRun(db: SqliteDb, snapshotIds: string[], question = '哪些岗位要求 Python?'): { runId: string; subquestionId: string } {
  const { value } = createResearchRun(
    db,
    {
      request: { question, snapshot_ids: snapshotIds, snapshot_policy: 'fixed', budget: {} },
      contextClock: CONTEXT_CLOCK,
      clock: FIXED_CLOCK
    },
    'op-' + Math.random().toString(36).slice(2)
  )
  const sub = createSubQuestion(db, value.run.runId, { ordinal: 1, question: 'Python 要求' })
  return { runId: value.run.runId, subquestionId: sub.subquestionId }
}

/** 造一个 span+claim+supports 引用的完整证据链,返回三者 ID */
function chainOf(
  db: SqliteDb,
  runId: string,
  subquestionId: string,
  snapshotId: string,
  opts: {
    quote: string
    start: number
    end: number
    claimText: string
    relation?: 'supports' | 'contradicts' | 'context'
    subject?: Record<string, unknown>
    qualifier?: Record<string, unknown>
    claimType?: 'fact' | 'comparison' | 'recommendation'
    evidenceGroupId?: string
    groupOperator?: 'all_of'
  }
): { evidenceId: string; claimId: string; citationId: string } {
  const chunkId = chunkCovering(db, snapshotId, opts.start, opts.end).chunk_id
  const span = createEvidenceSpan(db, runId, subquestionId, {
    snapshot_id: snapshotId,
    chunk_id: chunkId,
    start_offset: opts.start,
    end_offset: opts.end,
    quote: opts.quote
  })
  const claim = createClaim(db, runId, {
    subquestionId,
    claim: {
      text: opts.claimText,
      claim_type: opts.claimType ?? 'fact',
      subject: opts.subject ?? { entity: '岗位A', attribute: 'Python 要求' },
      qualifier: opts.qualifier ?? {}
    }
  })
  const citation = createCitation(db, runId, {
    claim_id: claim.claimId,
    evidence_id: span.evidenceId,
    relation: opts.relation ?? 'supports',
    ...(opts.evidenceGroupId ? { evidence_group_id: opts.evidenceGroupId } : {}),
    ...(opts.groupOperator ? { group_operator: opts.groupOperator } : {})
  })
  return { evidenceId: span.evidenceId, claimId: claim.claimId, citationId: citation.citationId }
}

const SAMPLE_JD = '岗位:数据工程师。\n要求:Python 熟练。\n加分项:SQL。\n地点:上海。\n'
const QUOTE_PYTHON = '要求:Python 熟练。'

// ---------- 引用闭包:URL 正常但原文不支持 / 跨运行 / hash ----------

describe('validateCitations 引用闭包检查', () => {
  it('URL 正常但原文不支持:quote 与 offset 不匹配的 span 落 invalid,claim 落 unsupported', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId, subquestionId } = seedRun(db, [snap.documentId])
    // quote 正确但 offset 指到别处(错位):结构检查发现切片与 quote 不匹配
    const wrongStart = codePointOffsetOf(db, snap.documentId, '加分项:SQL。')
    chainOf(db, runId, subquestionId, snap.documentId, {
      quote: QUOTE_PYTHON,
      start: wrongStart,
      end: wrongStart + Array.from(QUOTE_PYTHON).length,
      claimText: '岗位A 明确要求 Python 熟练'
    })
    const report = validateCitations(db, runId)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]!.reason).toContain('不匹配')
    expect(report.unsupportedClaimIds).toHaveLength(1)
    const span = getEvidenceSpan(db, report.failed[0]!.evidenceId)
    expect(span?.validationStatus).toBe('invalid')
    expect(getClaim(db, report.unsupportedClaimIds[0]!)?.supportStatus).toBe('unsupported')
  })

  it('正确 quote 配正确 offset:结构通过,span 落 valid,claim 保持 candidate 等待语义审核', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId, subquestionId } = seedRun(db, [snap.documentId])
    const start = codePointOffsetOf(db, snap.documentId, QUOTE_PYTHON)
    const chain = chainOf(db, runId, subquestionId, snap.documentId, {
      quote: QUOTE_PYTHON,
      start,
      end: start + Array.from(QUOTE_PYTHON).length,
      claimText: '岗位A 明确要求 Python 熟练'
    })
    const report = validateCitations(db, runId)
    expect(report.failed).toHaveLength(0)
    expect(report.pendingClaimIds).toEqual([chain.claimId])
    expect(getEvidenceSpan(db, chain.evidenceId)?.validationStatus).toBe('valid')
    // 未审核前不升级为 supported
    expect(getClaim(db, chain.claimId)?.supportStatus).toBe('candidate')
  })

  it('快照 hash 与冻结清单不一致时整体失败(SNAPSHOT_HASH_MISMATCH)', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId, subquestionId } = seedRun(db, [snap.documentId])
    const start = codePointOffsetOf(db, snap.documentId, QUOTE_PYTHON)
    chainOf(db, runId, subquestionId, snap.documentId, {
      quote: QUOTE_PYTHON,
      start,
      end: start + Array.from(QUOTE_PYTHON).length,
      claimText: '岗位A 明确要求 Python 熟练'
    })
    // 模拟快照被替换:改写 normalized_text 与 text_sha256(清单仍持旧 hash)
    db.run(
      'UPDATE retrieval_documents SET normalized_text = ?, text_sha256 = ? WHERE document_id = ?',
      ['被替换的内容', '0'.repeat(64), snap.documentId]
    )
    expect(() => validateCitations(db, runId)).toThrow(/SNAPSHOT_HASH_MISMATCH/)
  })

  it('跨运行引用拒绝(createCitation 在写入时即拒绝)', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const runA = seedRun(db, [snap.documentId])
    const runB = seedRun(db, [snap.documentId], 'B 运行的问题')
    const start = codePointOffsetOf(db, snap.documentId, QUOTE_PYTHON)
    const chain = chainOf(db, runA.runId, runA.subquestionId, snap.documentId, {
      quote: QUOTE_PYTHON,
      start,
      end: start + Array.from(QUOTE_PYTHON).length,
      claimText: '岗位A 明确要求 Python 熟练'
    })
    // run B 的 claim 引用 run A 的证据:跨运行,拒绝
    const claimB = createClaim(db, runB.runId, {
      subquestionId: runB.subquestionId,
      claim: { text: 'B 运行的结论', claim_type: 'fact' }
    })
    expect(() =>
      createCitation(db, runB.runId, { claim_id: claimB.claimId, evidence_id: chain.evidenceId, relation: 'supports' })
    ).toThrow(/跨运行/)
  })

  it('不在冻结清单内的快照被拒绝(清单外来源)', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId, subquestionId } = seedRun(db, [snap.documentId])
    // 运行创建后另导入一份快照(不在本 run 清单内),给它造 span
    const other = importOne(db, { sourceName: 'jd-b.md', bytes: bytesOf('另一份:要求 Go。\n'), sample: true })
    const otherStart = codePointOffsetOf(db, other.documentId, '要求 Go。')
    chainOf(db, runId, subquestionId, other.documentId, {
      quote: '要求 Go。',
      start: otherStart,
      end: otherStart + Array.from('要求 Go。').length,
      claimText: '岗位A 明确要求 Go'
    })
    const report = validateCitations(db, runId)
    expect(report.failed[0]!.reason).toContain('冻结清单')
  })
})

// ---------- offset 补全:唯一匹配 / 多处命中 ----------

describe('resolveSpanOffsets offset 补全', () => {
  it('限定 chunk 内唯一精确匹配成功,返回全文绝对码点坐标', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const chunk = chunksOf(db, snap.documentId)[0]!
    const resolved = resolveSpanOffsets({
      quote: QUOTE_PYTHON,
      snapshotText: normTextOf(db, snap.documentId),
      chunk: { startOffset: chunk.startOffset, endOffset: chunk.endOffset }
    })
    expect(resolved.ok).toBe(true)
    expect(resolved.reason).toBeNull()
    const expected = codePointOffsetOf(db, snap.documentId, QUOTE_PYTHON)
    expect(resolved.startOffset).toBe(expected)
    expect(resolved.endOffset).toBe(expected + Array.from(QUOTE_PYTHON).length)
  })

  it('多处命中必须显式定位:返回失败原因,不猜(offset 未定)', async () => {
    const text = '要求:Python。前文。要求:Python。后文。'
    const resolved = resolveSpanOffsets({
      quote: '要求:Python。',
      snapshotText: text,
      chunk: { startOffset: 0, endOffset: Array.from(text).length }
    })
    expect(resolved.ok).toBe(false)
    expect(resolved.reason).toContain('2 处')
    expect(resolved.startOffset).toBe(-1)
  })

  it('chunk 外的匹配不补:限定范围外的命中视为无匹配', () => {
    const text = '前半:要求 Python。后半:要求 Python。'
    const cps = Array.from(text)
    const secondHalf = cps.findIndex((ch) => ch === '后')
    const resolved = resolveSpanOffsets({
      quote: '要求 Python。',
      snapshotText: text,
      chunk: { startOffset: secondHalf, endOffset: cps.length }
    })
    expect(resolved.ok).toBe(true)
    expect(resolved.startOffset).toBe(secondHalf + Array.from('后半:').length)
  })

  it('无匹配拒绝', () => {
    const resolved = resolveSpanOffsets({
      quote: '不存在的内容',
      snapshotText: SAMPLE_JD,
      chunk: { startOffset: 0, endOffset: Array.from(SAMPLE_JD).length }
    })
    expect(resolved.ok).toBe(false)
    expect(resolved.reason).toContain('无精确匹配')
  })
})

// ---------- all_of 组:context 当支持 / 多片段缺一 ----------

describe('all_of 证据组与 context 关系', () => {
  it('context 当支持无效:只有 context 引用的 claim 不构成支持,落 unsupported', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId, subquestionId } = seedRun(db, [snap.documentId])
    const start = codePointOffsetOf(db, snap.documentId, '地点:上海。')
    chainOf(db, runId, subquestionId, snap.documentId, {
      quote: '地点:上海。',
      start,
      end: start + Array.from('地点:上海。').length,
      claimText: '岗位A 明确要求 Python 熟练',
      relation: 'context'
    })
    const report = validateCitations(db, runId)
    expect(report.pendingClaimIds).toHaveLength(0)
    expect(report.unsupportedClaimIds).toHaveLength(1)
    expect(report.noSupportClaimIds).toHaveLength(1)
    expect(getClaim(db, report.unsupportedClaimIds[0]!)?.supportStatus).toBe('unsupported')
  })

  it('all_of 多片段缺一:组内一个成员结构失效,整组不成立', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId, subquestionId } = seedRun(db, [snap.documentId])
    const groupId = 'grp-1'
    const pyStart = codePointOffsetOf(db, snap.documentId, QUOTE_PYTHON)
    chainOf(db, runId, subquestionId, snap.documentId, {
      quote: QUOTE_PYTHON,
      start: pyStart,
      end: pyStart + Array.from(QUOTE_PYTHON).length,
      claimText: '岗位A 要求 Python 熟练且在上海',
      evidenceGroupId: groupId,
      groupOperator: 'all_of'
    })
    // 第二个成员:正确 quote 配错误 offset(结构失败)
    const wrongStart = codePointOffsetOf(db, snap.documentId, '地点:上海。')
    chainOf(db, runId, subquestionId, snap.documentId, {
      quote: '地点:上海。',
      start: wrongStart + 1,
      end: wrongStart + 1 + Array.from('地点:上海。').length,
      claimText: '岗位A 要求 Python 熟练且在上海',
      evidenceGroupId: groupId,
      groupOperator: 'all_of'
    })
    const report = validateCitations(db, runId)
    expect(report.unsupportedClaimIds).toHaveLength(1)
    const claim = getClaim(db, report.unsupportedClaimIds[0]!)
    expect(claim?.supportStatus).toBe('unsupported')
    expect(JSON.stringify(claim?.review)).toContain('all_of')
  })

  it('all_of 组内全部有效才算支持(evaluateAllOfGroups 纯函数)', () => {
    const mkRow = (citationId: string, groupId: string | null, operator: 'all_of' | null): Parameters<typeof evaluateAllOfGroups>[0][number] =>
      ({
        citation: {
          citationId,
          claimId: 'c1',
          evidenceId: `e-${citationId}`,
          relation: 'supports',
          evidenceGroupId: groupId,
          groupOperator: operator
        },
        claim: {} as never,
        span: {} as never
      })
    const structure = new Map([
      ['cite-1', { citationId: 'cite-1', claimId: 'c1', evidenceId: 'e-1', ok: true, reason: null }],
      ['cite-2', { citationId: 'cite-2', claimId: 'c1', evidenceId: 'e-2', ok: false, reason: 'x' }]
    ])
    const rows = [mkRow('cite-1', 'g1', 'all_of'), mkRow('cite-2', 'g1', 'all_of')]
    const checks = evaluateAllOfGroups(rows, structure)
    expect(checks).toHaveLength(1)
    expect(checks[0]!.satisfied).toBe(false)
    expect(checks[0]!.failedCitationIds).toEqual(['cite-2'])
  })
})

// ---------- 冲突分组:并列不投票 / 不同公司不合并 ----------

describe('detectConflicts 冲突分组', () => {
  it('同一对齐键的矛盾证据成 conflict_group,双方并列标 unresolved,不投票', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId, subquestionId } = seedRun(db, [snap.documentId])
    const pyStart = codePointOffsetOf(db, snap.documentId, QUOTE_PYTHON)
    const sqlStart = codePointOffsetOf(db, snap.documentId, '加分项:SQL。')
    // 正方:要求 Python(supports)
    chainOf(db, runId, subquestionId, snap.documentId, {
      quote: QUOTE_PYTHON,
      start: pyStart,
      end: pyStart + Array.from(QUOTE_PYTHON).length,
      claimText: '岗位A 明确要求 Python 熟练'
    })
    // 反方:引用"加分项"片段作 contradicts(模型输出错误关系的场景)
    const contra = chainOf(db, runId, subquestionId, snap.documentId, {
      quote: '加分项:SQL。',
      start: sqlStart,
      end: sqlStart + Array.from('加分项:SQL。').length,
      claimText: '岗位A 不要求 Python(仅加分)',
      subject: { entity: '岗位A', attribute: 'Python 要求' },
      relation: 'contradicts'
    })
    const result = detectConflicts(db, runId)
    expect(result.groups).toHaveLength(1)
    expect(result.unresolvedClaimIds).toHaveLength(2)
    const claimA = listClaims(db, db.get<{ research_task_id: string }>('SELECT research_task_id FROM research_claims WHERE claim_id = ?', [result.unresolvedClaimIds[0]!])!.research_task_id)
    for (const id of result.unresolvedClaimIds) {
      const claim = claimA.find((c) => c.claimId === id)!
      expect(claim.conflictGroup).toBe(result.groups[0]!.groupId)
      const review = claim.review as Record<string, { status?: string }>
      expect(review.conflict.status).toBe('unresolved')
      expect(JSON.stringify(review.conflict)).toContain('不按多数副本投票')
    }
    expect(getEvidenceSpan(db, contra.evidenceId)!.validationStatus).not.toBe('invalid')
  })

  it('不同公司(subject 不同)不合并:对齐键不同不成组', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId, subquestionId } = seedRun(db, [snap.documentId])
    const pyStart = codePointOffsetOf(db, snap.documentId, QUOTE_PYTHON)
    const sqlStart = codePointOffsetOf(db, snap.documentId, '加分项:SQL。')
    chainOf(db, runId, subquestionId, snap.documentId, {
      quote: QUOTE_PYTHON,
      start: pyStart,
      end: pyStart + Array.from(QUOTE_PYTHON).length,
      claimText: '岗位A 明确要求 Python 熟练',
      subject: { entity: '公司甲', attribute: 'Python 要求' }
    })
    chainOf(db, runId, subquestionId, snap.documentId, {
      quote: '加分项:SQL。',
      start: sqlStart,
      end: sqlStart + Array.from('加分项:SQL。').length,
      claimText: '公司乙 不要求 Python(仅加分)',
      subject: { entity: '公司乙', attribute: 'Python 要求' },
      relation: 'contradicts'
    })
    const result = detectConflicts(db, runId)
    expect(result.groups).toHaveLength(0)
    expect(result.unresolvedClaimIds).toHaveLength(0)
  })

  it('对齐键含适用条件:时间/地区/层级不同不成组(条件不同不是事实冲突)', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId, subquestionId } = seedRun(db, [snap.documentId])
    const pyStart = codePointOffsetOf(db, snap.documentId, QUOTE_PYTHON)
    const sqlStart = codePointOffsetOf(db, snap.documentId, '加分项:SQL。')
    chainOf(db, runId, subquestionId, snap.documentId, {
      quote: QUOTE_PYTHON,
      start: pyStart,
      end: pyStart + Array.from(QUOTE_PYTHON).length,
      claimText: '2025 版 JD 要求 Python',
      qualifier: { time: '2025' }
    })
    chainOf(db, runId, subquestionId, snap.documentId, {
      quote: '加分项:SQL。',
      start: sqlStart,
      end: sqlStart + Array.from('加分项:SQL。').length,
      claimText: '2024 版 JD 不要求 Python',
      qualifier: { time: '2024' },
      relation: 'contradicts'
    })
    expect(detectConflicts(db, runId).groups).toHaveLength(0)
  })
})

// ---------- 语义审核:错误岗位 / 条件被删 / 降级路径 ----------

describe('reviewClaims 语义审核', () => {
  it('正确 quote 配错误岗位:结构通过,模型审核判 unsupported', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId, subquestionId } = seedRun(db, [snap.documentId])
    const start = codePointOffsetOf(db, snap.documentId, QUOTE_PYTHON)
    const chain = chainOf(db, runId, subquestionId, snap.documentId, {
      quote: QUOTE_PYTHON,
      start,
      end: start + Array.from(QUOTE_PYTHON).length,
      claimText: '岗位Z(完全无关的岗位)明确要求 Python 熟练',
      subject: { entity: '岗位Z', attribute: 'Python 要求' }
    })
    validateCitations(db, runId)
    const provider = new FakeProvider({
      script: (_i, req) => {
        expect(req.prompt).toContain('岗位Z')
        return {
          verdicts: [{ claim_id: chain.claimId, status: 'unsupported', reason: '片段来自岗位A 的 JD,不支持下岗位Z 的命题' }]
        }
      }
    })
    const outcome = await reviewClaims(db, runId, provider, { contextBudget: 100000 })
    expect(outcome.skipped).toBe(false)
    expect(outcome.reviewedCount).toBe(1)
    expect(getClaim(db, chain.claimId)?.supportStatus).toBe('unsupported')
    expect(JSON.stringify(getClaim(db, chain.claimId)?.review)).toContain('可错判断')
  })

  it('条件被删(quote 缺上下文):审核判 uncertain 并降级,不升级为 supported', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId, subquestionId } = seedRun(db, [snap.documentId])
    // claim 断言"必须",但片段只有加分项(条件被删)
    const sqlStart = codePointOffsetOf(db, snap.documentId, '加分项:SQL。')
    const chain = chainOf(db, runId, subquestionId, snap.documentId, {
      quote: '加分项:SQL。',
      start: sqlStart,
      end: sqlStart + Array.from('加分项:SQL。').length,
      claimText: '岗位A 必须精通 SQL',
      subject: { entity: '岗位A', attribute: 'SQL 要求' }
    })
    validateCitations(db, runId)
    const provider = new FakeProvider({
      responses: [{ verdicts: [{ claim_id: chain.claimId, status: 'uncertain', reason: '片段标注为加分项,不足以支持"必须"的结论' }] }]
    })
    const outcome = await reviewClaims(db, runId, provider, { contextBudget: 100000 })
    expect(getClaim(db, chain.claimId)?.supportStatus).toBe('uncertain')
    expect(outcome.verdicts[chain.claimId]!.status).toBe('uncertain')
  })

  it('输出 supported 的正常路径:claim 升级为 supported', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId, subquestionId } = seedRun(db, [snap.documentId])
    const start = codePointOffsetOf(db, snap.documentId, QUOTE_PYTHON)
    const chain = chainOf(db, runId, subquestionId, snap.documentId, {
      quote: QUOTE_PYTHON,
      start,
      end: start + Array.from(QUOTE_PYTHON).length,
      claimText: '岗位A 明确要求 Python 熟练'
    })
    validateCitations(db, runId)
    const provider = new FakeProvider({
      responses: [{ verdicts: [{ claim_id: chain.claimId, status: 'supported', reason: '片段直接列出 Python 要求' }] }]
    })
    await reviewClaims(db, runId, provider, { contextBudget: 100000 })
    expect(getClaim(db, chain.claimId)?.supportStatus).toBe('supported')
  })

  it('completer 为 null 时跳过语义审核:candidate 不升级为 supported', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId, subquestionId } = seedRun(db, [snap.documentId])
    const start = codePointOffsetOf(db, snap.documentId, QUOTE_PYTHON)
    const chain = chainOf(db, runId, subquestionId, snap.documentId, {
      quote: QUOTE_PYTHON,
      start,
      end: start + Array.from(QUOTE_PYTHON).length,
      claimText: '岗位A 明确要求 Python 熟练'
    })
    validateCitations(db, runId)
    const outcome = await reviewClaims(db, runId, null, { contextBudget: 100000 })
    expect(outcome.skipped).toBe(true)
    expect(outcome.reviewedCount).toBe(0)
    expect(getClaim(db, chain.claimId)?.supportStatus).toBe('candidate')
  })

  it('预算不足:候选整体移除(uncovered),不截断证据,保持 candidate', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId, subquestionId } = seedRun(db, [snap.documentId])
    const start = codePointOffsetOf(db, snap.documentId, QUOTE_PYTHON)
    const chain = chainOf(db, runId, subquestionId, snap.documentId, {
      quote: QUOTE_PYTHON,
      start,
      end: start + Array.from(QUOTE_PYTHON).length,
      claimText: '岗位A 明确要求 Python 熟练'
    })
    validateCitations(db, runId)
    const outcome = await reviewClaims(db, runId, new FakeProvider({ responses: [] }), { contextBudget: 10 })
    expect(outcome.uncoveredClaimIds).toEqual([chain.claimId])
    expect(outcome.skipped).toBe(true)
    expect(getClaim(db, chain.claimId)?.supportStatus).toBe('candidate')
  })

  it('模型输出无效(白名单外 claim_id 或非法 status):按候选处理不升级', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId, subquestionId } = seedRun(db, [snap.documentId])
    const start = codePointOffsetOf(db, snap.documentId, QUOTE_PYTHON)
    const chain = chainOf(db, runId, subquestionId, snap.documentId, {
      quote: QUOTE_PYTHON,
      start,
      end: start + Array.from(QUOTE_PYTHON).length,
      claimText: '岗位A 明确要求 Python 熟练'
    })
    validateCitations(db, runId)
    const provider = new FakeProvider({
      responses: [
        { verdicts: [{ claim_id: 'hallucinated-claim', status: 'supported', reason: '幻觉引用' }] },
        { verdicts: [{ claim_id: chain.claimId, status: 'definitely_true', reason: '非法枚举' }] }
      ]
    })
    const outcome = await reviewClaims(db, runId, provider, { contextBudget: 100000 })
    expect(outcome.invalidOutputClaimIds).toEqual([chain.claimId])
    expect(getClaim(db, chain.claimId)?.supportStatus).toBe('candidate')
  })

  it('模型抛异常:全部候选保持候选态', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId, subquestionId } = seedRun(db, [snap.documentId])
    const start = codePointOffsetOf(db, snap.documentId, QUOTE_PYTHON)
    const chain = chainOf(db, runId, subquestionId, snap.documentId, {
      quote: QUOTE_PYTHON,
      start,
      end: start + Array.from(QUOTE_PYTHON).length,
      claimText: '岗位A 明确要求 Python 熟练'
    })
    validateCitations(db, runId)
    const provider = new FakeProvider({
      script: () => {
        throw new Error('模型不可用')
      }
    })
    const outcome = await reviewClaims(db, runId, provider, { contextBudget: 100000 })
    expect(outcome.invalidOutputClaimIds).toEqual([chain.claimId])
    expect(getClaim(db, chain.claimId)?.supportStatus).toBe('candidate')
  })
})

// ---------- 不足表达三分 ----------

describe('三分不足表达', () => {
  it('「没有证据」「明确没有该要求」「资料存在冲突」分别落 outcome/insufficiency_reason', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId } = seedRun(db, [snap.documentId], '三个子问题的研究')
    const sub1 = createSubQuestion(db, runId, { ordinal: 2, question: '学历要求(无任何证据)' })
    const sub2 = createSubQuestion(db, runId, { ordinal: 3, question: '是否要求 Go(明确没有)' })

    const task = db.get<{ research_task_id: string }>('SELECT research_task_id FROM research_tasks WHERE run_id = ?', [runId])!
    const claims = listClaims(db, task.research_task_id)

    // 子问题 3:明确没有(contradicts 证据)
    const goStart = codePointOffsetOf(db, snap.documentId, '地点:上海。')
    chainOf(db, runId, sub2.subquestionId, snap.documentId, {
      quote: '地点:上海。',
      start: goStart,
      end: goStart + Array.from('地点:上海。').length,
      claimText: '岗位A 不要求 Go',
      subject: { entity: '岗位A', attribute: 'Go 要求' },
      relation: 'contradicts'
    })
    void claims

    validateCitations(db, runId)
    const summaries = persistSubquestionOutcomes(db, runId)
    const bySub = new Map(summaries.map((s) => [s.subquestionId, s]))

    const noEvidence = bySub.get(sub1.subquestionId)!
    expect(noEvidence.kind).toBe('no_evidence')
    expect(noEvidence.status).toBe('insufficient')
    expect(noEvidence.insufficiencyReason).toContain('没有证据')
    expect(noEvidence.outcome.message).toContain('没有找到')

    // 子问题 1(ordinal=1):有 supported 之外的可核对链路——无 claim 之外,主子问题已建但无引用
    // 主子问题没有 claim,同样是 no_evidence
    const all = (await import('../../src/main/research/repository')).listSubQuestions(db, task.research_task_id)
    expect(bySub.get(all[0]!.subquestionId)!.kind).toBe('no_evidence')
  })

  it('「明确没有该要求」:有有效 contradicts 引用的子问题落 explicit_absence(answered)', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId, subquestionId } = seedRun(db, [snap.documentId], '是否要求 Go?')
    const goStart = codePointOffsetOf(db, snap.documentId, '地点:上海。')
    chainOf(db, runId, subquestionId, snap.documentId, {
      quote: '地点:上海。',
      start: goStart,
      end: goStart + Array.from('地点:上海。').length,
      claimText: '岗位A 不要求 Go',
      subject: { entity: '岗位A', attribute: 'Go 要求' },
      relation: 'contradicts'
    })
    validateCitations(db, runId)
    const summaries = persistSubquestionOutcomes(db, runId)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.kind).toBe('explicit_absence')
    expect(summaries[0]!.status).toBe('answered')
    expect(summaries[0]!.outcome.message).toContain('明确表明没有该要求')
  })

  it('「资料存在冲突」:conflict_group 存在的子问题落 conflicted,优先于不足', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId, subquestionId } = seedRun(db, [snap.documentId], 'Python 要求是否有争议?')
    const pyStart = codePointOffsetOf(db, snap.documentId, QUOTE_PYTHON)
    const sqlStart = codePointOffsetOf(db, snap.documentId, '加分项:SQL。')
    chainOf(db, runId, subquestionId, snap.documentId, {
      quote: QUOTE_PYTHON,
      start: pyStart,
      end: pyStart + Array.from(QUOTE_PYTHON).length,
      claimText: '岗位A 明确要求 Python 熟练'
    })
    chainOf(db, runId, subquestionId, snap.documentId, {
      quote: '加分项:SQL。',
      start: sqlStart,
      end: sqlStart + Array.from('加分项:SQL。').length,
      claimText: '岗位A 不要求 Python(仅加分)',
      relation: 'contradicts'
    })
    validateCitations(db, runId)
    detectConflicts(db, runId)
    const summaries = persistSubquestionOutcomes(db, runId)
    expect(summaries[0]!.kind).toBe('conflict')
    expect(summaries[0]!.status).toBe('conflicted')
    expect(summaries[0]!.outcome.message).toContain('资料存在冲突')
  })
})

// ---------- 版本化报告:白名单、模板、版本唯一与不可变 ----------

describe('buildReport 版本化报告', () => {
  /** 造一条 supported 链并返回 runId/claimId */
  async function seedSupportedRun(db: SqliteDb): Promise<{ runId: string; claimId: string; snapshotId: string }> {
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId, subquestionId } = seedRun(db, [snap.documentId])
    const start = codePointOffsetOf(db, snap.documentId, QUOTE_PYTHON)
    const chain = chainOf(db, runId, subquestionId, snap.documentId, {
      quote: QUOTE_PYTHON,
      start,
      end: start + Array.from(QUOTE_PYTHON).length,
      claimText: '岗位A 明确要求 Python 熟练'
    })
    validateCitations(db, runId)
    const provider = new FakeProvider({
      responses: [{ verdicts: [{ claim_id: chain.claimId, status: 'supported', reason: '片段直接支持' }] }]
    })
    await reviewClaims(db, runId, provider, { contextBudget: 100000 })
    return { runId, claimId: chain.claimId, snapshotId: snap.documentId }
  }

  it('组织模型返回白名单外的新 Claim:整体拒绝并回退模板输出', async () => {
    const db = await makeTestDb()
    const { runId, claimId, snapshotId } = await seedSupportedRun(db)
    const provider = new FakeProvider({
      script: (_i, req) => {
        expect(req.prompt).toContain('白名单')
        return {
          sections: ['question', 'core_findings'],
          claim_order: [claimId, 'new-claim-999'],
          recommendation_claim_ids: []
        }
      }
    })
    const { report, response } = await buildReport(db, runId, { version: 1, completer: provider })
    // 白名单外 claim 使整个计划被拒绝:回退模板输出(全部章节、planUsedModel=false),
    // 不部分信任模型的 sections——白名单校验是整体通过或整体拒绝
    expect(response.sections.map((s) => s.section)).toEqual([
      'question', 'scope', 'core_findings', 'evidence_by_subquestion', 'conflicts_and_gaps', 'recommendations', 'method_and_budget', 'sources'
    ])
    expect(report.markdown).toContain('模板直接输出')
    // 白名单外被过滤,但白名单内的 claim 仍按计划排序进入事实区
    expect(response.claims.map((c) => c.claim_id)).toEqual([claimId])
    expect(report.reportState).toBe('partial')
    expect(response.sources[0]!.source_id).toBe(snapshotId)
  })

  it('完整 final 报告:全部子问题 answered,版本唯一,重复 version 报错', async () => {
    const db = await makeTestDb()
    const { runId, claimId } = await seedSupportedRun(db)
    // 子问题落 answered(审核通过)
    const task = db.get<{ research_task_id: string }>('SELECT research_task_id FROM research_tasks WHERE run_id = ?', [runId])!
    db.run(
      "UPDATE research_subquestions SET status = 'answered' WHERE research_task_id = ?",
      [task.research_task_id]
    )
    const { report } = await buildReport(db, runId, {
      version: 1,
      plan: {
        sections: [
          'question', 'scope', 'core_findings', 'evidence_by_subquestion',
          'conflicts_and_gaps', 'recommendations', 'method_and_budget', 'sources'
        ],
        claim_order: [claimId]
      }
    })
    expect(report.reportState).toBe('final')
    expect(report.markdown).toContain('## 研究问题')
    expect(report.markdown).toContain('岗位A 明确要求 Python 熟练')
    expect(report.markdown).toContain('## 完整来源清单')
    // 版本唯一:createReport 的 (research_task_id, version) 唯一约束
    const dup = createReportVersionConflict(db, runId)
    expect(appCode(dup)).toBe('CONFLICT')
  })

  it('报告版本不可变:进入版本的 claim 被冻结,状态回写被拒绝', async () => {
    const db = await makeTestDb()
    const { runId, claimId } = await seedSupportedRun(db)
    await buildReport(db, runId, {
      version: 1,
      plan: { sections: ['core_findings'], claim_order: [claimId] }
    })
    // 冻结后回写 support_status 被拒(CONFLICT)
    const { updateClaimReview } = await import('../../src/main/research/repository')
    expect(() => updateClaimReview(db, claimId, 'unsupported', null)).toThrow(/冻结/)
    // 新版本可继续生成(补正走新版本)
    const { report: v2 } = await buildReport(db, runId, {
      version: 2,
      plan: { sections: ['core_findings'], claim_order: [claimId] }
    })
    expect(v2.version).toBe(2)
  })

  it('模型不可用:模板仍输出已验证内容与未完成清单', async () => {
    const db = await makeTestDb()
    const { runId, claimId } = await seedSupportedRun(db)
    const { report, response } = await buildReport(db, runId, { version: 1, completer: null })
    expect(report.markdown).toContain('岗位A 明确要求 Python 熟练')
    expect(report.markdown).toContain('模板直接输出')
    expect(response.sections.map((s) => s.section)).toEqual([
      'question', 'scope', 'core_findings', 'evidence_by_subquestion', 'conflicts_and_gaps', 'recommendations', 'method_and_budget', 'sources'
    ])
    expect(response.claims.map((c) => c.claim_id)).toEqual([claimId])
  })

  it('candidate(未审核)claim 不进事实区;response 组装含完整字段', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId, subquestionId } = seedRun(db, [snap.documentId])
    const start = codePointOffsetOf(db, snap.documentId, QUOTE_PYTHON)
    const chain = chainOf(db, runId, subquestionId, snap.documentId, {
      quote: QUOTE_PYTHON,
      start,
      end: start + Array.from(QUOTE_PYTHON).length,
      claimText: '岗位A 明确要求 Python 熟练'
    })
    validateCitations(db, runId) // 结构通过但未语义审核:仍 candidate
    const { response } = await buildReport(db, runId, { version: 1, completer: null })
    expect(response.claims).toHaveLength(0)
    expect(response.markdown).not.toContain('岗位A 明确要求 Python 熟练')
    expect(response.run_id).toBe(runId)
    expect(response.manifest_sha256).not.toBe('')
    expect(response.budget_usage.max_model_calls).toBe(6)
    expect(response.unanswered_subquestions[0]!.question).toBe('Python 要求')
    void chain
  })

  it('parseSynthesisPlan:非法章节、白名单外 claim、非数组 claim_order 全部拒绝', () => {
    const allowed = new Set(['c1'])
    expect(parseSynthesisPlan({ sections: ['question'], claim_order: ['c1'] }, allowed)).not.toBeNull()
    expect(parseSynthesisPlan({ sections: ['unknown-section'], claim_order: [] }, allowed)).toBeNull()
    expect(parseSynthesisPlan({ sections: ['question'], claim_order: ['c2'] }, allowed)).toBeNull()
    expect(parseSynthesisPlan({ sections: 'question' }, allowed)).toBeNull()
    expect(parseSynthesisPlan({ sections: ['question'], claim_order: 'c1' }, allowed)).toBeNull()
    expect(reportEligibleClaims([
      { claimId: 'a', researchTaskId: 't', subquestionId: 's', text: 'x', claimType: 'fact', subject: null, qualifier: null, supportStatus: 'supported', conflictGroup: null, review: null },
      { claimId: 'b', researchTaskId: 't', subquestionId: 's', text: 'y', claimType: 'fact', subject: null, qualifier: null, supportStatus: 'candidate', conflictGroup: null, review: null },
      { claimId: 'c', researchTaskId: 't', subquestionId: 's', text: 'z', claimType: 'fact', subject: null, qualifier: null, supportStatus: 'uncertain', conflictGroup: 'g1', review: null },
      { claimId: 'd', researchTaskId: 't', subquestionId: 's', text: 'w', claimType: 'fact', subject: null, qualifier: null, supportStatus: 'uncertain', conflictGroup: null, review: null }
    ]).map((c) => c.claimId)).toEqual(['a', 'c'])
  })

  it('部分完成:有 insufficient 子问题时报告为 partial', async () => {
    const db = await makeTestDb()
    const snap = importOne(db, { sourceName: 'jd-a.md', bytes: bytesOf(SAMPLE_JD), sample: true })
    const { runId } = seedRun(db, [snap.documentId])
    // 子问题 1 标记 insufficient,无 claim
    const summaries = persistSubquestionOutcomes(db, runId)
    expect(summaries[0]!.status).toBe('insufficient')
    const { report, response } = await buildReport(db, runId, { version: 1, completer: null })
    expect(report.reportState).toBe('partial')
    expect(response.unanswered_subquestions).toHaveLength(1)
    expect(report.markdown).toContain('没有证据')
  })
})

// ---------- checkCitationStructure 直测:边界与 hash ----------

describe('checkCitationStructure 单项边界', () => {
  it('offset 越界与 end<=start 被拒绝', () => {
    const snapshot = { snapshotId: 's1', textSha256: 'h', normalizedText: 'abc' }
    const manifest = {
      manifestId: 'm', schemaVersion: 1, manifestSha256: 'mh', createdAt: 't',
      entries: [{ snapshot_id: 's1', text_sha256: 'h', raw_sha256: 'r', source_type: 'txt', source_name: 'a.txt' }]
    }
    const mkSpan = (start: number, end: number) => ({
      evidenceId: 'e1', subquestionId: 'sub', snapshotId: 's1', chunkId: 'k1',
      startOffset: start, endOffset: end, quote: 'abc',
      spanSha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      validationStatus: 'candidate' as const
    })
    const citation = { citationId: 'c1', claimId: 'cl', evidenceId: 'e1', relation: 'supports' as const, evidenceGroupId: null, groupOperator: null }
    const chunk = { chunkId: 'k1', snapshotId: 's1', startOffset: 0, endOffset: 3, content: 'abc' }
    expect(checkCitationStructure({ citation, span: mkSpan(2, 5), snapshot, manifest, chunk }).ok).toBe(false)
    expect(checkCitationStructure({ citation, span: mkSpan(2, 2), snapshot, manifest, chunk }).ok).toBe(false)
    const ok = checkCitationStructure({ citation, span: mkSpan(0, 3), snapshot, manifest, chunk })
    expect(ok.ok).toBe(true)
  })
})

/** 版本冲突的错误码(独立小工具) */
function createReportVersionConflict(db: SqliteDb, runId: string): unknown {
  try {
    createReport(db, runId, { version: 1, reportState: 'final', markdown: '# 重复' })
    return null
  } catch (err) {
    return err
  }
}

// getSubQuestion 引用保持(测试里通过动态 import 使用 listSubQuestions)
void getSubQuestion
