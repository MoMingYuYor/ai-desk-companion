// Agent 运行、轨迹事件与审批的仓库层(C-03)。
//
// 设计要点:
// 1. seq 由本层分配(当前最大值 + 1),并校验连续性;(run_id, seq) 复合主键是库层兜底。
// 2. 状态转移经 stateMachine 校验,非法转移直接抛错,不写库。
// 3. 轨迹事件落库后才允许广播(调用方负责广播时机,本层只负责持久化)。

import type { SqliteDb } from '../db/connection'
import { uid } from '../db/dao'
import { nowTimestamp } from '../../shared/dateUtils'
import {
  isRunMode,
  isRunStatus,
  type Approval,
  type ApprovalDecision,
  type RunMode,
  type RunStatus,
  type TokenUsage,
  type TraceEvent,
  type TraceEventType
} from '../../shared/agent'
import { assertTransition } from '../agent/stateMachine'

export interface AgentRunRecord {
  runId: string
  mode: RunMode
  status: RunStatus
  input: string
  timezone: string
  /** 上下文时钟的固定时刻(UTC ISO 8601);运行时用注入时钟写入 */
  contextClock: string
  configVersion: string
  budgetJson: string
  resultRef: string | null
  errorCode: string | null
  startedAt: string
  finishedAt: string | null
}

interface RunRow {
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
}

function toRun(row: RunRow): AgentRunRecord {
  if (!isRunMode(row.mode)) throw new Error(`运行记录 mode 非法:${row.mode}`)
  if (!isRunStatus(row.status)) throw new Error(`运行记录 status 非法:${row.status}`)
  return {
    runId: row.run_id,
    mode: row.mode,
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

// ---------- 运行 ----------

export interface CreateRunInput {
  mode: RunMode
  input: string
  contextClock: string
  timezone?: string
  configVersion?: string
  budgetJson?: string
}

/** 创建运行:初始状态恒为 queued;runId 由本层生成 */
export function createRun(db: SqliteDb, input: CreateRunInput): AgentRunRecord {
  if (!isRunMode(input.mode)) throw new Error(`mode 非法:${String(input.mode)}`)
  if (input.input.trim() === '') throw new Error('运行输入不能为空')
  const record: AgentRunRecord = {
    runId: uid(),
    mode: input.mode,
    status: 'queued',
    input: input.input,
    timezone: input.timezone ?? 'Asia/Shanghai',
    contextClock: input.contextClock,
    configVersion: input.configVersion ?? '',
    budgetJson: input.budgetJson ?? '{}',
    resultRef: null,
    errorCode: null,
    startedAt: nowTimestamp(),
    finishedAt: null
  }
  db.run(
    `INSERT INTO agent_runs
       (run_id, mode, status, input, timezone, context_clock, config_version, budget_json,
        result_ref, error_code, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.runId,
      record.mode,
      record.status,
      record.input,
      record.timezone,
      record.contextClock,
      record.configVersion,
      record.budgetJson,
      record.resultRef,
      record.errorCode,
      record.startedAt,
      record.finishedAt
    ]
  )
  return record
}

export function getRun(db: SqliteDb, runId: string): AgentRunRecord | null {
  const row = db.get<RunRow>('SELECT * FROM agent_runs WHERE run_id = ?', [runId])
  return row ? toRun(row) : null
}

export interface UpdateRunPatch {
  resultRef?: string | null
  errorCode?: string | null
  budgetJson?: string
}

/**
 * 状态转移:先经状态机校验,再写库。
 * 进入终态时写入 finished_at;非终态不写(避免终态时间被后续 patch 覆盖)。
 */
export function transitionRun(
  db: SqliteDb,
  runId: string,
  to: RunStatus,
  patch: UpdateRunPatch = {}
): AgentRunRecord {
  const current = getRun(db, runId)
  if (!current) throw new Error(`运行不存在:${runId}`)
  assertTransition(current.status, to)
  const finishedAt = isTerminal(to) ? nowTimestamp() : null
  db.run(
    `UPDATE agent_runs
        SET status = ?,
            result_ref = COALESCE(?, result_ref),
            error_code = COALESCE(?, error_code),
            budget_json = COALESCE(?, budget_json),
            finished_at = COALESCE(?, finished_at)
      WHERE run_id = ?`,
    [
      to,
      patch.resultRef ?? null,
      patch.errorCode ?? null,
      patch.budgetJson ?? null,
      finishedAt,
      runId
    ]
  )
  const updated = getRun(db, runId)
  if (!updated) throw new Error(`运行更新后读取失败:${runId}`)
  return updated
}

function isTerminal(status: RunStatus): boolean {
  return status === 'succeeded' || status === 'partial' || status === 'failed' || status === 'cancelled'
}

export function listRunsByStatus(db: SqliteDb, status: RunStatus): AgentRunRecord[] {
  return db
    .all<RunRow>('SELECT * FROM agent_runs WHERE status = ? ORDER BY started_at ASC', [status])
    .map(toRun)
}

/** 按多个状态列出运行,按开始时间升序(队列判定"谁占用执行权"用) */
export function listRunsByStatuses(db: SqliteDb, statuses: readonly RunStatus[]): AgentRunRecord[] {
  if (statuses.length === 0) return []
  const placeholders = statuses.map(() => '?').join(', ')
  return db
    .all<RunRow>(
      `SELECT * FROM agent_runs WHERE status IN (${placeholders}) ORDER BY started_at ASC`,
      [...statuses]
    )
    .map(toRun)
}

// ---------- 轨迹事件 ----------

export interface AppendTraceInput {
  runId: string
  eventType: TraceEventType
  payload?: Record<string, unknown>
  durationMs?: number | null
  tokenUsage?: TokenUsage | null
}

/**
 * 追加轨迹事件:seq 取当前最大值 + 1,从 1 起连续。
 * 事件落库后才允许广播;调用方负责广播时机。
 */
export function appendTraceEvent(db: SqliteDb, input: AppendTraceInput): TraceEvent {
  const run = getRun(db, input.runId)
  if (!run) throw new Error(`运行不存在:${input.runId}`)
  const row = db.get<{ max_seq: number | null }>(
    'SELECT MAX(seq) AS max_seq FROM trace_events WHERE run_id = ?',
    [input.runId]
  )
  const seq = (row?.max_seq ?? 0) + 1
  const event: TraceEvent = {
    runId: input.runId,
    seq,
    eventType: input.eventType,
    schemaVersion: 1,
    payload: input.payload ?? {},
    durationMs: input.durationMs ?? null,
    tokenUsage: input.tokenUsage ?? null,
    createdAt: nowTimestamp()
  }
  db.run(
    `INSERT INTO trace_events
       (run_id, seq, event_type, schema_version, payload, duration_ms, token_usage, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.runId,
      event.seq,
      event.eventType,
      event.schemaVersion,
      JSON.stringify(event.payload),
      event.durationMs,
      event.tokenUsage === null ? null : JSON.stringify(event.tokenUsage),
      event.createdAt
    ]
  )
  return event
}

interface TraceRow {
  run_id: string
  seq: number
  event_type: string
  schema_version: number
  payload: string
  duration_ms: number | null
  token_usage: string | null
  created_at: string
}

function toTraceEvent(row: TraceRow): TraceEvent {
  return {
    runId: row.run_id,
    seq: row.seq,
    eventType: row.event_type as TraceEventType,
    schemaVersion: 1,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    durationMs: row.duration_ms,
    tokenUsage: row.token_usage === null ? null : (JSON.parse(row.token_usage) as TokenUsage),
    createdAt: row.created_at
  }
}

/** 读取轨迹事件;afterSeq 用于按 seq 补发缺失事件(严格大于该值) */
export function listTraceEvents(db: SqliteDb, runId: string, afterSeq = 0): TraceEvent[] {
  return db
    .all<TraceRow>(
      'SELECT * FROM trace_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC',
      [runId, afterSeq]
    )
    .map(toTraceEvent)
}

// ---------- 审批 ----------

export interface CreateApprovalInput {
  runId: string
  toolName: string
  argumentsHash: string
  planVersion: number
  targetVersion?: number | null
  /** 有效期(UTC ISO 8601);默认由调用方按 config 的 approvalTtlHours 计算 */
  expiresAt: string
}

export function createApproval(db: SqliteDb, input: CreateApprovalInput): Approval {
  const run = getRun(db, input.runId)
  if (!run) throw new Error(`运行不存在:${input.runId}`)
  if (!Number.isInteger(input.planVersion) || input.planVersion < 1) {
    throw new Error(`planVersion 必须是不小于 1 的整数,收到 ${String(input.planVersion)}`)
  }
  const approval: Approval = {
    approvalId: uid(),
    runId: input.runId,
    toolName: input.toolName,
    argumentsHash: input.argumentsHash,
    planVersion: input.planVersion,
    targetVersion: input.targetVersion ?? null,
    expiresAt: input.expiresAt,
    decision: 'pending',
    decidedAt: null
  }
  db.run(
    `INSERT INTO approvals
       (approval_id, run_id, tool_name, arguments_hash, plan_version, target_version,
        expires_at, decision, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      approval.approvalId,
      approval.runId,
      approval.toolName,
      approval.argumentsHash,
      approval.planVersion,
      approval.targetVersion,
      approval.expiresAt,
      approval.decision,
      approval.decidedAt
    ]
  )
  return approval
}

interface ApprovalRow {
  approval_id: string
  run_id: string
  tool_name: string
  arguments_hash: string
  plan_version: number
  target_version: number | null
  expires_at: string
  decision: string
  decided_at: string | null
}

function toApproval(row: ApprovalRow): Approval {
  return {
    approvalId: row.approval_id,
    runId: row.run_id,
    toolName: row.tool_name,
    argumentsHash: row.arguments_hash,
    planVersion: row.plan_version,
    targetVersion: row.target_version,
    expiresAt: row.expires_at,
    decision: row.decision as ApprovalDecision,
    decidedAt: row.decided_at
  }
}

export function getApproval(db: SqliteDb, approvalId: string): Approval | null {
  const row = db.get<ApprovalRow>('SELECT * FROM approvals WHERE approval_id = ?', [approvalId])
  return row ? toApproval(row) : null
}

export function listApprovals(db: SqliteDb, runId: string): Approval[] {
  return db
    .all<ApprovalRow>('SELECT * FROM approvals WHERE run_id = ? ORDER BY rowid ASC', [runId])
    .map(toApproval)
}

export function pendingApprovals(db: SqliteDb, runId: string): Approval[] {
  return listApprovals(db, runId).filter((a) => a.decision === 'pending')
}

/**
 * 记录审批决策。条件更新:只有仍为 pending 的记录才会被改写,
 * 因此同一审批的重复决策不会互相覆盖(与并发批准通过条件更新解决的约定一致)。
 * 返回是否本次生效。
 */
export function decideApproval(
  db: SqliteDb,
  approvalId: string,
  decision: Exclude<ApprovalDecision, 'pending'>,
  decidedAt: string = nowTimestamp()
): boolean {
  const before = getApproval(db, approvalId)
  if (!before) throw new Error(`审批记录不存在:${approvalId}`)
  db.run('UPDATE approvals SET decision = ?, decided_at = ? WHERE approval_id = ? AND decision = ?', [
    decision,
    decidedAt,
    approvalId,
    'pending'
  ])
  const after = getApproval(db, approvalId)
  return after?.decision === decision && before.decision === 'pending'
}

/** 过期待批准记录:仅改状态,不删除(保留审计痕迹) */
export function expireStaleApprovals(db: SqliteDb, now: string): number {
  const rows = db.all<{ approval_id: string }>(
    "SELECT approval_id FROM approvals WHERE decision = 'pending' AND expires_at <= ?",
    [now]
  )
  for (const row of rows) {
    db.run("UPDATE approvals SET decision = 'expired', decided_at = ? WHERE approval_id = ?", [
      now,
      row.approval_id
    ])
  }
  return rows.length
}
