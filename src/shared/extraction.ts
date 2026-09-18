// 提取契约层:分析输出 schema 的单一事实源(schema → 提示词规范 → 运行时校验)
import type { AnalysisPayload, ExtractedCourse, ExtractedSchoolEvent } from './types'

export interface ExtractionFieldSpec {
  key: string
  type: 'string' | 'string[]' | 'number' | 'object' | 'objectArray'
  /** 提示词中的中文说明 */
  description: string
  enum?: string[]
  /** objectArray 的子字段 */
  itemFields?: ExtractionFieldSpec[]
}

/** 通知分析输出结构;提示词与运行时校验都由它生成 */
export const ANALYSIS_EXTRACTION_SCHEMA: ExtractionFieldSpec[] = [
  { key: 'title', type: 'string', description: '这件事的简短标题(15字以内)' },
  { key: 'summary', type: 'string', description: '通知重点摘要,2-4 句' },
  { key: 'keyPoints', type: 'string[]', description: '要点列表' },
  {
    key: 'actionItems',
    type: 'objectArray',
    description: '需要安排的事项列表,没有则空数组',
    itemFields: [
      { key: 'title', type: 'string', description: '需要做的事项' },
      { key: 'type', type: 'string', description: '事项类型', enum: ['todo', 'event'] },
      { key: 'deadline', type: 'string', description: '截止时间,格式 YYYY-MM-DDTHH:mm,没有则为 null' },
      { key: 'start', type: 'string', description: '建议执行/开始时间,格式 YYYY-MM-DDTHH:mm,没有则为 null' },
      { key: 'durationMinutes', type: 'number', description: '预计耗时分钟数或 null' },
      { key: 'location', type: 'string', description: '地点或 null' },
      { key: 'participants', type: 'string[]', description: '参与人物名单,无法确定则空数组' },
      { key: 'notes', type: 'string', description: '补充说明' },
      { key: 'sourceRef', type: 'string', description: '出处材料名称' },
      { key: 'confidence', type: 'string', description: '置信度', enum: ['high', 'medium', 'low'] }
    ]
  },
  { key: 'questions', type: 'string[]', description: '缺失或待确认的信息,例如具体几点下班、会议时长等' },
  { key: 'conflicts', type: 'string[]', description: '材料之间时间冲突或表述不一致的地方,没有则空数组' },
  {
    key: 'changes',
    type: 'objectArray',
    description: '对已有事项的变更,没有则空数组',
    itemFields: [
      { key: 'ref', type: 'string', description: '涉及的原事项' },
      { key: 'change', type: 'string', description: '改期/取消等变更描述' }
    ]
  }
]

function renderField(f: ExtractionFieldSpec, indent: string): string {
  if (f.type === 'objectArray' && f.itemFields) {
    const inner = f.itemFields
      .map((c) => {
        const enumNote = c.enum ? `,取值 ${c.enum.join(' 或 ')}` : ''
        return `${indent}  "${c.key}": ${c.type === 'string[]' ? '[]' : c.type === 'number' ? '0或null' : c.type === 'objectArray' ? '[]' : `"…"${enumNote}`} // ${c.description}`
      })
      .join(',\n')
    return `${indent}"${f.key}": [\n${indent}  {\n${inner}\n${indent}  }\n${indent}] // ${f.description}`
  }
  const sample =
    f.type === 'string[]' ? '[]' : f.type === 'number' ? '0或null' : `"…"`
  const enumNote = f.enum ? `,取值 ${f.enum.join(' 或 ')}` : ''
  return `${indent}"${f.key}": ${sample}${enumNote} // ${f.description}`
}

/** 渲染成嵌入系统提示词的 JSON 规范段 */
export function schemaToPrompt(schema: ExtractionFieldSpec[] = ANALYSIS_EXTRACTION_SCHEMA): string {
  const body = schema.map((f) => renderField(f, '  ')).join(',\n')
  return `输出 JSON 对象,结构如下:\n{\n${body}\n}`
}

export interface PayloadValidation {
  ok: boolean
  /** ok=true 时的降级说明(例如某字段类型不符被置空),由调用方并入 questions */
  warnings: string[]
  /** ok=false 时的致命错误(面向模型的修复反馈) */
  errors: string[]
}

function asStringArray(v: unknown, field: string, warnings: string[]): string[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) {
    warnings.push(`字段 ${field} 应为数组,已忽略原值`)
    return undefined
  }
  const arr = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
  if (arr.length !== v.length) warnings.push(`字段 ${field} 中含非文本项,已过滤`)
  return arr
}

function asStringOrNull(v: unknown, field: string, warnings: string[]): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t || t.toLowerCase() === 'null') return null
    return t
  }
  warnings.push(`字段 ${field} 应为字符串或 null,已置空`)
  return null
}

function coerceCandidate(item: unknown, index: number, warnings: string[]): Record<string, unknown> {
  const src = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (typeof src.title === 'string' && src.title.trim()) out.title = src.title.trim()
  else warnings.push(`候选事项[${index}] 缺少有效 title,已按"未命名事项"处理`)
  out.type = src.type === 'event' ? 'event' : 'todo'
  out.deadline = asStringOrNull(src.deadline, `候选事项[${index}].deadline`, warnings) ?? null
  out.start = asStringOrNull(src.start, `候选事项[${index}].start`, warnings) ?? null
  out.durationMinutes =
    typeof src.durationMinutes === 'number' && isFinite(src.durationMinutes)
      ? Math.round(src.durationMinutes)
      : null
  out.location = asStringOrNull(src.location, `候选事项[${index}].location`, warnings) ?? null
  const participants = asStringArray(src.participants, `候选事项[${index}].participants`, warnings)
  if (participants) out.participants = participants
  if (typeof src.notes === 'string' && src.notes.trim()) out.notes = src.notes.trim()
  if (typeof src.sourceRef === 'string' && src.sourceRef.trim()) out.sourceRef = src.sourceRef.trim()
  out.confidence =
    src.confidence === 'high' || src.confidence === 'medium' || src.confidence === 'low'
      ? src.confidence
      : null
  return out
}

/**
 * 运行时校验与收敛:致命失败(非对象)返回 ok=false;
 * 字段级问题降级并记录 warnings,产出干净的 AnalysisPayload。
 */
export function validateAnalysisPayload(
  raw: unknown
): { ok: true; value: AnalysisPayload; warnings: string[] } | { ok: false; errors: string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['输出不是 JSON 对象,要求只输出一个 JSON 对象'] }
  }
  const warnings: string[] = []
  const src = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}

  const title = asStringOrNull(src.title, 'title', warnings)
  if (title) out.title = title
  const summary = asStringOrNull(src.summary, 'summary', warnings)
  if (summary) out.summary = summary

  const keyPoints = asStringArray(src.keyPoints, 'keyPoints', warnings)
  if (keyPoints) out.keyPoints = keyPoints

  if (src.actionItems !== undefined && src.actionItems !== null) {
    if (Array.isArray(src.actionItems)) {
      out.actionItems = src.actionItems.map((item, i) => coerceCandidate(item, i, warnings))
    } else {
      warnings.push('字段 actionItems 应为数组,已忽略原值')
    }
  }

  const questions = asStringArray(src.questions, 'questions', warnings)
  if (questions) out.questions = questions
  const conflicts = asStringArray(src.conflicts, 'conflicts', warnings)
  if (conflicts) out.conflicts = conflicts

  if (src.changes !== undefined && src.changes !== null) {
    if (Array.isArray(src.changes)) {
      out.changes = src.changes
        .filter((c) => typeof c === 'object' && c !== null)
        .map((c) => {
          const o = c as Record<string, unknown>
          return {
            ref: typeof o.ref === 'string' ? o.ref : '',
            change: typeof o.change === 'string' ? o.change : ''
          }
        })
        .filter((c) => c.ref || c.change)
    } else {
      warnings.push('字段 changes 应为数组,已忽略原值')
    }
  }

  return { ok: true, value: out as unknown as AnalysisPayload, warnings }
}

/** 修复反馈:把校验问题回传给模型 */
export function repairFeedback(errors: string[], warnings: string[] = []): string {
  const problems = [...errors, ...warnings.slice(0, 5)].map((e) => `- ${e}`).join('\n')
  return `你上一次的输出不合格,问题如下:\n${problems}\n请修正后重新输出:只输出一个符合字段规范的 JSON 对象,不要输出任何解释文字或代码块。`
}

// ---------- 课表/校历导入载荷校验 ----------

export type ImportKind = 'timetable' | 'school-calendar'

const WEEKDAY_TEXT: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7
}

function coerceWeekday(v: unknown, field: string, warnings: string[]): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 7) return v
  if (typeof v === 'string') {
    const digit = /^([1-7])$/.exec(v.trim())
    if (digit) return Number(digit[1])
    const m = /(?:星期|周)\s*([一二三四五六日天])/.exec(v.trim())
    if (m) return WEEKDAY_TEXT[m[1]]
  }
  warnings.push(`${field} 星期无效,该条已忽略`)
  return null
}

function coerceTime(v: unknown, field: string, warnings: string[]): string | null {
  if (typeof v !== 'string') {
    warnings.push(`${field} 时间无效,该条已忽略`)
    return null
  }
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(v.trim())
  if (!m) {
    warnings.push(`${field} 时间格式无效(${v.trim()}),该条已忽略`)
    return null
  }
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) {
    warnings.push(`${field} 时间超出范围(${v.trim()}),该条已忽略`)
    return null
  }
  return `${String(h).padStart(2, '0')}:${m[2]}`
}

function coerceWeeks(v: unknown, courseName: string, warnings: string[]): Array<[number, number]> {
  const fail = (): Array<[number, number]> => {
    warnings.push(`课程 ${courseName} 缺少有效周次,已默认 1-17 周,请在确认页核对`)
    return [[1, 17]]
  }
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1) return [[v, v]]
  if (typeof v === 'string') {
    const range = /^(\d{1,3})\s*[-–—]\s*(\d{1,3})$/.exec(v.trim())
    if (range) {
      const s = Number(range[1])
      const e = Number(range[2])
      if (s >= 1 && e >= s) return [[s, e]]
    }
    const single = /^(\d{1,3})$/.exec(v.trim())
    if (single) return [[Number(single[1]), Number(single[1])]]
    return fail()
  }
  if (Array.isArray(v)) {
    const pair = v.map((x) => Number(x))
    // [1,17] 这类两元素扁平数组优先解释为"第1到17周"区间
    if (v.length === 2 && pair.every((n) => Number.isInteger(n) && n >= 1) && pair[1] >= pair[0]) {
      return [[pair[0], pair[1]]]
    }
    const out: Array<[number, number]> = []
    for (const item of v) {
      if (typeof item === 'number' && Number.isInteger(item) && item >= 1) {
        out.push([item, item])
      } else if (Array.isArray(item) && item.length === 2) {
        const s = Number(item[0])
        const e = Number(item[1])
        if (Number.isInteger(s) && Number.isInteger(e) && s >= 1 && e >= s) out.push([s, e])
      }
    }
    if (out.length > 0) return out
  }
  return fail()
}

function coerceDate(v: unknown, field: string, warnings: string[]): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') {
    warnings.push(`${field} 日期无效(${String(v)}),已置空`)
    return null
  }
  const t = v.trim()
  if (!t || t.toLowerCase() === 'null') return null
  const m = /^(\d{4})[年./\-](\d{1,2})[月./\-](\d{1,2})日?$/.exec(t)
  if (!m) {
    warnings.push(`${field} 日期无法识别(${t}),已置空,请在确认页填写`)
    return null
  }
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) {
    warnings.push(`${field} 日期超出范围(${t}),已置空`)
    return null
  }
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function coerceSemester(
  src: unknown,
  kind: ImportKind,
  warnings: string[]
): { name?: string; startDate?: string | null; weeks?: number | null } | undefined {
  if (src === undefined) return undefined
  if (src === null) return undefined
  if (typeof src !== 'object') {
    warnings.push(`${kind === 'timetable' ? '课表' : '校历'}材料中的学期信息无法解析,已忽略`)
    return undefined
  }
  const s = src as Record<string, unknown>
  const out: { name?: string; startDate?: string | null; weeks?: number | null } = {}
  if (typeof s.name === 'string' && s.name.trim()) out.name = s.name.trim()
  const startDate = coerceDate(s.startDate, '开学日期', warnings)
  out.startDate = startDate ?? null
  let weeks: number | null = null
  if (typeof s.weeks === 'number' && Number.isInteger(s.weeks) && s.weeks >= 1 && s.weeks <= 30) weeks = s.weeks
  else if (typeof s.weeks === 'string') {
    const n = /^(\d{1,2})\s*周?$/.exec(s.weeks.trim())
    if (n) weeks = Number(n[1])
    else if (s.weeks.trim() && s.weeks.trim().toLowerCase() !== 'null') warnings.push('学期总周数无法识别,已置空')
  }
  out.weeks = weeks
  return out
}

function coerceCourse(
  item: unknown,
  index: number,
  warnings: string[]
): ExtractedCourse | null {
  if (typeof item !== 'object' || item === null) {
    warnings.push(`课程[${index}] 不是对象,已忽略`)
    return null
  }
  const src = item as Record<string, unknown>
  const name = typeof src.name === 'string' ? src.name.trim() : ''
  if (!name) {
    warnings.push(`课程[${index}] 缺少课程名,已忽略`)
    return null
  }
  const weekday = coerceWeekday(src.weekday, `课程 ${name}`, warnings)
  const startTime = coerceTime(src.startTime, `课程 ${name}`, warnings)
  const endTime = coerceTime(src.endTime, `课程 ${name}`, warnings)
  if (weekday === null || startTime === null || endTime === null) return null
  return {
    name,
    weekday,
    startTime,
    endTime,
    weeks: coerceWeeks(src.weeks, name, warnings),
    location: typeof src.location === 'string' && src.location.trim() ? src.location.trim() : null,
    teacher: typeof src.teacher === 'string' && src.teacher.trim() ? src.teacher.trim() : null
  }
}

function coerceSchoolEvent(
  item: unknown,
  index: number,
  warnings: string[]
): ExtractedSchoolEvent | null {
  if (typeof item !== 'object' || item === null) {
    warnings.push(`校历[${index}] 不是对象,已忽略`)
    return null
  }
  const src = item as Record<string, unknown>
  const title = typeof src.title === 'string' ? src.title.trim() : ''
  if (!title) {
    warnings.push(`校历[${index}] 缺少名称,已忽略`)
    return null
  }
  const startDate = coerceDate(src.startDate, `校历 ${title}`, warnings)
  if (!startDate) {
    warnings.push(`校历 ${title} 缺少有效日期,已忽略`)
    return null
  }
  const allowed: ExtractedSchoolEvent['type'][] = ['holiday', 'exam', 'registration', 'adjust', 'other']
  let type = allowed.includes(src.type as ExtractedSchoolEvent['type'])
    ? (src.type as ExtractedSchoolEvent['type'])
    : 'other'
  if (type === 'other' && typeof src.type === 'string' && src.type !== 'other') {
    const cn: Record<string, ExtractedSchoolEvent['type']> = {
      假期: 'holiday', 放假: 'holiday', 考试: 'exam', 报到: 'registration', 调课: 'adjust', 补课: 'adjust'
    }
    if (cn[src.type.trim()]) type = cn[src.type.trim()]
    else warnings.push(`校历 ${title} 的类型无法识别,已按"其他"处理`)
  }
  return {
    type,
    title,
    startDate,
    endDate: coerceDate(src.endDate, `校历 ${title} 结束日期`, warnings),
    note: typeof src.note === 'string' && src.note.trim() ? src.note.trim() : null
  }
}

/**
 * 课表/校历导入载荷的运行时校验:结构致命失败(含"键存在但全脏")返回 ok=false 触发模型修复;
 * 字段级问题降级为 warnings,由确认页展示给用户核对。
 */
export function validateImportPayload(
  raw: unknown,
  kind: ImportKind
): { ok: true; value: AnalysisPayload; warnings: string[] } | { ok: false, errors: string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['输出不是 JSON 对象,要求只输出一个 JSON 对象'] }
  }
  const warnings: string[] = []
  const src = raw as Record<string, unknown>
  const out: AnalysisPayload = {}
  const listKey = kind === 'timetable' ? 'courses' : 'schoolEvents'
  const listLabel = kind === 'timetable' ? '课程' : '校历条目'

  const semester = coerceSemester(src.semester, kind, warnings)
  if (semester) out.semester = semester

  if (src[listKey] !== undefined && src[listKey] !== null) {
    if (!Array.isArray(src[listKey])) {
      return { ok: false, errors: [`字段 ${listKey} 应为数组`] }
    }
    if (kind === 'timetable') {
      const items = (src[listKey] as unknown[])
        .map((item, i) => coerceCourse(item, i, warnings))
        .filter((c): c is ExtractedCourse => c !== null)
      if (items.length === 0) {
        return { ok: false, errors: [`字段 ${listLabel} 非空但没有任何一条能解析,请核对字段规范后重新输出`] }
      }
      out.courses = items
    } else {
      const items = (src[listKey] as unknown[])
        .map((item, i) => coerceSchoolEvent(item, i, warnings))
        .filter((c): c is ExtractedSchoolEvent => c !== null)
      if (items.length === 0) {
        return { ok: false, errors: [`字段 ${listLabel} 非空但没有任何一条能解析,请核对字段规范后重新输出`] }
      }
      out.schoolEvents = items
    }
  } else {
    warnings.push(`模型没有输出 ${listLabel} 列表`)
  }

  const questions = asStringArray(src.questions, 'questions', warnings)
  if (questions) out.questions = questions

  return { ok: true, value: out, warnings }
}
