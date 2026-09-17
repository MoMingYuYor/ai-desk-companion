// 提取契约层:分析输出 schema 的单一事实源(schema → 提示词规范 → 运行时校验)
import type { AnalysisPayload } from './types'

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
