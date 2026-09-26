import type { SqliteDb } from '../connection'

// M3(C-05):检索文档、分块与 FTS4 索引。
//
// storage 设计(实测验证,见 C-05 探针):
// - retrieval_fts 是外部内容 FTS4 表(content="retrieval_chunks"),
//   docid 对应 retrieval_chunks 的 rowid;索引行由导入器显式写入。
// - 恢复备份会整体替换 chunks 行,rowid 可能变化,因此 restore 之后
//   必须执行 rebuild('INSERT INTO retrieval_fts(retrieval_fts) VALUES("rebuild")'),
//   由 services/backup.ts 调用 retrieval/search 的 rebuildSearchIndex 完成。
// - FTS 虚表是派生索引,不进备份清单;业务真相(chunks, documents)进备份。
// - 枚举列带 CHECK 约束;不建外键,与既有基础表一致。

export const RETRIEVAL_DOCUMENTS_SQL = `
CREATE TABLE IF NOT EXISTS retrieval_documents (
  document_id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('markdown', 'txt', 'json', 'csv')),
  raw_sha256 TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retrieval_documents_raw ON retrieval_documents (raw_sha256);
`

export const RETRIEVAL_CHUNKS_SQL = `
CREATE TABLE IF NOT EXISTS retrieval_chunks (
  chunk_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset >= start_offset),
  content TEXT NOT NULL,
  search_text TEXT NOT NULL,
  search_version INTEGER NOT NULL CHECK (search_version >= 1)
);
CREATE INDEX IF NOT EXISTS idx_retrieval_chunks_doc ON retrieval_chunks (document_id, chunk_index);
`

export const RETRIEVAL_FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS retrieval_fts USING fts4(search_text, content="retrieval_chunks");
`

/** v5 → v6:检索文档、分块与 FTS4 索引 */
export function migrateM3(db: SqliteDb): void {
  db.run(RETRIEVAL_DOCUMENTS_SQL)
  db.run(RETRIEVAL_CHUNKS_SQL)
  db.run(RETRIEVAL_FTS_SQL)
}

/** 回滚 v6:先删派生索引,再删分块与文档 */
export function rollbackM3(db: SqliteDb): void {
  db.run('DROP TABLE IF EXISTS retrieval_fts')
  db.run('DROP TABLE IF EXISTS retrieval_chunks')
  db.run('DROP TABLE IF EXISTS retrieval_documents')
}
