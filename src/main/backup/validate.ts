// R1(Task 4):备份文件先验校验。按备份文件自身声明的 schemaVersion 校验当时必需的
// 业务表、列型、主键与引用;允许完整空库;不把旧版本 JSON 缺少新表判作坏文件;未来版本拒绝。
// 本模块保持纯函数(不触碰文件系统),文件读写与恢复流程在 services/backup.ts。
import { appError } from '../../shared/operations'
import { OperationError } from '../db/operations'
import { argumentsHash } from '../tools/schema'

/** 备份文件应用标识:导出与校验共用,防止拿错文件 */
export const BACKUP_APP_ID = 'ai-desk-companion'

export type BackupColumnType = 'text' | 'integer'

export interface BackupColumnSpec {
  name: string
  type: BackupColumnType
  /** true = 数据库允许 NULL;false = NOT NULL,备份行必须提供 */
  nullable: boolean
}

export interface BackupTableSpec {
  name: string
  columns: BackupColumnSpec[]
  /** 主键列(单列或复合),用于文件内唯一性校验 */
  primaryKey: string[]
}

export interface BackupReferenceSpec {
  table: string
  column: string
  targetTable: string
  targetColumn: string
  /** 引用列可空时,null 不算悬空引用 */
  nullable: boolean
}

export interface BackupVersionSpec {
  version: number
  /** 该版本备份文件必须出现的表(值可以是空数组) */
  requiredTables: readonly string[]
  tables: Readonly<Record<string, BackupTableSpec>>
  /** 文件内可安全校验的引用(只校验应用按构造保证一致的关系,见文末说明) */
  references: readonly BackupReferenceSpec[]
}

export interface ValidatedBackup {
  schemaVersion: number
  /** 规格化后的表数据:键为该版本规格内的全部表名(缺失的可选表补空数组) */
  tables: Record<string, Array<Record<string, unknown>>>
}

const t = (name: string, nullable = false): BackupColumnSpec => ({ name, type: 'text', nullable })
const i = (name: string, nullable = false): BackupColumnSpec => ({ name, type: 'integer', nullable })

// ---------- 各业务表规格(列序与 schema 一致,v4 在 v3 基础上追加 revision) ----------

const CONVERSATIONS: BackupColumnSpec[] = [
  t('id'), t('title'), t('kind'), t('status'), t('created_at'), t('updated_at')
]
const MESSAGES: BackupColumnSpec[] = [
  t('id'), t('conversation_id'), t('role'), t('content'),
  t('model_label', true), t('meta', true), t('created_at')
]
const MATERIALS: BackupColumnSpec[] = [
  t('id'), t('conversation_id'), t('name'), t('type'),
  t('mime', true), i('size', true), t('content', true), t('path', true), t('parse_error', true), t('created_at')
]
const ANALYSES: BackupColumnSpec[] = [
  t('id'), t('conversation_id'), i('version'), t('payload', true), t('raw_response', true),
  t('model_label', true), t('status'), t('error', true), t('created_at')
]
const EVENTS_V3: BackupColumnSpec[] = [
  t('id'), t('title'), t('start_at'), t('end_at'), i('all_day'),
  t('color', true), t('location', true), t('notes', true),
  t('source'), t('source_ref', true), i('reminder_minutes', true), t('status'), t('fingerprint', true),
  t('created_at'), t('updated_at')
]
const EVENTS_V4: BackupColumnSpec[] = [...EVENTS_V3.slice(0, 13), i('revision'), ...EVENTS_V3.slice(13)]
const TODOS_V3: BackupColumnSpec[] = [
  t('id'), t('title'), t('notes', true), t('due_at', true), t('priority'), t('completed_at', true),
  t('linked_event_id', true), t('source'), t('source_ref', true), t('fingerprint', true),
  t('created_at'), t('updated_at')
]
const TODOS_V4: BackupColumnSpec[] = [...TODOS_V3.slice(0, 10), i('revision'), ...TODOS_V3.slice(10)]
const PENDING_V3: BackupColumnSpec[] = [
  t('id'), t('conversation_id', true), t('title'), t('notes', true), t('status'),
  t('created_at'), t('updated_at')
]
const PENDING_V4: BackupColumnSpec[] = [...PENDING_V3.slice(0, 5), i('revision'), ...PENDING_V3.slice(5)]
const SEMESTERS: BackupColumnSpec[] = [
  t('id'), t('name'), t('start_date'), i('weeks'), t('created_at')
]
const COURSES: BackupColumnSpec[] = [
  t('id'), t('semester_id'), t('name'), i('weekday'), t('start_time'), t('end_time'), t('weeks'),
  t('location', true), t('teacher', true), t('created_at')
]
const COURSE_OVERRIDES: BackupColumnSpec[] = [
  t('id'), t('course_id'), t('date'), t('kind'),
  t('new_start_time', true), t('new_end_time', true), t('new_location', true), t('note', true), t('created_at')
]
const SCHOOL_EVENTS: BackupColumnSpec[] = [
  t('id'), t('semester_id', true), t('type'), t('title'), t('start_date'), t('end_date', true), t('note', true), t('created_at')
]
const PROFILE_FACTS: BackupColumnSpec[] = [
  t('id'), t('category'), t('key'), t('value'), t('source'), t('status'), t('created_at'), t('updated_at')
]
const MAIL_ANALYSIS_LINKS: BackupColumnSpec[] = [
  t('source_key'), t('message_id', true), t('conversation_id', true),
  t('snapshot'), t('last_material_ids'), t('status'), t('last_error', true)
]
const MAIL_ANALYSIS_VERSIONS: BackupColumnSpec[] = [
  t('analysis_id'), t('source_key'), t('material_ids')
]
const MAIL_CONFIRMATIONS: BackupColumnSpec[] = [
  t('analysis_id'), i('candidate_index'), t('source_key'), t('ref_type'), t('ref_id')
]
const OPERATION_RECEIPTS: BackupColumnSpec[] = [
  t('operation_id'), t('command'), t('request_hash'), t('result_ref'), t('created_at')
]
// v5(C-03):Agent 运行、轨迹与审批。三张表不引用业务实体,故不登记 references。
const AGENT_RUNS: BackupColumnSpec[] = [
  t('run_id'), t('mode'), t('status'), t('input'), t('timezone'), t('context_clock'),
  t('config_version'), t('budget_json'), t('result_ref', true), t('error_code', true),
  t('started_at'), t('finished_at', true)
]
const TRACE_EVENTS: BackupColumnSpec[] = [
  t('run_id'), i('seq'), t('event_type'), i('schema_version'), t('payload'),
  i('duration_ms', true), t('token_usage', true), t('created_at')
]
const APPROVALS: BackupColumnSpec[] = [
  t('approval_id'), t('run_id'), t('tool_name'), t('arguments_hash'), i('plan_version'),
  i('target_version', true), t('expires_at'), t('decision'), t('decided_at', true)
]
// v7(A-01/OPS-01):审批参数持久化列(v7 迁移添加;v5/v6 历史备份没有它)。
// 不向历史备份强加新必需列:缺失/null 的参数在恢复阶段按"参数不可恢复"处理。
const APPROVALS_V7: BackupColumnSpec[] = [...APPROVALS, t('arguments_json', true)]
// v6(C-05):检索文档与分块。FTS4 虚表是派生索引,不进备份;恢复后由 rebuild 重建。
const RETRIEVAL_DOCUMENTS: BackupColumnSpec[] = [
  t('document_id'), t('source_name'), t('source_type'), t('raw_sha256'), t('text_sha256'),
  t('normalized_text'), i('size_bytes'), t('created_at')
]
// v9(R-02):研究侧来源元数据与定位列(全部可空;v8 及更早备份没有它们)。
const RETRIEVAL_DOCUMENTS_V9: BackupColumnSpec[] = [
  ...RETRIEVAL_DOCUMENTS,
  t('source_identity', true), t('provenance_group_id', true), t('source_locator', true),
  t('source_metadata_json', true), t('collection_time_basis', true)
]
const RETRIEVAL_CHUNKS: BackupColumnSpec[] = [
  t('chunk_id'), t('document_id'), i('chunk_index'), i('start_offset'), i('end_offset'),
  t('content'), t('search_text'), i('search_version')
]
// v7(A-01):邮件草稿。无发送状态字段(设计边界:草稿不能被发送)。
const MAIL_DRAFTS: BackupColumnSpec[] = [
  t('draft_id'), t('recipients'), t('subject'), t('body'), t('source_ref', true),
  i('revision'), t('created_at'), t('updated_at')
]
// v8(R-01):研究领域表。清单条目与 JSON 列均为文本;研究实体时间列为 UTC ISO 8601。
const RESEARCH_SNAPSHOT_MANIFESTS: BackupColumnSpec[] = [
  t('manifest_id'), i('schema_version'), t('entries_json'), t('manifest_sha256'), t('created_at')
]
const RESEARCH_TASKS: BackupColumnSpec[] = [
  t('research_task_id'), t('run_id'), t('question'), t('constraints_json', true),
  t('snapshot_manifest_id'), t('budget_json'), t('phase'), t('config_json', true),
  t('parent_run_id', true), t('created_at')
]
const RESEARCH_SUBQUESTIONS: BackupColumnSpec[] = [
  t('subquestion_id'), t('research_task_id'), i('ordinal'), t('question'), t('query_json', true),
  t('status'), t('insufficiency_reason', true), t('outcome_json', true)
]
const RESEARCH_EVIDENCE_SPANS: BackupColumnSpec[] = [
  t('evidence_id'), t('subquestion_id'), t('snapshot_id'), t('chunk_id'),
  i('start_offset'), i('end_offset'), t('quote'), t('span_sha256'), t('validation_status')
]
const RESEARCH_CLAIMS: BackupColumnSpec[] = [
  t('claim_id'), t('research_task_id'), t('subquestion_id'), t('text'), t('claim_type'),
  t('subject_json', true), t('qualifier_json', true), t('support_status'),
  t('conflict_group', true), t('review_json', true)
]
const RESEARCH_CITATIONS: BackupColumnSpec[] = [
  t('citation_id'), t('claim_id'), t('evidence_id'), t('relation'),
  t('evidence_group_id', true), t('group_operator', true)
]
const RESEARCH_REPORTS: BackupColumnSpec[] = [
  t('report_id'), t('research_task_id'), i('version'), t('report_state'),
  t('structured_json', true), t('markdown'), t('report_sha256'), t('manifest_sha256'), t('created_at')
]

/** 备份写入/清除顺序:被依赖的表在前,回执最后(回执随其引用的业务实体一起替换) */
export const BACKUP_TABLE_ORDER = [
  'conversations', 'messages', 'materials', 'analyses',
  'events', 'todos', 'pending_items',
  'semesters', 'courses', 'course_overrides', 'school_events',
  'profile_facts',
  'mail_analysis_links', 'mail_analysis_versions', 'mail_confirmations',
  'operation_receipts',
  'agent_runs', 'trace_events', 'approvals',
  'retrieval_documents', 'retrieval_chunks',
  'mail_drafts',
  // v8(R-01):研究表。依赖顺序:清单/任务在前,子问题/证据/结论/引用/报告在后
  'research_snapshot_manifests', 'research_tasks', 'research_subquestions',
  'research_evidence_spans', 'research_claims', 'research_citations', 'research_reports'
] as const

const BUSINESS_REFERENCES: BackupReferenceSpec[] = [
  { table: 'messages', column: 'conversation_id', targetTable: 'conversations', targetColumn: 'id', nullable: false },
  { table: 'materials', column: 'conversation_id', targetTable: 'conversations', targetColumn: 'id', nullable: false },
  { table: 'analyses', column: 'conversation_id', targetTable: 'conversations', targetColumn: 'id', nullable: false },
  { table: 'courses', column: 'semester_id', targetTable: 'semesters', targetColumn: 'id', nullable: false },
  { table: 'course_overrides', column: 'course_id', targetTable: 'courses', targetColumn: 'id', nullable: false },
  { table: 'school_events', column: 'semester_id', targetTable: 'semesters', targetColumn: 'id', nullable: true }
]

/** 复合或非 id 主键的表:其余表默认单列 id 主键 */
const PRIMARY_KEY_OVERRIDES: Readonly<Record<string, readonly string[]>> = {
  mail_confirmations: ['analysis_id', 'candidate_index'],
  agent_runs: ['run_id'],
  trace_events: ['run_id', 'seq'],
  approvals: ['approval_id'],
  retrieval_documents: ['document_id'],
  retrieval_chunks: ['chunk_id'],
  mail_drafts: ['draft_id'],
  research_snapshot_manifests: ['manifest_id'],
  research_tasks: ['research_task_id'],
  research_subquestions: ['subquestion_id'],
  research_evidence_spans: ['evidence_id'],
  research_claims: ['claim_id'],
  research_citations: ['citation_id'],
  research_reports: ['report_id']
}

function buildTables(columns: Array<[string, BackupColumnSpec[]]>, pkColumn = 'id'): Record<string, BackupTableSpec> {
  const out: Record<string, BackupTableSpec> = {}
  for (const [name, cols] of columns) {
    out[name] = {
      name,
      columns: cols,
      primaryKey: [...(PRIMARY_KEY_OVERRIDES[name] ?? [pkColumn])]
    }
  }
  return out
}

const V3_TABLES = buildTables([
  ['conversations', CONVERSATIONS], ['messages', MESSAGES], ['materials', MATERIALS],
  ['analyses', ANALYSES], ['events', EVENTS_V3], ['todos', TODOS_V3], ['pending_items', PENDING_V3],
  ['semesters', SEMESTERS], ['courses', COURSES], ['course_overrides', COURSE_OVERRIDES],
  ['school_events', SCHOOL_EVENTS], ['profile_facts', PROFILE_FACTS],
  ['mail_analysis_links', MAIL_ANALYSIS_LINKS], ['mail_analysis_versions', MAIL_ANALYSIS_VERSIONS],
  ['mail_confirmations', MAIL_CONFIRMATIONS]
])

const V4_TABLES = buildTables([
  ['conversations', CONVERSATIONS], ['messages', MESSAGES], ['materials', MATERIALS],
  ['analyses', ANALYSES], ['events', EVENTS_V4], ['todos', TODOS_V4], ['pending_items', PENDING_V4],
  ['semesters', SEMESTERS], ['courses', COURSES], ['course_overrides', COURSE_OVERRIDES],
  ['school_events', SCHOOL_EVENTS], ['profile_facts', PROFILE_FACTS],
  ['mail_analysis_links', MAIL_ANALYSIS_LINKS], ['mail_analysis_versions', MAIL_ANALYSIS_VERSIONS],
  ['mail_confirmations', MAIL_CONFIRMATIONS], ['operation_receipts', OPERATION_RECEIPTS]
])

const V5_TABLES = buildTables([
  ['conversations', CONVERSATIONS], ['messages', MESSAGES], ['materials', MATERIALS],
  ['analyses', ANALYSES], ['events', EVENTS_V4], ['todos', TODOS_V4], ['pending_items', PENDING_V4],
  ['semesters', SEMESTERS], ['courses', COURSES], ['course_overrides', COURSE_OVERRIDES],
  ['school_events', SCHOOL_EVENTS], ['profile_facts', PROFILE_FACTS],
  ['mail_analysis_links', MAIL_ANALYSIS_LINKS], ['mail_analysis_versions', MAIL_ANALYSIS_VERSIONS],
  ['mail_confirmations', MAIL_CONFIRMATIONS], ['operation_receipts', OPERATION_RECEIPTS],
  ['agent_runs', AGENT_RUNS], ['trace_events', TRACE_EVENTS], ['approvals', APPROVALS]
])

const V6_TABLES = buildTables([
  ['conversations', CONVERSATIONS], ['messages', MESSAGES], ['materials', MATERIALS],
  ['analyses', ANALYSES], ['events', EVENTS_V4], ['todos', TODOS_V4], ['pending_items', PENDING_V4],
  ['semesters', SEMESTERS], ['courses', COURSES], ['course_overrides', COURSE_OVERRIDES],
  ['school_events', SCHOOL_EVENTS], ['profile_facts', PROFILE_FACTS],
  ['mail_analysis_links', MAIL_ANALYSIS_LINKS], ['mail_analysis_versions', MAIL_ANALYSIS_VERSIONS],
  ['mail_confirmations', MAIL_CONFIRMATIONS], ['operation_receipts', OPERATION_RECEIPTS],
  ['agent_runs', AGENT_RUNS], ['trace_events', TRACE_EVENTS], ['approvals', APPROVALS],
  ['retrieval_documents', RETRIEVAL_DOCUMENTS], ['retrieval_chunks', RETRIEVAL_CHUNKS]
])

/** v6 追加分块对文档的引用;低版本规格没有检索表,共用会因缺表定义崩溃 */
const V6_REFERENCES: BackupReferenceSpec[] = [
  ...BUSINESS_REFERENCES,
  { table: 'retrieval_chunks', column: 'document_id', targetTable: 'retrieval_documents', targetColumn: 'document_id', nullable: false }
]

const V7_TABLES = buildTables([
  ['conversations', CONVERSATIONS], ['messages', MESSAGES], ['materials', MATERIALS],
  ['analyses', ANALYSES], ['events', EVENTS_V4], ['todos', TODOS_V4], ['pending_items', PENDING_V4],
  ['semesters', SEMESTERS], ['courses', COURSES], ['course_overrides', COURSE_OVERRIDES],
  ['school_events', SCHOOL_EVENTS], ['profile_facts', PROFILE_FACTS],
  ['mail_analysis_links', MAIL_ANALYSIS_LINKS], ['mail_analysis_versions', MAIL_ANALYSIS_VERSIONS],
  ['mail_confirmations', MAIL_CONFIRMATIONS], ['operation_receipts', OPERATION_RECEIPTS],
  ['agent_runs', AGENT_RUNS], ['trace_events', TRACE_EVENTS], ['approvals', APPROVALS_V7],
  ['retrieval_documents', RETRIEVAL_DOCUMENTS], ['retrieval_chunks', RETRIEVAL_CHUNKS],
  ['mail_drafts', MAIL_DRAFTS]
])

const V8_TABLES = buildTables([
  ['conversations', CONVERSATIONS], ['messages', MESSAGES], ['materials', MATERIALS],
  ['events', EVENTS_V4], ['todos', TODOS_V4], ['pending_items', PENDING_V4],
  ['semesters', SEMESTERS], ['courses', COURSES], ['course_overrides', COURSE_OVERRIDES],
  ['school_events', SCHOOL_EVENTS], ['profile_facts', PROFILE_FACTS],
  ['mail_analysis_links', MAIL_ANALYSIS_LINKS], ['mail_analysis_versions', MAIL_ANALYSIS_VERSIONS],
  ['mail_confirmations', MAIL_CONFIRMATIONS], ['operation_receipts', OPERATION_RECEIPTS],
  ['agent_runs', AGENT_RUNS], ['trace_events', TRACE_EVENTS], ['approvals', APPROVALS_V7],
  ['retrieval_documents', RETRIEVAL_DOCUMENTS], ['retrieval_chunks', RETRIEVAL_CHUNKS],
  ['mail_drafts', MAIL_DRAFTS],
  ['research_snapshot_manifests', RESEARCH_SNAPSHOT_MANIFESTS], ['research_tasks', RESEARCH_TASKS],
  ['research_subquestions', RESEARCH_SUBQUESTIONS], ['research_evidence_spans', RESEARCH_EVIDENCE_SPANS],
  ['research_claims', RESEARCH_CLAIMS], ['research_citations', RESEARCH_CITATIONS],
  ['research_reports', RESEARCH_REPORTS]
])

/** v9(R-02):研究侧来源列追加到检索文档表;其余表与 v8 相同 */
const V9_TABLES = buildTables([
  ['conversations', CONVERSATIONS], ['messages', MESSAGES], ['materials', MATERIALS],
  ['analyses', ANALYSES], ['events', EVENTS_V4], ['todos', TODOS_V4], ['pending_items', PENDING_V4],
  ['semesters', SEMESTERS], ['courses', COURSES], ['course_overrides', COURSE_OVERRIDES],
  ['school_events', SCHOOL_EVENTS], ['profile_facts', PROFILE_FACTS],
  ['mail_analysis_links', MAIL_ANALYSIS_LINKS], ['mail_analysis_versions', MAIL_ANALYSIS_VERSIONS],
  ['mail_confirmations', MAIL_CONFIRMATIONS], ['operation_receipts', OPERATION_RECEIPTS],
  ['agent_runs', AGENT_RUNS], ['trace_events', TRACE_EVENTS], ['approvals', APPROVALS_V7],
  ['retrieval_documents', RETRIEVAL_DOCUMENTS_V9], ['retrieval_chunks', RETRIEVAL_CHUNKS],
  ['mail_drafts', MAIL_DRAFTS],
  ['research_snapshot_manifests', RESEARCH_SNAPSHOT_MANIFESTS], ['research_tasks', RESEARCH_TASKS],
  ['research_subquestions', RESEARCH_SUBQUESTIONS], ['research_evidence_spans', RESEARCH_EVIDENCE_SPANS],
  ['research_claims', RESEARCH_CLAIMS], ['research_citations', RESEARCH_CITATIONS],
  ['research_reports', RESEARCH_REPORTS]
])

/** v8 追加研究表的文件内引用;运行归属经 agent_runs,子问题经 research_tasks 间接归属 */
const V8_REFERENCES: BackupReferenceSpec[] = [
  ...V6_REFERENCES,
  { table: 'research_tasks', column: 'run_id', targetTable: 'agent_runs', targetColumn: 'run_id', nullable: false },
  { table: 'research_tasks', column: 'snapshot_manifest_id', targetTable: 'research_snapshot_manifests', targetColumn: 'manifest_id', nullable: false },
  { table: 'research_subquestions', column: 'research_task_id', targetTable: 'research_tasks', targetColumn: 'research_task_id', nullable: false },
  { table: 'research_evidence_spans', column: 'subquestion_id', targetTable: 'research_subquestions', targetColumn: 'subquestion_id', nullable: false },
  { table: 'research_evidence_spans', column: 'snapshot_id', targetTable: 'retrieval_documents', targetColumn: 'document_id', nullable: false },
  { table: 'research_evidence_spans', column: 'chunk_id', targetTable: 'retrieval_chunks', targetColumn: 'chunk_id', nullable: false },
  { table: 'research_claims', column: 'research_task_id', targetTable: 'research_tasks', targetColumn: 'research_task_id', nullable: false },
  { table: 'research_claims', column: 'subquestion_id', targetTable: 'research_subquestions', targetColumn: 'subquestion_id', nullable: false },
  { table: 'research_citations', column: 'claim_id', targetTable: 'research_claims', targetColumn: 'claim_id', nullable: false },
  { table: 'research_citations', column: 'evidence_id', targetTable: 'research_evidence_spans', targetColumn: 'evidence_id', nullable: false },
  { table: 'research_reports', column: 'research_task_id', targetTable: 'research_tasks', targetColumn: 'research_task_id', nullable: false }
]

const VERSION_SPECS: Readonly<Record<number, BackupVersionSpec>> = {
  3: { version: 3, requiredTables: Object.keys(V3_TABLES), tables: V3_TABLES, references: BUSINESS_REFERENCES },
  4: { version: 4, requiredTables: Object.keys(V4_TABLES), tables: V4_TABLES, references: BUSINESS_REFERENCES },
  5: { version: 5, requiredTables: Object.keys(V5_TABLES), tables: V5_TABLES, references: BUSINESS_REFERENCES },
  6: { version: 6, requiredTables: Object.keys(V6_TABLES), tables: V6_TABLES, references: V6_REFERENCES },
  7: { version: 7, requiredTables: Object.keys(V7_TABLES), tables: V7_TABLES, references: V6_REFERENCES },
  8: { version: 8, requiredTables: Object.keys(V8_TABLES), tables: V8_TABLES, references: V8_REFERENCES },
  9: { version: 9, requiredTables: Object.keys(V9_TABLES), tables: V9_TABLES, references: V8_REFERENCES }
}

/** 取指定备份版本的规格;未登记版本(未来/未知)拒绝 */
export function getBackupVersionSpec(version: number): BackupVersionSpec {
  const spec = VERSION_SPECS[version]
  if (!spec) {
    throw new OperationError(appError('BACKUP_INVALID', `不支持的备份版本:${version}`, { retryable: false }))
  }
  return spec
}

function invalid(message: string): OperationError {
  return new OperationError(appError('BACKUP_INVALID', `无效的备份文件:${message}`, { retryable: false }))
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 主键唯一键:把主键列值规范化后拼接 */
function primaryKeyValue(table: BackupTableSpec, row: Record<string, unknown>): string {
  return JSON.stringify(table.primaryKey.map((c) => {
    const v = row[c]
    if (typeof v === 'boolean') return v ? 1 : 0
    return v === undefined ? null : v
  }))
}

function validateRows(table: BackupTableSpec, rows: unknown[]): Array<Record<string, unknown>> {
  const seen = new Set<string>()
  return rows.map((row, index) => {
    if (!isPlainObject(row)) throw invalid(`表 ${table.name} 第 ${index} 行不是对象`)
    for (const col of table.columns) {
      const v = row[col.name]
      if (v === undefined || v === null) {
        if (!col.nullable) throw invalid(`表 ${table.name} 第 ${index} 行缺少必需列 ${col.name}`)
        continue
      }
      if (col.type === 'text') {
        if (typeof v !== 'string') throw invalid(`表 ${table.name} 第 ${index} 行列 ${col.name} 应为文本`)
      } else {
        // INTEGER 列允许 JSON 布尔(按 0/1 落库);不允许非整数数值
        if (typeof v === 'boolean') continue
        if (typeof v !== 'number' || !Number.isInteger(v)) {
          throw invalid(`表 ${table.name} 第 ${index} 行列 ${col.name} 应为整数`)
        }
        // revision 不变量:初始为 1,每次成功业务更新递增
        if (col.name === 'revision' && v < 1) throw invalid(`表 ${table.name} 第 ${index} 行 revision 必须为正整数`)
      }
    }
    const key = primaryKeyValue(table, row)
    if (seen.has(key)) throw invalid(`表 ${table.name} 存在重复主键(第 ${index} 行)`)
    seen.add(key)
    return row
  })
}

/**
 * 校验备份文件结构:
 * 1) 根对象 + 应用标识 + 整数 schemaVersion,且必须落在 supportedVersions 内(未来版本不降级导入);
 * 2) tables 必须是对象;版本规格内的每个表值必须是数组,逐行按列型/可空/主键校验;
 *    规格外(未来)表键忽略,不把旧 JSON 缺少新表判作坏文件;
 * 3) 该版本必需业务表必须齐全(允许全空)——旧版本文件按其自身版本要求的表集合校验;
 * 4) 文件内引用校验:只校验应用按构造保证一致的关系(级联删除覆盖),
 *    运行时容忍悬空的关系(如 pending_items.conversation_id、todos.linked_event_id、
 *    邮件分析映射对已删除会话/分析的引用)不做拒绝,导入后由既有查询逻辑自然降级。
 */
export function validateBackup(raw: unknown, supportedVersions: readonly number[]): ValidatedBackup {
  if (!isPlainObject(raw)) throw invalid('根节点必须是对象')
  if (raw.app !== BACKUP_APP_ID) throw invalid('应用标识不符')
  const schemaVersion = raw.schemaVersion
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    throw invalid('缺少有效的 schemaVersion')
  }
  if (!supportedVersions.includes(schemaVersion)) {
    throw invalid(`备份版本 ${schemaVersion} 不受支持(支持:${supportedVersions.join(' / ')});未来版本不降级导入`)
  }
  const spec = getBackupVersionSpec(schemaVersion)

  const tablesRaw = raw.tables
  if (!isPlainObject(tablesRaw)) throw invalid('缺少 tables 结构')

  const tables: Record<string, Array<Record<string, unknown>>> = {}
  for (const [name, value] of Object.entries(tablesRaw)) {
    const tableSpec = spec.tables[name]
    if (!tableSpec) continue // 规格外表键:忽略,不判为坏文件
    if (!Array.isArray(value)) throw invalid(`表 ${name} 的内容必须是数组`)
    tables[name] = validateRows(tableSpec, value)
  }
  for (const required of spec.requiredTables) {
    if (!(required in tablesRaw)) throw invalid(`缺少必需的业务表 ${required}`)
    if (!tables[required]) tables[required] = []
  }
  // 规格内该版本未出现的表(旧版本文件没有新表)补空数组:
  // 输出统一为全量表清单,替换流程按同一份清单清空/写入
  for (const tableName of BACKUP_TABLE_ORDER) {
    if (!tables[tableName]) tables[tableName] = []
  }

  checkReferences(spec, tables)
  validateApprovalParams(schemaVersion, tables['approvals'] ?? [])
  return { schemaVersion, tables }
}

/**
 * OPS-01:v7 起审批行携带冻结参数(arguments_json)——
 * 非空参数必须是 JSON 对象,并与行内 tool_name 及 arguments_hash 对应
 * (hash = sha256(stableStringify({tool, arguments})),与网关 propose 一致)。
 * 缺失或 null 不算坏文件:恢复阶段把未执行的待批/已批审批置 expired。
 */
function validateApprovalParams(schemaVersion: number, rows: ReadonlyArray<Record<string, unknown>>): void {
  if (schemaVersion < 7) return
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    const raw = row['arguments_json']
    if (raw === undefined || raw === null) continue
    if (typeof raw !== 'string') throw invalid(`表 approvals 第 ${index} 行 arguments_json 应为文本`)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw invalid(`表 approvals 第 ${index} 行 arguments_json 不是有效 JSON`)
    }
    if (!isPlainObject(parsed)) {
      throw invalid(`表 approvals 第 ${index} 行 arguments_json 必须是 JSON 对象`)
    }
    const recomputed = argumentsHash({ tool: row['tool_name'], arguments: parsed })
    if (recomputed !== row['arguments_hash']) {
      throw invalid(`表 approvals 第 ${index} 行 arguments_json 与 tool_name/arguments_hash 不对应`)
    }
  }
}

function checkReferences(spec: BackupVersionSpec, tables: ValidatedBackup['tables']): void {
  const targetIds = new Map<string, Set<unknown>>()
  for (const ref of spec.references) {
    let ids = targetIds.get(ref.targetTable)
    if (!ids) {
      const targetTable = spec.tables[ref.targetTable]
      const targetRows = tables[ref.targetTable] ?? []
      ids = new Set(targetRows.map((row) => row[targetTable.primaryKey[0]]))
      targetIds.set(ref.targetTable, ids)
    }
    const rows = tables[ref.table] ?? []
    for (let index = 0; index < rows.length; index += 1) {
      const v = rows[index][ref.column]
      if (v === undefined || v === null) {
        if (!ref.nullable) continue // 非空引用列的缺失已在行校验报错
        continue
      }
      if (!ids.has(v)) throw invalid(`表 ${ref.table} 第 ${index} 行引用了不存在的 ${ref.targetTable}.${ref.targetColumn}`)
    }
  }
}
