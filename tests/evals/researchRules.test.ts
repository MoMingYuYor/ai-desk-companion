// EVAL-03 research gold 判分测试(researchRules.test.ts)。
//
// 三个独立反例(构造 fake case,不依赖数据集)证明判分不被终态或结构指标收买:
// 1. 终态 succeeded 但无正确证据 → Recall@k 判失败(判分输入根本不含终态);
// 2. 引用坐标合法但语义不支持 → 结构指标通过,语义支持度只输出"待人工",
//    不自动判通过(EVAL-04 人工审阅才有正式结论);
// 3. 诚实不足零事实 claim → 事实引用覆盖率 N/A(零分母)+ 不足识别正确。
//
// 另覆盖:recallForQuestion 规范实现、recordsByLogical + resolveLogicalGoldSpan
// 的 gold 定位(多记录文件唯一定位、跨界 [GOLD_SPAN_UNRESOLVABLE]、hash 版本混用)、
// loadResearchGold 的缺失/损坏语义。
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadResearchGold,
  recallForQuestion,
  scoreResearchCase,
  type ResearchGold,
  type ResearchScoringInput
} from '../../src/main/evals/researchRules'
import type { ScopedSnapshot } from '../../src/main/research/recordScope'

// ---------- 共享 fixture:一个逻辑文件两条记录(RES-02 多记录形态) ----------

const TEXT_SHA = 'h1'.padEnd(64, '0')
const records: ScopedSnapshot[] = [
  { documentId: 'doc-a', scope: { version: 1, coordinateSystem: 'full-file-codepoint-v1', sourceLocator: '/0', startOffset: 0, endOffset: 100 }, textSha256: TEXT_SHA },
  { documentId: 'doc-b', scope: { version: 1, coordinateSystem: 'full-file-codepoint-v1', sourceLocator: '/1', startOffset: 100, endOffset: 200 }, textSha256: TEXT_SHA }
]

const chunksBySnapshot = new Map([
  ['doc-a', [
    { chunkId: 'c-a1', startOffset: 0, endOffset: 60 },
    { chunkId: 'c-a2', startOffset: 60, endOffset: 100 }
  ]],
  ['doc-b', [
    { chunkId: 'c-b1', startOffset: 100, endOffset: 150 },
    { chunkId: 'c-b2', startOffset: 150, endOffset: 200 }
  ]]
])

const recordsByLogical = new Map([['fx-001/notes.json', records]])

function goldSpan(logical: string, start: number, end: number) {
  return { snapshot_id: logical, text_sha256: TEXT_SHA, start_offset: start, end_offset: end, relation: 'supports' }
}

const baseGold: ResearchGold = {
  schema_version: 'research-eval.v1',
  case_id: 'fake-case',
  gold_claims: [
    {
      gold_claim_id: 'gc-1',
      text: 'gold 命题一(位于记录 B)',
      acceptable_evidence_sets: [[goldSpan('fx-001/notes.json', 120, 140)]]
    },
    {
      gold_claim_id: 'gc-2',
      text: 'gold 命题二(位于记录 A)',
      acceptable_evidence_sets: [[goldSpan('fx-001/notes.json', 10, 30)]]
    }
  ]
}

function baseInput(over: Partial<ResearchScoringInput> = {}): ResearchScoringInput {
  return {
    gold: baseGold,
    recordsByLogical,
    chunksBySnapshot,
    claims: [],
    citations: [],
    spans: [],
    subquestions: [{ subquestionId: 'sub-1', status: 'answered', insufficiencyReason: null }],
    retrievedChunkIds: [],
    ...over
  }
}

describe('EVAL-03 recallForQuestion 规范实现', () => {
  it('gold 为空返回 null(N/A),不产 0 分', () => {
    expect(recallForQuestion(new Set(['c-1']), new Set())).toBeNull()
  })
  it('命中比例按去重集合计算', () => {
    expect(recallForQuestion(new Set(['c-a1', 'c-b1', 'c-x']), new Set(['c-a1', 'c-b1']))).toBe(1)
    expect(recallForQuestion(new Set(['c-a1']), new Set(['c-a1', 'c-b1']))).toBe(0.5)
    expect(recallForQuestion(new Set(), new Set(['c-a1']))).toBe(0)
  })
})

describe('EVAL-03 gold span 定位(recordsByLogical + resolveLogicalGoldSpan)', () => {
  it('gold span 唯一定位到包含记录,并映射到相交 chunk(去重)', () => {
    const result = scoreResearchCase(baseInput({ retrievedChunkIds: ['c-b1', 'c-a1'] }))
    expect(result.applicable).toBe(true)
    expect(result.questions.map((q) => q.resolvedSnapshotIds)).toEqual([['doc-b'], ['doc-a']])
    expect(result.questions.map((q) => q.goldChunkIds)).toEqual([['c-b1'], ['c-a1']])
    expect(result.recallMacro).toBe(1)
  })

  it('跨界 span 抛 [GOLD_SPAN_UNRESOLVABLE]:该 claim recall 记 null 并单列错误', () => {
    const gold: ResearchGold = {
      ...baseGold,
      gold_claims: [
        {
          gold_claim_id: 'gc-cross',
          text: '跨越记录边界的标注(数据缺陷)',
          acceptable_evidence_sets: [[goldSpan('fx-001/notes.json', 90, 110)]]
        }
      ]
    }
    const result = scoreResearchCase(baseInput({ gold, retrievedChunkIds: ['c-a1', 'c-b1'] }))
    expect(result.questions[0]!.recall).toBeNull()
    expect(result.questions[0]!.resolutionError).toContain('GOLD_SPAN_UNRESOLVABLE')
    expect(result.goldResolutionErrors).toHaveLength(1)
    expect(result.recallMacro).toBeNull() // 无可用 gold claim → N/A
  })

  it('gold text_sha256 与真实记录不一致按版本混用拒绝,不混用坐标', () => {
    const gold: ResearchGold = {
      ...baseGold,
      gold_claims: [
        {
          gold_claim_id: 'gc-hash',
          text: '旧版本坐标',
          acceptable_evidence_sets: [[goldSpan('fx-001/notes.json', 120, 140)]]
        }
      ]
    }
    ;(gold.gold_claims[0]!.acceptable_evidence_sets[0]![0] as { text_sha256: string }).text_sha256 = 'old'.padEnd(64, '0')
    const result = scoreResearchCase(baseInput({ gold }))
    expect(result.questions[0]!.resolutionError).toContain('版本混用')
  })
})

// ---------- 反例一:终态 succeeded 但无正确证据 ----------

describe('反例一:终态 succeeded 但无正确证据 → 证据判分失败', () => {
  it('判分输入不含终态;引用结构完好而 gold chunk 零命中 → recallMacro 0', () => {
    // 运行侧:结构检查全部通过的有效引用,但支撑证据落在与 gold 无交的 chunk
    const result = scoreResearchCase(
      baseInput({
        claims: [{ claimId: 'cl-1', claimType: 'fact', supportStatus: 'supported', subquestionId: 'sub-1' }],
        citations: [{ citationId: 'cit-1', claimId: 'cl-1', evidenceId: 'ev-1', relation: 'supports' }],
        spans: [
          {
            evidenceId: 'ev-1',
            snapshotId: 'doc-a',
            chunkId: 'c-a2',
            startOffset: 70,
            endOffset: 90,
            quote: '与 gold 无关但结构合法的切片',
            validationStatus: 'valid'
          }
        ],
        retrievedChunkIds: ['c-a2', 'c-b2'] // 交付集合与 gold chunk 零交集
      })
    )
    expect(result.applicable).toBe(true)
    // 结构侧全部通过(这正是"终态成功"假象的来源)
    expect(result.citationStructure).toEqual({ valid: 1, total: 1, precision: 1 })
    expect(result.factCoverage.value).toBe(1)
    // 证据侧判失败:gold 相关 chunk 零命中
    expect(result.recallMacro).toBe(0)
    // 判分结果不提供任何"通过"出口:语义支持度只归人工
    expect(result.semanticSupport).toBe('pending_human_review')
  })
})

// ---------- 反例二:引用坐标合法但语义不支持 ----------

describe('反例二:引用坐标合法但语义不支持 → 结构通过、支持度待人工', () => {
  it('结构有效率 100% 且 recall 满分,仍不自动判通过', () => {
    const result = scoreResearchCase(
      baseInput({
        claims: [{ claimId: 'cl-1', claimType: 'fact', supportStatus: 'supported', subquestionId: 'sub-1' }],
        citations: [
          { citationId: 'cit-1', claimId: 'cl-1', evidenceId: 'ev-1', relation: 'supports' },
          { citationId: 'cit-2', claimId: 'cl-1', evidenceId: 'ev-2', relation: 'supports' }
        ],
        spans: [
          // 坐标/quote/chunk 结构完全合法(运行时结构检查通过),但引用的原文
          // 语义上并不支持命题文本——判分层不解读语义,只能标待人工
          { evidenceId: 'ev-1', snapshotId: 'doc-b', chunkId: 'c-b1', startOffset: 110, endOffset: 130, quote: '本科在读,专业不限。', validationStatus: 'valid' },
          { evidenceId: 'ev-2', snapshotId: 'doc-a', chunkId: 'c-a1', startOffset: 10, endOffset: 30, quote: '工作地点:北京。', validationStatus: 'valid' }
        ],
        retrievedChunkIds: ['c-b1', 'c-a1']
      })
    )
    expect(result.citationStructure).toEqual({ valid: 2, total: 2, precision: 1 })
    expect(result.recallMacro).toBe(1)
    expect(result.factCoverage.value).toBe(1)
    // 关键断言:结构全绿 ≠ 语义通过;唯一合法出口是待人工(EVAL-04)
    expect(result.semanticSupport).toBe('pending_human_review')
    const resultRecord = result as unknown as Record<string, unknown>
    expect(Object.keys(resultRecord)).not.toContain('autoPassed')
    expect(Object.keys(resultRecord)).not.toContain('passed')
  })
})

// ---------- 反例三:诚实不足零事实 claim ----------

describe('反例三:诚实不足且零事实 claim → 覆盖 N/A + 不足行为正确', () => {
  it('gold_claims 为空 + missing_requirements:覆盖率 N/A,不足识别 pass', () => {
    const gold: ResearchGold = {
      schema_version: 'research-eval.v1',
      case_id: 'fake-insufficient',
      gold_claims: [],
      missing_requirements: ['salary']
    }
    const result = scoreResearchCase(
      baseInput({
        gold,
        claims: [], // 不编造:零可核验事实 claim
        subquestions: [
          { subquestionId: 'sub-1', status: 'insufficient', insufficiencyReason: '没有证据:未检索到相关材料' }
        ],
        retrievedChunkIds: []
      })
    )
    expect(result.applicable).toBe(true)
    expect(result.factCoverage).toEqual({ covered: 0, total: 0, value: null }) // 零分母 N/A
    expect(result.recallMacro).toBeNull() // 无 gold 题 → 不进分母
    expect(result.insufficiency).toEqual({ expected: true, recognized: true, pass: true })
  })

  it('该诚实而未诚实(编造了 claim):不足识别不通过,覆盖率落到 0/1', () => {
    const gold: ResearchGold = {
      schema_version: 'research-eval.v1',
      case_id: 'fake-insufficient',
      gold_claims: [],
      missing_requirements: ['salary']
    }
    const result = scoreResearchCase(
      baseInput({
        gold,
        claims: [{ claimId: 'cl-fake', claimType: 'fact', supportStatus: 'candidate', subquestionId: 'sub-1' }],
        subquestions: [{ subquestionId: 'sub-1', status: 'answered', insufficiencyReason: null }]
      })
    )
    // 有可核验事实 claim(哪怕无引用)就有分母:覆盖率 0,不再是 N/A
    expect(result.factCoverage).toEqual({ covered: 0, total: 1, value: 0 })
    expect(result.insufficiency).toEqual({ expected: true, recognized: false, pass: false })
  })

  it('有 gold 的题不足识别不适用(pass = null)', () => {
    const result = scoreResearchCase(baseInput({}))
    expect(result.insufficiency).toEqual({ expected: false, recognized: false, pass: null })
  })
})

// ---------- loadResearchGold:缺失/损坏语义 ----------

describe('EVAL-03 loadResearchGold', () => {
  it('文件缺失返回 null(gold 缺失 → 判分 N/A,不伪造 0 分)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-gold-'))
    expect(loadResearchGold(dir, 'research-x')).toBeNull()
    const scored = scoreResearchCase(baseInput({ gold: loadResearchGold(dir, 'research-x') }))
    expect(scored.applicable).toBe(false)
    expect(scored.notScoredReason).toBe('gold_missing')
  })

  it('case_id 不一致或 schema 不符直接抛错(数据问题必须显式暴露)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-gold-'))
    mkdirSync(join(dir, 'annotations'), { recursive: true })
    writeFileSync(
      join(dir, 'annotations', 'research-y.json'),
      JSON.stringify({ ...baseGold, case_id: 'other-case', gold_claims: [] }),
      'utf-8'
    )
    writeFileSync(
      join(dir, 'annotations', 'research-z.json'),
      JSON.stringify({ schema_version: 'other.v9', case_id: 'research-z', gold_claims: [] }),
      'utf-8'
    )
    expect(() => loadResearchGold(dir, 'research-y')).toThrow(/case_id 不一致/)
    expect(() => loadResearchGold(dir, 'research-z')).toThrow(/schema 版本不支持/)
  })
})
