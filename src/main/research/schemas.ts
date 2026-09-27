// 研究契约(R-01):请求 schema、领域实体类型、运行时校验器、预算契约与标准错误码。
//
// 契约边界(研究模块规格第 5/7/8 节):
// 1. 请求对象与研究实体载荷一律拒绝未知字段(双向),与 planner.parseModelPlan 同一风格;
// 2. 预算只能下调不能上调(参照 agent/config.ts 的 resolveAgentBudget),
//    默认 3/8/6/120,max_active_seconds 下限 10;
// 3. 研究标准错误码仅作为 agent_runs.error_code 的词表与领域语义;
//    IPC 层错误信封复用 shared/operations.ts 的 appError 体系,不另造第二套。
//
// 时间语义:研究实体统一 UTC ISO 8601(规格第 5 节)。既有业务表用本地朴素时间,
// 这是规格冻结的有意差异(研究实体要跨 CLI/评测/复现包使用),不做全库时间语义迁移。

import { appError } from '../../shared/operations'
import { OperationError } from '../db/operations'
import type { RunStatus } from '../../shared/agent'

function invalid(message: string): OperationError {
  return new OperationError(appError('VALIDATION', message, { retryable: false }))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Unicode 码点计数(不是 UTF-16 下标):问题长度与 span 上限都按码点计 */
export function codePointLength(text: string): number {
  return Array.from(text).length
}

// ---------- 研究标准错误码(agent_runs.error_code 词表) ----------

/**
 * 研究侧标准错误码(规格第 7 节)。仅用于 agent_runs.error_code 与领域语义;
 * 抛出的异常仍走 appError(VALIDATION/CONFLICT/TARGET_UNAVAILABLE)信封。
 */
export type ResearchErrorCode =
  | 'INVALID_BUDGET'
  | 'EMPTY_SOURCE_SET'
  | 'QUESTION_LIMIT_EXCEEDED'
  | 'SNAPSHOT_NOT_FOUND'
  | 'SNAPSHOT_HASH_MISMATCH'
  | 'REPORT_NOT_READY'
  | 'REPORT_VERSION_NOT_FOUND'
  | 'MODE_MISMATCH'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_OUTPUT_INVALID'
  | 'CITATION_INVALID'
  | 'WORKER_INTERRUPTED'
  | 'BUDGET_EXHAUSTED'

export const RESEARCH_ERROR_CODES: readonly ResearchErrorCode[] = [
  'INVALID_BUDGET',
  'EMPTY_SOURCE_SET',
  'QUESTION_LIMIT_EXCEEDED',
  'SNAPSHOT_NOT_FOUND',
  'SNAPSHOT_HASH_MISMATCH',
  'REPORT_NOT_READY',
  'REPORT_VERSION_NOT_FOUND',
  'MODE_MISMATCH',
  'MODEL_UNAVAILABLE',
  'MODEL_OUTPUT_INVALID',
  'CITATION_INVALID',
  'WORKER_INTERRUPTED',
  'BUDGET_EXHAUSTED'
]

export function isResearchErrorCode(value: unknown): value is ResearchErrorCode {
  return typeof value === 'string' && (RESEARCH_ERROR_CODES as readonly string[]).includes(value)
}

// ---------- 研究预算契约 ----------

export interface ResearchBudget {
  /** 已物化子问题上限;客户端可下调至 1 */
  max_subqueries: number
  /** 进入抽取的实际 chunk 上限;重叠片段也占额 */
  max_chunks_per_subquery: number
  /** 模型调用次数上限(含所有重试) */
  max_model_calls: number
  /** 累计活动时间上限(秒),不含排队与等待用户 */
  max_active_seconds: number
}

/** P0 默认预算;运行时冻结,避免调用方就地改写共享默认值 */
export const DEFAULT_RESEARCH_BUDGET: Readonly<ResearchBudget> = Object.freeze({
  max_subqueries: 3,
  max_chunks_per_subquery: 8,
  max_model_calls: 6,
  max_active_seconds: 120
})

/** max_active_seconds 的下限(规格第 8 节:客户端可下调;最低 10) */
export const MIN_ACTIVE_SECONDS = 10

function budgetInvalid(message: string): OperationError {
  return new OperationError(appError('VALIDATION', `预算无效:${message}`, { retryable: false }))
}

/**
 * 合并客户端预算覆盖值:只允许下调,上调或非法值一律拒绝。
 * 入参是未信数据(来自请求 JSON),因此未知字段与形状也在这里拒绝。
 */
export function resolveResearchBudget(override: unknown = {}): ResearchBudget {
  if (!isPlainObject(override)) throw budgetInvalid('budget 必须是对象')
  const allowed = new Set(Object.keys(DEFAULT_RESEARCH_BUDGET))
  for (const key of Object.keys(override)) {
    if (!allowed.has(key)) throw budgetInvalid(`预算含未知字段:${key}`)
  }
  const merged: ResearchBudget = { ...DEFAULT_RESEARCH_BUDGET }
  for (const key of allowed) {
    const value = override[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw budgetInvalid(`${key} 必须是整数,收到 ${String(value)}`)
    }
    const ceiling = DEFAULT_RESEARCH_BUDGET[key as keyof ResearchBudget]
    if (key === 'max_active_seconds') {
      if (value < MIN_ACTIVE_SECONDS) throw budgetInvalid(`${key} 不得低于 ${MIN_ACTIVE_SECONDS} 秒,收到 ${value}`)
    } else if (value < 1) {
      throw budgetInvalid(`${key} 必须不小于 1,收到 ${value}`)
    }
    if (value > ceiling) {
      throw budgetInvalid(`${key} 不允许高于默认上限 ${ceiling},收到 ${value}`)
    }
    merged[key as keyof ResearchBudget] = value
  }
  return merged
}

// ---------- 领域枚举 ----------

export type SubQuestionStatus = 'pending' | 'running' | 'answered' | 'insufficient' | 'conflicted' | 'skipped'
export type EvidenceValidationStatus = 'candidate' | 'valid' | 'invalid'
export type ClaimType = 'fact' | 'comparison' | 'recommendation'
export type SupportStatus = 'candidate' | 'supported' | 'unsupported' | 'uncertain'
export type CitationRelation = 'supports' | 'contradicts' | 'context'
export type ReportState = 'draft' | 'final' | 'partial'

export const SUBQUESTION_STATUSES: readonly SubQuestionStatus[] = [
  'pending', 'running', 'answered', 'insufficient', 'conflicted', 'skipped'
]
export const EVIDENCE_VALIDATION_STATUSES: readonly EvidenceValidationStatus[] = ['candidate', 'valid', 'invalid']
export const CLAIM_TYPES: readonly ClaimType[] = ['fact', 'comparison', 'recommendation']
export const SUPPORT_STATUSES: readonly SupportStatus[] = ['candidate', 'supported', 'unsupported', 'uncertain']
export const CITATION_RELATIONS: readonly CitationRelation[] = ['supports', 'contradicts', 'context']
export const REPORT_STATES: readonly ReportState[] = ['draft', 'final', 'partial']

export function isSubQuestionStatus(value: unknown): value is SubQuestionStatus {
  return typeof value === 'string' && (SUBQUESTION_STATUSES as readonly string[]).includes(value)
}
export function isEvidenceValidationStatus(value: unknown): value is EvidenceValidationStatus {
  return typeof value === 'string' && (EVIDENCE_VALIDATION_STATUSES as readonly string[]).includes(value)
}
export function isClaimType(value: unknown): value is ClaimType {
  return typeof value === 'string' && (CLAIM_TYPES as readonly string[]).includes(value)
}
export function isSupportStatus(value: unknown): value is SupportStatus {
  return typeof value === 'string' && (SUPPORT_STATUSES as readonly string[]).includes(value)
}
export function isCitationRelation(value: unknown): value is CitationRelation {
  return typeof value === 'string' && (CITATION_RELATIONS as readonly string[]).includes(value)
}
export function isReportState(value: unknown): value is ReportState {
  return typeof value === 'string' && (REPORT_STATES as readonly string[]).includes(value)
}

// ---------- 领域实体类型(持久化形态;规格第 5 节字段清单) ----------

/** 冻结清单条目:有序快照 ID/hash 与来源元数据 */
export interface SnapshotManifestEntry {
  snapshot_id: string
  text_sha256: string
  raw_sha256: string
  source_type: string
  source_name: string
}

export interface SnapshotManifest {
  manifestId: string
  schemaVersion: number
  entries: SnapshotManifestEntry[]
  /** 对 entries 规范化 JSON 的 sha256;运行创建后清单不可修改 */
  manifestSha256: string
  /** UTC ISO 8601 */
  createdAt: string
}

export interface ResearchTask {
  researchTaskId: string
  /** 唯一外键 → agent_runs;公共运行状态以 AgentRun 为准,不在此复制 */
  runId: string
  question: string
  constraints: Record<string, string | number | boolean> | null
  snapshotManifestId: string
  budget: ResearchBudget
  /** 工作流阶段镜像;权威状态在 run_id 对应的 AgentRun 上 */
  phase: RunStatus
  config: Record<string, unknown> | null
  parentRunId: string | null
  /** UTC ISO 8601 */
  createdAt: string
}

export interface SubQuestion {
  subquestionId: string
  researchTaskId: string
  /** 每任务内唯一,1~3 */
  ordinal: number
  question: string
  query: Record<string, unknown> | null
  status: SubQuestionStatus
  insufficiencyReason: string | null
  outcome: Record<string, unknown> | null
}

export interface EvidenceSpan {
  evidenceId: string
  subquestionId: string
  snapshotId: string
  chunkId: string
  /** 规范化全文的码点坐标:零起点、左闭右开,0 ≤ start < end ≤ 码点长度 */
  startOffset: number
  endOffset: number
  quote: string
  spanSha256: string
  validationStatus: EvidenceValidationStatus
}

export interface Claim {
  claimId: string
  researchTaskId: string
  subquestionId: string
  text: string
  claimType: ClaimType
  subject: Record<string, unknown> | null
  qualifier: Record<string, unknown> | null
  supportStatus: SupportStatus
  conflictGroup: string | null
  review: Record<string, unknown> | null
}

export interface Citation {
  citationId: string
  claimId: string
  evidenceId: string
  relation: CitationRelation
  evidenceGroupId: string | null
  /** 证据组内 all_of;context 不算支持 */
  groupOperator: 'all_of' | null
}

export interface Report {
  reportId: string
  researchTaskId: string
  /** (research_task_id, version) 唯一;版本不可变 */
  version: number
  reportState: ReportState
  structured: Record<string, unknown> | null
  markdown: string
  reportSha256: string
  manifestSha256: string
  /** UTC ISO 8601 */
  createdAt: string
}

// ---------- 研究请求 schema(规格第 7 节) ----------

export const QUESTION_MAX_CODE_POINTS = 4000
export const MAX_SNAPSHOT_IDS = 100
export const MAX_SUBQUESTIONS = 3
export const SPAN_MAX_CODE_POINTS = 400

/** 快照策略:P0 仅接受 fixed(导入时的固定快照) */
export type SnapshotPolicy = 'fixed'

export interface ResearchRequest {
  question: string
  /** 去重后 1~100 个,保留首次出现顺序 */
  snapshot_ids: string[]
  snapshot_policy: SnapshotPolicy
  constraints?: Record<string, string | number | boolean>
  /** 经 resolveResearchBudget 归一后的完整预算(含默认值) */
  budget: ResearchBudget
}

/** 解析并校验研究请求;形状或边界不合法抛 OperationError(VALIDATION) */
export function parseResearchRequest(raw: unknown): ResearchRequest {
  if (!isPlainObject(raw)) throw invalid('研究请求必须是对象')
  const allowed = new Set(['question', 'snapshot_ids', 'snapshot_policy', 'constraints', 'budget'])
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw invalid(`研究请求含未知字段:${key}`)
  }

  const question = raw.question
  if (typeof question !== 'string' || question.trim() === '') throw invalid('研究问题不能为空')
  if (codePointLength(question) > QUESTION_MAX_CODE_POINTS) {
    throw invalid(`研究问题超过 ${QUESTION_MAX_CODE_POINTS} 码点上限`)
  }

  if (!Array.isArray(raw.snapshot_ids)) throw invalid('snapshot_ids 必须是数组')
  const snapshotIds: string[] = []
  for (const id of raw.snapshot_ids) {
    if (typeof id !== 'string' || id.trim() === '') throw invalid('snapshot_ids 必须是非空字符串')
    if (!snapshotIds.includes(id)) snapshotIds.push(id)
  }
  if (snapshotIds.length === 0) throw invalid('资料清单为空:至少需要一份已导入快照')
  if (snapshotIds.length > MAX_SNAPSHOT_IDS) throw invalid(`快照数量超过上限 ${MAX_SNAPSHOT_IDS}`)

  if (raw.snapshot_policy !== undefined && raw.snapshot_policy !== 'fixed') {
    throw invalid("snapshot_policy 仅接受 'fixed'")
  }

  let constraints: ResearchRequest['constraints']
  if (raw.constraints !== undefined) {
    if (!isPlainObject(raw.constraints)) throw invalid('constraints 必须是对象')
    constraints = {}
    for (const [key, value] of Object.entries(raw.constraints)) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw invalid(`constraints.${key} 的值必须是标量`)
      }
      constraints[key] = value
    }
  }

  const budget = resolveResearchBudget(raw.budget ?? {})

  return {
    question,
    snapshot_ids: snapshotIds,
    snapshot_policy: 'fixed',
    constraints,
    budget
  }
}

// ---------- 研究实体载荷校验器(模型/客户端提交方向;未知字段拒绝) ----------

export interface SubQuestionInput {
  ordinal: number
  question: string
  query?: Record<string, unknown>
}

export function parseSubQuestionInput(raw: unknown): SubQuestionInput {
  if (!isPlainObject(raw)) throw invalid('子问题必须是对象')
  const allowed = new Set(['ordinal', 'question', 'query'])
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw invalid(`子问题含未知字段:${key}`)
  }
  const ordinal = raw.ordinal
  if (typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 1 || ordinal > MAX_SUBQUESTIONS) {
    throw invalid(`ordinal 必须是 1~${MAX_SUBQUESTIONS} 的整数,收到 ${String(ordinal)}`)
  }
  const question = raw.question
  if (typeof question !== 'string' || question.trim() === '') throw invalid('子问题缺少 question')
  if (raw.query !== undefined && !isPlainObject(raw.query)) throw invalid('query 必须是对象')
  return { ordinal, question, query: raw.query as Record<string, unknown> | undefined }
}

export interface EvidenceSpanInput {
  snapshot_id: string
  chunk_id: string
  start_offset: number
  end_offset: number
  quote: string
}

export function parseEvidenceSpanInput(raw: unknown): EvidenceSpanInput {
  if (!isPlainObject(raw)) throw invalid('证据片段必须是对象')
  const allowed = new Set(['snapshot_id', 'chunk_id', 'start_offset', 'end_offset', 'quote'])
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw invalid(`证据片段含未知字段:${key}`)
  }
  if (typeof raw.snapshot_id !== 'string' || raw.snapshot_id === '') throw invalid('证据片段缺少 snapshot_id')
  if (typeof raw.chunk_id !== 'string' || raw.chunk_id === '') throw invalid('证据片段缺少 chunk_id')
  const { start_offset, end_offset } = raw
  if (typeof start_offset !== 'number' || !Number.isInteger(start_offset) || start_offset < 0) {
    throw invalid(`start_offset 必须是不小于 0 的整数,收到 ${String(start_offset)}`)
  }
  if (typeof end_offset !== 'number' || !Number.isInteger(end_offset) || end_offset <= start_offset) {
    throw invalid(`end_offset 必须是大于 start_offset 的整数,收到 ${String(end_offset)}`)
  }
  const quote = raw.quote
  if (typeof quote !== 'string' || quote === '') throw invalid('证据片段缺少 quote')
  if (codePointLength(quote) > SPAN_MAX_CODE_POINTS) {
    throw invalid(`quote 超过 ${SPAN_MAX_CODE_POINTS} 码点上限`)
  }
  return {
    snapshot_id: raw.snapshot_id,
    chunk_id: raw.chunk_id,
    start_offset,
    end_offset,
    quote
  }
}

export interface ClaimInput {
  text: string
  claim_type: ClaimType
  subject?: Record<string, unknown>
  qualifier?: Record<string, unknown>
}

export function parseClaimInput(raw: unknown): ClaimInput {
  if (!isPlainObject(raw)) throw invalid('Claim 必须是对象')
  const allowed = new Set(['text', 'claim_type', 'subject', 'qualifier'])
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw invalid(`Claim 含未知字段:${key}`)
  }
  const text = raw.text
  if (typeof text !== 'string' || text.trim() === '') throw invalid('Claim 缺少 text')
  if (!isClaimType(raw.claim_type)) throw invalid('claim_type 非法')
  if (raw.subject !== undefined && !isPlainObject(raw.subject)) throw invalid('subject 必须是对象')
  if (raw.qualifier !== undefined && !isPlainObject(raw.qualifier)) throw invalid('qualifier 必须是对象')
  return {
    text,
    claim_type: raw.claim_type,
    subject: raw.subject as Record<string, unknown> | undefined,
    qualifier: raw.qualifier as Record<string, unknown> | undefined
  }
}

export interface CitationInput {
  claim_id: string
  evidence_id: string
  relation: CitationRelation
  evidence_group_id?: string
  group_operator?: 'all_of'
}

export function parseCitationInput(raw: unknown): CitationInput {
  if (!isPlainObject(raw)) throw invalid('引用必须是对象')
  const allowed = new Set(['claim_id', 'evidence_id', 'relation', 'evidence_group_id', 'group_operator'])
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw invalid(`引用含未知字段:${key}`)
  }
  if (typeof raw.claim_id !== 'string' || raw.claim_id === '') throw invalid('引用缺少 claim_id')
  if (typeof raw.evidence_id !== 'string' || raw.evidence_id === '') throw invalid('引用缺少 evidence_id')
  if (!isCitationRelation(raw.relation)) throw invalid('relation 非法')
  if (raw.evidence_group_id !== undefined && (typeof raw.evidence_group_id !== 'string' || raw.evidence_group_id === '')) {
    throw invalid('evidence_group_id 必须是非空字符串')
  }
  if (raw.group_operator !== undefined && raw.group_operator !== 'all_of') {
    throw invalid("group_operator 仅接受 'all_of'")
  }
  return {
    claim_id: raw.claim_id,
    evidence_id: raw.evidence_id,
    relation: raw.relation,
    evidence_group_id: raw.evidence_group_id as string | undefined,
    group_operator: raw.group_operator as 'all_of' | undefined
  }
}
