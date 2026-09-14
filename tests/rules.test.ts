import { describe, expect, it } from 'vitest'
import {
  confirmCandidate,
  createEvent,
  createTodo,
  getTodo,
  insertAnalysis,
  latestAnalysis,
  listEventsRange,
  listTodos,
  updateEvent,
  updateTodo
} from '../src/main/db/dao'
import { makeTestDb } from './helpers'

describe('计划规则:分析结果与正式事项分开保存', () => {
  it('未确认时,正式日程和待办不增加', async () => {
    const db = await makeTestDb()
    insertAnalysis(db, 'conv1', {
      title: '提交材料',
      actionItems: [{ title: '提交材料', type: 'todo', deadline: '2026-09-18T23:59' }]
    })
    expect(listEventsRange(db, '2026-01-01T00:00', '2026-12-31T23:59')).toHaveLength(0)
    expect(listTodos(db)).toHaveLength(0)
  })

  it('确认后写入;重复确认不产生重复事项', async () => {
    const db = await makeTestDb()
    const item = { title: '提交材料', type: 'todo' as const, deadline: '2026-09-18T23:59' }
    const r1 = confirmCandidate(db, item)
    expect(r1.result).toBe('created')
    const r2 = confirmCandidate(db, item)
    expect(r2.result).toBe('duplicate')
    expect(listTodos(db)).toHaveLength(1)
  })

  it('同一日程重复确认只保存一次', async () => {
    const db = await makeTestDb()
    const item = { title: '项目会', type: 'event' as const, start: '2026-09-16T14:00', durationMinutes: 90 }
    expect(confirmCandidate(db, item).result).toBe('created')
    expect(confirmCandidate(db, item).result).toBe('duplicate')
    expect(listEventsRange(db, '2026-09-01T00:00', '2026-09-30T23:59')).toHaveLength(1)
  })
})

describe('计划规则:截止时间与执行时间独立', () => {
  it('待办带执行时段;移动执行时段不改变截止时间', async () => {
    const db = await makeTestDb()
    const r = confirmCandidate(db, {
      title: '准备进度说明',
      type: 'todo',
      deadline: '2026-09-15T18:00',
      start: '2026-09-14T14:00',
      durationMinutes: 60
    })
    expect(r.result).toBe('created')
    const todo = getTodo(db, r.refId)!
    expect(todo.dueAt).toBe('2026-09-15T18:00')
    expect(todo.linkedEventId).toBeTruthy()

    // 把执行时段移到周二上午:截止时间保持不变
    updateEvent(db, todo.linkedEventId!, { startAt: '2026-09-15T09:00', endAt: '2026-09-15T10:00' })
    const after = getTodo(db, r.refId)!
    expect(after.dueAt).toBe('2026-09-15T18:00')
  })

  it('只改待办内容不影响关联日程的起止', async () => {
    const db = await makeTestDb()
    const ev = createEvent(db, { title: '整理材料', startAt: '2026-09-14T14:00', endAt: '2026-09-14T15:00' })
    const td = createTodo(db, { title: '整理材料', dueAt: '2026-09-15T18:00' })
    updateTodo(db, td.id, { linkedEventId: ev.id })
    updateTodo(db, td.id, { priority: 'high' })
    const after = getTodo(db, td.id)!
    expect(after.linkedEvent?.startAt).toBe('2026-09-14T14:00')
  })
})

describe('计划规则:分析版本不被覆盖', () => {
  it('补充材料生成新版本,latest 返回最新版', async () => {
    const db = await makeTestDb()
    insertAnalysis(db, 'conv1', { summary: '第一版' })
    insertAnalysis(db, 'conv1', { summary: '第二版(含补充材料)' })
    const latest = latestAnalysis(db, 'conv1')!
    expect(latest.version).toBe(2)
    expect(latest.payload.summary).toContain('第二版')
  })
})

describe('待办与手动创建', () => {
  it('手动创建的日程/待办带有 fingerprint 用于导入去重', async () => {
    const db = await makeTestDb()
    createEvent(db, { title: '手动日程', startAt: '2026-09-16T10:00', endAt: '2026-09-16T11:00' })
    createTodo(db, { title: '手动待办', dueAt: '2026-09-16T23:59' })
    expect(listTodos(db)).toHaveLength(1)
    expect(listEventsRange(db, '2026-09-16T00:00', '2026-09-16T23:59')).toHaveLength(1)
  })
})
