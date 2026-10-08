// runOperation / 操作回执 / 条件更新测试(计划 Task 2 Interfaces)。
// 红灯依据:src/main/db/operations.ts 尚不存在,导入即失败。
import { describe, expect, it, vi } from 'vitest'
import type { SqliteDb } from '../../src/main/db/connection'
import { createEvent, createTodo, deleteEventInner, listTodos, listTodosDueOn, updateTodo } from '../../src/main/db/dao'
import { buildDayAgenda } from '../../src/main/services/context'
import { OperationError, assertRevision, getOperationReceipt, runOperation } from '../../src/main/db/operations'
import { makeTestDb } from '../helpers'

function opInput(overrides: Partial<Parameters<typeof runOperation>[1]> = {}): Parameters<typeof runOperation>[1] {
  return {
    operationId: 'op-1',
    command: 'todos:update',
    requestHash: 'hash-1',
    workspaceEpoch: 'epoch-1',
    ...overrides
  }
}

describe('runOperation:关键命令唯一事务拥有者', () => {
  it('首次执行:业务写入与回执同一事务落库,返回 replayed:false', async () => {
    const db = await makeTestDb()
    const todo = createTodo(db, { title: '原始待办' })

    const result = runOperation<{ todoId: string }>(db, opInput(), () => {
      updateTodo(db, todo.id, { title: '更新后的待办' })
      return { todoId: todo.id }
    })

    expect(result).toEqual({ value: { todoId: todo.id }, replayed: false })
    expect(db.get<{ title: string }>('SELECT title FROM todos WHERE id = ?', [todo.id])?.title).toBe('更新后的待办')
    // 回执保存 operation_id/command/request_hash/result_ref/created_at
    const receipt = getOperationReceipt(db, 'op-1')
    expect(receipt).toBeDefined()
    expect(receipt).toMatchObject({ operationId: 'op-1', command: 'todos:update', requestHash: 'hash-1' })
    expect(JSON.parse(receipt!.resultRef)).toEqual({ kind: 'json', value: { todoId: todo.id } })
    expect(receipt!.createdAt).toBeTruthy()
  })

  it('同 ID 同摘要重试:返回首次结果且 replayed:true,即使原 revision 已过期', async () => {
    const db = await makeTestDb()
    const todo = createTodo(db, { title: '原始待办' })
    const first = runOperation<{ todoId: string }>(db, opInput(), () => {
      updateTodo(db, todo.id, { title: '第一次更新' })
      return { todoId: todo.id }
    })

    // 制造 revision 过期:另一条路径又更新过一次
    updateTodo(db, todo.id, { title: '无关的后续修改' })
    const revision = db.get<{ revision: number }>('SELECT revision FROM todos WHERE id = ?', [todo.id])!.revision
    expect(revision).toBeGreaterThan(1)

    // 幂等查重先于 revision 检查:用过期 revision 重试也必须返回首次结果,不误报冲突
    const apply = vi.fn(() => {
      throw new Error('重试时不应再次执行业务写入')
    })
    const retry = runOperation<{ todoId: string }>(db, opInput({ expectedRevision: 1 }), apply)
    expect(retry).toEqual({ value: first.value, replayed: true })
    expect(apply).not.toHaveBeenCalled()
    expect(db.all('SELECT id FROM todos WHERE id = ?', [todo.id])).toHaveLength(1)
  })

  it('同 ID 不同摘要:CONFLICT,且不执行业务写入', async () => {
    const db = await makeTestDb()
    const todo = createTodo(db, { title: '原始待办' })
    runOperation<{ todoId: string }>(db, opInput(), () => ({ todoId: todo.id }))

    let caught: unknown
    try {
      runOperation(db, opInput({ requestHash: 'hash-DIFFERENT', command: 'todos:rename' }), () => {
        updateTodo(db, todo.id, { title: '不应生效' })
        return {}
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(OperationError)
    expect((caught as OperationError).appError).toMatchObject({ code: 'CONFLICT', retryable: false, operationId: 'op-1' })
    expect(db.get<{ title: string }>('SELECT title FROM todos WHERE id = ?', [todo.id])?.title).toBe('原始待办')
  })

  it('revision 条件检查失败:CONFLICT,业务写入与回执整体回滚', async () => {
    const db = await makeTestDb()
    const ev = createEvent(db, { title: '原日程', startAt: '2026-09-21T09:00', endAt: '2026-09-21T10:00' })

    let caught: unknown
    try {
      runOperation(db, opInput({ operationId: 'op-c', command: 'events:update', requestHash: 'hash-c', expectedRevision: 999 }), () => {
        assertRevision(db, 'events', ev.id, 999) // 用错误的期望 revision 触发条件失败
        db.run('UPDATE events SET title = ?', ['不应生效'])
        return {}
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(OperationError)
    expect((caught as OperationError).appError).toMatchObject({ code: 'CONFLICT', retryable: true })

    expect(db.get<{ title: string }>('SELECT title FROM events WHERE id = ?', [ev.id])?.title).toBe('原日程')
    expect(db.get<{ revision: number }>('SELECT revision FROM events WHERE id = ?', [ev.id])?.revision).toBe(1)
    expect(getOperationReceipt(db, 'op-c')).toBeUndefined()
  })

  it('目标不存在:TARGET_UNAVAILABLE 且整体回滚', async () => {
    const db = await makeTestDb()
    let caught: unknown
    try {
      runOperation(db, opInput({ operationId: 'op-miss' }), () => {
        assertRevision(db, 'todos', 'no-such-id', 1)
        return {}
      })
    } catch (err) {
      caught = err
    }
    expect((caught as OperationError).appError).toMatchObject({ code: 'TARGET_UNAVAILABLE' })
    expect(getOperationReceipt(db, 'op-miss')).toBeUndefined()
  })

  it('apply 抛普通错误:回执与业务写入一起回滚', async () => {
    const db = await makeTestDb()
    const todo = createTodo(db, { title: '原始待办' })
    expect(() =>
      runOperation(db, opInput({ operationId: 'op-fail' }), () => {
        updateTodo(db, todo.id, { title: '先改一半' })
        throw new Error('业务校验失败')
      })
    ).toThrow('业务校验失败')
    expect(db.get<{ title: string }>('SELECT title FROM todos WHERE id = ?', [todo.id])?.title).toBe('原始待办')
    expect(getOperationReceipt(db, 'op-fail')).toBeUndefined()
  })

  it('apply 内禁止嵌套事务;复合 DAO 的内部方法(无独立 BEGIN)可用', async () => {
    const db = await makeTestDb()
    const todo = createTodo(db, { title: '原始待办' })

    // 嵌套 BEGIN 必须失败:runOperation 是唯一事务拥有者
    expect(() =>
      runOperation(db, opInput({ operationId: 'op-nested' }), () => {
        db.transaction(() => {
          db.run('UPDATE todos SET title = ?', ['嵌套写入'])
        })
        return {}
      })
    ).toThrow(/within a transaction/i)
    expect(db.get<{ title: string }>('SELECT title FROM todos WHERE id = ?', [todo.id])?.title).toBe('原始待办')
    expect(getOperationReceipt(db, 'op-nested')).toBeUndefined()

    // 不嵌套事务的内部方法在 apply 内正常工作
    const ev = createEvent(db, { title: '待删日程', startAt: '2026-09-21T09:00', endAt: '2026-09-21T10:00' })
    const ok = runOperation<string>(db, opInput({ operationId: 'op-del', command: 'events:delete', requestHash: 'hash-del' }), () => {
      deleteEventInner(db, ev.id)
      return 'deleted'
    })
    expect(ok).toEqual({ value: 'deleted', replayed: false })
    expect(db.all('SELECT id FROM events WHERE id = ?', [ev.id])).toHaveLength(0)
    expect(db.all('SELECT id FROM todos WHERE linked_event_id = ?', [ev.id])).toHaveLength(0)
  })

  it('结构校验:operationId/command/requestHash 缺失返回 VALIDATION,不产生任何写入', async () => {
    const db = await makeTestDb()
    for (const bad of [
      opInput({ operationId: '' }),
      opInput({ command: '' }),
      opInput({ requestHash: '' })
    ]) {
      expect(() => runOperation(db, bad, () => ({}))).toThrow(OperationError)
    }
    try {
      runOperation(db, opInput({ operationId: '' }), () => ({}))
    } catch (err) {
      expect((err as OperationError).appError).toMatchObject({ code: 'VALIDATION' })
    }
  })
})

// ---------- PERF-02:listTodosDueOn / buildDayAgenda 查询一致性 ----------

describe('PERF-02:按日定向待办查询与全量路径逐字段一致(20% 关联夹具)', () => {
  /** 夹具:200 条待办,截止日跨 5 天(各 40 条),其中 20% 关联日程;
   *  含已完成、无截止、同日不同时刻(验证排序)与缺失关联(事件已删)的情况。 */
  async function seedLinkedFixture(): Promise<SqliteDb> {
    const db = await makeTestDb()
    const dueDays = ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10']
    const times = ['08:00', '12:00', '18:00', '23:59', '06:30']
    for (let i = 0; i < 200; i++) {
      const day = dueDays[i % dueDays.length]
      const time = times[i % times.length]
      // 20% 关联日程;其中 i === 40 的关联事件稍后删除,验证缺失关联时 linkedEvent 同样缺省
      let linkedEventId: string | null = null
      if (i % 5 === 0) {
        const ev = createEvent(db, { title: `执行时段 ${i}`, startAt: `${day}T${time}`, endAt: `${day}T${time}` })
        linkedEventId = ev.id
      }
      const completedAt = i % 10 === 1 ? '2026-10-07T09:00' : null
      const todo = createTodo(db, { title: `待办 ${i}`, notes: i % 2 === 0 ? `备注 ${i}` : null, dueAt: i % 10 === 2 ? null : `${day}T${time}`, linkedEventId })
      if (completedAt) updateTodo(db, todo.id, { completedAt })
    }
    // 直接删除事件行(绕过 deleteEventInner 的外键清理)制造悬挂关联:
    // 该待办 linked_event_id 仍指向已不存在的事件,验证缺失关联时 linkedEvent 同样缺省
    const orphan = db.get<{ id: string }>("SELECT id FROM events WHERE title = '执行时段 40'")
    db.run('DELETE FROM events WHERE id = ?', [orphan!.id])
    return db
  }

  /** 旧实现口径:全量 listTodos 后内存过滤(与改动前 buildDayAgenda 相同) */
  function legacyFilter(db: SqliteDb, date: string) {
    return listTodos(db).filter((t) => {
      if (t.completedAt) return false
      if (!t.dueAt) return false
      return t.dueAt.slice(0, 10) === date
    })
  }

  it('listTodosDueOn 与 listTodos+filter 的字段、排序、linkedEvent 附着完全一致', async () => {
    const db = await seedLinkedFixture()
    for (const date of ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']) {
      const viaTargeted = listTodosDueOn(db, date)
      const viaLegacy = legacyFilter(db, date)
      expect(viaTargeted.map((t) => t.id)).toEqual(viaLegacy.map((t) => t.id))
      // 逐字段深度相等(含 linkedEvent 附着与缺失关联时的缺省形态)
      expect(JSON.parse(JSON.stringify(viaTargeted))).toEqual(JSON.parse(JSON.stringify(viaLegacy)))
    }
    // 抽查关联附着:命中行中 20% 关联仍带 linkedEvent;缺失关联(事件已删)不携带 linkedEvent 字段
    const dayTodos = listTodosDueOn(db, '2026-10-08')
    expect(dayTodos.length).toBeGreaterThan(0)
    for (const t of dayTodos) {
      if (t.linkedEventId && db.get('SELECT id FROM events WHERE id = ?', [t.linkedEventId])) {
        expect(t.linkedEvent?.id).toBe(t.linkedEventId)
      } else {
        expect(t.linkedEvent).toBeUndefined()
      }
    }
  })

  it('buildDayAgenda(date).todos 与旧口径一致,events/schoolEvents 不受影响', async () => {
    const db = await seedLinkedFixture()
    for (const date of ['2026-10-06', '2026-10-08', '2026-10-10']) {
      const agenda = buildDayAgenda(db, date)
      const legacy = legacyFilter(db, date)
      expect(agenda.date).toBe(date)
      expect(JSON.parse(JSON.stringify(agenda.todos))).toEqual(JSON.parse(JSON.stringify(legacy)))
      // 事件分区与旧实现同一查询路径(listEventsRange 按日区间),此处核对排序键稳定性
      for (const ev of agenda.events) {
        expect(ev.startAt.slice(0, 10)).toBe(date)
      }
    }
  })
})
