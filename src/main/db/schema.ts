// v4(M1 写入基础):实体 revision、操作回执。
// v5(C-03):Agent 运行、轨迹事件与审批记录。
// v6(C-05):检索文档、分块与 FTS4 索引。
// v7(A-01/A-04):邮件草稿表;审批记录补参数持久化列。
// v8(R-01):研究领域表(任务、子问题、证据、结论、引用、报告、快照清单)。
// v9(R-02):检索文档表补研究侧来源元数据与定位列(source_identity/provenance_group_id 等)。
// 版本号由集成负责人按合入顺序唯一分配;迁移路径见 src/main/db/migrations/registry.ts。
import { AGENT_RUNS_SQL, APPROVALS_SQL, TRACE_EVENTS_SQL } from './migrations/m2'
import {
  RETRIEVAL_CHUNKS_SQL,
  RETRIEVAL_DOCUMENTS_SQL,
  RETRIEVAL_FTS_SQL
} from './migrations/m3'
import { MAIL_DRAFTS_SQL } from './migrations/m4'
import {
  RESEARCH_CLAIMS_SQL,
  RESEARCH_CITATIONS_SQL,
  RESEARCH_EVIDENCE_SPANS_SQL,
  RESEARCH_REPORTS_SQL,
  RESEARCH_SNAPSHOT_MANIFESTS_SQL,
  RESEARCH_SUBQUESTIONS_SQL,
  RESEARCH_TASKS_SQL
} from './migrations/m5'
import { RESEARCH_SOURCE_COLUMNS_SQL } from './migrations/m6'

export const SCHEMA_VERSION = 9

const BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT '',
  api_key_enc TEXT NOT NULL DEFAULT '',
  protocol TEXT NOT NULL DEFAULT 'chat-completions',
  models TEXT NOT NULL DEFAULT '[]',
  default_model TEXT NOT NULL DEFAULT '',
  supports_vision INTEGER NOT NULL DEFAULT 1,
  supports_json_mode INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model_label TEXT,
  meta TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  content TEXT,
  path TEXT,
  parse_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_materials_conv ON materials (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload TEXT,
  raw_response TEXT,
  model_label TEXT,
  status TEXT NOT NULL DEFAULT 'done',
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analyses_conv ON analyses (conversation_id, version);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  location TEXT,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  reminder_minutes INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  fingerprint TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events (start_at);

CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT,
  due_at TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  completed_at TEXT,
  linked_event_id TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  fingerprint TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_items (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  title TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS semesters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  weeks INTEGER NOT NULL DEFAULT 20,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  semester_id TEXT NOT NULL,
  name TEXT NOT NULL,
  weekday INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  weeks TEXT NOT NULL DEFAULT '[]',
  location TEXT,
  teacher TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_courses_sem ON courses (semester_id, weekday);

CREATE TABLE IF NOT EXISTS course_overrides (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  new_start_time TEXT,
  new_end_time TEXT,
  new_location TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS school_events (
  id TEXT PRIMARY KEY,
  semester_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_facts (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'explicit',
  status TEXT NOT NULL DEFAULT 'confirmed',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fired_reminders (
  key TEXT PRIMARY KEY,
  fired_at TEXT NOT NULL
);

-- v4(M1):操作回执。只保存摘要与可恢复结果引用,不存请求全文或凭据;
-- 回执与业务数据在同一事务内写入(runOperation 是唯一事务拥有者)。
CREATE TABLE IF NOT EXISTS operation_receipts (
  operation_id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_ref TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`

// v6(C-05):检索文档、分块与 FTS4 外部内容索引。
// v7(A-01):邮件草稿表(approvals.arguments_json 的追加由 m4 对旧库执行)。
// v8(R-01):研究领域表。
// v9(R-02):检索文档表的研究侧来源列(与迁移共用同一 ALTER 定义,避免两处漂移)。
// DDL 与迁移共用同一份定义,避免"当前库形状"与"迁移脚本"两处漂移。
export const SCHEMA_SQL =
  BASE_SCHEMA_SQL + AGENT_RUNS_SQL + TRACE_EVENTS_SQL + APPROVALS_SQL +
  RETRIEVAL_DOCUMENTS_SQL + RETRIEVAL_CHUNKS_SQL + RETRIEVAL_FTS_SQL +
  MAIL_DRAFTS_SQL +
  RESEARCH_SNAPSHOT_MANIFESTS_SQL + RESEARCH_TASKS_SQL + RESEARCH_SUBQUESTIONS_SQL +
  RESEARCH_EVIDENCE_SPANS_SQL + RESEARCH_CLAIMS_SQL + RESEARCH_CITATIONS_SQL +
  RESEARCH_REPORTS_SQL +
  RESEARCH_SOURCE_COLUMNS_SQL
