// 检索搜索(C-05):查询分词 → 安全 MATCH → 应用层词频计分 → 稳定排序。
//
// 安全:用户输入永远不直接拼接进 MATCH 表达式——先经 tokenizeForSearch
// (只产 CJK 二元组与字母数字词),再由 buildMatchQuery 双引号包裹。
// 排序:bm25() 是 FTS5 特性本构建不可用;采用应用层计分——
// score = Σ(去重后查询 token 在 chunk 中出现次数),同分按
// document_id、chunk_index 字典序稳定排序,可复现、可手算核对。
//
// RES-02:提供 options.frozenSnapshotIds 时,冻结集合过滤移入 MATCH 候选阶段
// (JOIN retrieval_chunks,参数绑定),再应用 candidateLimit——清单外资料不再
// 挤占候选窗口;分批取候选(超过 SQL 参数上限),合并后稳定排序并统一截断。

import type { SqliteDb } from '../db/connection'
import { tokenizeForSearch, buildMatchQuery } from './tokenize'

export interface SearchHit {
  chunkId: string
  documentId: string
  sourceName: string
  sourceType: string
  chunkIndex: number
  startOffset: number
  endOffset: number
  /** 命中块原文(规范文本的连续切片) */
  content: string
  /** 应用层词频得分(去重查询 token 出现次数之和) */
  score: number
  /** 命中的查询 token */
  matchedTerms: string[]
}

export interface SearchDocumentsOptions {
  /** 冻结集合:候选阶段即按 document_id 过滤(参数绑定);空集合直接返回 [] */
  frozenSnapshotIds: readonly string[]
  /** 候选上限(过滤后统一截断);缺省 500 */
  candidateLimit?: number
}

interface ChunkRow {
  chunk_id: string
  document_id: string
  chunk_index: number
  start_offset: number
  end_offset: number
  content: string
  search_text: string
}

interface DocumentRow {
  source_name: string
  source_type: string
}

/** 单次查询进入评分的候选上限(候选集截断,防止超大语料全量评分) */
const MATCH_CANDIDATE_LIMIT = 500

/** SQL 参数分批上限:每批 MATCH 表达式占 1 个参数,其余留给 document_id 绑定 */
const SQL_PARAM_BATCH = 400

/** 按 (documentId, chunkIndex, chunkId) 的稳定全序(跨批合并后统一截断用) */
function compareCandidateRows(a: ChunkRow, b: ChunkRow): number {
  return (
    (a.document_id < b.document_id ? -1 : a.document_id > b.document_id ? 1 : 0) ||
    a.chunk_index - b.chunk_index ||
    (a.chunk_id < b.chunk_id ? -1 : a.chunk_id > b.chunk_id ? 1 : 0)
  )
}

/**
 * 关键词检索。查询为空或分词后为空(纯标点等)返回空数组而非报错;
 * 恶意 MATCH 语法经分词归一后不可能进入表达式。
 * options.frozenSnapshotIds 提供时(RES-02),冻结过滤发生在 MATCH 候选阶段。
 */
export function searchDocuments(db: SqliteDb, query: string, limit = 8, options?: SearchDocumentsOptions): SearchHit[] {
  const candidateLimit = options?.candidateLimit ?? MATCH_CANDIDATE_LIMIT
  if (!Number.isInteger(candidateLimit) || candidateLimit < 0 || candidateLimit > MATCH_CANDIDATE_LIMIT) {
    throw new Error('candidateLimit 必须是 0 至 500 的整数')
  }
  if (candidateLimit === 0) return []
  const tokens = tokenizeForSearch(query)
  if (tokens.length === 0) return []
  const match = buildMatchQuery(tokens)

  let rows: Array<ChunkRow & DocumentRow>
  if (options !== undefined) {
    // RES-02 路径:候选阶段 JOIN retrieval_chunks 按冻结 document_id 过滤;
    // 冻结集合为空直接返回 [];超过 SQL 参数上限分批取候选
    const frozen = [...new Set(options.frozenSnapshotIds)].sort()
    if (frozen.length === 0) return []
    const candidateRows: Array<ChunkRow & DocumentRow> = []
    for (let i = 0; i < frozen.length; i += SQL_PARAM_BATCH) {
      const remaining = candidateLimit - candidateRows.length
      if (remaining === 0) break
      const batch = frozen.slice(i, i + SQL_PARAM_BATCH)
      const placeholders = batch.map(() => '?').join(', ')
      candidateRows.push(
        ...db.all<ChunkRow & DocumentRow>(
          `SELECT c.chunk_id, c.document_id, c.chunk_index, c.start_offset, c.end_offset,
                  c.content, c.search_text, d.source_name, d.source_type
             FROM retrieval_fts f
             JOIN retrieval_chunks c ON c.rowid = f.docid
             JOIN retrieval_documents d ON d.document_id = c.document_id
            WHERE retrieval_fts MATCH ? AND c.document_id IN (${placeholders})
            ORDER BY c.document_id COLLATE BINARY, c.chunk_index, c.chunk_id COLLATE BINARY LIMIT ?`,
          [match, ...batch, remaining]
        )
      )
    }
    // 合并去重后按稳定全序排序,再做统一候选截断(不能每批各截断后不做全局上限)
    const seen = new Set<string>()
    const deduped = candidateRows.filter((row) => {
      if (seen.has(row.chunk_id)) return false
      seen.add(row.chunk_id)
      return true
    })
    rows = deduped.sort(compareCandidateRows).slice(0, candidateLimit)
  } else {
    const candidates = db.all<{ docid: number }>(
      `SELECT docid FROM retrieval_fts WHERE retrieval_fts MATCH ? LIMIT ${MATCH_CANDIDATE_LIMIT}`,
      [match]
    )
    if (candidates.length === 0) return []
    const placeholders = candidates.map(() => '?').join(', ')
    rows = db.all<ChunkRow & DocumentRow>(
      `SELECT c.chunk_id, c.document_id, c.chunk_index, c.start_offset, c.end_offset,
              c.content, c.search_text, d.source_name, d.source_type
         FROM retrieval_chunks c
         JOIN retrieval_documents d ON d.document_id = c.document_id
        WHERE c.rowid IN (${placeholders})`,
      candidates.map((c) => c.docid)
    )
  }
  if (rows.length === 0) return []

  const distinct = [...new Set(tokens)]
  const hits: SearchHit[] = rows.map((row) => {
    const chunkTokens = row.search_text.length === 0 ? [] : row.search_text.split(' ')
    const counts = new Map<string, number>()
    for (const token of chunkTokens) counts.set(token, (counts.get(token) ?? 0) + 1)
    let score = 0
    const matchedTerms: string[] = []
    for (const token of distinct) {
      const n = counts.get(token) ?? 0
      if (n > 0) {
        score += n
        matchedTerms.push(token)
      }
    }
    return {
      chunkId: row.chunk_id,
      documentId: row.document_id,
      sourceName: row.source_name,
      sourceType: row.source_type,
      chunkIndex: row.chunk_index,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      content: row.content,
      score,
      matchedTerms
    }
  })

  return hits
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0) ||
        a.chunkIndex - b.chunkIndex
    )
    .slice(0, limit)
}

/**
 * 重建 FTS 索引(外部内容表专用命令):备份恢复整体替换 chunks 行后,
 * rowid 可能变化,必须重建使索引与内容重新对齐。表不存在时静默跳过
 * (调用方可能在无检索表的旧库路径上)。
 */
export function rebuildSearchIndex(db: SqliteDb): void {
  const exists = db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'retrieval_fts'"
  )
  if (!exists) return
  db.run("INSERT INTO retrieval_fts(retrieval_fts) VALUES ('rebuild')")
}
