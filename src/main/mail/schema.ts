import type { SqliteDb } from '../db/connection'

export const MAIL_SCHEMA_SQL = `
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
`

export function migrateMailV2(db: SqliteDb): void {
  db.run(MAIL_SCHEMA_SQL)
}
