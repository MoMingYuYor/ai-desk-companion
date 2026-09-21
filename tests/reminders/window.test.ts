import { describe, expect, it } from 'vitest'
import { createEvent, createTodo, markReminderFired, updateEvent, updateTodo } from '../../src/main/db/dao'
import { dueReminders } from '../../src/main/services/reminder'
import { makeTestDb } from '../helpers'

// 固定本地时钟:2026-09-20 12:00(计划 Task 9 Step 1 的关键测试)
const now = new Date(2026, 8, 20, 12, 0, 0, 0)

/** 本地朴素时间(带毫秒):与提醒调度使用的无时区格式一致 */
function localMs(d: Date): string {
  const p = (n: number, size = 2): string => String(n).padStart(size, '0')
  return [d.getFullYear(), p(d.getMonth() + 1), p(d.getDate())].join('-') + 'T' +
    [p(d.getHours()), p(d.getMinutes()), p(d.getSeconds())].join(':') + '.' + p(d.getMilliseconds(), 3)
}

/** now 偏移 offsetMs 后的本地时间串 */
const at = (offsetMs: number): string => localMs(new Date(now.getTime() + offsetMs))

it('R6: fireAt 在闭合的过去24小时窗口内且提前数天的提醒可见', async () => {
  const db = await makeTestDb()
  const inside = createEvent(db, {
    title: '提前数天', startAt: at(3 * 86_400_000), endAt: at(3 * 86_400_000 + 3_600_000),
    reminderMinutes: 3 * 24 * 60
  })
  const boundary = createEvent(db, {
    title: '恰好24小时', startAt: at(-86_400_000), endAt: at(-86_400_000 + 3_600_000),
    reminderMinutes: 0
  })
  const tooOld = createEvent(db, {
    title: '早1毫秒', startAt: at(-86_400_001), endAt: at(-86_400_001 + 3_600_000),
    reminderMinutes: 0
  })
  const future = createEvent(db, {
    title: '晚1毫秒', startAt: at(1), endAt: at(3_600_001), reminderMinutes: 0
  })
  const ids = dueReminders(db, now).map((r) => r.entityId)
  expect(ids).toContain(inside.id)
  expect(ids).toContain(boundary.id)
  expect(ids).not.toContain(tooOld.id)
  expect(ids).not.toContain(future.id)
})

describe('R6: 通知前状态检查与重复 key', () => {
  it('已完成待办与取消日程不出现', async () => {
    const db = await makeTestDb()
    const doneTodo = createTodo(db, { title: '已交的表', dueAt: at(-5 * 60_000) })
    updateTodo(db, doneTodo.id, { completedAt: at(-1 * 60_000) })
    const cancelled = createEvent(db, {
      title: '已取消的会', startAt: at(-10 * 60_000), endAt: at(50 * 60_000), reminderMinutes: 0
    })
    updateEvent(db, cancelled.id, { status: 'cancelled' })
    const activeTodo = createTodo(db, { title: '待交的表', dueAt: at(-3 * 60_000) })

    const ids = dueReminders(db, now).map((r) => r.entityId)
    expect(ids).toContain(activeTodo.id)
    expect(ids).not.toContain(doneTodo.id)
    expect(ids).not.toContain(cancelled.id)
  })

  it('同一 key 标记 fired 后不再报;无截止时间的待办不生成提醒', async () => {
    const db = await makeTestDb()
    const ev = createEvent(db, {
      title: '只报一次', startAt: at(-2 * 60_000), endAt: at(58 * 60_000), reminderMinutes: 0
    })
    createTodo(db, { title: '没有截止时间' })

    const first = dueReminders(db, now)
    expect(first.map((r) => r.entityId)).toEqual([ev.id])
    markReminderFired(db, first[0]!.key)
    expect(dueReminders(db, now).map((r) => r.entityId)).toEqual([])
  })

  it('窗口外过期待办不补报;窗口内待办可见', async () => {
    const db = await makeTestDb()
    createTodo(db, { title: '很久前的待办', dueAt: at(-25 * 3_600_000) })
    const recent = createTodo(db, { title: '刚过期的待办', dueAt: at(-6 * 60_000) })
    const future = createTodo(db, { title: '明天的待办', dueAt: at(3_600_000) })
    const ids = dueReminders(db, now).map((r) => r.entityId)
    expect(ids).toEqual([recent.id])
    expect(ids).not.toContain(future.id)
  })
})
