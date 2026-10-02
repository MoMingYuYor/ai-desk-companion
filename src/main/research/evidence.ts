// 证据语义审核与冲突检测(R-05;evidence.ts):研究模块规格第 4 节。
//
// 三条职责:
// 1. 冲突分组:按「实体、属性、适用时间、适用地区或岗位层级」对齐,冲突键一致的
//    矛盾证据形成 conflict_group 并列双方标 unresolved;**不按多数副本投票**;
//    不同公司(subject 不同)要求不同不是事实冲突,不合并。
// 2. 语义审核:用 packageReviewClaims(R-04 打包纯函数,整体移除、禁截断)打包后
//    调 StructuredCompleter,输出 supported/unsupported/uncertain 及理由。审核是
//    可错的判断步骤:completer 为 null、预算不足、输出无效时一律按候选处理,不把
//    未审核内容升级为 supported。
// 3. 不足表达:「没有证据」「明确没有该要求」「资料存在冲突」三分,分别落
//    outcome_json/insufficiency_reason,供 R-04 工作流与报告使用。

import type { SqliteDb } from '../db/connection'
import type { StructuredCompleter } from '../agent/llm'
import { ModelRequestError, type ModelRequestControl } from '../services/modelRequest'
import { allOfIncompleteClaimIds } from './citations'
import { isBudgetExhaustedError, packageReviewClaims, type ReviewClaimCandidate, type ReviewSpanInput } from './budget'
import {
  getClaim,
  getResearchTaskByRun,
  listClaims,
  listCitationsForRun,
  listEvidenceSpansForRun,
  listFrozenClaimIds,
  listRunCitationsForClaim,
  updateClaimConflictGroup,
  updateClaimReview,
  updateSubQuestionOutcome,
  type RunCitationRow
} from './repository'
import { listSubQuestions } from './repository'
import type { Claim, SupportStatus } from './schemas'

// ---------- 冲突对齐键 ----------

/** 冲突对齐字段:实体、属性、适用时间、适用地区、岗位层级(规格第 4 节) */
export interface ConflictAlignKey {
  entity: string
  attribute: string
  time?: string
  region?: string
  level?: string
}

function normalizeScalar(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  return String(value)
}

/**
 * 从 claim 的 subject/qualifier 提取冲突对齐键。
 * subject_json 承载实体与属性(entity/attribute;缺省 attribute 用空串占位,
 * 同实体的不同属性证据不会误并);qualifier_json 承载适用条件(time/region/level)。
 * 键完全一致(逐字段相等,缺省一致)才视为同一对齐维度——不同公司 subject.entity
 * 不同,键不同,不合并(不同公司要求不同不是事实冲突)。
 */
export function conflictAlignKeyOf(claim: Claim): ConflictAlignKey {
  const subject = claim.subject ?? {}
  const qualifier = claim.qualifier ?? {}
  return {
    entity: normalizeScalar(subject.entity ?? subject.company ?? subject.subject ?? ''),
    attribute: normalizeScalar(subject.attribute ?? subject.property ?? ''),
    time: normalizeScalar(qualifier.time ?? qualifier.effective_time) || undefined,
    region: normalizeScalar(qualifier.region ?? qualifier.location) || undefined,
    level: normalizeScalar(qualifier.level ?? qualifier.seniority) || undefined
  }
}

function alignKeyEqual(a: ConflictAlignKey, b: ConflictAlignKey): boolean {
  return (
    a.entity === b.entity &&
    a.attribute === b.attribute &&
    (a.time ?? '') === (b.time ?? '') &&
    (a.region ?? '') === (b.region ?? '') &&
    (a.level ?? '') === (b.level ?? '')
  )
}

// ---------- 冲突分组 ----------

export interface ConflictGroup {
  groupId: string
  /** 组内并列双方的 claim ID(至少两个,来自同一对齐键的矛盾证据) */
  claimIds: string[]
  /** 对齐键(实体/属性/时间/地区/层级一致) */
  alignKey: ConflictAlignKey
}

export interface ConflictDetectionResult {
  groups: ConflictGroup[]
  /** 进入冲突组的 claim ID(双方均标 unresolved,写入 conflict_group 与 review_json) */
  unresolvedClaimIds: string[]
}

/**
 * 冲突检测(确定性规则):
 * - 前提:两侧 claim 都有结构有效的 contradicts 引用(矛盾证据),且两侧对齐键一致;
 * - 同一 claim 对多个对象矛盾时,每个矛盾对各自成组(claim 可进入多个组,并列展示);
 * - **不投票**:组内全部成员都标 unresolved,不按副本数或模型可信分裁决。
 * contradicts 引用关系的建立是抽取阶段(R-04)的职责;本函数消费已落库的引用。
 */
export function detectConflicts(db: SqliteDb, runId: string): ConflictDetectionResult {
  const task = getResearchTaskByRun(db, runId)
  if (!task) throw new Error(`运行缺少研究任务:${runId}`)
  const claims = listClaims(db, task.researchTaskId)
  const frozen = listFrozenClaimIds(db, task.researchTaskId)

  // 每 claim 的有效矛盾证据(span ID 集合)
  const contradictsByClaim = new Map<string, Set<string>>()
  for (const claim of claims) {
    const rows = listRunCitationsForClaim(db, claim)
    const evidences = new Set(
      rows
        .filter((row) => row.citation.relation === 'contradicts')
        .filter((row) => row.span.validationStatus !== 'invalid')
        .map((row) => row.span.evidenceId)
    )
    contradictsByClaim.set(claim.claimId, evidences)
  }

  const groups: ConflictGroup[] = []
  const unresolved = new Set<string>()
  let seq = 0
  for (let i = 0; i < claims.length; i += 1) {
    for (let j = i + 1; j < claims.length; j += 1) {
      const a = claims[i]!
      const b = claims[j]!
      if (!alignKeyEqual(conflictAlignKeyOf(a), conflictAlignKeyOf(b))) continue
      const ea = contradictsByClaim.get(a.claimId) ?? new Set<string>()
      const eb = contradictsByClaim.get(b.claimId) ?? new Set<string>()
      // 互相矛盾:任一侧引用的 contradicts 片段与对方 claim 的支持证据片段重叠,
      // 或两侧都引用同一矛盾片段。这里采用可判定的规则:任一侧存在 contradicts
      // 引用,且另一侧存在有效支持证据(supports 引用的片段),即构成对立双方。
      const supportOf = (claim: Claim): Set<string> => {
        const rows = listRunCitationsForClaim(db, claim)
        return new Set(
          rows
            .filter((row) => row.citation.relation === 'supports')
            .filter((row) => row.span.validationStatus !== 'invalid')
            .map((row) => row.span.evidenceId)
        )
      }
      const sa = supportOf(a)
      const sb = supportOf(b)
      const opposing =
        (ea.size > 0 && sb.size > 0) || (eb.size > 0 && sa.size > 0)
      if (!opposing) continue
      seq += 1
      const groupId = `conflict-${task.researchTaskId.slice(0, 8)}-${seq}`
      groups.push({ groupId, claimIds: [a.claimId, b.claimId], alignKey: conflictAlignKeyOf(a) })
      unresolved.add(a.claimId)
      unresolved.add(b.claimId)
    }
  }

  // 落库:并列双方都标 unresolved,写入 conflict_group 与 review_json;冻结的不回写
  for (const group of groups) {
    for (const claimId of group.claimIds) {
      if (frozen.has(claimId)) continue
      const claim = getClaim(db, claimId)
      if (!claim) continue
      updateClaimConflictGroup(db, claimId, group.groupId, {
        ...(claim.review ?? {}),
        conflict: {
          group_id: group.groupId,
          status: 'unresolved',
          counterpart_claims: group.claimIds.filter((id) => id !== claimId),
          align_key: group.alignKey,
          // 明示不投票:组内并列展示,不按多数副本或可信分裁决
          resolution: '并列展示矛盾双方,不按多数副本投票'
        }
      })
    }
  }

  return { groups, unresolvedClaimIds: [...unresolved] }
}

// ---------- 语义审核 ----------

/** reviewClaims 的配置:预算与上下文打包参数 */
export interface ReviewOptions {
  /** 上下文预算(码点);候选整体移除、禁截断的打包约束 */
  contextBudget: number
  /** 是否执行语义审核;false 或 completer 缺省时跳过(只留结构检查结果) */
  enabled?: boolean
  /** RES-01:审核模型调用的传输控制;审核不重试,槽位预留由调用方维持 */
  control?: ModelRequestControl
}

export interface ReviewOutcome {
  /** 参与审核的 claim 数(实际发送给模型的) */
  reviewedCount: number
  /** 因预算不足被整体移除的 claim ID(packageReviewClaims 的 uncovered) */
  uncoveredClaimIds: string[]
  /** 审核输出无效而保持候选的 claim ID(不升级) */
  invalidOutputClaimIds: string[]
  /** 审核判定汇总 */
  verdicts: Record<string, { status: SupportStatus; reason: string }>
  /** 跳过审核的 claim ID(completer 为 null、未启用或无候选) */
  skipped: boolean
}

interface ReviewModelOutput {
  claim_id: unknown
  status: unknown
  reason: unknown
}

/** 模型输出白名单校验:status 只接受三种语义结论;claim_id 必须是本次打包的候选 */
function parseVerdict(raw: unknown, allowedClaimIds: ReadonlySet<string>): { claimId: string; status: SupportStatus; reason: string } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const obj = raw as ReviewModelOutput
  if (typeof obj.claim_id !== 'string' || !allowedClaimIds.has(obj.claim_id)) return null
  if (obj.status !== 'supported' && obj.status !== 'unsupported' && obj.status !== 'uncertain') return null
  if (typeof obj.reason !== 'string' || obj.reason.trim() === '') return null
  return { claimId: obj.claim_id, status: obj.status, reason: obj.reason }
}

/**
 * 语义审核(可错判断步骤,不是事实正确性证明):
 * 1) 取本次 run 的全部结构候选 claim,与完整支持片段一起经 packageReviewClaims 打包
 *    (超上下文预算整体移除低优先级候选并记录 uncovered,禁截断、禁拆成额外调用);
 * 2) completer 为 null 或未启用时跳过审核——候选保持原状,不把未审核内容升级为 supported;
 * 3) 模型输出经白名单校验(claim_id 必须在本次打包候选内,status 三值枚举),
 *    无效输出按候选处理不升级;white-list 外的 claim ID(幻觉)整体忽略并记录。
 * 调用方(R-04 工作流)负责模型调用预算的预留与扣减;本函数只消费打包结果。
 */
export async function reviewClaims(db: SqliteDb, runId: string, completer: StructuredCompleter | null, options: ReviewOptions): Promise<ReviewOutcome> {
  const task = getResearchTaskByRun(db, runId)
  if (!task) throw new Error(`运行缺少研究任务:${runId}`)
  const claims = listClaims(db, task.researchTaskId)
  const frozen = listFrozenClaimIds(db, task.researchTaskId)

  const outcome: ReviewOutcome = {
    reviewedCount: 0,
    uncoveredClaimIds: [],
    invalidOutputClaimIds: [],
    verdicts: {},
    skipped: true
  }
  const enabled = options.enabled !== false

  // RES-03:即使被直接调用(未先跑 validateCitations)也先检查 all_of 完整性——
  // 缺员或缺预期清单的命题确定性拒绝,不送模型;模型返回 supported 也不能覆盖。
  // 结构结果未知(候选态 span)按缺失处理;已冻结命题不回写,保持原状态。
  const blockedByAllOf = allOfIncompleteClaimIds(db, claims)
  for (const claim of claims) {
    if (!blockedByAllOf.has(claim.claimId) || frozen.has(claim.claimId)) continue
    if (claim.supportStatus === 'candidate') {
      updateClaimReview(db, claim.claimId, 'unsupported', {
        ...(claim.review ?? {}),
        review: {
          stage: 'all_of_completeness',
          status: 'unsupported',
          reason: 'all_of 证据组缺员或缺预期清单 [ALL_OF_EXPECTATION_MISSING],整组不成立(送审入口确定性拒绝)'
        }
      })
    }
  }

  // 送审范围:未冻结、候选态的 fact/comparison claim(recommendation 属建议区,单独审核;
  // 已有结构结论(unsupported)的不重审——确定性规则优先于模型判断;
  // all_of 缺员命题已被确定性拒绝,不进入打包范围)
  const reviewable = claims.filter(
    (c) =>
      !frozen.has(c.claimId) &&
      c.supportStatus === 'candidate' &&
      c.claimType !== 'recommendation' &&
      !blockedByAllOf.has(c.claimId)
  )
  if (!enabled || completer === null || reviewable.length === 0) {
    // 跳过语义审核:只留结构检查结果,candidate 不升级(规格第 8 节)
    return outcome
  }

  const spans = listEvidenceSpansForRun(db, runId)
  const spanTexts: ReviewSpanInput[] = []
  const spanTextById = new Map<string, string>()
  const supportsByClaim = new Map<string, string[]>()
  for (const claim of reviewable) {
    const rows = listRunCitationsForClaim(db, claim)
    const spanIds = rows
      .filter((row) => row.citation.relation === 'supports')
      .map((row) => row.span.evidenceId)
    supportsByClaim.set(claim.claimId, spanIds)
  }
  const usedSpanIds = new Set([...supportsByClaim.values()].flat())
  for (const span of spans) {
    if (!usedSpanIds.has(span.evidenceId)) continue
    const snapshotRow = db.get<{ normalized_text: string }>(
      'SELECT normalized_text FROM retrieval_documents WHERE document_id = ?',
      [span.snapshotId]
    )
    const fullText = snapshotRow?.normalized_text ?? ''
    const text = Array.from(fullText).slice(span.startOffset, span.endOffset).join('')
    spanTextById.set(span.evidenceId, text)
    spanTexts.push({ spanId: span.evidenceId, text })
  }

  const candidates: ReviewClaimCandidate[] = reviewable.map((claim, index) => ({
    claimId: claim.claimId,
    text: claim.text,
    supportSpanIds: supportsByClaim.get(claim.claimId) ?? [],
    // 优先级 = 子问题序 + 落库序:先入先审,超预算移除尾部(整体移除,不截断)
    priority: index
  }))
  const pkg = packageReviewClaims(candidates, spanTexts, options.contextBudget)
  outcome.uncoveredClaimIds = [...pkg.uncovered]
  if (pkg.included.length === 0) {
    return outcome
  }

  const allowed = new Set(pkg.included.map((c) => c.claimId))
  const claimById = new Map(reviewable.map((c) => [c.claimId, c]))
  const promptLines = pkg.included.map((c) => {
    const spanLines = (supportsByClaim.get(c.claimId) ?? [])
      .map((id) => spanTextById.get(id) ?? '')
      .filter((t) => t !== '')
      .map((t) => `  - 片段:${t}`)
    return `Claim(${c.claimId}):${c.text}\n${spanLines.join('\n')}`
  })

  outcome.skipped = false
  let data: unknown
  try {
    const result = await completer.completeJson({
      system:
        '你是证据审核员。对每个 Claim 判断其支持片段是否直接支持命题的实体、谓词、数量、时间、否定与条件;' +
        '把"加分项"改成"必须"、"可选其一"改成"全部要求"、某岗位结论推广到所有岗位,都判 unsupported。' +
        '只输出 JSON:{"verdicts":[{"claim_id":"...","status":"supported|unsupported|uncertain","reason":"..."}]}。' +
        '不确定时用 uncertain,不得编造。不审核范围之外的 claim_id。',
      prompt: `逐条审核以下 Claim 是否被其片段直接支持:\n${promptLines.join('\n\n')}`,
      ...(options.control !== undefined ? { control: options.control } : {})
    })
    data = result.data
  } catch (err) {
    // 取消、观测失败与预算/时限耗尽必须原样传播,不得按候选处理吞掉。
    // 其余模型调用失败(异常):本次候选全部按候选处理,不升级
    if (isBudgetExhaustedError(err)) throw err
    if (err instanceof ModelRequestError && err.code === 'CANCELLED') throw err
    if (err instanceof ModelRequestError && err.code === 'OBSERVATION_FAILED') throw err
    if (options.control?.signal.aborted) throw err
    outcome.invalidOutputClaimIds = [...allowed]
    return outcome
  }
  outcome.reviewedCount = pkg.included.length

  const verdictsRaw = (typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>).verdicts
    : null)
  const verdictList: unknown[] = Array.isArray(verdictsRaw) ? verdictsRaw : []
  const returned = new Set<string>()
  let invalidSeen = false
  for (const raw of verdictList) {
    const verdict = parseVerdict(raw, allowed)
    if (verdict === null) {
      invalidSeen = true
      continue
    }
    returned.add(verdict.claimId)
    outcome.verdicts[verdict.claimId] = { status: verdict.status, reason: verdict.reason }
    const claim = claimById.get(verdict.claimId)
    if (claim && !frozen.has(claim.claimId)) {
      updateClaimReview(db, claim.claimId, verdict.status, {
        ...(claim.review ?? {}),
        review: {
          stage: 'semantic_review',
          status: verdict.status,
          reason: verdict.reason,
          // 可错判断的明示:审核结论不是事实正确性的证明
          disclaimer: '模型语义审核为可错判断,正式准确率由人工 gold 与 Eval Lab 评估'
        }
      })
    }
  }
  // 白名单内的候选没有被有效 verdict 覆盖(整体输出无效或缺项):按候选处理,不升级
  for (const claimId of allowed) {
    if (!returned.has(claimId)) {
      outcome.invalidOutputClaimIds.push(claimId)
      invalidSeen = true
      const claim = claimById.get(claimId)
      if (claim && !frozen.has(claim.claimId)) {
        updateClaimReview(db, claimId, 'candidate', {
          ...(claim.review ?? {}),
          review: { stage: 'semantic_review', status: 'candidate', reason: '模型输出无效或缺项,保持候选不升级' }
        })
      }
    }
  }
  if (invalidSeen) outcome.invalidOutputClaimIds = [...new Set([...outcome.invalidOutputClaimIds])]
  return outcome
}

// ---------- 不足表达 ----------

/** 子问题级不足类别:三分表达(规格第 4 节) */
export type InsufficiencyKind = 'no_evidence' | 'explicit_absence' | 'conflict'

export interface SubquestionOutcomeSummary {
  subquestionId: string
  kind: InsufficiencyKind
  status: 'answered' | 'insufficient' | 'conflicted'
  insufficiencyReason: string | null
  outcome: Record<string, unknown>
}

/**
 * 不足表达三分(确定性判定,供 R-04 工作流与报告使用):
 * - 「资料存在冲突」:该子问题的 claim 中存在 conflict_group(冲突优先于不足);
 * - 「明确没有该要求」:存在有效 contradicts 引用或模型审核明确 unsupported 且带否定理由;
 * - 「没有证据」:检索无 claim、全部证据 invalid 或全部 claim unsupported/无支持引用。
 * 「未检索到不能推导为不需要」:no_evidence 的 outcome 明示不得反推。
 */
export function summarizeSubquestionOutcomes(db: SqliteDb, runId: string): SubquestionOutcomeSummary[] {
  const task = getResearchTaskByRun(db, runId)
  if (!task) throw new Error(`运行缺少研究任务:${runId}`)
  const claims = listClaims(db, task.researchTaskId)
  const rows = listCitationsForRun(db, runId)
  const verdictByClaim = new Map<string, { status: string }>()
  for (const row of rows) {
    const claim = getClaim(db, row.claim.claimId)
    if (claim) verdictByClaim.set(claim.claimId, { status: claim.supportStatus })
  }

  const summaries: SubquestionOutcomeSummary[] = []
  for (const sub of listSubQuestions(db, task.researchTaskId)) {
    const subClaims = claims.filter((c) => c.subquestionId === sub.subquestionId)
    if (subClaims.length === 0) {
      summaries.push({
        subquestionId: sub.subquestionId,
        kind: 'no_evidence',
        status: 'insufficient',
        insufficiencyReason: '没有证据:本子问题未抽取到任何 claim(检索为空或无候选)',
        outcome: { kind: 'no_evidence', message: '没有找到与该子问题相关的证据', note: '未检索到不能推导为岗位不需要该要求' }
      })
      continue
    }
    const conflictClaim = subClaims.find((c) => c.conflictGroup !== null)
    if (conflictClaim) {
      summaries.push({
        subquestionId: sub.subquestionId,
        kind: 'conflict',
        status: 'conflicted',
        insufficiencyReason: `资料存在冲突:claim ${conflictClaim.claimId} 的矛盾证据并列于冲突组 ${conflictClaim.conflictGroup},不投票裁决`,
        outcome: {
          kind: 'conflict',
          conflict_group: conflictClaim.conflictGroup,
          message: '资料存在冲突,矛盾证据并列展示',
          claim_ids: subClaims.filter((c) => c.conflictGroup !== null).map((c) => c.claimId)
        }
      })
      continue
    }
    // 明确没有:结构有效的 contradicts 引用,或审核结论 unsupported 且理由含明确否定
    const rowsByClaim = new Map<string, RunCitationRow[]>()
    for (const row of rows) rowsByClaim.set(row.claim.claimId, [...(rowsByClaim.get(row.claim.claimId) ?? []), row])
    const explicitContradicts = subClaims.some((c) =>
      (rowsByClaim.get(c.claimId) ?? []).some(
        (r) => r.citation.relation === 'contradicts' && r.span.validationStatus === 'valid'
      )
    )
    const reviewedUnsupported = subClaims.some(
      (c) => verdictByClaim.get(c.claimId)?.status === 'unsupported'
    )
    if (explicitContradicts || reviewedUnsupported) {
      const reason = explicitContradicts
        ? '明确没有该要求:存在有效的 contradicts 证据'
        : '明确没有该要求:语义审核判定不支持'
      summaries.push({
        subquestionId: sub.subquestionId,
        kind: 'explicit_absence',
        status: 'answered',
        insufficiencyReason: null,
        outcome: { kind: 'explicit_absence', message: '资料明确表明没有该要求', reason }
      })
      continue
    }
    // 剩余:全部候选/无支持/全部 unsupported 之外的不足(如全部 uncertain/无有效证据)
    const anyValid = (rowsByClaim.get(subClaims[0]!.claimId) ?? []).some(
      (r) => r.span.validationStatus === 'valid'
    )
    const allCandidates = subClaims.every((c) => c.supportStatus === 'candidate')
    if (allCandidates && !anyValid) {
      summaries.push({
        subquestionId: sub.subquestionId,
        kind: 'no_evidence',
        status: 'insufficient',
        insufficiencyReason: '没有证据:候选证据全部未通过结构检查',
        outcome: { kind: 'no_evidence', message: '没有找到可核对的证据', note: '未检索到不能推导为岗位不需要该要求' }
      })
      continue
    }
    summaries.push({
      subquestionId: sub.subquestionId,
      kind: 'no_evidence',
      status: 'insufficient',
      insufficiencyReason: '没有证据:本子问题的候选均未形成可核对的支持',
      outcome: { kind: 'no_evidence', message: '没有足够的证据支持该子问题的结论' }
    })
  }
  return summaries
}

/** 把三分结果落库(outcome_json/insufficiency_reason);供 R-04 工作流在审核后调用 */
export function persistSubquestionOutcomes(db: SqliteDb, runId: string): SubquestionOutcomeSummary[] {
  const summaries = summarizeSubquestionOutcomes(db, runId)
  for (const summary of summaries) {
    updateSubQuestionOutcome(db, {
      subquestionId: summary.subquestionId,
      status: summary.status,
      insufficiencyReason: summary.insufficiencyReason,
      outcome: summary.outcome
    })
  }
  return summaries
}
