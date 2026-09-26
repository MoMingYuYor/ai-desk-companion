import type { SqliteDb } from '../connection'

// M2(C-03):Agent 运行、轨迹事件与审批记录。
//
// 与既有基础表的差异:这三张表的状态与枚举列带 CHECK 约束,
// 把契约落在库层而不只靠应用校验——状态集、运行模式、事件类型、审批决策
// 都是封闭枚举,写错值应当在插入时就失败。
//
// 不建外键,与既有基础表保持一致(现状是应用层维护引用)。

export const AGENT_RUNS_SQL = `
CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('personal_ops', 'research')),
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'planning', 'awaiting_input', 'awaiting_confirmation',
    'executing', 'succeeded', 'partial', 'failed', 'cancelled'
  )),
  input TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  context_clock TEXT NOT NULL,
  config_version TEXT NOT NULL DEFAULT '',
  budget_json TEXT NOT NULL DEFAULT '{}',
  result_ref TEXT,
  error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs (status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs (started_at);
`

/** (run_id, seq) 复合主键即"同一运行内 seq 唯一"的库层保证;seq 从 1 连续递增由仓库层校验 */
export const TRACE_EVENTS_SQL = `
CREATE TABLE IF NOT EXISTS trace_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'input', 'retrieval', 'plan', 'tool_call', 'confirmation', 'model', 'output', 'error'
  )),
  schema_version INTEGER NOT NULL DEFAULT 1,
  payload TEXT NOT NULL DEFAULT '{}',
  duration_ms INTEGER,
  token_usage TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
`

export const APPROVALS_SQL = `
CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_hash TEXT NOT NULL,
  arguments_json TEXT,
  plan_version INTEGER NOT NULL CHECK (plan_version >= 1),
  target_version INTEGER,
  expires_at TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN (
    'pending', 'approved', 'rejected', 'expired'
  )),
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_run ON approvals (run_id);
`

/** v4 → v5:Agent 运行、轨迹事件与审批记录 */
export function migrateM2(db: SqliteDb): void {
  db.run(AGENT_RUNS_SQL)
  db.run(TRACE_EVENTS_SQL)
  db.run(APPROVALS_SQL)
}

/** 回滚 v5:先删有外键依赖可能的审批与轨迹,再删运行 */
export function rollbackM2(db: SqliteDb): void {
  db.run('DROP TABLE IF EXISTS approvals')
  db.run('DROP TABLE IF EXISTS trace_events')
  db.run('DROP TABLE IF EXISTS agent_runs')
}
