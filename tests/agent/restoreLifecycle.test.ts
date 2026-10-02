import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { makeTestDb } from '../helpers'
import { openDatabase } from '../../src/main/db/connection'
import { initSchema } from '../../src/main/db/dao'
import { getWorkspaceEpoch, initWorkspaceEpoch } from '../../src/main/db/operations'
import { createRun, getRun, transitionRun } from '../../src/main/runs/repository'
import { RunQueue } from '../../src/main/agent/runQueue'
import { RunScheduler } from '../../src/main/agent/runScheduler'
import { recoverInterruptedRuns } from '../../src/main/agent/recovery'
import { exportBackup, restoreBackup, isRestoreWindowOpen } from '../../src/main/services/backup'

const NOW = '2026-09-30T01:00:00.000Z'

it.each(['personal_ops', 'research'] as const)('%s 恢复等待完整驱动退出，同 ID 快照不会承接旧驱动', async mode => {
  const db = await makeTestDb()
  initWorkspaceEpoch()
  const epoch = getWorkspaceEpoch()
  const run = createRun(db, { mode, input: '旧运行', contextClock: NOW })
  const backup = join(mkdtempSync(join(tmpdir(), 'restore-agent-')), 'backup.json')
  const current = run
  const scheduler = new RunScheduler(db, new RunQueue(db), { workspaceEpoch: getWorkspaceEpoch })
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  scheduler.register(mode, async (id, _intent, signal) => {
    transitionRun(db, id, 'planning')
    await blocked
    if (!signal.aborted) transitionRun(db, id, 'succeeded')
  })
  scheduler.request()
  await vi.waitFor(() => expect(scheduler.currentDriver()?.runId).toBe(current.runId))
  exportBackup(db, backup) // 与正在退出的驱动使用完全相同的 runId。
  const cancel = vi.fn((id: string) => transitionRun(db, id, 'cancelled'))
  let replaced = 0
  const restoring = restoreBackup(db, backup, {
    quiesceExternal: () => scheduler.quiesceForRestore(cancel),
    afterReplace: () => { replaced++; recoverInterruptedRuns(db) }
  })
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith(current.runId))
  expect(replaced).toBe(0)
  expect(getWorkspaceEpoch()).toBe(epoch)
  expect(scheduler.currentDriver()?.signal.aborted).toBe(true)
  release()
  await restoring
  expect(replaced).toBe(1)
  expect(getRun(db, run.runId)?.errorCode).toBe('WORKER_INTERRUPTED')
  expect(getRun(db, current.runId)?.status).toBe('failed')
  expect(getWorkspaceEpoch()).not.toBe(epoch)
  expect(scheduler.currentDriver()).toBeNull()
  const next = createRun(db, { mode, input: '新运行', contextClock: NOW })
  scheduler.request()
  await vi.waitFor(() => expect(getRun(db, next.runId)?.status).toBe('succeeded'))
})

it('排空超时拒绝替换，旧驱动保持占位直到退出，暂停句柄可重复释放', async () => {
  const db = await makeTestDb()
  initWorkspaceEpoch()
  const epoch = getWorkspaceEpoch()
  const run = createRun(db, { mode: 'personal_ops', input: '阻塞', contextClock: NOW })
  const file = join(mkdtempSync(join(tmpdir(), 'restore-timeout-')), 'backup.json')
  exportBackup(db, file)
  const scheduler = new RunScheduler(db, new RunQueue(db))
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  scheduler.register('personal_ops', async id => { transitionRun(db, id, 'planning'); await blocked })
  scheduler.request()
  await vi.waitFor(() => expect(scheduler.currentDriver()).not.toBeNull())
  const replaced = vi.fn()
  await expect(restoreBackup(db, file, {
    quiesceExternal: () => scheduler.quiesceForRestore(id => transitionRun(db, id, 'cancelled'), 10),
    afterReplace: replaced
  })).rejects.toThrow('超时')
  expect(replaced).not.toHaveBeenCalled()
  expect(getWorkspaceEpoch()).toBe(epoch)
  expect(scheduler.currentDriver()?.runId).toBe(run.runId)
  expect(isRestoreWindowOpen()).toBe(false)
  release()
  await vi.waitFor(() => expect(scheduler.currentDriver()).toBeNull())
  const resume = await scheduler.quiesceForRestore(() => {})
  resume(); resume()
})

it.each(['planning', 'executing'] as const)('恢复的 %s 状态在首次落盘前修复，事务钩子失败回滚', async status => {
  const dir = mkdtempSync(join(tmpdir(), 'restore-disk-'))
  const path = join(dir, 'db.sqlite')
  const sqljs = join(process.cwd(), 'node_modules/sql.js/dist')
  const { db } = await openDatabase(path, sqljs)
  initSchema(db)
  initWorkspaceEpoch()
  const donor = await makeTestDb()
  const run = createRun(donor, { mode: 'research', input: '备份运行', contextClock: NOW })
  transitionRun(donor, run.runId, 'planning')
  if (status === 'executing') transitionRun(donor, run.runId, 'executing')
  const file = join(dir, 'backup.json')
  exportBackup(donor, file)
  const original = createRun(db, { mode: 'personal_ops', input: '原库', contextClock: NOW })
  await expect(restoreBackup(db, file, { afterReplace: () => { throw new Error('钩子失败') } })).rejects.toThrow('钩子失败')
  expect(getRun(db, original.runId)).toBeDefined()
  expect(getRun(db, run.runId)).toBeNull()
  await restoreBackup(db, file, { afterReplace: () => { recoverInterruptedRuns(db) } })
  const { db: disk } = await openDatabase(path, sqljs)
  expect(getRun(disk, run.runId)?.status).toBe('failed')
  expect(getRun(disk, run.runId)?.errorCode).toBe('WORKER_INTERRUPTED')
})

it('替换和原快照均无法落盘时保留故障窗口及外部暂停，不广播成功', async () => {
  const db = await makeTestDb()
  initWorkspaceEpoch()
  const donor = await makeTestDb()
  createRun(donor, { mode: 'personal_ops', input: '导入数据', contextClock: NOW })
  const file = join(mkdtempSync(join(tmpdir(), 'restore-lock-')), 'backup.json')
  exportBackup(donor, file)
  const flush = db.flush.bind(db)
  vi.spyOn(db, 'flush').mockImplementationOnce(flush).mockImplementation(() => { throw new Error('持续保存失败') })
  const resume = vi.fn()
  const broadcast = vi.fn()
  await expect(restoreBackup(db, file, { quiesceExternal: async () => resume, onRestored: broadcast })).rejects.toThrow('已暂停写入')
  expect(isRestoreWindowOpen()).toBe(true)
  expect(resume).not.toHaveBeenCalled()
  expect(broadcast).not.toHaveBeenCalled()
})
