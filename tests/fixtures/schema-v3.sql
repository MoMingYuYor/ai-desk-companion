-- 冻结的 v3 schema 夹具(2026-09-21 冻结)。
-- 来源:v3 时期的 src/main/db/schema.ts(SCHEMA_SQL)+ src/main/mail/schema.ts(MAIL_SCHEMA_SQL)。
-- 本文件禁止随后续 schema 演进而修改:迁移测试用它显式建立真实 v3 旧库并写 schema_version=3,
-- 不得用会随当前 schema 更新的 makeTestDb() 伪装旧库。
-- '>>> v3 DATA <<<' 标记之前为纯 schema(空库迁移用),之后为代表性 v3 行(有数据迁移用)。

-- ========== v3 SCHEMA(冻结) ==========

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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_items (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  title TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open',
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

-- v2 起的邮箱表(冻结时的 MAIL_SCHEMA_SQL)

CREATE TABLE IF NOT EXISTS mail_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  email TEXT NOT NULL,
  provider TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  credential_enc TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'idle',
  last_success_at TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(host, port, email)
);

CREATE TABLE IF NOT EXISTS mail_sync_state (
  account_id TEXT PRIMARY KEY REFERENCES mail_accounts(id) ON DELETE CASCADE,
  mailbox TEXT NOT NULL DEFAULT 'INBOX',
  uid_validity TEXT,
  last_uid INTEGER NOT NULL DEFAULT 0,
  oldest_day TEXT,
  initialized INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mail_messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  mailbox TEXT NOT NULL,
  uid_validity TEXT,
  uid INTEGER,
  remote_message_id TEXT,
  subject TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipients TEXT NOT NULL,
  received_at TEXT NOT NULL,
  size INTEGER NOT NULL,
  read_local INTEGER NOT NULL,
  body_state TEXT NOT NULL DEFAULT 'missing',
  body_path TEXT,
  body_structure TEXT NOT NULL,
  remote_available INTEGER NOT NULL DEFAULT 1,
  UNIQUE(account_id, mailbox, uid_validity, uid)
);
CREATE INDEX IF NOT EXISTS idx_mail_list ON mail_messages(account_id, received_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS mail_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  part TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER,
  cache_path TEXT,
  UNIQUE(message_id, part)
);

CREATE TABLE IF NOT EXISTS mail_analysis_links (
  source_key TEXT PRIMARY KEY,
  message_id TEXT UNIQUE,
  conversation_id TEXT UNIQUE,
  snapshot TEXT NOT NULL,
  last_material_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'idle',
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS mail_analysis_versions (
  analysis_id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL,
  material_ids TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_confirmations (
  analysis_id TEXT NOT NULL,
  candidate_index INTEGER NOT NULL,
  source_key TEXT NOT NULL,
  ref_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  PRIMARY KEY(analysis_id, candidate_index)
);

-- >>> v3 DATA <<<

-- 显式写死 v3 版本号:本夹具代表 v3 旧库,不随代码演进
INSERT INTO meta (key, value) VALUES ('schema_version', '3');

-- 已确认邮件:账号 + 同步游标 + 消息 + 分析来源 + 确认映射
INSERT INTO mail_accounts (id, label, email, provider, host, port, credential_enc, enabled, status, created_at)
VALUES ('acc-1', '测试邮箱', 'user@example.com', 'imap', 'imap.example.com', 993, 'enc-frozen-fixture', 1, 'idle', '2026-09-01T08:00:00.000Z');
INSERT INTO mail_sync_state (account_id, mailbox, uid_validity, last_uid, initialized)
VALUES ('acc-1', 'INBOX', 'uv-1', 42, 1);
INSERT INTO mail_messages (id, account_id, mailbox, uid_validity, uid, remote_message_id, subject, sender, recipients, received_at, size, read_local, body_state, body_structure)
VALUES ('m-1', 'acc-1', 'INBOX', 'uv-1', 7, 'remote-7', '会议通知', 'boss@example.com', '["user@example.com"]', '2026-09-10T09:00:00.000Z', 1024, 1, 'ready', '{"frozen":true}');
INSERT INTO mail_analysis_links (source_key, message_id, conversation_id, snapshot, last_material_ids, status, last_error)
VALUES ('acc-1:INBOX:uv-1:7', 'm-1', NULL, '{"frozen":true}', '[]', 'done', NULL);
INSERT INTO mail_confirmations (analysis_id, candidate_index, source_key, ref_type, ref_id)
VALUES ('m-1', 0, 'acc-1:INBOX:uv-1:7', 'todo', 'td-1');

-- 多待办共用日程:ev-1 被 td-1 与 td-2 同时引用
INSERT INTO events (id, title, start_at, end_at, all_day, color, location, notes, source, source_ref, reminder_minutes, status, fingerprint, created_at, updated_at)
VALUES ('ev-1', '组会', '2026-09-15T10:00', '2026-09-15T11:00', 0, NULL, NULL, NULL, 'manual', NULL, 15, 'active', 'fp-ev-1', '2026-09-02T08:00:00.000Z', '2026-09-02T08:00:00.000Z');
INSERT INTO todos (id, title, notes, due_at, priority, completed_at, linked_event_id, source, source_ref, fingerprint, created_at, updated_at)
VALUES ('td-1', '准备组会材料', NULL, '2026-09-15T09:00', 'normal', NULL, 'ev-1', 'manual', NULL, 'fp-td-1', '2026-09-02T08:00:00.000Z', '2026-09-02T08:00:00.000Z');
INSERT INTO todos (id, title, notes, due_at, priority, completed_at, linked_event_id, source, source_ref, fingerprint, created_at, updated_at)
VALUES ('td-2', '预定会议室', NULL, '2026-09-15T09:30', 'normal', NULL, 'ev-1', 'manual', NULL, 'fp-td-2', '2026-09-02T08:05:00.000Z', '2026-09-02T08:05:00.000Z');

-- 损坏引用:指向不存在日程的待办,迁移不得静默修复或删除
INSERT INTO todos (id, title, notes, due_at, priority, completed_at, linked_event_id, source, source_ref, fingerprint, created_at, updated_at)
VALUES ('td-3', '悬空引用待办', NULL, NULL, 'normal', NULL, 'ev-missing', 'manual', NULL, 'fp-td-3', '2026-09-03T08:00:00.000Z', '2026-09-03T08:00:00.000Z');

-- 旧提醒:已触发记录必须原样保留
INSERT INTO fired_reminders (key, fired_at)
VALUES ('event:ev-1:2026-09-15T09:45', '2026-09-15T09:45:00.000Z');

-- 一个 provider(v3 含 supports_json_mode 列)
INSERT INTO providers (id, name, base_url, api_key_enc, protocol, models, default_model, supports_vision, supports_json_mode, is_default, sort_order, created_at, updated_at)
VALUES ('p-1', '示例模型', 'https://api.example.com', 'plain:frozen-fixture', 'chat-completions', '["m1"]', 'm1', 1, 0, 1, 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
