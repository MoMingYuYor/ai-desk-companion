// 研究领域表的持久化仓库(R-01)。纯函数风格,与 runs/repository.ts 一致。
//
// 事务边界:写路径尽量薄;createResearchRun 是唯一需要跨表原子性的入口,
// 经 runOperation(幂等回执 + 单事务)实现"agent_runs 与 research_tasks 同事务写入"。
//
// ID 与时间约定:
// - 领域 ID 用服务端生成的 UUID(研究模块规格第 5 节);agent_runs 的 runId
//   仍由共享 createRun 的 uid() 生成,研究侧不另行生成运行 ID。
// - 研究实体时间统一 UTC ISO 8601(nowTimestamp() / clock.now().toISOString())。
//   既有业务表的本地朴素时间(nowLocalIso)是有意保留的历史差异:研究实体要进
//   复现包与评测导出,跨时区可解释,规格第 5 节明确以 UTC 为准。

import { createHash, randomUUID } from 'node:crypto'
import type { SqliteDb } from '../db/connection'
import { getWorkspaceEpoch, runOperation, OperationError, type OperationOutcome } from '../db/operations'
import { createRun, type AgentRunRecord } from '../runs/repository'
import { appError } from '../../shared/operations'
import { systemClock, type Clock } from '../../shared/clock'
import { isRunStatus, type RunStatus } from '../../shared/agent'
import {
  isReportState,
  isSubQuestionStatus,
  parseClaimInput,
  parseCitationInput,
  parseEvidenceSpanInput,
  parseResearchRequest,
  parseSubQuestionInput,
  type Claim,
  type Citation,
  type EvidenceSpan,
  type Report,
  type ReportState,
  type ResearchBudget,
  type ResearchRequest,
  type ResearchTask,
  type SnapshotManifest,
  type SnapshotManifestEntry,
  type SubQuestion,
  type SubQuestionInput
} from './schemas'

// ---------- 通用工具 ----------

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 规范化 JSON:键递归排序,同一份数据在任何调用方得到同一摘要(幂等 requestHash 用) */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** 研究侧失败:研究错误码进 message 前缀(供运行收尾写入 agent_runs.error_code),信封仍用公共 AppError */
function researchFailure(appCode: 'CONFLICT' | 'TARGET_UNAVAILABLE', code: string, message: string): OperationError {
  return new OperationError(appError(appCode, `[${code}] ${message}`, { retryable: false }))
}

// ---------- 行映射 ----------

interface TaskRow {
  research_task_id: string
  run_id: string
  question: string
  constraints_json: string | null
  snapshot_manifest_id: string
  budget_json: string
  phase: string
  config_json: string | null
  parent_run_id: string | null
  created_at: string
}

function toTask(row: TaskRow): ResearchTask {
  if (!isRunStatus(row.phase)) throw new Error(`研究任务 phase 非法:${row.phase}`)
  return {
    researchTaskId: row.research_task_id,
    runId: row.run_id,
    question: row.question,
    constraints: row.constraints_json === null ? null : (JSON.parse(row.constraints_json) as ResearchTask['constraints']),
    snapshotManifestId: row.snapshot_manifest_id,
    budget: JSON.parse(row.budget_json) as ResearchBudget,
    phase: row.phase,
    config: row.config_json === null ? null : (JSON.parse(row.config_json) as Record<string, unknown>),
    parentRunId: row.parent_run_id,
    createdAt: row.created_at
  }
}

interface ManifestRow {
  manifest_id: string
  schema_version: number
  entries_json: string
  manifest_sha256: string
  created_at: string
}

function toManifest(row: ManifestRow): SnapshotManifest {
  return {
    manifestId: row.manifest_id,
    schemaVersion: row.schema_version,
    entries: JSON.parse(row.entries_json) as SnapshotManifestEntry[],
    manifestSha256: row.manifest_sha256,
    createdAt: row.created_at
  }
}

interface SubQuestionRow {
  subquestion_id: string
  research_task_id: string
  ordinal: number
  question: string
  query_json: string | null
  status: string
  insufficiency_reason: string | null
  outcome_json: string | null
}

function toSubQuestion(row: SubQuestionRow): SubQuestion {
  if (!isSubQuestionStatus(row.status)) throw new Error(`子问题状态非法:${row.status}`)
  return {
    subquestionId: row.subquestion_id,
    researchTaskId: row.research_task_id,
    ordinal: row.ordinal,
    question: row.question,
    query: row.query_json === null ? null : (JSON.parse(row.query_json) as Record<string, unknown>),
    status: row.status,
    insufficiencyReason: row.insufficiency_reason,
    outcome: row.outcome_json === null ? null : (JSON.parse(row.outcome_json) as Record<string, unknown>)
  }
}

interface EvidenceSpanRow {
  evidence_id: string
  subquestion_id: string
  snapshot_id: string
  chunk_id: string
  start_offset: number
  end_offset: number
  quote: string
  span_sha256: string
  validation_status: string
}

function toEvidenceSpan(row: EvidenceSpanRow): EvidenceSpan {
  return {
    evidenceId: row.evidence_id,
    subquestionId: row.subquestion_id,
    snapshotId: row.snapshot_id,
    chunkId: row.chunk_id,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    quote: row.quote,
    spanSha256: row.span_sha256,
    validationStatus: row.validation_status as EvidenceSpan['validationStatus']
  }
}

interface ClaimRow {
  claim_id: string
  research_task_id: string
  subquestion_id: string
  text: string
  claim_type: string
  subject_json: string | null
  qualifier_json: string | null
  support_status: string
  conflict_group: string | null
  review_json: string | null
}

function toClaim(row: ClaimRow): Claim {
  return {
    claimId: row.claim_id,
    researchTaskId: row.research_task_id,
    subquestionId: row.subquestion_id,
    text: row.text,
    claimType: row.claim_type as Claim['claimType'],
    subject: row.subject_json === null ? null : (JSON.parse(row.subject_json) as Record<string, unknown>),
    qualifier: row.qualifier_json === null ? null : (JSON.parse(row.qualifier_json) as Record<string, unknown>),
    supportStatus: row.support_status as Claim['supportStatus'],
    conflictGroup: row.conflict_group,
    review: row.review_json === null ? null : (JSON.parse(row.review_json) as Record<string, unknown>)
  }
}

interface CitationRow {
  citation_id: string
  claim_id: string
  evidence_id: string
  relation: string
  evidence_group_id: string | null
  group_operator: string | null
}

function toCitation(row: CitationRow): Citation {
  return {
    citationId: row.citation_id,
    claimId: row.claim_id,
    evidenceId: row.evidence_id,
    relation: row.relation as Citation['relation'],
    evidenceGroupId: row.evidence_group_id,
    groupOperator: row.group_operator === null ? null : 'all_of'
  }
}

interface ReportRow {
  report_id: string
  research_task_id: string
  version: number
  report_state: string
  structured_json: string | null
  markdown: string
  report_sha256: string
  manifest_sha256: string
  created_at: string
}

function toReport(row: ReportRow): Report {
  if (!isReportState(row.report_state)) throw new Error(`报告状态非法:${row.report_state}`)
  return {
    reportId: row.report_id,
    researchTaskId: row.research_task_id,
    version: row.version,
    reportState: row.report_state,
    structured: row.structured_json === null ? null : (JSON.parse(row.structured_json) as Record<string, unknown>),
    markdown: row.markdown,
    reportSha256: row.report_sha256,
    manifestSha256: row.manifest_sha256,
    createdAt: row.created_at
  }
}

// ---------- 模式守卫 ----------

/**
 * 研究操作的模式守卫:运行必须存在且 mode=research。
 * mode 不匹配(对 personal_ops 运行做研究操作,或反之)抛 CONFLICT,携带研究错误码 MODE_MISMATCH。
 */
export function assertResearchRun(db: SqliteDb, runId: string): AgentRunRecord {
  const run = db.get<{ run_id: string; mode: string }>(
    'SELECT run_id, mode FROM agent_runs WHERE run_id = ?',
    [runId]
  )
  if (!run) {
    throw new OperationError(appError('TARGET_UNAVAILABLE', `运行不存在:${runId}`, { retryable: false }))
  }
  if (run.mode !== 'research') {
    throw researchFailure('CONFLICT', 'MODE_MISMATCH', `运行 ${runId} 的 mode 是 ${run.mode},研究操作仅适用于 research 运行`)
  }
  const record = getRunRecord(db, runId)
  if (!record) throw new OperationError(appError('TARGET_UNAVAILABLE', `运行不存在:${runId}`, { retryable: false }))
  return record
}

/** 读取完整运行记录(字段映射与 runs 仓库的 toRun 一致;本层不依赖其行类型) */
function getRunRecord(db: SqliteDb, runId: string): AgentRunRecord | null {
  const row = db.get<{
    run_id: string
    mode: string
    status: string
    input: string
    timezone: string
    context_clock: string
    config_version: string
    budget_json: string
    result_ref: string | null
    error_code: string | null
    started_at: string
    finished_at: string | null
  }>('SELECT * FROM agent_runs WHERE run_id = ?', [runId])
  if (!row) return null
  if (!isRunStatus(row.status)) throw new Error(`运行 status 非法:${row.status}`)
  return {
    runId: row.run_id,
    mode: row.mode as AgentRunRecord['mode'],
    status: row.status,
    input: row.input,
    timezone: row.timezone,
    contextClock: row.context_clock,
    configVersion: row.config_version,
    budgetJson: row.budget_json,
    resultRef: row.result_ref,
    errorCode: row.error_code,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  }
}

/** 校验子问题属于给定 run(跨运行引用在应用层拒绝;外键只能保证"存在") */
function assertSubQuestionInRun(db: SqliteDb, runId: string, subquestionId: string): SubQuestion {
  const sub = getSubQuestion(db, subquestionId)
  if (!sub) {
    throw new OperationError(appError('TARGET_UNAVAILABLE', `子问题不存在:${subquestionId}`, { retryable: false }))
  }
  const task = getResearchTask(db, sub.researchTaskId)
  if (!task || task.runId !== runId) {
    throw researchFailure('CONFLICT', 'MODE_MISMATCH', `子问题 ${subquestionId} 不属于运行 ${runId},拒绝跨运行引用`)
  }
  return sub
}

// ---------- createResearchRun(幂等入口) ----------

export interface CreateResearchRunInput {
  /** 未信研究请求载荷;内部经 parseResearchRequest 校验(未知字段拒绝) */
  request: unknown
  /** 上下文时钟的固定时刻(UTC ISO 8601),与共享 createRun 契约一致 */
  contextClock: string
  timezone?: string
  configVersion?: string
  /** 部分完成的再研究场景:父运行关联 */
  parentRunId?: string | null
  /** 领域时钟;默认系统时钟(测试注入 fixedClock) */
  clock?: Clock
  /** 主进程边界已校验的工作空间代数;缺省取当前进程代数 */
  workspaceEpoch?: string
}

export interface ResearchRunHandle {
  run: AgentRunRecord
  task: ResearchTask
  manifest: SnapshotManifest
}

const CREATE_RUN_COMMAND = 'research:create-run'

/**
 * 创建研究运行(幂等):
 * 1) 校验请求(未知字段、问题长度、快照清单、预算边界);
 * 2) 冻结快照清单(逐个快照核对存在性,清单内容 hash 后落 research_snapshot_manifests);
 * 3) 经共享 createRun(mode='research') 建 agent_runs 行,并在同一事务写 research_tasks(run_id 唯一外键);
 * 4) 同 operationId 同请求重放返回原运行(replayed=true),不新建。
 * 请求摘要只含规范化业务输入,排除 epoch 与操作 ID。
 */
export function createResearchRun(db: SqliteDb, input: CreateResearchRunInput, operationId: string): OperationOutcome<ResearchRunHandle> {
  const clock = input.clock ?? systemClock
  const requestHash = sha256Hex(stableStringify(input.request))
  return runOperation<ResearchRunHandle>(
    db,
    {
      operationId,
      command: CREATE_RUN_COMMAND,
      requestHash,
      workspaceEpoch: input.workspaceEpoch ?? getWorkspaceEpoch()
    },
    () => {
      const request = parseResearchRequest(input.request)

      // 冻结清单:快照必须已导入(SourceSnapshot 即 retrieval_documents,m3 共享表;
      // v9 起补研究侧来源列——source_identity/provenance_group_id/collection_time_basis)
      const entries: SnapshotManifestEntry[] = []
      for (const snapshotId of request.snapshot_ids) {
        const doc = db.get<{
          document_id: string
          source_name: string
          source_type: string
          raw_sha256: string
          text_sha256: string
          source_identity: string | null
          provenance_group_id: string | null
          collection_time_basis: string | null
        }>(
          `SELECT document_id, source_name, source_type, raw_sha256, text_sha256,
                  source_identity, provenance_group_id, collection_time_basis
           FROM retrieval_documents WHERE document_id = ?`,
          [snapshotId]
        )
        if (!doc) {
          throw researchFailure('TARGET_UNAVAILABLE', 'SNAPSHOT_NOT_FOUND', `快照不存在或未导入:${snapshotId}`)
        }
        entries.push({
          snapshot_id: doc.document_id,
          text_sha256: doc.text_sha256,
          raw_sha256: doc.raw_sha256,
          source_type: doc.source_type,
          source_name: doc.source_name,
          source_identity: doc.source_identity ?? undefined,
          provenance_group_id: doc.provenance_group_id ?? undefined,
          collection_time_basis:
            doc.collection_time_basis === 'imported' || doc.collection_time_basis === 'source'
              ? doc.collection_time_basis
              : undefined
        })
      }
      const manifest: SnapshotManifest = {
        manifestId: randomUUID(),
        schemaVersion: 1,
        entries,
        manifestSha256: sha256Hex(stableStringify({ schema_version: 1, entries })),
        createdAt: clock.now().toISOString()
      }
      db.run(
        `INSERT INTO research_snapshot_manifests
           (manifest_id, schema_version, entries_json, manifest_sha256, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [manifest.manifestId, manifest.schemaVersion, JSON.stringify(manifest.entries), manifest.manifestSha256, manifest.createdAt]
      )

      // 共享 RunService:运行行与任务行同事务(runOperation 拥有事务)
      const run = createRun(db, {
        mode: 'research',
        input: request.question,
        contextClock: input.contextClock,
        timezone: input.timezone,
        configVersion: input.configVersion,
        budgetJson: JSON.stringify(request.budget)
      })

      const task: ResearchTask = {
        researchTaskId: randomUUID(),
        runId: run.runId,
        question: request.question,
        constraints: request.constraints ?? null,
        snapshotManifestId: manifest.manifestId,
        budget: request.budget,
        phase: run.status,
        config: null,
        parentRunId: input.parentRunId ?? null,
        createdAt: clock.now().toISOString()
      }
      db.run(
        `INSERT INTO research_tasks
           (research_task_id, run_id, question, constraints_json, snapshot_manifest_id, budget_json,
            phase, config_json, parent_run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          task.researchTaskId,
          task.runId,
          task.question,
          task.constraints === null ? null : JSON.stringify(task.constraints),
          task.snapshotManifestId,
          JSON.stringify(task.budget),
          task.phase,
          task.config === null ? null : JSON.stringify(task.config),
          task.parentRunId,
          task.createdAt
        ]
      )
      return { run, task, manifest }
    }
  )
}

// ---------- 任务与清单读取 ----------

export function getResearchTask(db: SqliteDb, researchTaskId: string): ResearchTask | null {
  const row = db.get<TaskRow>('SELECT * FROM research_tasks WHERE research_task_id = ?', [researchTaskId])
  return row ? toTask(row) : null
}

export function getResearchTaskByRun(db: SqliteDb, runId: string): ResearchTask | null {
  const row = db.get<TaskRow>('SELECT * FROM research_tasks WHERE run_id = ?', [runId])
  return row ? toTask(row) : null
}

/** 工作流阶段镜像写入;权威状态在 agent_runs,本函数不做状态机校验(由 R-04 工作流负责) */
export function updateResearchTaskPhase(db: SqliteDb, researchTaskId: string, phase: RunStatus): ResearchTask {
  if (!isRunStatus(phase)) throw new Error(`phase 非法:${String(phase)}`)
  db.run('UPDATE research_tasks SET phase = ? WHERE research_task_id = ?', [phase, researchTaskId])
  const updated = getResearchTask(db, researchTaskId)
  if (!updated) throw new Error(`研究任务不存在:${researchTaskId}`)
  return updated
}

export function getSnapshotManifest(db: SqliteDb, manifestId: string): SnapshotManifest | null {
  const row = db.get<ManifestRow>('SELECT * FROM research_snapshot_manifests WHERE manifest_id = ?', [manifestId])
  return row ? toManifest(row) : null
}

/**
 * 清单复核:逐个快照核对存在性、双 hash(text/raw)及 R-02 来源元数据
 * (source_identity/provenance_group_id/collection_time_basis)是否与冻结时一致。
 * 任一项不一致说明快照在运行创建后被改动(损坏或被替换),抛 CONFLICT(SNAPSHOT_HASH_MISMATCH)。
 * 旧清单(无扩展字段)只核对双 hash,视为导入路径未知。
 */
export function verifySnapshotManifest(db: SqliteDb, manifestId: string): SnapshotManifest {
  const manifest = getSnapshotManifest(db, manifestId)
  if (!manifest) {
    throw new OperationError(appError('TARGET_UNAVAILABLE', `快照清单不存在:${manifestId}`, { retryable: false }))
  }
  for (const entry of manifest.entries) {
    const doc = db.get<{
      raw_sha256: string
      text_sha256: string
      source_identity: string | null
      provenance_group_id: string | null
      collection_time_basis: string | null
    }>(
      `SELECT raw_sha256, text_sha256, source_identity, provenance_group_id, collection_time_basis
       FROM retrieval_documents WHERE document_id = ?`,
      [entry.snapshot_id]
    )
    if (!doc) {
      throw researchFailure('CONFLICT', 'SNAPSHOT_HASH_MISMATCH', `快照已不存在:${entry.snapshot_id}`)
    }
    if (doc.text_sha256 !== entry.text_sha256 || doc.raw_sha256 !== entry.raw_sha256) {
      throw researchFailure('CONFLICT', 'SNAPSHOT_HASH_MISMATCH', `快照 hash 与冻结清单不一致:${entry.snapshot_id}`)
    }
    // R-02 扩展字段仅在该条目冻结过时才复核(旧清单条目没有这些键)
    if (entry.source_identity !== undefined && doc.source_identity !== entry.source_identity) {
      throw researchFailure('CONFLICT', 'SNAPSHOT_HASH_MISMATCH', `快照 source_identity 与冻结清单不一致:${entry.snapshot_id}`)
    }
    if (entry.provenance_group_id !== undefined && doc.provenance_group_id !== entry.provenance_group_id) {
      throw researchFailure('CONFLICT', 'SNAPSHOT_HASH_MISMATCH', `快照 provenance_group_id 与冻结清单不一致:${entry.snapshot_id}`)
    }
    if (
      entry.collection_time_basis !== undefined &&
      doc.collection_time_basis !== entry.collection_time_basis
    ) {
      throw researchFailure('CONFLICT', 'SNAPSHOT_HASH_MISMATCH', `快照采集时间依据与冻结清单不一致:${entry.snapshot_id}`)
    }
  }
  return manifest
}

// ---------- 子问题 ----------

export function createSubQuestion(db: SqliteDb, runId: string, raw: unknown): SubQuestion {
  assertResearchRun(db, runId)
  const task = getResearchTaskByRun(db, runId)
  if (!task) throw new OperationError(appError('TARGET_UNAVAILABLE', `运行缺少研究任务:${runId}`, { retryable: false }))
  const input: SubQuestionInput = parseSubQuestionInput(raw)
  const existing = db.get<{ subquestion_id: string }>(
    'SELECT subquestion_id FROM research_subquestions WHERE research_task_id = ? AND ordinal = ?',
    [task.researchTaskId, input.ordinal]
  )
  if (existing) {
    throw new OperationError(appError('CONFLICT', `子问题序号已存在:ordinal=${input.ordinal}`, { retryable: false }))
  }
  const sub: SubQuestion = {
    subquestionId: randomUUID(),
    researchTaskId: task.researchTaskId,
    ordinal: input.ordinal,
    question: input.question,
    query: input.query ?? null,
    status: 'pending',
    insufficiencyReason: null,
    outcome: null
  }
  db.run(
    `INSERT INTO research_subquestions
       (subquestion_id, research_task_id, ordinal, question, query_json, status, insufficiency_reason, outcome_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [sub.subquestionId, sub.researchTaskId, sub.ordinal, sub.question, sub.query === null ? null : JSON.stringify(sub.query), sub.status, sub.insufficiencyReason, sub.outcome === null ? null : JSON.stringify(sub.outcome)]
  )
  return sub
}

export function getSubQuestion(db: SqliteDb, subquestionId: string): SubQuestion | null {
  const row = db.get<SubQuestionRow>('SELECT * FROM research_subquestions WHERE subquestion_id = ?', [subquestionId])
  return row ? toSubQuestion(row) : null
}

export function listSubQuestions(db: SqliteDb, researchTaskId: string): SubQuestion[] {
  return db
    .all<SubQuestionRow>(
      'SELECT * FROM research_subquestions WHERE research_task_id = ? ORDER BY ordinal ASC',
      [researchTaskId]
    )
    .map(toSubQuestion)
}

// ---------- 证据片段 ----------

export function createEvidenceSpan(db: SqliteDb, runId: string, subquestionId: string, raw: unknown): EvidenceSpan {
  assertResearchRun(db, runId)
  assertSubQuestionInRun(db, runId, subquestionId)
  const input = parseEvidenceSpanInput(raw)

  const doc = db.get<{ normalized_text: string }>(
    'SELECT normalized_text FROM retrieval_documents WHERE document_id = ?',
    [input.snapshot_id]
  )
  if (!doc) {
    throw researchFailure('TARGET_UNAVAILABLE', 'SNAPSHOT_NOT_FOUND', `快照不存在或未导入:${input.snapshot_id}`)
  }
  const chunk = db.get<{ chunk_id: string }>('SELECT chunk_id FROM retrieval_chunks WHERE chunk_id = ?', [input.chunk_id])
  if (!chunk) {
    throw new OperationError(appError('TARGET_UNAVAILABLE', `chunk 不存在:${input.chunk_id}`, { retryable: false }))
  }
  // offset 是规范化全文的码点坐标:超出快照长度在写入时即拒绝(验收项)
  const snapshotLength = Array.from(doc.normalized_text).length
  if (input.end_offset > snapshotLength) {
    throw new OperationError(
      appError('VALIDATION', `offset 超出快照范围:end_offset=${input.end_offset} > 快照码点长度 ${snapshotLength}`, { retryable: false })
    )
  }

  const span: EvidenceSpan = {
    evidenceId: randomUUID(),
    subquestionId,
    snapshotId: input.snapshot_id,
    chunkId: input.chunk_id,
    startOffset: input.start_offset,
    endOffset: input.end_offset,
    quote: input.quote,
    spanSha256: sha256Hex(input.quote),
    validationStatus: 'candidate'
  }
  db.run(
    `INSERT INTO research_evidence_spans
       (evidence_id, subquestion_id, snapshot_id, chunk_id, start_offset, end_offset, quote, span_sha256, validation_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [span.evidenceId, span.subquestionId, span.snapshotId, span.chunkId, span.startOffset, span.endOffset, span.quote, span.spanSha256, span.validationStatus]
  )
  return span
}

export function getEvidenceSpan(db: SqliteDb, evidenceId: string): EvidenceSpan | null {
  const row = db.get<EvidenceSpanRow>('SELECT * FROM research_evidence_spans WHERE evidence_id = ?', [evidenceId])
  return row ? toEvidenceSpan(row) : null
}

export function listEvidenceSpans(db: SqliteDb, subquestionId: string): EvidenceSpan[] {
  return db
    .all<EvidenceSpanRow>(
      'SELECT * FROM research_evidence_spans WHERE subquestion_id = ? ORDER BY rowid ASC',
      [subquestionId]
    )
    .map(toEvidenceSpan)
}

// ---------- 结论(Claim) ----------

export interface CreateClaimInput {
  subquestionId: string
  /** 未信载荷;内部经 parseClaimInput 校验 */
  claim: unknown
}

export function createClaim(db: SqliteDb, runId: string, input: CreateClaimInput): Claim {
  assertResearchRun(db, runId)
  const sub = assertSubQuestionInRun(db, runId, input.subquestionId)
  const parsed = parseClaimInput(input.claim)
  const claim: Claim = {
    claimId: randomUUID(),
    researchTaskId: sub.researchTaskId,
    subquestionId: sub.subquestionId,
    text: parsed.text,
    claimType: parsed.claim_type,
    subject: parsed.subject ?? null,
    qualifier: parsed.qualifier ?? null,
    supportStatus: 'candidate',
    conflictGroup: null,
    review: null
  }
  db.run(
    `INSERT INTO research_claims
       (claim_id, research_task_id, subquestion_id, text, claim_type, subject_json, qualifier_json,
        support_status, conflict_group, review_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      claim.claimId,
      claim.researchTaskId,
      claim.subquestionId,
      claim.text,
      claim.claimType,
      claim.subject === null ? null : JSON.stringify(claim.subject),
      claim.qualifier === null ? null : JSON.stringify(claim.qualifier),
      claim.supportStatus,
      claim.conflictGroup,
      claim.review === null ? null : JSON.stringify(claim.review)
    ]
  )
  return claim
}

export function getClaim(db: SqliteDb, claimId: string): Claim | null {
  const row = db.get<ClaimRow>('SELECT * FROM research_claims WHERE claim_id = ?', [claimId])
  return row ? toClaim(row) : null
}

export function listClaims(db: SqliteDb, researchTaskId: string): Claim[] {
  return db
    .all<ClaimRow>('SELECT * FROM research_claims WHERE research_task_id = ? ORDER BY rowid ASC', [researchTaskId])
    .map(toClaim)
}

// ---------- 引用 ----------

export function createCitation(db: SqliteDb, runId: string, raw: unknown): Citation {
  assertResearchRun(db, runId)
  const input = parseCitationInput(raw)

  // 引用闭包的运行归属:claim 与 evidence 都必须属于本 run(跨运行引用拒绝)
  const claim = getClaim(db, input.claim_id)
  if (!claim) {
    throw new OperationError(appError('TARGET_UNAVAILABLE', `Claim 不存在:${input.claim_id}`, { retryable: false }))
  }
  const claimTask = getResearchTask(db, claim.researchTaskId)
  if (!claimTask || claimTask.runId !== runId) {
    throw researchFailure('CONFLICT', 'MODE_MISMATCH', `Claim ${input.claim_id} 不属于运行 ${runId},拒绝跨运行引用`)
  }
  const evidence = getEvidenceSpan(db, input.evidence_id)
  if (!evidence) {
    throw new OperationError(appError('TARGET_UNAVAILABLE', `证据片段不存在:${input.evidence_id}`, { retryable: false }))
  }
  const evidenceSub = getSubQuestion(db, evidence.subquestionId)
  const evidenceTask = evidenceSub ? getResearchTask(db, evidenceSub.researchTaskId) : null
  if (!evidenceTask || evidenceTask.runId !== runId) {
    throw researchFailure('CONFLICT', 'MODE_MISMATCH', `证据 ${input.evidence_id} 不属于运行 ${runId},拒绝跨运行引用`)
  }

  const duplicate = db.get<{ citation_id: string }>(
    'SELECT citation_id FROM research_citations WHERE claim_id = ? AND evidence_id = ? AND relation = ?',
    [input.claim_id, input.evidence_id, input.relation]
  )
  if (duplicate) {
    throw new OperationError(
      appError('CONFLICT', `引用已存在:(claim, evidence, relation) = (${input.claim_id}, ${input.evidence_id}, ${input.relation})`, { retryable: false })
    )
  }

  const citation: Citation = {
    citationId: randomUUID(),
    claimId: input.claim_id,
    evidenceId: input.evidence_id,
    relation: input.relation,
    evidenceGroupId: input.evidence_group_id ?? null,
    groupOperator: input.group_operator ?? null
  }
  db.run(
    `INSERT INTO research_citations
       (citation_id, claim_id, evidence_id, relation, evidence_group_id, group_operator)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [citation.citationId, citation.claimId, citation.evidenceId, citation.relation, citation.evidenceGroupId, citation.groupOperator]
  )
  return citation
}

export function getCitation(db: SqliteDb, citationId: string): Citation | null {
  const row = db.get<CitationRow>('SELECT * FROM research_citations WHERE citation_id = ?', [citationId])
  return row ? toCitation(row) : null
}

export function listCitations(db: SqliteDb, claimId: string): Citation[] {
  return db
    .all<CitationRow>('SELECT * FROM research_citations WHERE claim_id = ? ORDER BY rowid ASC', [claimId])
    .map(toCitation)
}

// ---------- 报告 ----------

export interface CreateReportInput {
  version: number
  reportState: ReportState
  structured?: Record<string, unknown>
  markdown: string
}

export function createReport(db: SqliteDb, runId: string, input: CreateReportInput): Report {
  assertResearchRun(db, runId)
  const task = getResearchTaskByRun(db, runId)
  if (!task) throw new OperationError(appError('TARGET_UNAVAILABLE', `运行缺少研究任务:${runId}`, { retryable: false }))
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new OperationError(appError('VALIDATION', `报告版本必须是不小于 1 的整数,收到 ${String(input.version)}`, { retryable: false }))
  }
  if (typeof input.markdown !== 'string' || input.markdown === '') {
    throw new OperationError(appError('VALIDATION', '报告 markdown 不能为空', { retryable: false }))
  }
  const existing = db.get<{ report_id: string }>(
    'SELECT report_id FROM research_reports WHERE research_task_id = ? AND version = ?',
    [task.researchTaskId, input.version]
  )
  if (existing) {
    throw new OperationError(appError('CONFLICT', `报告版本已存在:version=${input.version}`, { retryable: false }))
  }
  const manifest = getSnapshotManifest(db, task.snapshotManifestId)
  const report: Report = {
    reportId: randomUUID(),
    researchTaskId: task.researchTaskId,
    version: input.version,
    reportState: input.reportState,
    structured: input.structured ?? null,
    markdown: input.markdown,
    reportSha256: sha256Hex(input.markdown),
    manifestSha256: manifest?.manifestSha256 ?? '',
    createdAt: systemClock.now().toISOString()
  }
  db.run(
    `INSERT INTO research_reports
       (report_id, research_task_id, version, report_state, structured_json, markdown, report_sha256, manifest_sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      report.reportId,
      report.researchTaskId,
      report.version,
      report.reportState,
      report.structured === null ? null : JSON.stringify(report.structured),
      report.markdown,
      report.reportSha256,
      report.manifestSha256,
      report.createdAt
    ]
  )
  return report
}

export function getReport(db: SqliteDb, researchTaskId: string, version: number): Report | null {
  const row = db.get<ReportRow>(
    'SELECT * FROM research_reports WHERE research_task_id = ? AND version = ?',
    [researchTaskId, version]
  )
  return row ? toReport(row) : null
}

/** 省略 version 时的报告读取:最大版本(REPORT_NOT_READY 由 API 层按 null 判定) */
export function latestReport(db: SqliteDb, researchTaskId: string): Report | null {
  const row = db.get<ReportRow>(
    'SELECT * FROM research_reports WHERE research_task_id = ? ORDER BY version DESC LIMIT 1',
    [researchTaskId]
  )
  return row ? toReport(row) : null
}

export function listReports(db: SqliteDb, researchTaskId: string): Report[] {
  return db
    .all<ReportRow>('SELECT * FROM research_reports WHERE research_task_id = ? ORDER BY version ASC', [researchTaskId])
    .map(toReport)
}
