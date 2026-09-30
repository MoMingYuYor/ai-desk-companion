// 人工审阅持久化(EVAL-04,F-13 评测部分):审阅记录从内存改为追加式 JSONL。
//
// 纪律(完成计划 eval.md EVAL-04):
// - subjectKey 组合 eval/config/case/repeat/claim/evidence 六段,唯一确定
//   一个待审对象;段 ID 全部过安全字符校验(路径 ID 校验);
// - reviewId 用随机唯一 ID(randomUUID),不用序号——并发/合并时不冲突;
// - 先持久写成功再返回:appendFileSync 完成后才把记录计入内存并返回调用方;
// - 同一对象重新审阅保留历史与理由,最后一条有效记录作为当前判断;
// - 空理由拒绝(与内存 ReviewStore 同一校验入口);
// - schema 与路径 ID 校验:加载时逐行校验,损坏行抛错并保留原文件,
//   禁止静默重置为新记录集;
// - 从产物枚举应审的全部 claim-evidence 对,计算 coverage 与 supportPrecision;
//   coverage 不足 100% 时 holdout 未完成,不以少量已审高分判通过;
//   unreviewed 对象在结果中显式可见。

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeSegment } from './artifacts'
import { VERIFIABLE_CLAIM_TYPES } from './researchRules'
import {
  assertAnnotationInput,
  reviewCompliance,
  type ReviewAnnotation,
  type ReviewDecision,
  type ReviewSource
} from './reviews'

/** 审阅存储错误:文件损坏或行 schema 非法(原文件保留,不重置) */
export class ReviewStoreError extends Error {
  constructor(message: string, readonly file?: string) {
    super(message)
    this.name = 'ReviewStoreError'
  }
}

// ---------- subjectKey:eval/config/case/repeat/claim/evidence 六段组合 ----------

/** 无引用 claim 的 evidence 段占位(可核验但没有任何 citation 的 claim 也要可审) */
export const NO_EVIDENCE_SEGMENT = 'none'

export interface ReviewSubjectRef {
  /** 评测批次 ID */
  evalRunId: string
  configId: string
  caseId: string
  repeatIndex: number
  claimId: string
  /** 引用的证据 ID;无引用为 NO_EVIDENCE_SEGMENT */
  evidenceId: string
}

function safeIdPart(label: string, value: string): string {
  try {
    return safeSegment(label, value)
  } catch (err) {
    throw new ReviewStoreError(err instanceof Error ? err.message : String(err))
  }
}

/** 组合 subjectKey:`<eval>::<config>::<case>::<repeat>::<claim>::<evidence>`;段 ID 严格校验 */
export function reviewSubjectKey(ref: ReviewSubjectRef): string {
  if (!Number.isInteger(ref.repeatIndex) || ref.repeatIndex < 0) {
    throw new ReviewStoreError(`repeatIndex 必须是不小于 0 的整数,收到 ${String(ref.repeatIndex)}`)
  }
  return [
    safeIdPart('evalRunId', ref.evalRunId),
    safeIdPart('configId', ref.configId),
    safeIdPart('caseId', ref.caseId),
    String(ref.repeatIndex),
    safeIdPart('claimId', ref.claimId),
    safeIdPart('evidenceId', ref.evidenceId)
  ].join('::')
}

/** 拆解 subjectKey(展示/分组用);段数或 ID 非法抛错 */
export function parseReviewSubjectKey(key: string): ReviewSubjectRef {
  const parts = key.split('::')
  if (parts.length !== 6) {
    throw new ReviewStoreError(`subjectKey 必须是 eval/config/case/repeat/claim/evidence 六段:${key}`)
  }
  const [evalRunId, configId, caseId, repeat, claimId, evidenceId] = parts as [string, string, string, string, string, string]
  const repeatIndex = Number(repeat)
  if (!Number.isInteger(repeatIndex) || repeatIndex < 0) {
    throw new ReviewStoreError(`subjectKey repeat 段非法:${key}`)
  }
  return {
    evalRunId: safeIdPart('evalRunId', evalRunId),
    configId: safeIdPart('configId', configId),
    caseId: safeIdPart('caseId', caseId),
    repeatIndex,
    claimId: safeIdPart('claimId', claimId),
    evidenceId: safeIdPart('evidenceId', evidenceId)
  }
}

// ---------- JSONL 行 schema 校验 ----------

const DECISIONS: readonly ReviewDecision[] = ['supported', 'contradicted', 'insufficient', 'unreviewed']

/** 逐行 schema 校验(加载与写入共用);非法即抛错 */
export function validateReviewRecord(raw: unknown): ReviewAnnotation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ReviewStoreError('审阅记录必须是对象')
  }
  const allowed = new Set(['reviewId', 'subjectKey', 'decision', 'reason', 'reviewer', 'rubricVersion', 'reviewedAt'])
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new ReviewStoreError(`审阅记录含未知字段:${key}`)
  }
  for (const field of ['reviewId', 'subjectKey', 'reason', 'reviewer', 'rubricVersion', 'reviewedAt']) {
    if (typeof record[field] !== 'string' || (record[field] as string).trim() === '') {
      throw new ReviewStoreError(`审阅记录 ${field} 必须是非空字符串`)
    }
  }
  if (!DECISIONS.includes(record.decision as ReviewDecision)) {
    throw new ReviewStoreError(`审阅判定非法:${String(record.decision)}`)
  }
  // 空理由拒绝:有效判定必须有理由(与内存 ReviewStore 同一入口校验)
  assertAnnotationInput({
    subjectKey: record.subjectKey as string,
    decision: record.decision as ReviewDecision,
    reason: record.reason as string,
    reviewer: record.reviewer as string,
    rubricVersion: record.rubricVersion as string,
    reviewedAt: record.reviewedAt as string
  })
  return record as unknown as ReviewAnnotation
}

/**
 * 追加式 JSONL 审阅存储:同一目录重开读回全部历史;损坏文件保留并报错。
 * 目录缺省文件名 reviews.jsonl。
 */
export class FileReviewStore implements ReviewSource {
  private readonly records: ReviewAnnotation[] = []
  readonly file: string

  constructor(readonly reviewRoot: string, fileName: string = 'reviews.jsonl') {
    this.file = join(reviewRoot, fileName)
    if (existsSync(this.file)) this.load(this.file)
  }

  private load(file: string): void {
    let raw: string
    try {
      raw = readFileSync(file, 'utf-8')
    } catch (err) {
      throw new ReviewStoreError(
        `审阅文件不可读(原文件保留):${file}:${err instanceof Error ? err.message : String(err)}`,
        file
      )
    }
    const lines = raw.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!.trim()
      if (line === '') continue
      try {
        this.records.push(validateReviewRecord(JSON.parse(line)))
      } catch (err) {
        // 损坏文件保留并报错:不跳过、不重置,由人工决定如何处置
        const message = err instanceof Error ? err.message : String(err)
        throw new ReviewStoreError(`审阅文件损坏(原文件保留,不重置):${file} 第 ${i + 1} 行:${message}`, file)
      }
    }
  }

  /** 记录一次审阅:先持久写成功,再计入内存并返回 */
  annotate(annotation: Omit<ReviewAnnotation, 'reviewId'>): ReviewAnnotation {
    if (typeof annotation.subjectKey !== 'string' || annotation.subjectKey.trim() === '') {
      throw new ReviewStoreError('审阅必须携带 subjectKey')
    }
    // subjectKey 段 ID 校验(路径 ID 校验):六段组合必须全部安全
    parseReviewSubjectKey(annotation.subjectKey)
    assertAnnotationInput(annotation)
    const record: ReviewAnnotation = {
      reviewId: randomUUID(),
      ...annotation
    }
    mkdirSync(this.reviewRoot, { recursive: true })
    // 先持久写成功再返回:同步追加,写失败抛错且不进内存
    appendFileSync(this.file, JSON.stringify(record) + '\n', 'utf-8')
    this.records.push(record)
    return record
  }

  /** 对象的最新审阅(无则 null;最后一条有效记录为当前判断) */
  latestFor(subjectKey: string): ReviewAnnotation | null {
    const all = this.historyFor(subjectKey)
    return all.length > 0 ? all[all.length - 1]! : null
  }

  historyFor(subjectKey: string): ReviewAnnotation[] {
    return this.records.filter((r) => r.subjectKey === subjectKey)
  }

  all(): readonly ReviewAnnotation[] {
    return this.records
  }
}

// ---------- 从产物枚举应审对象与 holdout 覆盖判定 ----------

/** 案例产物 evidence 段的最小投影(枚举 claim-evidence 对的输入) */
export interface ReviewableCaseEvidence {
  evalRunId: string
  configId: string
  caseId: string
  repeatIndex: number
  /** evidence.json 的 claims(claim_id + claim_type) */
  claims: ReadonlyArray<{ claim_id: string; claim_type: string }>
  /** evidence.json 的 citations(claim → evidence 引用) */
  citations: ReadonlyArray<{ claim_id: string; evidence_id: string; relation: string }>
}

/**
 * 枚举应审的全部 claim-evidence 对:
 * - 每条 citation 生成一个 (claim, evidence) 对(任何关系类型都需语义复核);
 * - 可核验类型(fact/comparison/recommendation)但没有任何 citation 的 claim
 *   单列一个 evidenceId='none' 的对——缺引用不能逃出分母(与事实引用覆盖率
 *   的 covered/total 同口径);
 * - 非可核验类型且无引用的 claim 不生成待审对。
 */
export function enumerateClaimEvidenceSubjects(src: ReviewableCaseEvidence): string[] {
  const subjects: string[] = []
  for (const claim of src.claims) {
    const pairs = src.citations.filter((c) => c.claim_id === claim.claim_id)
    if (pairs.length === 0) {
      if (!VERIFIABLE_CLAIM_TYPES.includes(claim.claim_type)) continue
      subjects.push(
        reviewSubjectKey({
          evalRunId: src.evalRunId,
          configId: src.configId,
          caseId: src.caseId,
          repeatIndex: src.repeatIndex,
          claimId: claim.claim_id,
          evidenceId: NO_EVIDENCE_SEGMENT
        })
      )
      continue
    }
    for (const citation of pairs) {
      subjects.push(
        reviewSubjectKey({
          evalRunId: src.evalRunId,
          configId: src.configId,
          caseId: src.caseId,
          repeatIndex: src.repeatIndex,
          claimId: claim.claim_id,
          evidenceId: citation.evidence_id
        })
      )
    }
  }
  return subjects
}

export interface ReviewHoldoutStatus {
  /** 复核覆盖率:已复核 / 应复核(零分母 N/A) */
  coverage: { value: number | null; reviewed: number; expected: number }
  /** 支持精度:supported / 已复核(零复核 N/A;unreviewed 不进分母) */
  supportPrecision: { value: number | null; reviewed: number; supported: number }
  /**
   * holdout 是否完成:coverage 达 100% 才为 true;不足 100% 时为 false——
   * 此时不得以少量已审高分判通过(消费方只能据此把 holdout 判为未完成)。
   */
  holdoutComplete: boolean
  /** 应审但未审(或最新判定为 unreviewed)的对象,显式可见 */
  unreviewed: string[]
}

/**
 * holdout 覆盖判定:基于期望对象清单与审阅存储的当前判断计算 coverage 与
 * supportPrecision,并给出 holdoutComplete 与 unreviewed 清单。
 */
export function reviewHoldoutStatus(
  store: ReviewSource,
  expectedSubjects: readonly string[]
): ReviewHoldoutStatus {
  const compliance = reviewCompliance(store, expectedSubjects)
  const latest = new Map<string, ReviewAnnotation>()
  for (const record of store.all()) latest.set(record.subjectKey, record)
  const unreviewed = expectedSubjects.filter((subject) => {
    const record = latest.get(subject)
    return !record || record.decision === 'unreviewed'
  })
  const expected = expectedSubjects.length
  return {
    coverage: compliance.coverage,
    supportPrecision: compliance.supportPrecision,
    holdoutComplete: expected > 0 && compliance.coverage.value === 1,
    unreviewed
  }
}
