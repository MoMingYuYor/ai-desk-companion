import { describe, expect, it } from 'vitest'
import { addMinutesIso, nowLocalIso } from '../src/shared/dateUtils'
import { createEvent, createTodo, getTodo, saveProfileFact, updateTodo, getMeta, setMeta } from '../src/main/db/dao'
import { exportBackup, importBackup } from '../src/main/services/backup'
import { ReminderService, type ReminderDeps } from '../src/main/services/reminder'
import { makeTestDb } from './helpers'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
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

function listTodosSafe(db: Awaited<ReturnType<typeof makeTestDb>>): unknown[] {
  return db.all('SELECT * FROM todos')
}
