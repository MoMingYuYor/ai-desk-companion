import { describe, expect, it } from 'vitest'
import { makeTestDb } from '../helpers'
import { getMeta } from '../../src/main/db/dao'
import { ToolGateway } from '../../src/main/tools/gateway'
import { ToolRegistry } from '../../src/main/tools/registry'
import { registerOpsTools } from '../../src/main/tools/definitions'
import { createMailDraft, listMailDrafts } from '../../src/main/agent/mailDrafts'
import { DEMO_SEED_FLAG, seedDemoData } from '../../src/main/agent/seed'
import { initWorkspaceEpoch } from '../../src/main/db/operations'
import { importDocument } from '../../src/main/retrieval/importer'
import { systemClock, fixedClock } from '../../src/shared/clock'
import type { ToolDefinition, ToolResult } from '../../src/main/tools/types'
import type { SqliteDb } from '../../src/main/db/connection'

// A-01/A-02:邮件草稿、演示种子与八个本地工具。
// 关键边界:草稿无发送状态字段;Agent 建的记录标 source='agent';
// 虚构 ID 的更新提案在 propose 阶段即被拒绝。

const NOW = '2026-09-28T01:00:00.000Z'

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registerOpsTools(registry)
  return registry
}

function runTool(
  db: SqliteDb,
  tool: string,
  args: Record<string, unknown>,
  targetVersion: number | null = null
): ToolResult {
  const def: ToolDefinition = makeRegistry().get(tool)
  return def.execute(args, { db, clock: systemClock, targetVersion })
}

describe('A-01 邮件草稿', () => {
  it('草稿创建与读取;正文必填;收件人缺省为空数组', async () => {
    const db = await makeTestDb()
    const draft = createMailDraft(db, { body: '正文内容', subject: '主题', recipients: ['a@example.com'] })
    expect(draft.recipients).toEqual(['a@example.com'])
    expect(listMailDrafts(db)).toHaveLength(1)
    expect(draft.sourceRef).toBeNull()

    const bare = createMailDraft(db, { body: '只有正文' })
    expect(bare.recipients).toEqual([])
    expect(bare.subject).toBe('')
  })

  it('空正文拒绝', async () => {
    const db = await makeTestDb()
    expect(() => createMailDraft(db, { body: '   ' })).toThrow(/正文不能为空/)
  })

  it('草稿没有发送状态字段(设计边界:草稿不能被发送)', async () => {
    const db = await makeTestDb()
    const cols = db.all<{ name: string }>('PRAGMA table_info(mail_drafts)').map((c) => c.name)
    expect(cols.filter((c) => /send|sent|发送/.test(c))).toEqual([])
  })
})

describe('A-01 演示种子', () => {
  it('首次播种:任务/日程/草稿/样例 JD 就位且标记来源', async () => {
    const db = await makeTestDb()
    const result = seedDemoData(db)
    expect(result.seeded).toBe(true)

    const todos = db.all<Record<string, unknown>>('SELECT * FROM todos')
    expect(todos).toHaveLength(3)
    expect(todos.filter((t) => t.source === 'agent')).toHaveLength(3)
    expect(todos.filter((t) => t.completed_at != null)).toHaveLength(1)

    expect(db.all('SELECT * FROM events')).toHaveLength(2)
    expect(listMailDrafts(db)).toHaveLength(1)
    expect(retrievalStats(db).documents).toBe(2)
    expect(getMeta(db, DEMO_SEED_FLAG)).toBe('1')
  })

  it('重复播种幂等:计数不变', async () => {
    const db = await makeTestDb()
    seedDemoData(db)
    const second = seedDemoData(db)
    expect(second.seeded).toBe(false)
    expect(db.all('SELECT * FROM todos')).toHaveLength(3)
    expect(db.all('SELECT * FROM events')).toHaveLength(2)
  })
})

describe('A-02 八个工具', () => {
  it('恰好注册八个,无任何发送能力', async () => {
    const registry = makeRegistry()
    expect(registry.list()).toEqual([
      'calendar.create_event',
      'calendar.list',
      'calendar.update_event',
      'document.search',
      'mail.create_draft',
      'todo.create',
      'todo.list',
      'todo.update'
    ])
    expect(registry.list().filter((n) => /send|发送/i.test(n))).toEqual([])
  })

  it('todo.list 按状态与优先级过滤(OPS-01:只读零写操作)', async () => {
    const db = await makeTestDb()
    seedDemoData(db)
    const open = runTool(db, 'todo.list', { status: 'open' })
    expect(open.ok).toBe(true)
    if (open.ok) expect((open.data as { todos: Array<{ completedAt: string | null }> }).todos.every((t) => t.completedAt == null)).toBe(true)

    const high = runTool(db, 'todo.list', { status: 'open', priority: 'high' })
    if (high.ok) expect((high.data as { todos: unknown[] }).todos).toHaveLength(1)
  })

  it('todo.create 以 agent 来源写入;todo.update 用目标版本安全更新', async () => {
    const db = await makeTestDb()
    const created = runTool(db, 'todo.create', { title: '新任务', priority: 'high' })
    expect(created.ok).toBe(true)
    if (created.ok) {
      const todo = (created.data as { todo: { id: string; source: string; revision: number; title: string } }).todo
      expect(todo.source).toBe('agent')
      expect(todo.title).toBe('新任务')

      const updated = runTool(db, 'todo.update', { id: todo.id, title: '改名' }, todo.revision)
      expect(updated.ok).toBe(true)
    }
  })

  it('todo.update 目标版本过期:CONFLICT 而非覆盖他人修改', async () => {
    const db = await makeTestDb()
    const created = runTool(db, 'todo.create', { title: '旧标题' })
    if (!created.ok) throw new Error('创建失败')
    const todo = (created.data as { todo: { id: string; revision: number } }).todo

    // 他人先改了一版,持有旧 revision 的执行必须失败
    const stale = runTool(db, 'todo.update', { id: todo.id, title: '过期修改' }, todo.revision + 5)
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.error.code).toBe('CONFLICT')
  })

  it('calendar.create_event:倒置区间以工具级失败拒绝(OPS 场景)', async () => {
    const db = await makeTestDb()
    const bad = runTool(db, 'calendar.create_event', {
      title: '倒置会议',
      startAt: '2026-09-28T10:00',
      endAt: '2026-09-28T09:00'
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe('VALIDATION')

    const good = runTool(db, 'calendar.create_event', {
      title: '正常会议',
      startAt: '2026-09-28T10:00',
      endAt: '2026-09-28T11:00'
    })
    expect(good.ok).toBe(true)
  })

  it('document.search 检索已导入文档', async () => {
    const db = await makeTestDb()
    importDocument(db, {
      sourceName: 'jd.md',
      sourceType: 'markdown',
      bytes: Buffer.from('要求:熟悉机器学习与检索。', 'utf8')
    })
    const result = runTool(db, 'document.search', { query: '机器学习' })
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.data as { hits: unknown[] }).hits.length).toBeGreaterThan(0)
  })

  it('虚构 ID 的更新提案在 propose 阶段被拒绝(模型不得虚构任务 ID)', async () => {
    const db = await makeTestDb()
    seedDemoData(db)
    const gateway = new ToolGateway({ db, registry: makeRegistry(), clock: fixedClock(NOW) })
    expect(() =>
      gateway.propose({
        runId: 'r',
        tool: 'todo.update',
        arguments: { id: '不存在的ID', title: '改名' },
        planVersion: 1
      })
    ).toThrow(/目标记录不存在/)
  })

  it('approve 后按 arguments_json 还原参数执行,目标版本随之绑定', async () => {
    const db = await makeTestDb()
    initWorkspaceEpoch()
    seedDemoData(db)
    const { createRun } = await import('../../src/main/runs/repository')
    const run = createRun(db, { mode: 'personal_ops', input: '改名任务', contextClock: NOW })
    const gateway = new ToolGateway({ db, registry: makeRegistry(), clock: fixedClock(NOW) })
    const todo = db.get<{ id: string; revision: number }>('SELECT id, revision FROM todos LIMIT 1')!

    const proposal = gateway.propose({
      runId: run.runId,
      tool: 'todo.update',
      arguments: { id: todo.id, title: '经批准的改名' },
      planVersion: 1
    })
    // 批准记录已持久化参数(OPS-10:重启后仍可执行)
    const approval = db.get<{ arguments_json: string }>(
      'SELECT arguments_json FROM approvals WHERE approval_id = ?',
      [proposal.approvalId!]
    )!
    expect(JSON.parse(approval.arguments_json!)).toEqual({ id: todo.id, title: '经批准的改名' })

    db.run("UPDATE approvals SET decision = 'approved', decided_at = ? WHERE approval_id = ?", [
      NOW,
      proposal.approvalId!
    ])
    const result = await gateway.execute({
      runId: run.runId,
      tool: 'todo.update',
      arguments: { id: todo.id, title: '经批准的改名' },
      planVersion: 1,
      callIndex: 0,
      approvalId: proposal.approvalId!
    })
    // 目标版本由网关重解析并注入 ctx,工具据此 assertRevision
    expect(result.ok).toBe(true)
  })
})

function retrievalStats(db: SqliteDb): { documents: number; chunks: number } {
  return {
    documents: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM retrieval_documents')!.n,
    chunks: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM retrieval_chunks')!.n
  }
}
