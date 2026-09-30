// 研究侧有界检索(R-03):每个子问题一次有界检索 + 冻结清单钳制 + 稳定排序 +
// provenance 来源组去重 + 检索 trace。纯确定性模块:不调用模型、不读取时钟、
// 不产生时间戳——同输入(查询、SEARCH_VERSION、冻结快照集合)多次调用逐字节一致。
//
// 边界与口径:
// - 检索复用共享 searchDocuments(src/main/retrieval/search.ts),安全 FTS 构造
//   由 tokenize.buildMatchQuery 保证(用户输入先经 tokenizeForSearch 归一,只产
//   CJK 二元组与字母数字词,再双引号包裹;非白名单形状 token 直接拒绝进 MATCH),
//   本模块不重复实现分词、计分与注入防线,只做研究侧过滤、排序、配额与统计;
// - 范围钳制在应用层完成:候选先按 document_id ∈ 冻结清单过滤,再截断到
//   chunkLimit(上限 DEFAULT_RESEARCH_BUDGET.max_chunks_per_subquery = 8),
//   检索永不越过冻结清单、交付数永不突破限额;为避免"清单外高分文档挤占名额",
//   先以共享候选上限等宽的窗口取回全部候选,过滤后再截断;
// - 稳定排序:score 降序 → documentId 字典序 → chunkIndex 升序(与共享实现同一
//   层级;(documentId, chunkIndex) 在库内唯一,序为全序,可逐字节复现);
// - provenance 口径:同一 provenance_group_id 的多个 chunk 全部计入交付结果
//   (证据定位需要具体 chunk),统计(trace.provenanceGroups 与
//   distinctProvenanceGroups)按来源组计数——同一 JD 的转载与已确认副本
//   合计一个来源组,不重复计数;provenance_group_id 为空(共享导入器的非研究
//   文档)时不并入任何组,逐文档独立成一个 null 组;
// - 相邻片段联合:同文档相邻 chunkIndex 且同时交付的片段以 pairedWith 互相
//   标注,各占 1 个名额(联合解释合计 2 个名额,不会因此突破上限);邻块未命中
//   但需要上下文时用 expandAdjacent 显式取出,由调用方把返回的邻块计入名额;
// - 多记录文件:source_locator 非空的记录(同文件多 Source)本就是独立
//   retrieval_documents 行,按 document_id 独立过滤与计额,无需特判。
//
// trace:RetrievalResult.trace 是可直接持久化的 JSON 载荷(无运行期可变字段),
// 供 R-04 工作流以
//   appendTraceEvent(db, { runId, eventType: 'retrieval', payload: result.trace })
//   落库;本模块不感知 runId、不直接写 trace_events(职责分离)。

import type { SqliteDb } from '../db/connection'
import { appError } from '../../shared/operations'
import { OperationError } from '../db/operations'
import { searchDocuments, type SearchHit } from '../retrieval/search'
import { SEARCH_VERSION, buildMatchQuery, tokenizeForSearch } from '../retrieval/tokenize'
import { DEFAULT_RESEARCH_BUDGET } from './schemas'

// ---------- 常量 ----------

/**
 * 取回候选的窗口上限:与共享 searchDocuments 的 MATCH_CANDIDATE_LIMIT(500)
 * 等宽——FTS 候选集本身被共享实现截断在 500,窗口取 500 即可覆盖全部候选,
 * 保证"冻结过滤后再截断"不因提前 slice 丢掉清单内命中。
 */
export const RETRIEVAL_FETCH_LIMIT = 500

/** 每题交付 chunk 的硬上限(规格第 4 节:8;权威值在 R-01 预算契约,不另立数字) */
export const MAX_CHUNKS_PER_SUBQUERY = DEFAULT_RESEARCH_BUDGET.max_chunks_per_subquery

// ---------- 输入/输出契约 ----------

export interface RetrieveForSubquestionInput {
  /** 子问题查询串(自然语言,可中英混合) */
  query: string
  /** 冻结清单内的 document_id 集合(来自 SnapshotManifest.entries 的 snapshot_id) */
  frozenSnapshotIds: readonly string[]
  /** 本题 chunk 交付上限;只能 ≤ 8(规格硬上限),由调用方从预算传入 */
  chunkLimit: number
  /** 可选比较维度(来自子问题 query_json);作为同一次 FTS 查询的追加关键词 */
  compareDimensions?: readonly string[]
  /** 可选实体范围(来自子问题 query_json);作为同一次 FTS 查询的追加关键词 */
  entityScope?: readonly string[]
}

/** 交付的命中块:共享 SearchHit + 研究侧来源组与相邻标注 */
export interface RetrievalHit extends SearchHit {
  /** 命中文档的 provenance_group_id;非研究导入路径(共享导入器)为 null */
  provenanceGroupId: string | null
  /** 同文档相邻且同时交付的配对块 chunkId;无配对为 null */
  pairedWith: string | null
}

/** 来源组命中统计:同一 JD 的转载与副本合计一组(组内 chunk 全部交付) */
export interface ProvenanceGroupCount {
  /** 来源组 ID;null 表示共享导入器文档(无研究侧分组,逐文档独立) */
  provenanceGroupId: string | null
  /** 该组交付的 chunk 数 */
  hitCount: number
  /** 该组涉及的文档 ID(升序,去重) */
  documentIds: string[]
}

/**
 * 检索 trace:可直接作为 TraceEvent('retrieval')的 payload 持久化。
 * 字段全部为 JSON 安全值,不含时间戳与运行期状态,可复核、可重放。
 */
export interface RetrievalTrace {
  /** 参与查询构造的部分(原 query + 维度 + 实体,trim 后依序);join(' ') === queryUsed */
  queryParts: string[]
  /** 实际用于分词的查询文本(预处理拼接形态) */
  queryUsed: string
  /** 版本化预处理的分词产物(SEARCH_VERSION 锁定) */
  queryTokens: string[]
  /** 由 queryTokens 经 buildMatchQuery 构造的安全 MATCH 表达式 */
  matchQuery: string
  /** 分词/索引版本 */
  searchVersion: number
  /** 本题冻结快照 ID(清单序,原样记录) */
  frozenSnapshotIds: string[]
  /** 冻结过滤后的候选数(截断前) */
  candidateCount: number
  /** 交付命中 chunk ID(交付序) */
  hitChunkIds: string[]
  /** 交付命中的 chunk 分数(与 hitChunkIds 同序) */
  hitScores: Array<{ chunkId: string; score: number }>
  /** 候选数超过上限被截断 */
  truncated: boolean
  /** 候选少于上限(检索不足;不扩写查询、不二次调用模型) */
  insufficient: boolean
  /** 实际交付数量(每 chunk 占 1 个名额,相邻联合合计 2) */
  usedCount: number
  /** 独立来源组数(provenance 去重后的统计口径) */
  distinctProvenanceGroups: number
  /** 参与 pairedWith 标注的 chunk ID(交付序) */
  pairedChunkIds: string[]
}

export interface RetrievalResult {
  hits: RetrievalHit[]
  /** 实际用于分词的查询文本(与 trace.queryUsed 一致) */
  queryUsed: string
  truncated: boolean
  insufficient: boolean
  usedCount: number
  /** 按来源组的命中数统计(去重口径见文件头) */
  provenanceGroups: ProvenanceGroupCount[]
  /** 检索 trace(供调用方持久化为 'retrieval' 事件) */
  trace: RetrievalTrace
}

// ---------- 错误工具 ----------

function retrievalInvalid(message: string): OperationError {
  return new OperationError(appError('VALIDATION', message, { retryable: false }))
}

// ---------- 排序与配额(纯函数) ----------

/** 研究侧稳定排序:score 降序 → documentId 字典序 → chunkIndex 升序(全序,可复现) */
function compareHits(a: SearchHit, b: SearchHit): number {
  return (
    b.score - a.score ||
    (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0) ||
    a.chunkIndex - b.chunkIndex
  )
}

/** 查询拼接:query + 比较维度 + 实体范围,逐项 trim、丢弃空项,依序拼接 */
function buildQueryParts(input: RetrieveForSubquestionInput): string[] {
  const parts: string[] = []
  const rest: readonly string[] = [
    ...(input.compareDimensions ?? []),
    ...(input.entityScope ?? [])
  ]
  for (const raw of [input.query, ...rest]) {
    const trimmed = raw.trim()
    if (trimmed !== '') parts.push(trimmed)
  }
  return parts
}

/**
 * 相邻配对标注:同文档相邻 chunkIndex 且同时交付的块互相标注 pairedWith。
 * 每块各占 1 个名额(交付数不变);同块有多个相邻邻居时取 chunkIndex 最小者,确定可复现。
 * 返回参与标注的 chunkId(交付序)。
 */
function markAdjacentPairs(hits: RetrievalHit[]): string[] {
  const paired: string[] = []
  for (const hit of hits) {
    let best: RetrievalHit | null = null
    for (const other of hits) {
      if (other === hit || other.documentId !== hit.documentId) continue
      if (Math.abs(other.chunkIndex - hit.chunkIndex) !== 1) continue
      if (best === null || other.chunkIndex < best.chunkIndex) best = other
    }
    if (best !== null) {
      hit.pairedWith = best.chunkId
      paired.push(hit.chunkId)
    }
  }
  return paired
}

// ---------- provenance 组统计 ----------

/** 读取交付文档的 provenance_group_id 映射;行缺失属内部不变量破坏,直接暴露 */
function provenanceMapOf(db: SqliteDb, documentIds: string[]): Map<string, string | null> {
  if (documentIds.length === 0) return new Map()
  const placeholders = documentIds.map(() => '?').join(', ')
  const rows = db.all<{ document_id: string; provenance_group_id: string | null }>(
    `SELECT document_id, provenance_group_id FROM retrieval_documents WHERE document_id IN (${placeholders})`,
    documentIds
  )
  const groupOf = new Map(rows.map((r) => [r.document_id, r.provenance_group_id]))
  for (const documentId of documentIds) {
    if (!groupOf.has(documentId)) {
      // 交付命中必然来自 retrieval_documents,行缺失属内部不变量破坏,直接暴露
      throw new Error(`交付命中的文档不存在:${documentId}`)
    }
  }
  return groupOf
}

/**
 * 按来源组统计交付命中:组内逐 chunk 计入 hitCount,组数即独立来源数。
 * 组序:null 组(无研究侧分组)最后,其余按组 ID 字典序(码点序,确定性)。
 */
function countProvenanceGroups(db: SqliteDb, hits: RetrievalHit[]): ProvenanceGroupCount[] {
  if (hits.length === 0) return []
  const groupOf = provenanceMapOf(db, [...new Set(hits.map((h) => h.documentId))])
  interface Bucket {
    provenanceGroupId: string | null
    hitCount: number
    documentIds: Set<string>
  }
  const buckets = new Map<string, Bucket>()
  for (const hit of hits) {
    const groupId = groupOf.get(hit.documentId) ?? null
    hit.provenanceGroupId = groupId
    // null 组逐文档独立,不互相合并(未知传播关系不宣称同源)
    const key = groupId ?? `doc:${hit.documentId}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { provenanceGroupId: groupId, hitCount: 0, documentIds: new Set() }
      buckets.set(key, bucket)
    }
    bucket.hitCount += 1
    bucket.documentIds.add(hit.documentId)
  }
  return [...buckets.values()]
    .map((b) => ({ provenanceGroupId: b.provenanceGroupId, hitCount: b.hitCount, documentIds: [...b.documentIds].sort() }))
    .sort((a, b) => {
      const aNull = a.provenanceGroupId === null ? 1 : 0
      const bNull = b.provenanceGroupId === null ? 1 : 0
      if (aNull !== bNull) return aNull - bNull
      const aId = a.provenanceGroupId ?? ''
      const bId = b.provenanceGroupId ?? ''
      return aId < bId ? -1 : aId > bId ? 1 : 0
    })
}

// ---------- 主入口 ----------

/**
 * 子问题有界检索(R-03):一次安全 FTS 检索 → 冻结清单过滤 → 稳定排序 →
 * 截断到 chunkLimit → 相邻配对标注 → provenance 组统计 → 组装 trace。
 * 查询为空(纯标点等)或冻结清单内无命中时返回不足标记的空结果,不报错、
 * 不扩写查询、不二次调用模型。
 */
export function retrieveForSubquestion(db: SqliteDb, input: RetrieveForSubquestionInput): RetrievalResult {
  if (typeof input.query !== 'string') {
    throw retrievalInvalid(`query 必须是字符串,收到 ${typeof input.query}`)
  }
  if (!Array.isArray(input.frozenSnapshotIds)) {
    throw retrievalInvalid('frozenSnapshotIds 必须是数组')
  }
  if (input.frozenSnapshotIds.length === 0) {
    throw retrievalInvalid('冻结清单为空:至少需要一个冻结快照才能检索')
  }
  for (const id of input.frozenSnapshotIds) {
    if (typeof id !== 'string' || id === '') {
      throw retrievalInvalid(`冻结快照 ID 必须是非空字符串,收到 ${JSON.stringify(id)}`)
    }
  }
  if (!Number.isInteger(input.chunkLimit) || input.chunkLimit < 1 || input.chunkLimit > MAX_CHUNKS_PER_SUBQUERY) {
    throw retrievalInvalid(
      `chunkLimit 必须是 1~${MAX_CHUNKS_PER_SUBQUERY} 的整数,收到 ${String(input.chunkLimit)}`
    )
  }
  for (const key of ['compareDimensions', 'entityScope'] as const) {
    const value = input[key]
    if (value !== undefined) {
      if (!Array.isArray(value)) {
        throw retrievalInvalid(`${key} 必须是字符串数组`)
      }
      for (const item of value) {
        if (typeof item !== 'string') {
          throw retrievalInvalid(`${key} 的每一项都必须是字符串,收到 ${JSON.stringify(item)}`)
        }
      }
    }
  }

  const frozenSnapshotIds = [...input.frozenSnapshotIds]
  const frozenSet = new Set(frozenSnapshotIds)
  const queryParts = buildQueryParts(input)
  const queryUsed = queryParts.join(' ')
  const queryTokens = tokenizeForSearch(queryUsed)
  const matchQuery = buildMatchQuery(queryTokens)

  const emptyResult = (): RetrievalResult => ({
    hits: [],
    queryUsed,
    truncated: false,
    insufficient: true,
    usedCount: 0,
    provenanceGroups: [],
    trace: {
      queryParts,
      queryUsed,
      queryTokens,
      matchQuery,
      searchVersion: SEARCH_VERSION,
      frozenSnapshotIds,
      candidateCount: 0,
      hitChunkIds: [],
      hitScores: [],
      truncated: false,
      insufficient: true,
      usedCount: 0,
      distinctProvenanceGroups: 0,
      pairedChunkIds: []
    }
  })

  // 分词为空(纯标点/空白查询):无法构造安全 MATCH,直接记检索不足
  if (queryTokens.length === 0) return emptyResult()

  // 每题仅此一次检索;RES-02:冻结集合过滤移入 MATCH 候选阶段(参数绑定),
  // 候选窗口只被冻结清单内内容占据,清单外高分资料不再挤占名额
  const filtered = searchDocuments(db, queryUsed, RETRIEVAL_FETCH_LIMIT, {
    frozenSnapshotIds: frozenSnapshotIds
  })
  const candidateCount = filtered.length
  filtered.sort(compareHits)
  const hits: RetrievalHit[] = filtered.slice(0, input.chunkLimit).map((hit) => ({
    ...hit,
    provenanceGroupId: null,
    pairedWith: null
  }))

  // 内部不变量:任何交付命中都必须在冻结清单内(钳制失效属编程错误,直接暴露)
  for (const hit of hits) {
    if (!frozenSet.has(hit.documentId)) {
      throw new Error(`内部不变量破坏:交付命中越过了冻结清单:${hit.documentId}`)
    }
  }

  const truncated = candidateCount > hits.length
  const insufficient = candidateCount < input.chunkLimit
  const pairedChunkIds = markAdjacentPairs(hits)
  const provenanceGroups = countProvenanceGroups(db, hits)

  return {
    hits,
    queryUsed,
    truncated,
    insufficient,
    usedCount: hits.length,
    provenanceGroups,
    trace: {
      queryParts,
      queryUsed,
      queryTokens,
      matchQuery,
      searchVersion: SEARCH_VERSION,
      frozenSnapshotIds,
      candidateCount,
      hitChunkIds: hits.map((h) => h.chunkId),
      hitScores: hits.map((h) => ({ chunkId: h.chunkId, score: h.score })),
      truncated,
      insufficient,
      usedCount: hits.length,
      distinctProvenanceGroups: provenanceGroups.length,
      pairedChunkIds
    }
  }
}

// ---------- 相邻片段联合 ----------

export interface AdjacentChunk {
  chunkId: string
  documentId: string
  chunkIndex: number
  startOffset: number
  endOffset: number
  /** 邻块原文(规范文本的连续切片,码点 offset) */
  content: string
  /** 邻块是否已在本次交付结果中(已在则不重复计入名额) */
  matched: boolean
}

/**
 * 取相邻片段供联合解释:优先取 chunkIndex+1,不存在(文档末块)时取 chunkIndex-1。
 * 邻块未命中时调用方须把返回的邻块计入本题 chunk 名额,保证交付总数 ≤ 上限;
 * matched=true 表示邻块已随本次结果交付,不重复占用名额。
 */
export function expandAdjacent(
  db: SqliteDb,
  result: RetrievalResult,
  hit: Pick<RetrievalHit, 'documentId' | 'chunkIndex'>
): AdjacentChunk | null {
  // 优先取后一块(阅读方向的自然延续),文档末块时取前一块
  const neighborIndex = hit.chunkIndex + 1
  const fetchChunk = (chunkIndex: number): Omit<AdjacentChunk, 'matched'> | null => {
    const row = db.get<{
      chunk_id: string
      chunk_index: number
      start_offset: number
      end_offset: number
      content: string
    }>(
      `SELECT chunk_id, chunk_index, start_offset, end_offset, content
         FROM retrieval_chunks WHERE document_id = ? AND chunk_index = ?`,
      [hit.documentId, chunkIndex]
    )
    if (!row) return null
    return {
      chunkId: row.chunk_id,
      documentId: hit.documentId,
      chunkIndex: row.chunk_index,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      content: row.content
    }
  }
  const neighbor = fetchChunk(neighborIndex) ?? fetchChunk(hit.chunkIndex - 1)
  if (!neighbor) return null
  return {
    ...neighbor,
    matched: result.hits.some((h) => h.chunkId === neighbor.chunkId)
  }
}
