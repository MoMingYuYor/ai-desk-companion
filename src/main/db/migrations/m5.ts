import type { SqliteDb } from '../connection'

// M5(R-01):研究领域表(7 张)。
//
// 与既有共享表的所有权关系(研究模块规格第 2/5 节):
// - 公共运行状态不复制:research_tasks.run_id 唯一外键指向 agent_runs(m2),
//   状态、错误码、预算消耗以 AgentRun 为准;
// - SourceSnapshot/DocumentChunk 即既有 retrieval_documents/retrieval_chunks(m3),
//   研究表对它们建外键,绝不新建重复的文档表;
// - evidence span 的 offset 是规范化全文的码点坐标(零起点、左闭右开),
//   库层 CHECK 保证 0 ≤ start < end;与快照文本长度/内容的一致性由仓库层与引用检查负责。
//
// 契约落在库层:状态/类型/关系枚举列带 CHECK(与 m2 同一取舍);
// report 版本唯一 (research_task_id, version);citation 唯一 (claim_id, evidence_id, relation);
// 每任务子问题 ordinal 唯一且最多 3 条。
//
// 外键依赖连接层 PRAGMA foreign_keys=ON(dao.initSchema 在事务外开启)。
// 新表建外键与 m2/m3 的"应用层维护引用"是并存的两段历史:m2/m3 先于本迁移发布,
// 其 DDL 不回改;备份恢复按 BACKUP_TABLE_ORDER 的先父后子顺序写入,与外键兼容。

export const RESEARCH_SNAPSHOT_MANIFESTS_SQL = `
CREATE TABLE IF NOT EXISTS research_snapshot_manifests (
  manifest_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  entries_json TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`

export const RESEARCH_TASKS_SQL = `
CREATE TABLE IF NOT EXISTS research_tasks (
  research_task_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  question TEXT NOT NULL CHECK (length(question) >= 1),
  constraints_json TEXT,
  snapshot_manifest_id TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN (
    'queued', 'planning', 'awaiting_input', 'awaiting_confirmation',
    'executing', 'succeeded', 'partial', 'failed', 'cancelled'
  )),
  config_json TEXT,
  parent_run_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES agent_runs (run_id),
  FOREIGN KEY (snapshot_manifest_id) REFERENCES research_snapshot_manifests (manifest_id)
);
`

export const RESEARCH_SUBQUESTIONS_SQL = `
CREATE TABLE IF NOT EXISTS research_subquestions (
  subquestion_id TEXT PRIMARY KEY,
  research_task_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 3),
  question TEXT NOT NULL,
  query_json TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'running', 'answered', 'insufficient', 'conflicted', 'skipped'
  )),
  insufficiency_reason TEXT,
  outcome_json TEXT,
  UNIQUE (research_task_id, ordinal),
  FOREIGN KEY (research_task_id) REFERENCES research_tasks (research_task_id)
);
CREATE INDEX IF NOT EXISTS idx_research_subquestions_task
  ON research_subquestions (research_task_id, ordinal);
`

export const RESEARCH_EVIDENCE_SPANS_SQL = `
CREATE TABLE IF NOT EXISTS research_evidence_spans (
  evidence_id TEXT PRIMARY KEY,
  subquestion_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
  quote TEXT NOT NULL,
  span_sha256 TEXT NOT NULL,
  validation_status TEXT NOT NULL CHECK (validation_status IN ('candidate', 'valid', 'invalid')),
  FOREIGN KEY (subquestion_id) REFERENCES research_subquestions (subquestion_id),
  FOREIGN KEY (snapshot_id) REFERENCES retrieval_documents (document_id),
  FOREIGN KEY (chunk_id) REFERENCES retrieval_chunks (chunk_id)
);
CREATE INDEX IF NOT EXISTS idx_research_evidence_spans_sub
  ON research_evidence_spans (subquestion_id);
`

export const RESEARCH_CLAIMS_SQL = `
CREATE TABLE IF NOT EXISTS research_claims (
  claim_id TEXT PRIMARY KEY,
  research_task_id TEXT NOT NULL,
  subquestion_id TEXT NOT NULL,
  text TEXT NOT NULL,
  claim_type TEXT NOT NULL CHECK (claim_type IN ('fact', 'comparison', 'recommendation')),
  subject_json TEXT,
  qualifier_json TEXT,
  support_status TEXT NOT NULL CHECK (support_status IN (
    'candidate', 'supported', 'unsupported', 'uncertain'
  )),
  conflict_group TEXT,
  review_json TEXT,
  FOREIGN KEY (research_task_id) REFERENCES research_tasks (research_task_id),
  FOREIGN KEY (subquestion_id) REFERENCES research_subquestions (subquestion_id)
);
CREATE INDEX IF NOT EXISTS idx_research_claims_task
  ON research_claims (research_task_id);
`

export const RESEARCH_CITATIONS_SQL = `
CREATE TABLE IF NOT EXISTS research_citations (
  citation_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('supports', 'contradicts', 'context')),
  evidence_group_id TEXT,
  group_operator TEXT CHECK (group_operator IS NULL OR group_operator = 'all_of'),
  UNIQUE (claim_id, evidence_id, relation),
  FOREIGN KEY (claim_id) REFERENCES research_claims (claim_id),
  FOREIGN KEY (evidence_id) REFERENCES research_evidence_spans (evidence_id)
);
CREATE INDEX IF NOT EXISTS idx_research_citations_claim
  ON research_citations (claim_id);
`

export const RESEARCH_REPORTS_SQL = `
CREATE TABLE IF NOT EXISTS research_reports (
  report_id TEXT PRIMARY KEY,
  research_task_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  report_state TEXT NOT NULL CHECK (report_state IN ('draft', 'final', 'partial')),
  structured_json TEXT,
  markdown TEXT NOT NULL,
  report_sha256 TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (research_task_id, version),
  FOREIGN KEY (research_task_id) REFERENCES research_tasks (research_task_id)
);
`

/** v7 → v8:研究领域表。建表顺序即外键依赖顺序(清单 → 任务 → 子问题 → 证据 → 结论 → 引用 → 报告) */
export function migrateM5(db: SqliteDb): void {
  db.run(RESEARCH_SNAPSHOT_MANIFESTS_SQL)
  db.run(RESEARCH_TASKS_SQL)
  db.run(RESEARCH_SUBQUESTIONS_SQL)
  db.run(RESEARCH_EVIDENCE_SPANS_SQL)
  db.run(RESEARCH_CLAIMS_SQL)
  db.run(RESEARCH_CITATIONS_SQL)
  db.run(RESEARCH_REPORTS_SQL)
}

/** 回滚 v8:先删引用方(citations/claims/spans/subquestions/reports),再删任务与清单 */
export function rollbackM5(db: SqliteDb): void {
  db.run('DROP TABLE IF EXISTS research_citations')
  db.run('DROP TABLE IF EXISTS research_claims')
  db.run('DROP TABLE IF EXISTS research_evidence_spans')
  db.run('DROP TABLE IF EXISTS research_subquestions')
  db.run('DROP TABLE IF EXISTS research_reports')
  db.run('DROP TABLE IF EXISTS research_tasks')
  db.run('DROP TABLE IF EXISTS research_snapshot_manifests')
}
