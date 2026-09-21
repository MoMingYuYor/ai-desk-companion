import { describe, expect, it } from 'vitest'
import { validateEventInput } from '../../src/main/planning/eventValidation'

describe('R7: validateEventInput 集中校验', () => {
  it('空标题、无效开始时间、相等/倒置区间均拒绝;缺结束时间在面向用户的入口报错', () => {
    expect(() =>
      validateEventInput({ title: '   ', startAt: '2026-09-21T09:00', endAt: '2026-09-21T10:00' })
    ).toThrow(/标题/)
    expect(() =>
      validateEventInput({ title: '例会', startAt: '下周三九点', endAt: '2026-09-21T10:00' })
    ).toThrow(/开始时间/)
    expect(() =>
      validateEventInput({ title: '例会', startAt: '2026-09-21T10:00', endAt: '2026-09-21T10:00' })
    ).toThrow(/结束时间/)
    expect(() =>
      validateEventInput({ title: '例会', startAt: '2026-09-21T10:00', endAt: '2026-09-21T09:00' })
    ).toThrow(/结束时间/)
    // 面向用户的入口必须有结束时间;缺结束时间只在编辑预览建议 30 分钟、确认后写入
    expect(() => validateEventInput({ title: '例会', startAt: '2026-09-21T09:00' })).toThrow(/结束时间/)
  })

  it('合法输入返回规范化结果;缺结束时间仅在候选路径按零长度处理(历史行为)', () => {
    const v = validateEventInput({
      title: ' 例会 ',
      startAt: '2026-09-21T09:00',
      endAt: '2026-09-21T10:00',
      location: '会议室',
      notes: null,
      reminderMinutes: 15
    })
    expect(v.title).toBe('例会')
    expect(v.startAt).toBe('2026-09-21T09:00')
    expect(v.endAt).toBe('2026-09-21T10:00')
    expect(v.endMs - v.startMs).toBe(3_600_000)

    const zero = validateEventInput({ title: '历史候选', startAt: '2026-09-21T09:00' }, { allowZeroLength: true })
    expect(zero.endAt).toBe('2026-09-21T09:00')
    expect(zero.endMs).toBe(zero.startMs)
    // 候选路径显式传入相等区间(无时长)同样放行;倒置仍拒绝
    const explicitZero = validateEventInput(
      { title: '历史候选', startAt: '2026-09-21T09:00', endAt: '2026-09-21T09:00' },
      { allowZeroLength: true }
    )
    expect(explicitZero.endMs).toBe(explicitZero.startMs)
  })

  it('全天按本地日期解析,排他结束日:同日拒绝、次日通过', () => {
    expect(() =>
      validateEventInput({ title: '全天', startAt: '2026-09-21', endAt: '2026-09-21', allDay: true })
    ).toThrow(/结束时间/)
    const v = validateEventInput({ title: '全天', startAt: '2026-09-21', endAt: '2026-09-22', allDay: true })
    expect(v.allDay).toBe(true)
    expect(v.endMs - v.startMs).toBe(86_400_000)
  })

  it('倒置全天区间拒绝', () => {
    expect(() =>
      validateEventInput({ title: '全天', startAt: '2026-09-22', endAt: '2026-09-21', allDay: true })
    ).toThrow(/结束时间/)
  })
})
