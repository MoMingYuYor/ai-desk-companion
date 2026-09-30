// EVAL-03 research gold 判分(researchRules.ts):用 gold 标注评估检索与
// 命题支持,修复 F-11(research eval 只判终态与禁止工具、未用 gold)。
//
// 判分口径(完成计划 eval.md EVAL-03,全部在相同规范文本坐标系
// full-file-codepoint-v1 内比较):
// - Recall@k:gold 相关 span 经 recordsByLogical + resolveLogicalGoldSpan 定位到
//   真实记录,再映射到相交的 chunk,去重后与运行实际交付/支撑的 chunk 集合求交;
//   每条 gold claim(评分"题"单元)计算一次,对有 gold 的题 macro 平均;
// - recallForQuestion:gold 集为空返回 null(不产 0 分),否则 |retrieved ∩ gold| / |gold|;
// - 引用结构有效率 = 结构有效 citation / 全部 citation(有效性来自运行时的
//   span 结构检查:快照 hash、offset 界内、quote 与切片一致、chunk 覆盖);
// - 事实引用覆盖率 = 至少一条有效支持引用的可核验事实 claim / 全部可核验事实 claim;
//   可核验类型按抽取期保存的 claim_type(fact/comparison/recommendation)判定,
//   不事后改标签逃避分母;零分母返回 null(展示层显示 N/A);
// - 无 gold 的不足题(gold_claims 为空 + missing_requirements)不进 recall 分母,
//   单列不足识别(零可核验事实 claim 且存在 insufficient 子问题 = 诚实不足);
// - 语义支持度一律 pending_human_review:本模块不做"引用语义是否支持命题"的
//   通过判定(那是 EVAL-04 人工审阅的正式结论),结构指标再高也不自动判通过;
// - gold 证据定位只用于判分:评测运行输入只有 question/snapshot_ids,gold 不进入
//   检索、抽取或脚本的任何输入路径。
//
// gold span 无法唯一映射到记录时按 RES-02 契约得到 [GOLD_SPAN_UNRESOLVABLE]:
// 判分层捕获并记入 goldResolutionErrors,该 claim 的 recall 记 null,
// 不让单条标注问题中断整批评测,但错误必须可见、不得静默丢弃。

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveLogicalGoldSpan, type ScopedSnapshot } from '../research/recordScope'

// ---------- gold 标注(research-eval.v1) ----------

/** gold 证据 span:逻辑 snapshot_id(`<fixture_id>/<file>`)+ 整文件码点坐标 */
export interface ResearchGoldSpan {
  snapshot_id: string
  text_sha256?: string
  start_offset: number
  end_offset: number
  quote?: string
  relation?: string
  provenance_group_id?: string
}

export interface ResearchGoldClaim {
  gold_claim_id: string
  text: string
  /** 可接受证据集合(集合间 OR,集合内 AND);判 recall 时取全部相关 span 的并集 */
  acceptable_evidence_sets: ResearchGoldSpan[][]
}

/** research gold 标注(只读形状;完整校验由 gold_integrity 测试承载) */
export interface ResearchGold {
  schema_version: string
  case_id: string
  group?: string
  split?: string
  input?: string
  gold_claims: ResearchGoldClaim[]
  conflict_flags?: string[]
  missing_requirements?: string[]
  fabrication_bans?: string[]
  forbidden_actions?: string[]
  annotation?: { status?: string; guideline_version?: string }
}

/**
 * 加载某案例的 gold 标注:`<datasetDir>/annotations/<case_id>.json`。
 * 文件缺失返回 null(gold 缺失 → 判分 N/A 并记 notScoredReason,不伪造 0 分);
 * 存在但损坏直接抛错(数据问题必须显式暴露,不能静默按无 gold 处理)。
 */
export function loadResearchGold(datasetDir: string, caseId: string): ResearchGold | null {
  const file = join(datasetDir, 'annotations', `${caseId}.json`)
  if (!existsSync(file)) return null
  const gold = JSON.parse(readFileSync(file, 'utf-8')) as ResearchGold
  if (gold.schema_version !== 'research-eval.v1') {
    throw new Error(`gold 标注 schema 版本不支持:${gold.schema_version}(${file})`)
  }
  if (gold.case_id !== caseId) {
    throw new Error(`gold 标注 case_id 不一致:文件 ${gold.case_id} ≠ 请求 ${caseId}(${file})`)
  }
  return gold
}

// ---------- 规范函数(完成计划 eval.md 签名原样) ----------

/** 每题 Recall@k:gold 集为空返回 null(N/A);否则命中数 / gold 数 */
export function recallForQuestion(retrieved: Set<string>, gold: Set<string>): number | null {
  if (gold.size === 0) return null
  return [...gold].filter((id) => retrieved.has(id)).length / gold.size
}

// ---------- 判分输入(全部来自运行后观测/产物,不含 gold 以外的先验) ----------

export interface ScoringCitation {
  citationId: string
  claimId: string
  evidenceId: string
  relation: string
}

export interface ScoringSpan {
  evidenceId: string
  snapshotId: string
  chunkId: string
  startOffset: number
  endOffset: number
  quote: string
  /** 运行时结构检查结论:valid / invalid / candidate */
  validationStatus: string
}

export interface ScoringClaim {
  claimId: string
  /** 抽取期保存的分类:fact / comparison / recommendation(不事后改标签) */
  claimType: string
  supportStatus: string
  subquestionId: string
}

export interface ScoringSubquestion {
  subquestionId: string
  status: string
  insufficiencyReason: string | null
}

export interface ResearchScoringInput {
  gold: ResearchGold | null
  /** 逻辑 snapshot_id → 该逻辑文件的全部真实记录(RES-02 映射) */
  recordsByLogical: Map<string, ScopedSnapshot[]>
  /** 逻辑 snapshot_id → 真实记录内与全文坐标相交的块(块边界来自导入索引) */
  chunksBySnapshot: Map<string, Array<{ chunkId: string; startOffset: number; endOffset: number }>>
  claims: readonly ScoringClaim[]
  citations: readonly ScoringCitation[]
  spans: readonly ScoringSpan[]
  subquestions: readonly ScoringSubquestion[]
  /** 运行实际交付的 chunk ID(trace retrieval 事件 hitChunkIds 的并集,交付序去重) */
  retrievedChunkIds: readonly string[]
}

// ---------- 判分结果 ----------

/** 单条 gold claim(评分"题"单元)的 Recall@k 明细(EVAL-04 人工复核的索引) */
export interface ResearchQuestionScore {
  goldClaimId: string
  goldText: string
  /** gold span 定位到的真实快照 ID(判分用途;不代表运行输入) */
  resolvedSnapshotIds: string[]
  /** gold 相关 span 相交 chunk 去重后的集合 */
  goldChunkIds: string[]
  recall: number | null
  /** gold span 无法唯一定位时的原因([GOLD_SPAN_UNRESOLVABLE] 摘要) */
  resolutionError: string | null
}

/** 可核验事实 claim 的类型集合:按抽取期 claim_type 判定,不事后改标签 */
export const VERIFIABLE_CLAIM_TYPES: readonly string[] = ['fact', 'comparison', 'recommendation']

export interface ResearchScoreResult {
  /** gold 可用且判分执行;false 时 only notScoredReason 有意义 */
  applicable: boolean
  /** gold 缺失等原因(不伪造 0 分) */
  notScoredReason?: string
  /** 有 gold 的题(claim)macro 平均 Recall@k;无可用 gold claim 为 null(N/A) */
  recallMacro: number | null
  questions: ResearchQuestionScore[]
  /** 引用结构有效率:valid/total;零引用为 null(N/A) */
  citationStructure: { valid: number; total: number; precision: number | null }
  /** 事实引用覆盖率:covered/total;零可核验事实 claim 为 null(N/A) */
  factCoverage: { covered: number; total: number; value: number | null }
  /** 不足识别:expected = gold 判定该题应有不足;recognized = 运行表达了诚实不足 */
  insufficiency: { expected: boolean; recognized: boolean; pass: boolean | null }
  /** 语义支持度:一律待人工(EVAL-04);本模块不自动判通过 */
  semanticSupport: 'pending_human_review'
  /** [GOLD_SPAN_UNRESOLVABLE] 等定位失败汇总(必须可见) */
  goldResolutionErrors: string[]
}

/**
 * research gold 判分主入口:输入全部来自运行后观测(claims/citations/spans/
 * 交付 chunk)与 gold 标注,不由案例终态反推——终态 succeeded 而证据不匹配
 * 依然判失败。见文件头口径说明。
 */
export function scoreResearchCase(input: ResearchScoringInput): ResearchScoreResult {
  const gold = input.gold
  if (!gold) {
    return {
      applicable: false,
      notScoredReason: 'gold_missing',
      recallMacro: null,
      questions: [],
      citationStructure: { valid: 0, total: 0, precision: null },
      factCoverage: { covered: 0, total: 0, value: null },
      insufficiency: { expected: false, recognized: false, pass: null },
      semanticSupport: 'pending_human_review',
      goldResolutionErrors: []
    }
  }

  // ---- Recall@k:gold span → 真实记录 → 相交 chunk(去重)→ 与交付集合求交 ----
  const retrieved = new Set(input.retrievedChunkIds)
  const questions: ResearchQuestionScore[] = []
  const goldResolutionErrors: string[] = []
  const spanValidById = new Map(input.spans.map((s) => [s.evidenceId, s]))

  for (const claim of gold.gold_claims) {
    const goldChunkIds = new Set<string>()
    const resolvedSnapshotIds = new Set<string>()
    let resolutionError: string | null = null
    for (const set of claim.acceptable_evidence_sets) {
      for (const span of set) {
        try {
          const records = input.recordsByLogical.get(span.snapshot_id)
          if (!records || records.length === 0) {
            throw new Error(`逻辑快照 ${span.snapshot_id} 无真实记录映射`)
          }
          const record = resolveLogicalGoldSpan(records, {
            startOffset: span.start_offset,
            endOffset: span.end_offset
          })
          if (span.text_sha256 !== undefined && record.textSha256 !== span.text_sha256) {
            throw new Error(`gold text_sha256 与真实记录不一致(版本混用):${span.snapshot_id}`)
          }
          resolvedSnapshotIds.add(record.documentId)
          // gold span 映射到相交 chunk:块与 span 的码点区间取交(相同坐标系)
          const chunks = input.chunksBySnapshot.get(record.documentId) ?? []
          for (const chunk of chunks) {
            if (chunk.startOffset < span.end_offset && span.start_offset < chunk.endOffset) {
              goldChunkIds.add(chunk.chunkId)
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          resolutionError = message
          goldResolutionErrors.push(`${claim.gold_claim_id}:${message}`)
        }
      }
    }
    const recall = resolutionError === null ? recallForQuestion(retrieved, goldChunkIds) : null
    questions.push({
      goldClaimId: claim.gold_claim_id,
      goldText: claim.text,
      resolvedSnapshotIds: [...resolvedSnapshotIds],
      goldChunkIds: [...goldChunkIds],
      recall,
      resolutionError
    })
  }

  const scored = questions.filter((q) => q.recall !== null)
  const recallMacro =
    scored.length === 0 ? null : scored.reduce((sum, q) => sum + (q.recall as number), 0) / scored.length

  // ---- 引用结构有效率:有效 citation / 全部 citation(有效性来自运行时结构检查) ----
  const totalCitations = input.citations.length
  let validCitations = 0
  for (const citation of input.citations) {
    const span = spanValidById.get(citation.evidenceId)
    // 引用指向缺失 span:按无效计(防御;正常链路引用闭包保证 span 存在)
    if (span && span.validationStatus === 'valid') validCitations += 1
  }
  const citationPrecision = totalCitations === 0 ? null : validCitations / totalCitations

  // ---- 事实引用覆盖率:≥1 条有效支持引用的可核验事实 claim / 全部可核验事实 claim ----
  const verifiable = input.claims.filter((c) => VERIFIABLE_CLAIM_TYPES.includes(c.claimType))
  const covered = verifiable.filter((c) =>
    input.citations.some(
      (cit) =>
        cit.claimId === c.claimId &&
        cit.relation === 'supports' &&
        spanValidById.get(cit.evidenceId)?.validationStatus === 'valid'
    )
  )
  const factCoverageValue = verifiable.length === 0 ? null : covered.length / verifiable.length

  // ---- 不足识别(单列,不进 recall 分母) ----
  // expected:gold_claims 为空且标注了 missing_requirements(无 gold 不足题)
  const insufficiencyExpected = gold.gold_claims.length === 0 && (gold.missing_requirements?.length ?? 0) > 0
  // recognized:零可核验事实 claim(不编造)且存在 insufficient 子问题(诚实表达)
  const insufficiencyRecognized =
    verifiable.length === 0 && input.subquestions.some((s) => s.status === 'insufficient')
  const insufficiencyPass = insufficiencyExpected ? insufficiencyRecognized : null

  return {
    applicable: true,
    recallMacro,
    questions,
    citationStructure: { valid: validCitations, total: totalCitations, precision: citationPrecision },
    factCoverage: { covered: covered.length, total: verifiable.length, value: factCoverageValue },
    insufficiency: { expected: insufficiencyExpected, recognized: insufficiencyRecognized, pass: insufficiencyPass },
    semanticSupport: 'pending_human_review',
    goldResolutionErrors
  }
}
