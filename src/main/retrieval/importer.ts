// 检索导入(C-05):bytes → 解码 → (JSON 投影) → 规范化 → 分块 → 入库 + 索引。
//
// 去重契约:同一原始文件(raw_sha256 相同)重复导入不产生重复 chunk,
// 返回已有文档与 deduped=true。
// 单文件上限 5 MB(总体规格第 6 节);批量上限(100 文件/25 MB)属调用方
// (IPC handler / 研究侧)职责,不在本层。

import type { SqliteDb } from '../db/connection'
import { uid } from '../db/dao'
import { nowTimestamp } from '../../shared/dateUtils'
import { appError } from '../../shared/operations'
import { OperationError } from '../db/operations'
import {
  decodeBytes,
  normalizePlainText,
  projectJsonSource,
  sha256Hex,
  textSha256
} from './normalize'
import { SEARCH_VERSION, tokenizeForSearch } from './tokenize'
import { chunkText } from './chunker'

export type RetrievalSourceType = 'markdown' | 'txt' | 'json' | 'csv'

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024

export interface ImportDocumentInput {
  sourceName: string
  sourceType: RetrievalSourceType
  bytes: Buffer
}

export interface ImportedDocument {
  documentId: string
  sourceName: string
  sourceType: RetrievalSourceType
  rawSha256: string
  textSha256: string
  chunkCount: number
}

export interface ImportDocumentResult {
  document: ImportedDocument
  /** 同一原始文件重复导入:true;未产生新 chunk */
  deduped: boolean
}

function tooLarge(): OperationError {
  return new OperationError(
    appError('VALIDATION', '单文件超过 5 MB 上限,请拆分后导入', { retryable: false })
  )
}

/** 按来源类型把字节变成规范文本:md/txt/csv 走文本,JSON 先投影再规范化 */
function toNormalizedText(sourceType: RetrievalSourceType, bytes: Buffer): { text: string; rawSha256: string } {
  const decoded = decodeBytes(bytes)
  if (sourceType === 'json') {
    return { text: normalizePlainText(projectJsonSource(decoded.text)), rawSha256: decoded.rawSha256 }
  }
  // markdown / txt / csv:整体按文本规范化(csv 的字段级映射属 R-02)
  return { text: normalizePlainText(decoded.text), rawSha256: decoded.rawSha256 }
}

/** 导入文档:同 raw_sha256 幂等;文档、分块与 FTS 索引行同一事务写入 */
export function importDocument(db: SqliteDb, input: ImportDocumentInput): ImportDocumentResult {
  if (input.bytes.length > MAX_DOCUMENT_BYTES) throw tooLarge()
  if (input.bytes.length === 0) {
    throw new OperationError(appError('VALIDATION', '空文件无法导入', { retryable: false }))
  }

  const rawSha256 = sha256Hex(input.bytes)
  const existing = db.get<{ document_id: string; source_name: string; source_type: string; text_sha256: string }>(
    'SELECT document_id, source_name, source_type, text_sha256 FROM retrieval_documents WHERE raw_sha256 = ?',
    [rawSha256]
  )
  if (existing) {
    const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM retrieval_chunks WHERE document_id = ?', [
      existing.document_id
    ])
    return {
      document: {
        documentId: existing.document_id,
        sourceName: existing.source_name,
        sourceType: existing.source_type as RetrievalSourceType,
        rawSha256,
        textSha256: existing.text_sha256,
        chunkCount: count?.n ?? 0
      },
      deduped: true
    }
  }

  const { text, rawSha256: rawHash } = toNormalizedText(input.sourceType, input.bytes)
  const finalTextSha = textSha256(text)
  const chunks = chunkText(text)
  const documentId = uid()

  db.transaction(() => {
    db.run(
      `INSERT INTO retrieval_documents
         (document_id, source_name, source_type, raw_sha256, text_sha256, normalized_text, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        documentId,
        input.sourceName,
        input.sourceType,
        rawHash,
        finalTextSha,
        text,
        input.bytes.length,
        nowTimestamp()
      ]
    )
    for (const chunk of chunks) {
      const chunkId = uid()
      const searchText = tokenizeForSearch(chunk.content).join(' ')
      db.run(
        `INSERT INTO retrieval_chunks
           (chunk_id, document_id, chunk_index, start_offset, end_offset, content, search_text, search_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [chunkId, documentId, chunk.index, chunk.startOffset, chunk.endOffset, chunk.content, searchText, SEARCH_VERSION]
      )
      // 外部内容 FTS4:docid 必须等于内容表的 rowid
      const row = db.get<{ rid: number }>('SELECT last_insert_rowid() AS rid')
      db.run('INSERT INTO retrieval_fts(docid, search_text) VALUES (?, ?)', [row!.rid, searchText])
    }
  })

  return {
    document: {
      documentId,
      sourceName: input.sourceName,
      sourceType: input.sourceType,
      rawSha256: rawHash,
      textSha256: finalTextSha,
      chunkCount: chunks.length
    },
    deduped: false
  }
}

/** 文档与其分块总数(评测与展示用) */
export function retrievalStats(db: SqliteDb): { documents: number; chunks: number } {
  const documents = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM retrieval_documents')?.n ?? 0
  const chunks = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM retrieval_chunks')?.n ?? 0
  return { documents, chunks }
}
