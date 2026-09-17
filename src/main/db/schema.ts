export const SCHEMA_VERSION = 2

export const SCHEMA_SQL = `
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
`
