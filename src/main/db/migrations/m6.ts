import type { SqliteDb } from '../connection'

// M6(R-02):检索文档表补研究侧来源元数据与定位列。
//
// SourceSnapshot 即共享 retrieval_documents(m3)。研究侧为每条逻辑 Source 冻结:
// - source_identity:来源稳定身份(JSON/CSV 记录取 company+title 派生;md/txt 可由调用方声明)。
//   不同岗位 identity 必然不同,是 provenance 分组"不误合并岗位"的判定基础;
// - provenance_group_id:同一 JD 的转载/副本同组;近似文本不自动合并(传播关系 unknown);
// - source_locator:JSON Pointer("/0")或 CSV 数据行号("row:N");NULL 表示整文件单源(md/txt);
// - source_metadata_json:冻结元数据(标题/公司/地点/URL/published_at 及可验证状态、
//   collected_at 与采集时间依据、传播判定、核心内容 hash、样例标记);
// - collection_time_basis:采集时间依据,imported=未知(用导入时间,不冒充发布时间),source=调用方提供。
//
// 为什么不改 m3 的 DDL:m3 已发布不回改,写入责任在 R-02。本迁移对旧库加列,
// 新库(v1 建表后)也由本迁移统一加列,两条路径收敛到同一形状;与 m4 给
// approvals 追加 arguments_json 的模式一致。

/** v9 新增列(全部可空,旧数据行保持 NULL,不改动既有快照) */
const NEW_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: 'source_identity', ddl: 'ALTER TABLE retrieval_documents ADD COLUMN source_identity TEXT' },
  { name: 'provenance_group_id', ddl: 'ALTER TABLE retrieval_documents ADD COLUMN provenance_group_id TEXT' },
  { name: 'source_locator', ddl: 'ALTER TABLE retrieval_documents ADD COLUMN source_locator TEXT' },
  { name: 'source_metadata_json', ddl: 'ALTER TABLE retrieval_documents ADD COLUMN source_metadata_json TEXT' },
  {
    name: 'collection_time_basis',
    ddl:
      "ALTER TABLE retrieval_documents ADD COLUMN collection_time_basis TEXT CHECK " +
      "(collection_time_basis IS NULL OR collection_time_basis IN ('imported', 'source'))"
  }
]

const IDENTITY_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_retrieval_documents_identity ON retrieval_documents (source_identity)'

/**
 * v9 列 DDL 与迁移共用:SCHEMA_SQL 的 v1 建表路径与 pending 迁移路径都执行这一段。
 * ALTER 语句在列已存在时由调用方(columnExists 幂等)保护,与 m4 的 arguments_json 同一模式。
 */
export const RESEARCH_SOURCE_COLUMNS_SQL =
  NEW_COLUMNS.map((c) => c.ddl + ';').join('\n') + '\n' + IDENTITY_INDEX_SQL + ';'

function columnExists(db: SqliteDb, table: string, column: string): boolean {
  const cols = db.all<{ name: string }>(`PRAGMA table_info(${table})`)
  return cols.some((c) => c.name === column)
}

function dropColumnIfExists(db: SqliteDb, column: string): void {
  const cols = db.all<{ name: string }>('PRAGMA table_info(retrieval_documents)')
  if (cols.some((c) => c.name === column)) {
    db.run(`ALTER TABLE retrieval_documents DROP COLUMN ${column}`)
  }
}

/** v8 → v9:研究侧来源元数据与定位列 + 身份索引 */
export function migrateM6(db: SqliteDb): void {
  for (const col of NEW_COLUMNS) {
    if (!columnExists(db, 'retrieval_documents', col.name)) {
      db.run(col.ddl)
    }
  }
  db.run(IDENTITY_INDEX_SQL)
}

/** 回滚 v9:先删索引再删列(表本身保留,属 v6) */
export function rollbackM6(db: SqliteDb): void {
  db.run('DROP INDEX IF EXISTS idx_retrieval_documents_identity')
  for (const col of NEW_COLUMNS) {
    dropColumnIfExists(db, col.name)
  }
}
