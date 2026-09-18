import { describe, expect, it } from 'vitest'
import { validateImportPayload } from '../src/shared/extraction'

type Result = ReturnType<typeof validateImportPayload>

function expectOk(r: Result): Extract<Result, { ok: true }> {
  if (!r.ok) throw new Error(`应当成功,实际失败:${r.errors.join(';')}`)
  return r
}

function expectFail(r: Result): Extract<Result, { ok: false }> {
  if (r.ok) throw new Error('应当失败,实际成功')
  return r
}

describe('课表/校历导入载荷校验', () => {
  it('非对象输出为致命错误(可触发修复)', () => {
    for (const bad of ['不是JSON', null, 42, [1, 2]]) {
      expect(validateImportPayload(bad, 'timetable').ok).toBe(false)
    }
  })

  it('courses 键存在但不是数组 → 致命错误,交给模型修复', () => {
    const r = expectFail(validateImportPayload({ courses: '看不懂' }, 'timetable'))
    expect(r.errors[0]).toContain('courses')
  })

  it('courses 数组全脏 → 致命错误;部分脏只降级并记录 warning', () => {
    const allBad = validateImportPayload({ courses: [{ foo: 1 }] }, 'timetable')
    expect(allBad.ok).toBe(false)

    const partial = expectOk(
      validateImportPayload(
        {
          courses: [
            { name: '软件工程', weekday: 1, startTime: '08:00', endTime: '09:35' },
            { name: '', weekday: 9, startTime: 'xx', endTime: 'yy' }
          ]
        },
        'timetable'
      )
    )
    expect(partial.value.courses).toHaveLength(1)
    expect(partial.warnings.length).toBeGreaterThan(0)
  })

  it('归一化:字符串星期/中文星期/宽松时间/字符串周次', () => {
    const r = expectOk(
      validateImportPayload(
        {
          courses: [
            { name: '高等数学', weekday: '3', startTime: '8:00', endTime: '9:35', weeks: '1-17' },
            { name: '大学英语', weekday: '星期日', startTime: '14:00:30', endTime: '15:35', weeks: '1' },
            { name: '体育', weekday: 2, startTime: '10:00', endTime: '11:35', weeks: [[1, 6], [8, 17]] }
          ]
        },
        'timetable'
      )
    )
    expect(r.value.courses).toEqual([
      { name: '高等数学', weekday: 3, startTime: '08:00', endTime: '09:35', weeks: [[1, 17]], location: null, teacher: null },
      { name: '大学英语', weekday: 7, startTime: '14:00', endTime: '15:35', weeks: [[1, 1]], location: null, teacher: null },
      { name: '体育', weekday: 2, startTime: '10:00', endTime: '11:35', weeks: [[1, 6], [8, 17]], location: null, teacher: null }
    ])
  })

  it('缺少周次的课程默认全学期并给出 warning', () => {
    const r = expectOk(
      validateImportPayload(
        { courses: [{ name: '线性代数', weekday: 4, startTime: '10:00', endTime: '11:35' }] },
        'timetable'
      )
    )
    expect(r.value.courses![0].weeks).toEqual([[1, 17]])
    expect(r.warnings.join('\n')).toContain('线性代数')
  })

  it('semester 归一化:宽松日期与字符串周数', () => {
    const r = expectOk(
      validateImportPayload(
        {
          semester: { name: ' 2026-2027-1 ', startDate: '2026/9/7', weeks: '20' },
          courses: [{ name: '数据结构', weekday: 1, startTime: '08:00', endTime: '09:35', weeks: [1, 17] }]
        },
        'timetable'
      )
    )
    expect(r.value.semester).toEqual({ name: '2026-2027-1', startDate: '2026-09-07', weeks: 20 })
    // weeks 单数字也接受 [1,17] 形式
    expect(r.value.courses![0].weeks).toEqual([[1, 17]])
  })

  it('非法 semester 日期不阻断导入,置空并提示', () => {
    const r = expectOk(
      validateImportPayload(
        {
          semester: { startDate: '九月七日', weeks: '二十' },
          courses: [{ name: '物理实验', weekday: 5, startTime: '13:00', endTime: '14:35', weeks: '2-9' }]
        },
        'timetable'
      )
    )
    expect(r.value.semester?.startDate).toBeNull()
    expect(r.value.semester?.weeks).toBeNull()
    expect(r.warnings.join('\n')).toContain('开学日期')
  })

  it('questions 保留传递给前端', () => {
    const r = expectOk(
      validateImportPayload(
        {
          courses: [{ name: '近代史', weekday: 3, startTime: '10:00', endTime: '11:35', weeks: '1-16' }],
          questions: ['材料中没有开学日期']
        },
        'timetable'
      )
    )
    expect(r.value.questions).toEqual(['材料中没有开学日期'])
  })

  it('校历:schoolEvents 归一化与丢弃规则与 courses 对称', () => {
    expect(validateImportPayload({ schoolEvents: [{ title: '乱写', startDate: '明天' }] }, 'school-calendar').ok).toBe(false)

    const r = expectOk(
      validateImportPayload(
        {
          semester: { startDate: '2026-09-07', weeks: 20 },
          schoolEvents: [
            { type: 'holiday', title: '国庆节放假', startDate: '2026-10-01', endDate: '2026-10-07', note: '共7天' },
            { type: '考试', title: '期末考试周', startDate: '2027-01-11', endDate: null },
            { type: 'unknown-type', title: '军训', startDate: '2026-09-14', endDate: null, note: '两周' }
          ]
        },
        'school-calendar'
      )
    )
    expect(r.value.schoolEvents).toEqual([
      { type: 'holiday', title: '国庆节放假', startDate: '2026-10-01', endDate: '2026-10-07', note: '共7天' },
      { type: 'exam', title: '期末考试周', startDate: '2027-01-11', endDate: null, note: null },
      { type: 'other', title: '军训', startDate: '2026-09-14', endDate: null, note: '两周' }
    ])
    expect(r.warnings.length).toBeGreaterThan(0)
  })
})
