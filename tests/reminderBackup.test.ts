import { describe, expect, it } from 'vitest'
import { addMinutesIso, nowLocalIso } from '../src/shared/dateUtils'
import { createEvent, createTodo, getTodo, saveProfileFact, updateTodo, getMeta, setMeta } from '../src/main/db/dao'
import { exportBackup, importBackup } from '../src/main/services/backup'
import { getOperationReceipt, getWorkspaceEpoch, initWorkspaceEpoch, runOperation } from '../src/main/db/operations'
import { dueReminders, ReminderService, type ReminderDeps } from '../src/main/services/reminder'
import { makeTestDb } from './helpers'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

function makeReminderDeps(db: Awaited<ReturnType<typeof makeTestDb>>): { deps: ReminderDeps; notices: Array<{ title: string }> } {
  const notices: Array<{ title: string }> = []
  return {
    notices,
    deps: {
      db,
      broadcast: () => {},
      showNotification: (n) => notices.push({ title: n.title }),
      onFired: () => {}
    }
  }
}

describe('计划规则:完成任务后,旧提醒失效', () => {
  it('未完成的到期待办触发提醒;完成后不再触发', async () => {
    const db = await makeTestDb()
    const past = addMinutesIso(nowLocalIso(), -5)
    const td = createTodo(db, { title: '交报名表', dueAt: past })
    const { deps, notices } = makeReminderDeps(db)

    let svc = new ReminderService(deps)
    svc.tick()
    expect(notices.length).toBe(1)
    expect(notices[0].title).toContain('交报名表')

    // 同一提醒不重复触发
    svc = new ReminderService(deps)
    svc.tick()
    expect(notices.length).toBe(1)

    // 完成后,即使再次修改截止时间也不提示
    updateTodo(db, td.id, { completedAt: nowLocalIso() })
    updateTodo(db, td.id, { dueAt: addMinutesIso(nowLocalIso(), -60) })
    new ReminderService(deps).tick()
    expect(notices.length).toBe(1)
    expect(getTodo(db, td.id)?.completedAt).toBeTruthy()
  })
})

describe('提醒:日程提前提醒与错过的提醒', () => {
  it('到达提醒时间触发;未到不触发', async () => {
    const db = await makeTestDb()
    const soon = addMinutesIso(nowLocalIso(), 5)
    createEvent(db, { title: '项目会', startAt: soon, endAt: addMinutesIso(soon, 60), reminderMinutes: 10 })
    const later = addMinutesIso(nowLocalIso(), 120)
    createEvent(db, { title: '晚课', startAt: later, endAt: addMinutesIso(later, 90), reminderMinutes: 15 })
    const { deps, notices } = makeReminderDeps(db)
    new ReminderService(deps).tick()
    expect(notices.length).toBe(1)
    expect(notices[0].title).toContain('项目会')
  })
})

describe('手动备份恢复', () => {
  it('导出后导入,数据一致(不含模型密钥)', async () => {
    const db = await makeTestDb()
    createTodo(db, { title: '待办A', dueAt: '2026-09-18T23:59' })
    createEvent(db, { title: '日程B', startAt: '2026-09-16T14:00', endAt: '2026-09-16T15:00' })
    saveProfileFact(db, { category: 'basic', key: '身份', value: '学生' })
    setMeta(db, 'provider:key', 'should-not-matter')

    const dir = mkdtempSync(join(tmpdir(), 'aide-backup-'))
    const file = join(dir, 'backup.json')
    exportBackup(db, file)

    const db2 = await makeTestDb()
    setMeta(db2, 'provider:key', 'should-not-matter')
    importBackup(db2, file)
    expect(listTodosSafe(db2)).toHaveLength(1)
    expect(db2.all('SELECT * FROM events')).toHaveLength(1)
    expect(db2.all("SELECT * FROM profile_facts WHERE key = '身份'")).toHaveLength(1)
    // 模型配置/设置(meta)不在备份范围,恢复后保留
    expect(getMeta(db2, 'provider:key')).toBe('should-not-matter')
  })
})

describe('R1: 备份包含操作回执与修订号(v4)', () => {
  it('导出含 operation_receipts 与 revision;恢复后回执随业务数据还原、revision 保留、同 ID 重试幂等', async () => {
    initWorkspaceEpoch()
    const db = await makeTestDb()
    const { value: todo } = runOperation(
      db,
      { operationId: 'op-receipt-1', command: 'todos:create', requestHash: 'hash-1', workspaceEpoch: getWorkspaceEpoch() },
      () => createTodo(db, { title: '回执待办' })
    )
    updateTodo(db, todo.id, { completedAt: nowLocalIso() }) // revision: 1 → 2

    const file = join(mkdtempSync(join(tmpdir(), 'aide-backup-')), 'v4.json')
    exportBackup(db, file)

    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as {
      schemaVersion: number
      tables: Record<string, Array<Record<string, unknown>>>
    }
    expect(parsed.schemaVersion).toBe(4)
    expect(parsed.tables.operation_receipts).toHaveLength(1)
    expect(parsed.tables.todos[0]).toMatchObject({ id: todo.id, revision: 2 })

    const db2 = await makeTestDb()
    initWorkspaceEpoch()
    importBackup(db2, file)
    // 回执随其引用的业务实体恢复
    const receipt = getOperationReceipt(db2, 'op-receipt-1')
    expect(receipt).toMatchObject({ operationId: 'op-receipt-1', command: 'todos:create', requestHash: 'hash-1' })
    // revision 保留备份时的真实值(不再重置为 1)
    expect(getTodo(db2, todo.id)?.revision).toBe(2)
    // 恢复后的库上同 ID 同摘要重试仍幂等返回首次结果,不重新执行
    const again = runOperation(
      db2,
      { operationId: 'op-receipt-1', command: 'todos:create', requestHash: 'hash-1', workspaceEpoch: getWorkspaceEpoch() },
      () => {
        throw new Error('重放不应执行 apply')
      }
    )
    expect(again).toMatchObject({ replayed: true, value: { id: todo.id } })
  })

  it('v3 旧备份受控迁移:无 revision 的行恢复为 1,不伪造回执', async () => {
    const db = await makeTestDb()
    const ts = '2026-09-20T00:00:00.000Z'
    const file = join(mkdtempSync(join(tmpdir(), 'aide-backup-')), 'v3.json')
    writeFileSync(
      file,
      JSON.stringify({
        app: 'ai-desk-companion',
        schemaVersion: 3,
        exportedAt: ts,
        tables: {
          conversations: [],
          messages: [],
          materials: [],
          analyses: [],
          events: [
            {
              id: 'evt-old', title: '旧日程', start_at: '2026-09-16T14:00', end_at: '2026-09-16T15:00',
              all_day: 0, color: null, location: null, notes: null, source: 'manual', source_ref: null,
              reminder_minutes: null, status: 'active', fingerprint: null, created_at: ts, updated_at: ts
            }
          ],
          todos: [
            {
              id: 'todo-old', title: '旧待办', notes: null, due_at: null, priority: 'normal', completed_at: null,
              linked_event_id: null, source: 'manual', source_ref: null, fingerprint: null, created_at: ts, updated_at: ts
            }
          ],
          pending_items: [],
          semesters: [],
          courses: [],
          course_overrides: [],
          school_events: [],
          profile_facts: [],
          mail_analysis_links: [],
          mail_analysis_versions: [],
          mail_confirmations: []
        }
      }),
      'utf-8'
    )

    importBackup(db, file)
    // 旧格式没有 revision:按不变量回到初始值 1
    expect(getTodo(db, 'todo-old')?.revision).toBe(1)
    // 旧 JSON 无回执:不伪造,恢复后回执表为空
    expect(db.all('SELECT * FROM operation_receipts')).toHaveLength(0)
    expect(db.all('SELECT * FROM events')).toHaveLength(1)
    expect(getTodo(db, 'todo-old')?.title).toBe('旧待办')
  })
})

describe('R6: 备份恢复后按 24 小时窗口补报', () => {
  it('恢复后仅补报窗口内的活跃提醒;窗口外的过期日程留历史不重发', async () => {
    const db = await makeTestDb()
    const now = new Date()
    const at = (offsetMs: number): string => {
      const p = (n: number, size = 2): string => String(n).padStart(size, '0')
      const d = new Date(now.getTime() + offsetMs)
      return [d.getFullYear(), p(d.getMonth() + 1), p(d.getDate())].join('-') + 'T' +
        [p(d.getHours()), p(d.getMinutes()), p(d.getSeconds())].join(':') + '.' + p(d.getMilliseconds(), 3)
    }
    const recent = createEvent(db, {
      title: '窗口内日程', startAt: at(-10 * 60_000), endAt: at(50 * 60_000), reminderMinutes: 0
    })
    createEvent(db, {
      title: '过期日程', startAt: at(-25 * 3_600_000), endAt: at(-24 * 3_600_000), reminderMinutes: 0
    })

    const file = join(mkdtempSync(join(tmpdir(), 'aide-backup-')), 'r6-window.json')
    exportBackup(db, file)
    const db2 = await makeTestDb()
    importBackup(db2, file)

    // 注入时钟的窗口判定:只补报 fireAt ∈ [now-24h, now] 的活跃事项
    const ids = dueReminders(db2, now).map((r) => r.entityId)
    expect(ids).toEqual([recent.id])

    // 重启语义:同一恢复库上新服务实例只补报一次,重复扫描不重发
    const { deps, notices } = makeReminderDeps(db2)
    new ReminderService(deps).tick()
    expect(notices.map((n) => n.title)).toEqual(['即将开始:窗口内日程'])
    new ReminderService(deps).tick()
    expect(notices).toHaveLength(1)
  })
})

function listTodosSafe(db: Awaited<ReturnType<typeof makeTestDb>>): unknown[] {
  return db.all('SELECT * FROM todos')
}
