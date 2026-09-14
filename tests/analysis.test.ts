import { describe, expect, it } from 'vitest'
import { extractJsonPayload, normalizeCandidate, normalizeDateTime } from '../src/main/services/engine'
import { saveProfileFact, listProfileFacts } from '../src/main/db/dao'
import { buildProfileContext } from '../src/main/services/context'
import { makeTestDb } from './helpers'

describe('模型输出解析', () => {
  it('解析裸 JSON', () => {
    const p = extractJsonPayload('{"title":"x","summary":"s"}')
    expect(p?.title).toBe('x')
  })

  it('解析 markdown 代码块包裹的 JSON', () => {
    const p = extractJsonPayload('```json\n{"title":"x"}\n```')
    expect(p?.title).toBe('x')
  })

  it('解析前后带说明文字的 JSON', () => {
    const p = extractJsonPayload('好的,以下是分析结果:\n{"title":"项目会","actionItems":[]}\n希望有帮助')
    expect(p?.title).toBe('项目会')
  })

  it('容忍尾随逗号', () => {
    const p = extractJsonPayload('{"title":"x","questions":["a",]}')
    expect(p?.title).toBe('x')
  })

  it('非法输出返回 null', () => {
    expect(extractJsonPayload('完全不是 JSON')).toBeNull()
    expect(extractJsonPayload('')).toBeNull()
  })
})

describe('时间规范化', () => {
  it('只给日期时,截止按 23:59、开始按 00:00', () => {
    expect(normalizeDateTime('2026-09-18')).toBe('2026-09-18T23:59')
    expect(normalizeDateTime('2026-09-18', true)).toBe('2026-09-18T00:00')
  })

  it('统一为分钟精度本地时间', () => {
    expect(normalizeDateTime('2026-9-8 14:5:00')).toBe('2026-09-08T14:05')
    expect(normalizeDateTime('2026-09-08T14:05')).toBe('2026-09-08T14:05')
  })

  it('无意义时间返回 null', () => {
    expect(normalizeDateTime('下周三')).toBeNull()
    expect(normalizeDateTime(null)).toBeNull()
  })

  it('候选事项规范化:null 字符串转为空', () => {
    const c = normalizeCandidate({ title: 'x', type: 'todo', deadline: 'null', durationMinutes: '3' })
    expect(c.deadline).toBeNull()
    expect(c.durationMinutes).toBeNull()
  })
})

describe('计划规则:画像保持可纠正', () => {
  it('明确资料直接生效;建议需确认后才进入上下文', async () => {
    const db = await makeTestDb()
    saveProfileFact(db, { category: 'basic', key: '身份', value: '大三学生' })
    saveProfileFact(db, { category: 'preference', key: '晚上安排任务', value: '尽量避免', source: 'suggested', status: 'pending' })

    let ctx = buildProfileContext(db)
    expect(ctx).toContain('大三学生')
    expect(ctx).not.toContain('尽量避免')

    // 用户采纳建议后生效
    const pending = listProfileFacts(db).find((f) => f.status === 'pending')!
    saveProfileFact(db, { ...pending, status: 'confirmed' })
    ctx = buildProfileContext(db)
    expect(ctx).toContain('尽量避免')

    // 用户删除后不再生效
    saveProfileFact(db, { ...pending, status: 'rejected' })
    ctx = buildProfileContext(db)
    expect(ctx).not.toContain('尽量避免')
  })
})
