// runOperation / 操作回执 / 条件更新测试(计划 Task 2 Interfaces)。
// 红灯依据:src/main/db/operations.ts 尚不存在,导入即失败。
import { describe, expect, it, vi } from 'vitest'
import { createEvent, createTodo, deleteEventInner, updateTodo } from '../../src/main/db/dao'
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
