// 研究侧导入入口(R-02):四格式 → 记录展开 → 来源元数据 → 快照落库。
//
// 与共享导入器(C-05)的边界:
// - 解码/规范化/JSON 投影/分块/分词全部复用 retrieval/ 的既有实现
//   (decodeBytes、normalizePlainText、projectJsonSource、chunkText、tokenizeForSearch),
//   本模块不另写一套规范化与分块;
// - 不直接复用 importDocument 的原因:其幂等键是 raw_sha256(整文件字节),
//   而多记录文件(JSON 数组/CSV 多行)的每条记录都要成为独立逻辑 Source
//   (规格第 5 节),同一 raw_sha256 下需要多行 retrieval_documents,
//   importDocument 会把第 2 条起全部折叠到第 1 行。因此本模块在共享原语之上
//   组织"逐记录"落库,插入 SQL 与 FTS 维护和 importer 逐句一致;
//   单记录文件(md/txt、单对象 JSON)的行为与 importDocument 等价,仅多写研究侧列。
//
// 关键一致性约束(gold offset 的锚点):
// - JSON 文件的规范全文 = normalizePlainText(projectJsonSource(整文件))(与 C-05、
//   gold_integrity 的 canonOf 同一重放契约);
// - CSV 文件的规范全文 = 表头 + 数据行按列序展平后 normalizePlainText
//   (与 evals/datasets/research_v1 的 gold 坐标系一致;C-05 的 importer 对 CSV
//   只做纯文本规范化,字段级映射属研究侧职责,见 importer.ts 的注释);
// - 每条记录行的 normalized_text 保存整文件规范全文(不是仅本记录投影):
//   research_v1 的 gold 证据坐标是全文件投影坐标,且同一文件多条记录的 gold
//   共享同一逻辑 snapshot_id,只有全文件文本能让所有 span 可重定位;
//   不同记录靠 source_locator 区分,符合"相同规范文本可共享内容对象、
//   不同逻辑 Source 分别保留"的规格语义。
//
// offset 语义:码点索引(零起点、左闭右开),与 Array.from(text) 切片对齐。
//
// RES-02:整文件规范全文仍是每条记录行的 normalized_text(gold 全文件坐标不变),
// 但 FTS 分块只按各记录的范围(projectResearchSourceWithRanges 累计的 RecordScope)
// 进行——范围内分块、检索与验证,块/邻块/span 不再跨记录端点;record_scope 随
// source_metadata_json 持久化并冻结进清单(v2)。

import { randomUUID } from 'node:crypto'
import type { SqliteDb } from '../db/connection'
import { appError } from '../../shared/operations'
import { OperationError } from '../db/operations'
import { systemClock, type Clock } from '../../shared/clock'
import {
  decodeBytes,
  normalizePlainText,
  projectJsonSource,
  sha256Hex,
  textSha256
} from '../retrieval/normalize'
import { SEARCH_VERSION, tokenizeForSearch } from '../retrieval/tokenize'
import { chunkRecord, validateRecordScope, type RecordScope } from './recordScope'
import { MAX_DOCUMENT_BYTES } from '../retrieval/importer'

// ---------- 常量与类型 ----------

/** 每批导入的文件上限(规格第 7 节:每批 100 文件为规划上限) */
export const IMPORT_BATCH_LIMIT = 100

/** 单记录投影文本的码点上限(规格第 9 节:JSON/CSV 单记录 100,000 码点) */
export const MAX_RECORD_CODE_POINTS = 100_000

export type ResearchSourceType = 'markdown' | 'txt' | 'json' | 'csv'

/** 采集时间依据:source=调用方提供;imported=未知,用导入时间,不冒充招聘发布时间 */
export type CollectionTimeBasis = 'source' | 'imported'

/** 传播关系:copy=身份+内容 hash 自动识别的副本;declared=调用方声明;unknown=未知传播关系 */
export type ProvenanceRelation = 'copy' | 'declared' | 'unknown'

/** 记录类来源的固定字段与顺序(规格第 5 节 JSON/CSV v1 schema;description 必填) */
const RECORD_FIELDS = ['title', 'company', 'location', 'description', 'source_url', 'published_at'] as const
/** 参与来源身份与核心内容 hash 的字段(排除 source_url/published_at:转载换 URL/日期仍是同一 JD) */
const CORE_FIELDS = ['title', 'company', 'location', 'description'] as const

export interface ResearchSourceInput {
  /** 文件名(展示与扩展名推断;不参与任何 hash) */
  sourceName: string
  /** 缺省按扩展名推断(.md/.txt/.json/.csv) */
  sourceType?: ResearchSourceType
  bytes: Buffer
  /** md/txt 的标题;记录类来源以记录字段为准 */
  title?: string
  /** 来源稳定身份声明;缺省时记录类用 company+title 派生,md/txt 用 title 或文件名 */
  sourceIdentity?: string
  /**
   * md/txt 核心内容等价声明(如转载剥离"转载"标记后的规范化正文)。
   * 提供;声明即"用户/标注者确认过同内容",不同字节可判 copy;
   * 缺省用整篇规范文本做核心内容——近似改写不自动合并(规格:疑似重复须确认)。
   */
  contentKey?: string
  /** 声明式分组:调用方已知转载/同岗位关系时直接指定(如 eval 标注的 pg-*) */
  provenanceGroupId?: string
  /** 已知的资料采集/导出时间(UTC ISO 8601);缺省用导入时间并记 collection_time_basis=imported */
  collectedAt?: string
  /** md/txt 显式声明的发布时间;记录类来源以记录字段为准 */
  publishedAt?: string
  /** 发布时间是否经人工核验(默认 false:仅透传记录值,不冒充可验证状态) */
  publishedAtVerified?: boolean
  /** 是否样例材料(默认 false) */
  sample?: boolean
}

export interface ResearchSourceError {
  code: 'DOCUMENT_PARSE_ERROR' | 'UNSUPPORTED_FORMAT' | 'IMPORT_LIMIT_EXCEEDED'
  message: string
}

/** 导入成功的逻辑 Source(一条 retrieval_documents 行,即一个 snapshot) */
export interface ImportedResearchSource {
  ok: true
  /** snapshot_id = retrieval_documents.document_id */
  documentId: string
  sourceName: string
  sourceType: ResearchSourceType
  /** JSON Pointer("/0")或 CSV 数据行号("row:1");整文件单源(md/txt、单对象 JSON)为 null */
  sourceLocator: string | null
  /** 记录序(0 起);整文件单源为 null。同一文件的首条记录是该文件逻辑 id 的代表快照 */
  recordIndex: number | null
  representative: boolean
  sourceIdentity: string
  provenanceGroupId: string
  provenanceRelation: ProvenanceRelation
  rawSha256: string
  /** 整文件规范全文的 sha256(UTF-8 字节) */
  textSha256: string
  /** 核心内容(排除 URL/发布时间)的 sha256,副本判定依据 */
  contentSha256: string
  /** 整文件规范全文的码点长度 */
  codePointLength: number
  collectedAt: string
  collectionTimeBasis: CollectionTimeBasis
  /** 本记录范围内的块数(RES-02:范围内分块,不再是整文件块数) */
  chunkCount: number
  /** 本记录在整文件规范全文坐标系内的范围;旧库行(无范围)为 null */
  recordScope: RecordScope | null
  /** 同一原始字节+定位已导入过,复用既有快照 */
  deduped: boolean
}

export interface FailedResearchSource {
  ok: false
  sourceName: string
  sourceType: ResearchSourceType | null
  recordIndex: number | null
  sourceLocator: string | null
  error: ResearchSourceError
}

export type ResearchSourceOutcome = ImportedResearchSource | FailedResearchSource

export interface ImportResearchSourcesInput {
  sources: ResearchSourceInput[]
  /** 领域时钟;默认系统时钟(测试注入 fixedClock) */
  clock?: Clock
}

// ---------- 错误工具 ----------

function validationError(message: string): OperationError {
  return new OperationError(appError('VALIDATION', message, { retryable: false }))
}

function parseError(message: string): ResearchSourceError {
  return { code: 'DOCUMENT_PARSE_ERROR', message }
}

function failed(
  sourceName: string,
  sourceType: ResearchSourceType | null,
  recordIndex: number | null,
  locator: string | null,
  error: ResearchSourceError
): FailedResearchSource {
  return { ok: false, sourceName, sourceType, recordIndex, sourceLocator: locator, error }
}

// ---------- 记录展开(纯函数,不触库) ----------

interface ParsedRecord {
  /** JSON Pointer / CSV 行号;整文件单源为 null */
  locator: string | null
  recordIndex: number | null
  fields: Partial<Record<(typeof RECORD_FIELDS)[number], string>>
  /** md/txt:整篇规范文本 */
  fullText: string | null
  /** md/txt 的来源类型 */
  sourceType: ResearchSourceType
}

/** RFC 4180 CSV 解析:双写转义、引号内逗号/换行保留;仅 \n 分行(与 gold 投影器一致) */
function parseCsvRows(content: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]!
    if (inQuotes) {
      if (ch === '"' && content[i + 1] === '"') {
        field += '"'
        i += 1
      } else if (ch === '"') {
        inQuotes = false
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** CSV 记录展开:表头按固定 schema 对齐,数据行取值;缺 description 列在逐记录校验时报错 */
function expandCsv(text: string, sourceName: string): { records: ParsedRecord[]; error: ResearchSourceError | null } {
  const rows = parseCsvRows(text)
  const [head, ...data] = rows
  if (!head || data.length === 0) {
    return { records: [], error: parseError(`${sourceName}:CSV 缺少表头或数据行`) }
  }
  const columnIndex = new Map<string, number>()
  head.forEach((name, i) => columnIndex.set(name.trim(), i))
  const records: ParsedRecord[] = []
  for (let i = 0; i < data.length; i += 1) {
    const row = data[i]!
    const fields: ParsedRecord['fields'] = {}
    for (const field of RECORD_FIELDS) {
      const idx = columnIndex.get(field)
      if (idx !== undefined) fields[field] = row[idx] ?? ''
    }
    records.push({ locator: `row:${i + 1}`, recordIndex: i, fields, fullText: null, sourceType: 'csv' })
  }
  return { records, error: null }
}

/** JSON 记录展开:单对象(整文件即记录,locator=null)或对象数组(locator=/i,JSON Pointer) */
function expandJson(text: string, sourceName: string): { records: ParsedRecord[]; error: ResearchSourceError | null } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { records: [], error: parseError(`${sourceName}:文件不是合法的 JSON`) }
  }
  const items: Array<{ value: unknown; locator: string | null; index: number | null }> = []
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return { records: [], error: parseError(`${sourceName}:JSON 数组没有记录`) }
    }
    parsed.forEach((value, i) => items.push({ value, locator: `/${i}`, index: i }))
  } else if (parsed !== null && typeof parsed === 'object') {
    items.push({ value: parsed, locator: null, index: null })
  } else {
    return { records: [], error: parseError(`${sourceName}:JSON 顶层必须是对象或数组`) }
  }
  const records: ParsedRecord[] = []
  for (const item of items) {
    if (item.value === null || typeof item.value !== 'object' || Array.isArray(item.value)) {
      return { records: [], error: parseError(`${sourceName}:JSON 记录必须是对象(locator=${item.locator ?? 'root'})`) }
    }
    const obj = item.value as Record<string, unknown>
    const fields: ParsedRecord['fields'] = {}
    for (const field of RECORD_FIELDS) {
      const v = obj[field]
      if (typeof v === 'string') fields[field] = v
      else if (typeof v === 'number' || typeof v === 'boolean') fields[field] = String(v)
    }
    records.push({ locator: item.locator, recordIndex: item.index, fields, fullText: null, sourceType: 'json' })
  }
  return { records, error: null }
}

// ---------- 分组判定 ----------

function deriveIdentity(input: ResearchSourceInput, record: ParsedRecord): string {
  if (input.sourceIdentity) return input.sourceIdentity
  if (record.fullText !== null) return input.title ?? input.sourceName
  const company = record.fields.company?.trim() ?? ''
  const title = record.fields.title?.trim() ?? ''
  if (company && title) return `${company}·${title}`
  if (title) return title
  if (company) return company
  return `record:${record.locator ?? 'root'}`
}

/** 核心内容文本:记录类取固定核心字段的投影(复用 projectJsonSource 的确定序);
 *  md/txt 取整篇规范文本。排除 source_url/published_at——同一 JD 的转载换 URL/日期仍是同一内容 */
function coreTextOf(record: ParsedRecord): string {
  if (record.fullText !== null) return record.fullText
  const core: Record<string, string> = {}
  for (const field of CORE_FIELDS) core[field] = record.fields[field] ?? ''
  return normalizePlainText(projectJsonSource(JSON.stringify(core)))
}

// ---------- 记录范围投影(RES-02) ----------

/** 多记录文件投影结果:整文件规范全文 + 各记录的码点范围 */
export interface ProjectedResearchFile {
  normalizedText: string
  scopes: RecordScope[]
}

/**
 * projectResearchSourceWithRanges(RES-02):复用现有 JSON 键排序/叶值遍历与 CSV
 * 解析,按产生字段的记录归属累计码点范围,禁止通过 indexOf 文本猜范围。
 * 输出 normalizedText 必须逐字节等于现存 normalizePlainText(projectJsonSource(...))
 * 或 CSV 表头加各行字段展平投影(运行时防御断言,不等价即整个文件导入拒绝);
 * 保留 BOM、CRLF→LF、NFC 的现有顺序。JSON 数组对象的全部投影叶子属于其 /i;
 * CSV 数据行属于 row:i,表头保留在全文但不进入任何数据记录的支持范围;
 * 单对象 JSON、md/txt 为全范围。
 */
export function projectResearchSourceWithRanges(
  sourceType: ResearchSourceType,
  decodedText: string
): ProjectedResearchFile {
  if (sourceType === 'markdown' || sourceType === 'txt') {
    const normalizedText = normalizePlainText(decodedText)
    return {
      normalizedText,
      scopes: [{
        version: 1,
        coordinateSystem: 'full-file-codepoint-v1',
        sourceLocator: null,
        startOffset: 0,
        endOffset: Array.from(normalizedText).length
      }]
    }
  }

  const parseInput = normalizePlainText(decodedText)
  const segments: Array<{ text: string; locator: string | null }> = []
  if (sourceType === 'json') {
    let parsed: unknown
    try {
      parsed = JSON.parse(parseInput)
    } catch {
      throw parseError('文件不是合法的 JSON')
    }
    // 与 projectJson 的 projectJsonSource 同序遍历(键排序、数组保序、空串跳过)
    const walk = (value: unknown, locator: string | null): void => {
      if (value === null || value === undefined) return
      if (typeof value === 'string') {
        if (value.trim() !== '') segments.push({ text: value, locator })
        return
      }
      if (typeof value === 'number' || typeof value === 'boolean') {
        segments.push({ text: String(value), locator })
        return
      }
      if (Array.isArray(value)) {
        for (const item of value) walk(item, locator)
        return
      }
      for (const key of Object.keys(value).sort()) {
        walk((value as Record<string, unknown>)[key], locator)
      }
    }
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) throw parseError('JSON 数组没有记录')
      parsed.forEach((item, i) => walk(item, `/${i}`))
    } else if (parsed !== null && typeof parsed === 'object') {
      walk(parsed, null)
    } else {
      throw parseError('JSON 顶层必须是对象或数组')
    }
  } else if (sourceType === 'csv') {
    const rows = parseCsvRows(parseInput)
    const [head, ...data] = rows
    if (!head || data.length === 0) throw parseError('CSV 缺少表头或数据行')
    for (const field of head) segments.push({ text: field, locator: null })
    data.forEach((row, i) => {
      for (const field of row) segments.push({ text: field, locator: `row:${i + 1}` })
    })
  } else {
    throw parseError(`不支持的格式:${String(sourceType)}`)
  }

  // 逐段规范化(与 normalizePlainText 相同的 CRLF→LF 与 NFC;段间 '\n' 分隔符
  // 阻断 NFC 跨段组合),首段行首 BOM 与全局规范化一致地剥离。
  const normSegments = segments.map((s) => ({
    locator: s.locator,
    text: s.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').normalize('NFC')
  }))
  if (normSegments.length > 0 && normSegments[0]!.text.startsWith('\uFEFF')) {
    normSegments[0]!.text = normSegments[0]!.text.slice(1)
  }
  const normalizedText = normSegments.map((s) => s.text).join('\n')

  // 投影等价防御:必须与现存共享投影器逐字节一致,否则整个文件导入拒绝
  const legacyProjection =
    sourceType === 'json'
      ? normalizePlainText(projectJsonSource(parseInput))
      : normalizePlainText(projectCsvSource(parseInput))
  if (normalizedText !== legacyProjection) {
    throw parseError('记录范围投影与现契约不等价,拒绝导入')
  }

  // 按记录归属累计码点范围:组内段间 '\n' 计入本记录,记录间分隔符不入任何范围
  const scopes: RecordScope[] = []
  let cursor = 0
  let current: { locator: string | null; start: number; end: number } | null = null
  const flush = (): void => {
    if (current !== null && current.end > current.start) {
      scopes.push({
        version: 1,
        coordinateSystem: 'full-file-codepoint-v1',
        sourceLocator: current.locator,
        startOffset: current.start,
        endOffset: current.end
      })
    }
  }
  for (const seg of normSegments) {
    const len = Array.from(seg.text).length
    if (current === null || current.locator !== seg.locator) {
      flush()
      current = { locator: seg.locator, start: cursor, end: cursor + len }
    } else {
      current.end = cursor + len
    }
    cursor += len + 1 // 段间分隔符 '\n'
  }
  flush()
  // CSV:表头不构成记录范围(保留在全文但不进入任何数据记录的支持范围)
  return {
    normalizedText,
    scopes: sourceType === 'csv' ? scopes.filter((s) => s.sourceLocator !== null) : scopes
  }
}

// ---------- 主入口 ----------

/**
 * 研究侧来源导入(R-02):
 * 1) 逐文件解码(BOM/UTF-16/严格 UTF-8)、展开记录(JSON 单对象/数组、CSV 表头);
 * 2) 每条记录成为一个逻辑 Source:规范全文(整文件投影)+ 分块 + FTS 索引 +
 *    v9 来源列(source_identity/provenance_group_id/source_locator/元数据/采集时间依据);
 * 3) description 必填(记录类),缺失按记录报 DOCUMENT_PARSE_ERROR,其余有效记录照常保留;
 * 4) 幂等:同一 raw_sha256 + source_locator 复用既有快照(deduped=true),不改历史行;
 * 5) 分组:身份 + 核心内容 hash 命中既有来源 → 并组(copy);调用方声明 → declared;否则新组(unknown)。
 * 每个文件一个事务:有效记录原子写入;文件级失败(解码/解析)不留任何行。
 */
export function importResearchSources(db: SqliteDb, input: ImportResearchSourcesInput): ResearchSourceOutcome[] {
  if (!Array.isArray(input.sources) || input.sources.length === 0) {
    throw validationError('导入清单为空:至少需要一个来源文件')
  }
  if (input.sources.length > IMPORT_BATCH_LIMIT) {
    throw validationError(`单批导入超过 ${IMPORT_BATCH_LIMIT} 个文件上限,收到 ${input.sources.length}`)
  }
  const clock = input.clock ?? systemClock
  const results: ResearchSourceOutcome[] = []
  /** 本批已成功导入的逻辑 Source(跨文件):分组判定用,与展示顺序无关 */
  const importedOk: ImportedResearchSource[] = []

  for (const source of input.sources) {
    results.push(...importOneFile(db, source, clock, importedOk))
  }
  return results
}

function importOneFile(
  db: SqliteDb,
  source: ResearchSourceInput,
  clock: Clock,
  importedOk: ImportedResearchSource[]
): ResearchSourceOutcome[] {
  const { sourceName, bytes } = source
  const sourceType = source.sourceType ?? sourceTypeOf(sourceName)
  if (sourceType === null) {
    return [failed(sourceName, null, null, null, {
      code: 'UNSUPPORTED_FORMAT',
      message: `${sourceName}:不支持的格式,仅支持 .md/.txt/.json/.csv`
    })]
  }
  if (bytes.length > MAX_DOCUMENT_BYTES) {
    return [failed(sourceName, sourceType, null, null, {
      code: 'IMPORT_LIMIT_EXCEEDED',
      message: `${sourceName}:单文件超过 5 MB 上限,请拆分后导入`
    })]
  }
  if (bytes.length === 0) {
    return [failed(sourceName, sourceType, null, null, parseError(`${sourceName}:空文件无法导入`))]
  }

  // 解码与展开(纯阶段):失败不留任何行。
  // JSON/CSV 在解析前先做行尾/NFC 归一:记录字段值与投影全文共享同一形态,
  // 且不影响整文件投影契约(CRLF→LF 与 NFC 不改变投影结构,gold 重放等价)。
  let decodedText: string
  let rawSha256: string
  try {
    const decoded = decodeBytes(bytes)
    decodedText = decoded.text
    rawSha256 = decoded.rawSha256
  } catch (err) {
    return [failed(sourceName, sourceType, null, null, parseError(`${sourceName}:${err instanceof Error ? err.message : String(err)}`))]
  }
  const parseInput =
    sourceType === 'json' || sourceType === 'csv' ? normalizePlainText(decodedText) : decodedText
  let records: ParsedRecord[]
  if (sourceType === 'json') {
    const expanded = expandJson(parseInput, sourceName)
    if (expanded.error) return [failed(sourceName, sourceType, null, null, expanded.error)]
    records = expanded.records
  } else if (sourceType === 'csv') {
    const expanded = expandCsv(parseInput, sourceName)
    if (expanded.error) return [failed(sourceName, sourceType, null, null, expanded.error)]
    records = expanded.records
  } else {
    // md/txt:整文件是单一逻辑 Source,正文即 description
    records = [{ locator: null, recordIndex: null, fields: {}, fullText: normalizePlainText(decodedText), sourceType }]
  }

  // 规范全文与记录范围(RES-02):JSON/CSV 走投影契约并累计记录范围,md/txt 全范围。
  // 投影不等价或解析失败时整个文件拒绝(不留任何行),其他文件可独立处理。
  let projected: ProjectedResearchFile
  try {
    projected = projectResearchSourceWithRanges(sourceType, decodedText)
  } catch (err) {
    return [failed(sourceName, sourceType, null, null, parseError(`${sourceName}:${err instanceof Error ? err.message : String(err)}`))]
  }
  const normText = projected.normalizedText
  const textSha = textSha256(normText)
  const codePointLength = Array.from(normText).length

  // 逐记录校验(description 必填、单记录码点上限、记录范围存在),先于任何写入。
  // 失败与有效条目都按记录序排队,最终 outcomes 严格按记录序输出。
  type ValidItem = { record: ParsedRecord; identity: string; contentSha: string; description: string; scope: RecordScope }
  const queue: Array<{ failure: ResearchSourceOutcome | null; valid: ValidItem | null }> = []
  for (const record of records) {
    const locator = record.locator
    const index = record.recordIndex
    const description = record.fullText !== null ? record.fullText : record.fields.description
    const scope = projected.scopes.find((s) => s.sourceLocator === locator) ?? null
    if (scope === null) {
      // 有效记录必须有范围(退化投影属文件结构异常):逐记录拒绝,不从全文猜边界
      queue.push({
        failure: failed(sourceName, sourceType, index, locator, parseError(
          `${sourceName}${describeLocator(locator)}:记录范围缺失,拒绝从扁平全文猜测边界`
        )),
        valid: null
      })
      continue
    }
    if (typeof description !== 'string' || description.trim() === '') {
      queue.push({
        failure: failed(sourceName, sourceType, index, locator, parseError(
          `${sourceName}${describeLocator(locator)}:缺少必填字段 description`
        )),
        valid: null
      })
      continue
    }
    const coreText = coreTextOf(record)
    if (Array.from(coreText).length > MAX_RECORD_CODE_POINTS) {
      queue.push({
        failure: failed(sourceName, sourceType, index, locator, parseError(
          `${sourceName}${describeLocator(locator)}:单记录超过 ${MAX_RECORD_CODE_POINTS} 码点上限,请拆分或排除`
        )),
        valid: null
      })
      continue
    }
    queue.push({
      failure: null,
      valid: {
        record,
        identity: deriveIdentity(source, record),
        contentSha: sha256Hex(coreText),
        description,
        scope
      }
    })
  }
  const valid = queue.map((q) => q.valid).filter((v): v is ValidItem => v !== null)

  // md/txt 核心内容等价声明:声明时覆盖 contentSha(与记录类共享身份+hash 判定通道)。
  // 声明即"调用方确认过同内容"(如转载剥离转载标记后的规范化正文);缺省不改写——
  // 近似文本保持 unknown,不自动合并(规格:疑似重复须确认后才能并组)。
  if (source.contentKey !== undefined) {
    const declaredSha = sha256Hex(normalizePlainText(source.contentKey))
    for (const item of valid) item.contentSha = declaredSha
  }

  if (valid.length === 0) {
    // 全部记录无效:文件级错误已在上面逐条给出;多记录文件补充一个整体提示没有额外信息量,直接返回
    return queue.map((q) => q.failure!).filter(Boolean)
  }

  const now = clock.now().toISOString()
  const collectedAt = source.collectedAt ?? now
  const timeBasis: CollectionTimeBasis = source.collectedAt ? 'source' : 'imported'

  /** 本文件的逐记录结果,事务成功后合并输出(保持记录序) */
  const outcomes: ResearchSourceOutcome[] = []
  const importedThisFile: ImportedResearchSource[] = []
  db.transaction(() => {
    for (const item of valid) {
      const { record, identity, contentSha, description, scope } = item
      const locator = record.locator

      // 幂等:同一原始字节 + 同一定位复用既有快照(同文件不同名称不产生新行)
      const existing = db.get<{ document_id: string }>(
        'SELECT document_id FROM retrieval_documents WHERE raw_sha256 = ? AND source_locator IS ?',
        [rawSha256, locator]
      )
      if (existing) {
        const stored = getResearchSourceRecord(db, existing.document_id)
        if (stored) {
          importedThisFile.push({
            ok: true,
            documentId: stored.documentId,
            sourceName,
            sourceType,
            sourceLocator: stored.sourceLocator,
            recordIndex: locator === null ? null : record.recordIndex,
            representative: locator === null,
            sourceIdentity: stored.sourceIdentity,
            provenanceGroupId: stored.provenanceGroupId,
            provenanceRelation: stored.provenanceRelation,
            rawSha256: stored.rawSha256,
            textSha256: stored.textSha256,
            contentSha256: stored.contentSha256,
            codePointLength: stored.codePointLength,
            collectedAt: stored.collectedAt,
            collectionTimeBasis: stored.collectionTimeBasis,
            chunkCount: stored.chunkCount,
            recordScope: stored.recordScope,
            deduped: true
          })
          continue
        }
      }

      // 分组判定:调用方声明优先;其次身份+核心内容 hash 命中既有来源(本批内存优先,再查库)
      let provenanceGroupId: string
      let relation: ProvenanceRelation
      if (source.provenanceGroupId) {
        provenanceGroupId = source.provenanceGroupId
        relation = 'declared'
      } else {
        // 元数据 JSON 用 LIKE 定位核心内容 hash:content_sha256 只在导入路径写入,属受控值
        const matchedGroup =
          [...importedThisFile, ...importedOk].find(
            (o) => o.sourceIdentity === identity && o.contentSha256 === contentSha
          )?.provenanceGroupId ??
          db.get<{ provenance_group_id: string }>(
            `SELECT provenance_group_id FROM retrieval_documents
             WHERE source_identity = ? AND source_metadata_json LIKE ? AND provenance_group_id IS NOT NULL
             ORDER BY rowid ASC LIMIT 1`,
            [identity, `%"content_sha256":"${contentSha}"%`]
          )?.provenance_group_id
        if (matchedGroup) {
          provenanceGroupId = matchedGroup
          relation = 'copy'
        } else {
          provenanceGroupId = `pg-${randomUUID()}`
          relation = 'unknown'
        }
      }

      const publishedAtValue = record.fullText !== null ? (source.publishedAt ?? null) : (record.fields.published_at ?? null)
      const metadata = {
        title: record.fullText !== null ? (source.title ?? sourceName) : (record.fields.title ?? ''),
        company: record.fullText !== null ? null : (record.fields.company ?? ''),
        location: record.fullText !== null ? null : (record.fields.location ?? ''),
        // md/txt 的正文即描述,不再复制进元数据(全文已存 normalized_text)
        description: record.fullText !== null ? null : description,
        source_url: record.fullText !== null ? null : (record.fields.source_url ?? ''),
        published_at: {
          value: publishedAtValue,
          source: record.fullText !== null ? (source.publishedAt ? 'caller' : 'none') : 'record',
          verified: source.publishedAtVerified ?? false
        },
        collected_at: collectedAt,
        collection_time_basis: timeBasis,
        provenance_relation: relation,
        content_sha256: contentSha,
        sample: source.sample ?? false,
        // RES-02:记录范围随元数据持久化(整文件规范全文码点坐标系)
        record_scope: scope
      }

      const documentId = randomUUID()
      db.run(
        `INSERT INTO retrieval_documents
           (document_id, source_name, source_type, raw_sha256, text_sha256, normalized_text, size_bytes, created_at,
            source_identity, provenance_group_id, source_locator, source_metadata_json, collection_time_basis)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          documentId,
          sourceName,
          sourceType,
          rawSha256,
          textSha,
          normText,
          bytes.length,
          now,
          identity,
          provenanceGroupId,
          locator,
          JSON.stringify(metadata),
          timeBasis
        ]
      )
      // RES-02:FTS 只索引本记录范围内的块(局部 offset 加 scope.startOffset),
      // 块/邻块/span 不跨记录端点;其他记录的内容不再被复制进本记录的索引
      const chunks = chunkRecord(normText, scope)
      for (const chunk of chunks) {
        const chunkId = randomUUID()
        const searchText = tokenizeForSearch(chunk.content).join(' ')
        db.run(
          `INSERT INTO retrieval_chunks
             (chunk_id, document_id, chunk_index, start_offset, end_offset, content, search_text, search_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [chunkId, documentId, chunk.index, chunk.startOffset, chunk.endOffset, chunk.content, searchText, SEARCH_VERSION]
        )
        // 外部内容 FTS4:docid 必须等于内容表的 rowid(与 importer 同一约定)
        const row = db.get<{ rid: number }>('SELECT last_insert_rowid() AS rid')
        db.run('INSERT INTO retrieval_fts(docid, search_text) VALUES (?, ?)', [row!.rid, searchText])
      }

      importedThisFile.push({
        ok: true,
        documentId,
        sourceName,
        sourceType,
        sourceLocator: locator,
        recordIndex: locator === null ? null : record.recordIndex,
        representative: locator === null,
        sourceIdentity: identity,
        provenanceGroupId,
        provenanceRelation: relation,
        rawSha256,
        textSha256: textSha,
        contentSha256: contentSha,
        codePointLength,
        collectedAt,
        collectionTimeBasis: timeBasis,
        chunkCount: chunks.length,
        recordScope: scope,
        deduped: false
      })
    }
  })

  // 事务成功后按记录序合并输出,并登记到本批已导入集合(跨文件分组判定用)
  const okByLocator = new Map(importedThisFile.map((o) => [o.sourceLocator, o]))
  const merged: ResearchSourceOutcome[] = []
  for (const q of queue) {
    if (q.failure) merged.push(q.failure)
    else merged.push(okByLocator.get(q.valid!.record.locator)!)
  }
  for (const o of importedThisFile) {
    if (!o.deduped) importedOk.push(o)
  }
  return merged
}

// ---------- 读取辅助 ----------

/** 已入库逻辑 Source 的读取形态(供 R-03/R-07 与本模块幂等路径使用) */
export interface ResearchSourceRecord {
  documentId: string
  sourceName: string
  sourceType: ResearchSourceType
  sourceLocator: string | null
  sourceIdentity: string
  provenanceGroupId: string
  provenanceRelation: ProvenanceRelation
  rawSha256: string
  textSha256: string
  contentSha256: string
  normalizedText: string
  codePointLength: number
  collectedAt: string
  collectionTimeBasis: CollectionTimeBasis
  chunkCount: number
  /** RES-02:记录范围(整文件规范全文码点坐标系);旧库行(无范围)为 null */
  recordScope: RecordScope | null
  metadata: Record<string, unknown>
}

/** 读取一条逻辑 Source(含 v9 研究侧列与冻结元数据);不存在返回 null */
export function getResearchSourceRecord(db: SqliteDb, documentId: string): ResearchSourceRecord | null {
  const row = db.get<{
    document_id: string
    source_name: string
    source_type: string
    source_locator: string | null
    source_identity: string | null
    provenance_group_id: string | null
    raw_sha256: string
    text_sha256: string
    normalized_text: string
    source_metadata_json: string | null
    collection_time_basis: string | null
  }>(
    `SELECT document_id, source_name, source_type, source_locator, source_identity, provenance_group_id,
            raw_sha256, text_sha256, normalized_text, source_metadata_json, collection_time_basis
     FROM retrieval_documents WHERE document_id = ?`,
    [documentId]
  )
  if (!row) return null
  const metadata = (row.source_metadata_json ? JSON.parse(row.source_metadata_json) : {}) as Record<string, unknown>
  const contentSha256 = typeof metadata.content_sha256 === 'string' ? metadata.content_sha256 : ''
  const codePointLength = Array.from(row.normalized_text).length
  const recordScope =
    metadata.record_scope === undefined ? null : validateRecordScope(metadata.record_scope, codePointLength)
  return {
    documentId: row.document_id,
    sourceName: row.source_name,
    sourceType: row.source_type as ResearchSourceType,
    sourceLocator: row.source_locator,
    sourceIdentity: row.source_identity ?? '',
    provenanceGroupId: row.provenance_group_id ?? '',
    provenanceRelation: (metadata.provenance_relation ?? 'unknown') as ProvenanceRelation,
    rawSha256: row.raw_sha256,
    textSha256: row.text_sha256,
    contentSha256,
    normalizedText: row.normalized_text,
    codePointLength,
    collectedAt: typeof metadata.collected_at === 'string' ? metadata.collected_at : '',
    collectionTimeBasis: (row.collection_time_basis === 'source' ? 'source' : 'imported'),
    chunkCount:
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM retrieval_chunks WHERE document_id = ?', [row.document_id])?.n ?? 0,
    recordScope,
    metadata
  }
}

// ---------- 内部工具 ----------

function sourceTypeOf(sourceName: string): ResearchSourceType | null {
  const lower = sourceName.toLowerCase()
  if (lower.endsWith('.md')) return 'markdown'
  if (lower.endsWith('.txt')) return 'txt'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.csv')) return 'csv'
  return null
}

function describeLocator(locator: string | null): string {
  return locator === null ? '' : `(locator=${locator})`
}

/**
 * CSV 投影:表头 + 数据行按列序展平(与 evals gold 坐标系同一契约)。
 * 与 parseCsvRows 共用解析,保证记录值与投影文本永不漂移。
 */
function projectCsvSource(content: string): string {
  const rows = parseCsvRows(content)
  const [head, ...data] = rows
  if (!head || data.length === 0) throw new Error('CSV 缺少表头或数据行')
  const out: string[] = [...head]
  for (const r of data) out.push(...r)
  return out.join('\n')
}
