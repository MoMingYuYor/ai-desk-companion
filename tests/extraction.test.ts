import { describe, expect, it } from 'vitest'
import {
  ANALYSIS_EXTRACTION_SCHEMA,
  schemaToPrompt,
  validateAnalysisPayload,
  repairFeedback
} from '../src/shared/extraction'

describe('schema 提示词生成', () => {
  it('包含全部关键字段与参与人物', () => {
    const p = schemaToPrompt()
    expect(p).toContain('"title"')
    expect(p).toContain('"actionItems"')
    expect(p).toContain('"participants"')
    expect(p).toContain('"location"')
    expect(p).toContain('"confidence"')
    expect(p).toContain('todo 或 event')
  })
})

describe('运行时校验与收敛', () => {
  it('合法载荷原样通过且无警告', () => {
    const raw = {
      title: '班会',
      summary: '9月18日开会',
      actionItems: [
        {
          title: '参加班会',
          type: 'event',
          deadline: null,
          start: '2026-09-18T14:00',
          durationMinutes: 60,
          location: '302教室',
          participants: ['李明', '王芳'],
          confidence: 'high'
        }
      ],
      questions: [],
      conflicts: [],
      changes: []
    }
    const r = validateAnalysisPayload(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warnings).toHaveLength(0)
    expect(r.value.actionItems?.[0].participants).toEqual(['李明', '王芳'])
  })

  it('非对象输出是致命失败', () => {
    expect(validateAnalysisPayload('纯文本').ok).toBe(false)
    expect(validateAnalysisPayload(null).ok).toBe(false)
    expect(validateAnalysisPayload([1, 2]).ok).toBe(false)
    expect(validateAnalysisPayload(42).ok).toBe(false)
  })

  it('字段类型不符降级并产生警告,不报废整体', () => {
    const r = validateAnalysisPayload({
      title: 123,
      deadline: 'not-a-field',
      actionItems: [
        {
          title: '交作业',
          type: 'todo',
          deadline: 20260918,
          location: { building: '302' },
          participants: '张三, 李四',
          confidence: '超高'
        }
      ]
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warnings.some((w) => w.includes('title'))).toBe(true)
    expect(r.warnings.some((w) => w.includes('participants'))).toBe(true)
    const item = r.value.actionItems?.[0]
    expect(item?.deadline).toBeNull()
    expect(item?.location).toBeNull()
    expect(item?.participants).toBeUndefined()
    expect(item?.confidence).toBeNull()
  })

  it('participants 数组中的非字符串元素被过滤', () => {
    const r = validateAnalysisPayload({
      actionItems: [{ title: 'x', type: 'todo', participants: ['张三', 42, null, '李四'] }]
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.actionItems?.[0].participants).toEqual(['张三', '李四'])
  })

  it('questions/conflicts/keyPoints 非文本项被过滤', () => {
    const r = validateAnalysisPayload({
      questions: ['会议时长?', 5],
      conflicts: [null, '时间冲突'],
      keyPoints: ['要点一']
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.questions).toEqual(['会议时长?'])
    expect(r.value.conflicts).toEqual(['时间冲突'])
    expect(r.value.keyPoints).toEqual(['要点一'])
  })

  it('"null" 字符串按 null 处理', () => {
    const r = validateAnalysisPayload({
      actionItems: [{ title: 'x', type: 'todo', deadline: 'null', location: 'NULL' }]
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.actionItems?.[0].deadline).toBeNull()
    expect(r.value.actionItems?.[0].location).toBeNull()
  })

  it('修复反馈包含错误与 JSON 要求', () => {
    const fb = repairFeedback(['输出无法解析为 JSON'], ['字段 title 应为字符串'])
    expect(fb).toContain('无法解析')
    expect(fb).toContain('title')
    expect(fb).toContain('只输出')
  })

  it('schema 常量含 10 个候选字段', () => {
    const actionItems = ANALYSIS_EXTRACTION_SCHEMA.find((f) => f.key === 'actionItems')
    expect(actionItems?.itemFields).toHaveLength(10)
  })
})
