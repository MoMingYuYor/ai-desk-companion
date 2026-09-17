import { describe, expect, it, vi } from 'vitest'
import { makeTestDb } from '../helpers'
import { confirmCandidate } from '../../src/main/db/dao'
import type { ActionCandidate } from '../../src/shared/types'
import { MailConfirmationService } from '../../src/main/mail/confirmation'
import { recordVersion } from '../../src/main/mail/analysisRepository'

type TestDb = Awaited<ReturnType<typeof makeTestDb>>

/** 模拟 R 区注入的 Engine.confirmItem 包装:真实走 dao.confirmCandidate 建事项 */
function makeConfirmItem(db: TestDb) {
  return vi.fn((_analysisId: string, item: unknown) =>
    confirmCandidate(db, item as ActionCandidate & { reminderMinutes?: number | null })
  )
}

describe('邮箱候选确认幂等', () => {
  it('重复确认同一 (analysisId, candidateIndex) 返回 duplicate 且 refId 不变', async () => {
    const db = await makeTestDb()
    const confirmItem = makeConfirmItem(db)
    const svc = new MailConfirmationService({ db, confirmItem })
    // 预置邮箱分析版本,使 confirm 进入邮箱幂等路径
    recordVersion(db, 'an-mail-1', 'mail:sk:1', [])

    const item: ActionCandidate & { candidateId?: string } = {
      candidateId: 'an-mail-1:0',
      title: '提交报名材料',
      type: 'todo',
      deadline: '2026-09-20T18:00'
    }
    const first = svc.confirm('an-mail-1', 0, item)
    expect(first.result).toBe('created')
    expect(first.refType).toBe('todo')
    expect(first.refId).not.toBe('')

    const again = svc.confirm('an-mail-1', 0, item)
    expect(again.result).toBe('duplicate')
    expect(again.refType).toBe('todo')
    expect(again.refId).toBe(first.refId)

    expect(confirmItem).toHaveBeenCalledTimes(1) // 只建一次事项
    expect(db.all('SELECT * FROM mail_confirmations')).toHaveLength(1)
    expect(db.all('SELECT * FROM todos')).toHaveLength(1)
  })

  it('同一封邮件不同 candidateIndex 各自确认成功', async () => {
    const db = await makeTestDb()
    const confirmItem = makeConfirmItem(db)
    const svc = new MailConfirmationService({ db, confirmItem })
    recordVersion(db, 'an-mail-2', 'mail:sk:2', [])

    const todo = svc.confirm('an-mail-2', 0, {
      title: '缴纳学费',
      type: 'todo',
      deadline: '2026-09-25T23:59'
    })
    const event = svc.confirm('an-mail-2', 1, {
      title: '参加开学典礼',
      type: 'event',
      start: '2026-09-28T09:00',
      durationMinutes: 120
    })

    expect(todo.result).toBe('created')
    expect(todo.refType).toBe('todo')
    expect(event.result).toBe('created')
    expect(event.refType).toBe('event')
    expect(todo.refId).not.toBe('')
    expect(event.refId).not.toBe('')
    expect(todo.refId).not.toBe(event.refId)
    expect(confirmItem).toHaveBeenCalledTimes(2)

    const rows = db.all<{ candidate_index: number; ref_type: string; ref_id: string }>(
      'SELECT * FROM mail_confirmations ORDER BY candidate_index'
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]?.candidate_index).toBe(0)
    expect(rows[0]?.ref_type).toBe('todo')
    expect(rows[0]?.ref_id).toBe(todo.refId)
    expect(rows[1]?.candidate_index).toBe(1)
    expect(rows[1]?.ref_type).toBe('event')
    expect(rows[1]?.ref_id).toBe(event.refId)
  })

  it('confirmItem 抛错时不写入幂等记录', async () => {
    const db = await makeTestDb()
    const confirmItem = vi.fn((_analysisId: string, _item: unknown) => {
      throw new Error('模型服务不可用')
    })
    const svc = new MailConfirmationService({ db, confirmItem })
    recordVersion(db, 'an-mail-3', 'mail:sk:3', [])

    expect(() =>
      svc.confirm('an-mail-3', 0, { title: '待办事项', type: 'todo' })
    ).toThrow('模型服务不可用')

    expect(db.all('SELECT * FROM mail_confirmations')).toHaveLength(0)
    expect(db.all('SELECT * FROM todos')).toHaveLength(0)
  })

  it('普通分析(无邮箱版本记录)不走邮箱幂等映射,原样透传', async () => {
    const db = await makeTestDb()
    const confirmItem = vi.fn((_analysisId: string, _item: unknown) => ({
      result: 'created' as const,
      refType: 'todo' as const,
      refId: 'plain-target-1'
    }))
    const svc = new MailConfirmationService({ db, confirmItem })

    const first = svc.confirm('plain-analysis', 0, { title: '普通事项', type: 'todo' })
    expect(first).toEqual({ result: 'created', refType: 'todo', refId: 'plain-target-1' })
    // 无版本记录即无邮箱映射,重复确认继续透传(由全局指纹去重兜底)
    svc.confirm('plain-analysis', 0, { title: '普通事项', type: 'todo' })
    expect(confirmItem).toHaveBeenCalledTimes(2)
    expect(db.all('SELECT * FROM mail_confirmations')).toHaveLength(0)
  })

  it('重复确认返回第一次目标,不因重复请求新建事项', async () => {
    const db = await makeTestDb()
    const confirmItem = makeConfirmItem(db)
    const svc = new MailConfirmationService({ db, confirmItem })
    recordVersion(db, 'an-mail-4', 'mail:sk:4', [])

    const item: ActionCandidate & { candidateId?: string } = {
      candidateId: 'an-mail-4:2',
      title: '领取教材',
      type: 'todo',
      deadline: '2026-09-22T17:00'
    }
    const created = svc.confirm('an-mail-4', 2, item)
    for (let i = 0; i < 3; i++) {
      const again = svc.confirm('an-mail-4', 2, item)
      expect(again.result).toBe('duplicate')
      expect(again.refId).toBe(created.refId)
    }
    expect(confirmItem).toHaveBeenCalledTimes(1)
    expect(db.all('SELECT * FROM todos')).toHaveLength(1)
  })
})
