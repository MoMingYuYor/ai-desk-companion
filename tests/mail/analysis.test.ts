import { describe, expect, it, vi } from 'vitest'
import { makeTestDb } from '../helpers'
import { createConversation, getConversation, insertAnalysis, insertMaterial } from '../../src/main/db/dao'
import { MAIL_LIMITS, type MailSource } from '../../src/shared/mail'
import type { Analysis } from '../../src/shared/types'
import { MailAnalysisService, MailAnalysisError } from '../../src/main/mail/analysis'
import {
  ensureLink,
  getLinkBySource,
  recordVersion,
  setLinkStatus
} from '../../src/main/mail/analysisRepository'

type TestDb = Awaited<ReturnType<typeof makeTestDb>>

const SOURCE_KEY = 'mail:qq:test-case-1'

/** 宏任务级让步:冲刷所有挂起的微任务(任务续体、迟到结果) */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function snapshotJson(overrides: Partial<MailSource> = {}): string {
  const snapshot: MailSource = {
    sourceKey: SOURCE_KEY,
    messageId: 'm1',
    accountEmail: 'student@qq.com',
    subject: '开学材料提交通知',
    from: 'teacher@example.com',
    receivedAt: '2026-09-16T02:00:00.000Z',
    accountRemoved: false,
    ...overrides
  }
  return JSON.stringify(snapshot)
}

function buildService(db: TestDb, analysisBytes = MAIL_LIMITS.analysisBytes) {
  const createdAnalyses: Analysis[] = []
  const runner = {
    runAnalysis: vi.fn((conversationId: string) => {
      const analysis = insertAnalysis(
        db,
        conversationId,
        { title: `分析结果 v${createdAnalyses.length + 1}` },
        { modelLabel: 'mock-model' }
      )
      createdAnalyses.push(analysis)
      return Promise.resolve(analysis)
    }),
    stop: vi.fn()
  }
  const materials = {
    addTextMaterial: vi.fn((conversationId: string, name: string, content: string) =>
      insertMaterial(db, { conversationId, name, type: 'text' as const, content })
    )
  }
  const service = new MailAnalysisService({ db, runner, materials, analysisBytes })
  return { service, runner, materials, createdAnalyses }
}

describe('邮件分析服务', () => {
  it('首次 start:创建会话、准备材料、记录版本并 running→done', async () => {
    const db = await makeTestDb()
    ensureLink(db, { sourceKey: SOURCE_KEY, messageId: 'm1', snapshot: snapshotJson() })
    const { service, runner, materials, createdAnalyses } = buildService(db)

    let ranAtState: string | null | undefined
    let ranAtLinkStatus: string | null | undefined
    runner.runAnalysis.mockImplementation((conversationId: string) => {
      // runner 被调用时内存与 link 状态必须已经是 running
      ranAtState = service.status('m1')?.state
      ranAtLinkStatus = getLinkBySource(db, SOURCE_KEY)?.status
      const analysis = insertAnalysis(db, conversationId, { title: '开学材料纪要' }, { modelLabel: 'mock-model' })
      createdAnalyses.push(analysis)
      return Promise.resolve(analysis)
    })

    const st = await service.start({ messageId: 'm1', attachmentIds: [] })
    expect(st.state).toBe('preparing')
    expect(st.conversationId).not.toBe('')

    const conv = getConversation(db, st.conversationId)
    expect(conv?.kind).toBe('analysis')
    expect(conv?.title).toBe('开学材料提交通知') // 会话标题取邮件主题

    // 排队阶段不调用 runner、不插入材料
    expect(runner.runAnalysis).not.toHaveBeenCalled()
    expect(materials.addTextMaterial).not.toHaveBeenCalled()

    const ids = service.prepareMaterials(st.conversationId, '请于本周五前提交材料', [])
    expect(ids).toHaveLength(1)
    // 正文材料以邮件主题命名
    expect(materials.addTextMaterial).toHaveBeenCalledWith(
      st.conversationId,
      '开学材料提交通知',
      '请于本周五前提交材料'
    )

    await tick()

    expect(ranAtState).toBe('running')
    expect(ranAtLinkStatus).toBe('running')

    const done = service.status('m1')
    expect(done?.state).toBe('done')
    expect(done?.conversationId).toBe(st.conversationId)
    expect(done?.analysisId).toBe(createdAnalyses[0]?.id)

    // 版本表记录本次 materialIds 快照
    const versionRows = db.all<{ analysis_id: string; material_ids: string }>(
      'SELECT * FROM mail_analysis_versions'
    )
    expect(versionRows).toHaveLength(1)
    expect(versionRows[0]?.analysis_id).toBe(createdAnalyses[0]?.id)
    expect(JSON.parse(versionRows[0]?.material_ids ?? '[]')).toEqual(ids)

    const link = getLinkBySource(db, SOURCE_KEY)
    expect(link?.status).toBe('done')
    expect(link?.conversationId).toBe(st.conversationId)
    expect(link?.lastMaterialIds).toEqual(ids)
  })

  it('runner 抛错时状态转 failed 并写入 last_error', async () => {
    const db = await makeTestDb()
    ensureLink(db, { sourceKey: SOURCE_KEY, messageId: 'm1', snapshot: snapshotJson() })
    const { service, runner } = buildService(db)
    runner.runAnalysis.mockImplementation(() => Promise.reject(new Error('模型连接失败')))

    const st = await service.start({ messageId: 'm1', attachmentIds: [] })
    service.prepareMaterials(st.conversationId, '正文', [])
    await tick()

    const status = service.status('m1')
    expect(status?.state).toBe('failed')
    expect(status?.error).toBe('模型连接失败')
    const link = getLinkBySource(db, SOURCE_KEY)
    expect(link?.status).toBe('failed')
    expect(link?.lastError).toBe('模型连接失败')
    // 失败没有分析产物,不写版本
    expect(db.all('SELECT * FROM mail_analysis_versions')).toHaveLength(0)
  })

  it('running 中重复 start 返回同一会话且 runner 只被调用一次', async () => {
    const db = await makeTestDb()
    ensureLink(db, { sourceKey: SOURCE_KEY, messageId: 'm1', snapshot: snapshotJson() })
    const { service, runner } = buildService(db)
    let release!: (analysis: Analysis) => void
    runner.runAnalysis.mockImplementation(
      () =>
        new Promise<Analysis>((resolve) => {
          release = resolve
        })
    )

    const first = await service.start({ messageId: 'm1', attachmentIds: [] })
    service.prepareMaterials(first.conversationId, '正文', [])
    await tick()
    expect(runner.runAnalysis).toHaveBeenCalledTimes(1)

    const second = await service.start({ messageId: 'm1', attachmentIds: [] })
    expect(second.conversationId).toBe(first.conversationId)
    expect(second.state).toBe('running')
    expect(runner.runAnalysis).toHaveBeenCalledTimes(1) // 双击互斥

    release(insertAnalysis(db, first.conversationId, { title: '手动完成' }))
    await tick()
    expect(service.status('m1')?.state).toBe('done')
  })

  it('cancel 调用 runner.stop 并置 cancelled,迟到的 AbortError 不覆盖状态', async () => {
    const db = await makeTestDb()
    ensureLink(db, { sourceKey: SOURCE_KEY, messageId: 'm1', snapshot: snapshotJson() })
    const { service, runner } = buildService(db)
    let rejectRun!: (err: Error) => void
    runner.runAnalysis.mockImplementation(
      () =>
        new Promise<Analysis>((_resolve, reject) => {
          rejectRun = reject
        })
    )
    runner.stop.mockImplementation((_conversationId: string) => {
      const err = new Error('已取消')
      err.name = 'AbortError'
      rejectRun(err)
    })

    const st = await service.start({ messageId: 'm1', attachmentIds: [] })
    service.prepareMaterials(st.conversationId, '正文', [])
    await tick()
    expect(runner.runAnalysis).toHaveBeenCalledTimes(1)

    await service.cancel(st.conversationId)
    expect(runner.stop).toHaveBeenCalledWith(st.conversationId)
    expect(service.status('m1')?.state).toBe('cancelled')

    await tick() // 迟到的 AbortError
    expect(service.status('m1')?.state).toBe('cancelled')
    expect(getLinkBySource(db, SOURCE_KEY)?.status).toBe('cancelled')
  })

  it('准备阶段取消时中途任务退出且不调用 runner,quiesce 不被悬挂任务阻塞', async () => {
    const db = await makeTestDb()
    ensureLink(db, { sourceKey: SOURCE_KEY, messageId: 'm1', snapshot: snapshotJson() })
    const { service, runner } = buildService(db)

    const st = await service.start({ messageId: 'm1', attachmentIds: [] })
    await service.cancel(st.conversationId)
    expect(runner.stop).toHaveBeenCalledWith(st.conversationId)
    expect(service.status('m1')?.state).toBe('cancelled')

    await tick()
    expect(runner.runAnalysis).not.toHaveBeenCalled()

    const resume = await service.quiesce()
    resume()
  })

  it('prepareMaterials 合计超过 20MiB 上限抛 LIMIT 且不写任何材料', async () => {
    const db = await makeTestDb()
    const { service, materials } = buildService(db)
    const limit = MAIL_LIMITS.analysisBytes

    const catchCode = (fn: () => void): string | null => {
      try {
        fn()
        return null
      } catch (err) {
        expect(err).toBeInstanceOf(MailAnalysisError)
        return (err as MailAnalysisError).code
      }
    }

    // 正文单独超限
    expect(catchCode(() => service.prepareMaterials('conv-x', 'x'.repeat(limit + 1), []))).toBe('LIMIT')
    // 正文与附件合计超限
    expect(
      catchCode(() =>
        service.prepareMaterials('conv-x', 'x'.repeat(limit / 2 + 1), [
          { id: 'att-1', name: '附件.txt', mime: 'text/plain', content: 'x'.repeat(limit / 2 + 1) }
        ])
      )
    ).toBe('LIMIT')
    expect(materials.addTextMaterial).not.toHaveBeenCalled()
    expect(db.all('SELECT * FROM materials')).toHaveLength(0)
  })

  it('listAnalyses 返回按版本排序的多次分析', async () => {
    const db = await makeTestDb()
    ensureLink(db, { sourceKey: SOURCE_KEY, messageId: 'm1', snapshot: snapshotJson() })
    const { service, createdAnalyses } = buildService(db)

    const first = await service.start({ messageId: 'm1', attachmentIds: [] })
    const ids1 = service.prepareMaterials(first.conversationId, '第一版正文', [])
    await tick()

    // 上一次已完成,允许重新分析形成新版本
    const second = await service.start({ messageId: 'm1', attachmentIds: [] })
    expect(second.conversationId).toBe(first.conversationId)
    const ids2 = service.prepareMaterials(second.conversationId, '第二版正文', [])
    await tick()

    const list = service.listAnalyses(first.conversationId)
    expect(list).toHaveLength(2)
    expect(list[0]?.version).toBe(1)
    expect(list[1]?.version).toBe(2)
    expect(list[0]?.payload.title).toBe('分析结果 v1')
    expect(list[1]?.payload.title).toBe('分析结果 v2')
    expect(list.map((a) => a.id)).toEqual(createdAnalyses.map((a) => a.id))
    expect(list[0]?.conversationId).toBe(first.conversationId)

    const versions = db
      .all<{ analysis_id: string; material_ids: string }>(
        'SELECT * FROM mail_analysis_versions ORDER BY rowid'
      )
      .map((row) => ({ analysisId: row.analysis_id, materialIds: JSON.parse(row.material_ids) as string[] }))
    expect(versions).toHaveLength(2)
    expect(versions[0]?.materialIds).toEqual(ids1)
    expect(versions[1]?.materialIds).toEqual(ids2)
  })

  it('start 未知 messageId 抛 NOT_FOUND', async () => {
    const db = await makeTestDb()
    const { service } = buildService(db)
    await expect(service.start({ messageId: 'missing', attachmentIds: [] })).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })

  it('quiesce 等待在途分析完成后暂停新 start,恢复函数解除暂停', async () => {
    const db = await makeTestDb()
    ensureLink(db, { sourceKey: SOURCE_KEY, messageId: 'm1', snapshot: snapshotJson() })
    const { service, runner } = buildService(db)
    let release!: (analysis: Analysis) => void
    runner.runAnalysis.mockImplementation(
      () =>
        new Promise<Analysis>((resolve) => {
          release = resolve
        })
    )

    const st = await service.start({ messageId: 'm1', attachmentIds: [] })
    service.prepareMaterials(st.conversationId, '正文', [])
    await tick()

    const quiescing = service.quiesce()
    // 暂停期间拒绝新的 start
    await expect(service.start({ messageId: 'm1', attachmentIds: [] })).rejects.toMatchObject({
      code: 'BUSY'
    })

    release(insertAnalysis(db, st.conversationId, { title: '收尾' }))
    const resume = await quiescing
    expect(service.status('m1')?.state).toBe('done')

    resume()
    const again = await service.start({ messageId: 'm1', attachmentIds: [] })
    expect(again.state).toBe('preparing')
    expect(again.conversationId).toBe(st.conversationId)
  })

  it('source 返回快照字段且 accountRemoved 恒为 false', async () => {
    const db = await makeTestDb()
    ensureLink(db, { sourceKey: SOURCE_KEY, messageId: 'm1', snapshot: snapshotJson() })
    const { service } = buildService(db)

    const src = service.source(SOURCE_KEY)
    expect(src).not.toBeNull()
    expect(src?.sourceKey).toBe(SOURCE_KEY)
    expect(src?.messageId).toBe('m1')
    expect(src?.accountEmail).toBe('student@qq.com')
    expect(src?.subject).toBe('开学材料提交通知')
    expect(src?.from).toBe('teacher@example.com')
    expect(src?.receivedAt).toBe('2026-09-16T02:00:00.000Z')
    expect(src?.accountRemoved).toBe(false)
    expect(service.source('no-such-source')).toBeNull()
  })

  it('status 在无内存状态时回退到 link 表与版本记录', async () => {
    const db = await makeTestDb()
    ensureLink(db, { sourceKey: SOURCE_KEY, messageId: 'm1', snapshot: snapshotJson() })
    const { service } = buildService(db)

    // 从未分析:idle 状态返回 null
    expect(service.status('m1')).toBeNull()

    const conv = createConversation(db, 'analysis', '开学材料提交通知')
    setLinkStatus(db, SOURCE_KEY, 'done')
    db.run('UPDATE mail_analysis_links SET conversation_id = ? WHERE source_key = ?', [
      conv.id,
      SOURCE_KEY
    ])
    const analysis = insertAnalysis(db, conv.id, { title: '历史版本' })
    recordVersion(db, analysis.id, SOURCE_KEY, ['mat-1'])

    const st = service.status('m1')
    expect(st?.state).toBe('done')
    expect(st?.conversationId).toBe(conv.id)
    expect(st?.analysisId).toBe(analysis.id)
    expect(st?.error).toBeNull()
  })
})
