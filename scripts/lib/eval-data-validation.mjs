// T12 纯校验：记录范围由同序投影累计；结论绑定整个数据树和每个成员内容。
import { createHash } from 'node:crypto'

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const normalize = (text) => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').normalize('NFC')
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value) => typeof value === 'string' && value.trim() !== ''
const hashString = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

function csvRows(text) {
  const rows = []
  let row = [], field = '', quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1 }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else field += ch
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

export function projectRecordRanges(sourceType, decodedText) {
  if (sourceType === 'markdown' || sourceType === 'txt') {
    const normalizedText = normalize(decodedText)
    return { normalizedText, records: [{ sourceLocator: null, startOffset: 0, endOffset: Array.from(normalizedText).length }] }
  }
  const input = normalize(decodedText)
  const segments = []
  if (sourceType === 'json') {
    const parsed = JSON.parse(input)
    const walk = (value, locator) => {
      if (value === null || value === undefined) return
      if (typeof value === 'string') { if (value.trim() !== '') segments.push({ text: value, locator }); return }
      if (typeof value === 'number' || typeof value === 'boolean') { segments.push({ text: String(value), locator }); return }
      if (Array.isArray(value)) { for (const item of value) walk(item, locator); return }
      for (const key of Object.keys(value).sort()) walk(value[key], locator)
    }
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) throw new Error('JSON 数组没有记录')
      parsed.forEach((item, i) => walk(item, `/${i}`))
    } else if (plainObject(parsed)) walk(parsed, null)
    else throw new Error('JSON 顶层必须是对象或数组')
  } else if (sourceType === 'csv') {
    const [header, ...data] = csvRows(input)
    if (!header || data.length === 0) throw new Error('CSV 缺少表头或数据行')
    for (const field of header) segments.push({ text: field, locator: null })
    data.forEach((row, i) => { for (const field of row) segments.push({ text: field, locator: `row:${i + 1}` }) })
  } else throw new Error(`不支持的格式:${String(sourceType)}`)

  const normalizedSegments = segments.map((s) => ({ ...s, text: s.text.replace(/\r\n?/g, '\n').normalize('NFC') }))
  if (normalizedSegments[0]?.text.startsWith('\uFEFF')) normalizedSegments[0].text = normalizedSegments[0].text.slice(1)
  const normalizedText = normalizedSegments.map((s) => s.text).join('\n')
  const records = []
  let cursor = 0, current = null
  const flush = () => {
    if (current && current.endOffset > current.startOffset) records.push(current)
  }
  for (const segment of normalizedSegments) {
    const length = Array.from(segment.text).length
    if (!current || current.sourceLocator !== segment.locator) {
      flush()
      current = { sourceLocator: segment.locator, startOffset: cursor, endOffset: cursor + length }
    } else current.endOffset = cursor + length
    cursor += length + 1
  }
  flush()
  return { normalizedText, records: sourceType === 'csv' ? records.filter((r) => r.sourceLocator !== null) : records }
}

/** gold 自身 hash 先核对；完整范围恰有一个所属记录才成立。 */
export function validateGoldEvidence(projected, evidence) {
  const textSha256 = sha256(projected.normalizedText)
  const rejected = (reason, count = 0) => ({ ok: false, reason, sourceLocator: null, textSha256, containingRecords: count })
  if (evidence.text_sha256 !== textSha256) return rejected('gold text_sha256 与规范全文不一致')
  const chars = Array.from(projected.normalizedText)
  const start = evidence.start_offset, end = evidence.end_offset
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end || end > chars.length) return rejected('gold offset 非法或越界')
  if (chars.slice(start, end).join('') !== evidence.quote) return rejected('gold quote 与坐标切片不一致')
  const owners = projected.records.filter((r) => r.startOffset <= start && end <= r.endOffset)
  if (owners.length !== 1) return rejected(`gold 完整范围须唯一归属记录,实际 ${owners.length} 条`, owners.length)
  return { ok: true, reason: null, sourceLocator: owners[0].sourceLocator, textSha256, containingRecords: 1 }
}

/** 只验证绑定与审查元数据；leak 是有效结论，但冻结调用方必须拒绝它。 */
export function validateConclusion(candidate, value, datasetSha256) {
  if (!plainObject(value) || value.schemaVersion !== 1 || !hashString(datasetSha256) || value.datasetSha256 !== datasetSha256) return false
  const allowed = new Set(['schemaVersion', 'datasetSha256', 'members', 'relation', 'verdict', 'reason', 'reviewer', 'reviewedAt'])
  if (Object.keys(value).some((key) => !allowed.has(key))) return false
  if (!['duplicate-repost', 'template-derived', 'same-job', 'unrelated'].includes(value.relation)) return false
  if (!['no-leak', 'leak'].includes(value.verdict) || !nonempty(value.reason) || !nonempty(value.reviewer)) return false
  if (typeof value.reviewedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.reviewedAt)
    || !Number.isFinite(Date.parse(value.reviewedAt))) return false
  const expected = [candidate.a, candidate.b].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  if (expected[0].id === expected[1].id || !Array.isArray(value.members) || value.members.length !== 2) return false
  return value.members.every((member, i) => plainObject(member)
    && Object.keys(member).length === 3 && nonempty(member.id) && hashString(member.sha256)
    && ['dev', 'holdout'].includes(member.split)
    && member.id === expected[i].id && member.sha256 === expected[i].sha256 && member.split === expected[i].split)
}
