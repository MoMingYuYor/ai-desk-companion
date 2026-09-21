import { describe, expect, it } from 'vitest'
import { insertPending, updatePending } from '../../src/main/db/dao'
import { getOperationReceipt } from '../../src/main/db/operations'
import { resolveExistingPendingInDb } from '../../src/main/planning/resolveExistingPending'
import { makeTestDb } from '../helpers'

it('R7: pending 状态更新失败时不留下孤立事件', async () => {
  const db = await makeTestDb()
  const pending = insertPending(db, { title: '整理材料' })
  db.run("CREATE TRIGGER reject_pending BEFORE UPDATE ON pending_items BEGIN SELECT RAISE(ABORT, 'forced pending failure'); END")
  const command = {
    context: { operationId: 'op-p1', expectedRevision: 1, workspaceEpoch: 'epoch-1' },
    pendingId: pending.id, decision: 'create_event' as const,
    event: { title: '整理材料', startAt: '2026-09-20T13:00', endAt: '2026-09-20T13:30' }
  }
  expect(() => resolveExistingPendingInDb(db, command)).toThrow()
  expect(db.all("SELECT id FROM events WHERE title = '整理材料'")).toHaveLength(0)
  expect(db.get<{ status: string }>('SELECT status FROM pending_items WHERE id = ?', [pending.id])?.status).toBe('open')
})

describe('R7: resolveExistingPendingInDb 原子转换', () => {
  it('成功路径:创建目标、pending 置 handled(revision+1)、回执落库', async () => {
    const db = await makeTestDb()
    const pending = insertPending(db, { title: '整理材料', notes: '周五前' })
    const command = {
      context: { operationId: 'op-ok-1', expectedRevision: 1, workspaceEpoch: 'epoch-1' },
      pendingId: pending.id,
      decision: 'create_event' as const,
      event: { title: '整理材料', startAt: '2026-09-20T13:00', endAt: '2026-09-20T13:30' }
    }
    const r = resolveExistingPendingInDb(db, command)
    expect(r.pendingId).toBe(pending.id)
    expect(r.targetId).toBeTruthy()
    expect(db.get('SELECT * FROM events WHERE id = ?', [r.targetId])).toMatchObject({
      title: '整理材料', start_at: '2026-09-20T13:00', end_at: '2026-09-20T13:30'
    })
    expect(
      db.get<{ status: string; revision: number }>('SELECT status, revision FROM pending_items WHERE id = ?', [pending.id])
    ).toMatchObject({ status: 'handled', revision: 2 })
    expect(getOperationReceipt(db, 'op-ok-1')).toMatchObject({ command: 'pending:resolve' })
  })

  it('同 ID 同内容重试幂等返回首次结果,不重复创建', async () => {
    const db = await makeTestDb()
    const pending = insertPending(db, { title: '整理材料' })
    const command = {
      context: { operationId: 'op-retry-1', expectedRevision: 1, workspaceEpoch: 'epoch-1' },
      pendingId: pending.id,
      decision: 'create_event' as const,
      event: { title: '整理材料', startAt: '2026-09-20T13:00', endAt: '2026-09-20T13:30' }
    }
    const first = resolveExistingPendingInDb(db, command)
    const second = resolveExistingPendingInDb(db, command)
    expect(second.targetId).toBe(first.targetId)
    expect(db.all('SELECT id FROM events')).toHaveLength(1)
  })

  it('无效输入在开事务前拒绝:不落库、pending 保持 open、不写回执', async () => {
    const db = await makeTestDb()
    const pending = insertPending(db, { title: '整理材料' })
    const command = {
      context: { operationId: 'op-bad-1', expectedRevision: 1, workspaceEpoch: 'epoch-1' },
      pendingId: pending.id,
      decision: 'create_event' as const,
      event: { title: '整理材料', startAt: '2026-09-20T13:00', endAt: '2026-09-20T13:00' }
    }
    expect(() => resolveExistingPendingInDb(db, command)).toThrow(/结束时间/)
    expect(db.all('SELECT id FROM events')).toHaveLength(0)
    expect(db.get<{ status: string }>('SELECT status FROM pending_items WHERE id = ?', [pending.id])?.status).toBe('open')
    expect(getOperationReceipt(db, 'op-bad-1')).toBeUndefined()
  })

  it('修订号过期以 CONFLICT 失败且不创建目标(整体回滚)', async () => {
    const db = await makeTestDb()
    const pending = insertPending(db, { title: '整理材料' })
    updatePending(db, pending.id, { notes: '已被其他窗口改过' }) // revision 1 → 2
    const command = {
      context: { operationId: 'op-stale-1', expectedRevision: 1, workspaceEpoch: 'epoch-1' },
      pendingId: pending.id,
      decision: 'create_event' as const,
      event: { title: '整理材料', startAt: '2026-09-20T13:00', endAt: '2026-09-20T13:30' }
    }
    expect(() => resolveExistingPendingInDb(db, command)).toThrow(/已被其他修改/)
    expect(db.all('SELECT id FROM events')).toHaveLength(0)
  })

  it('已处理条目再次转换被拒绝,不产生第二个目标', async () => {
    const db = await makeTestDb()
    const pending = insertPending(db, { title: '整理材料' })
    updatePending(db, pending.id, { status: 'handled' }) // revision 2
    const command = {
      context: { operationId: 'op-dup-1', expectedRevision: 2, workspaceEpoch: 'epoch-1' },
      pendingId: pending.id,
      decision: 'create_todo' as const,
      todo: { title: '再来一次' }
    }
    expect(() => resolveExistingPendingInDb(db, command)).toThrow(/已处理/)
    expect(db.all('SELECT id FROM todos')).toHaveLength(0)
  })

  it('转为待办走同一原子命令', async () => {
    const db = await makeTestDb()
    const pending = insertPending(db, { title: '买耗材', notes: '白板笔' })
    const r = resolveExistingPendingInDb(db, {
      context: { operationId: 'op-todo-1', expectedRevision: 1, workspaceEpoch: 'epoch-1' },
      pendingId: pending.id,
      decision: 'create_todo',
      todo: { title: '买耗材', notes: '白板笔' }
    })
    expect(db.get('SELECT * FROM todos WHERE id = ?', [r.targetId])).toMatchObject({ title: '买耗材' })
    expect(db.get<{ status: string }>('SELECT status FROM pending_items WHERE id = ?', [pending.id])?.status).toBe('handled')
  })
})
