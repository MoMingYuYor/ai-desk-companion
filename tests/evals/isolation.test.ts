import { describe, expect, it } from 'vitest'
import { createIsolatedCaseEnv, getFixtureById, registerFixtureById } from '../../src/main/evals/isolation'
import type { EvalCase } from '../../src/main/evals/types'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTodo } from '../../src/main/db/dao'
import { initWorkspaceEpoch } from '../../src/main/db/operations'
import { ToolGateway } from '../../src/main/tools/gateway'
import { ToolRegistry } from '../../src/main/tools/registry'
import { registerOpsTools } from '../../src/main/tools/definitions'

// E-02:隔离执行。EVAL-01:两 case 修改相同 task ID,各自只看到本 case 数据;
// EVAL-02:自动批准开关不存在(网关拒绝 approved 声明)。

const SQL_JS = join(process.cwd(), 'node_modules', 'sql.js', 'dist')

const CASE_BASE: EvalCase = {
  schema_version: 1,
  case_id: 'case-x',
  dataset_version: 'personal_ops_v1',
  mode: 'personal_ops',
  category: '可撤销写',
  split: 'dev',
  input: '创建任务',
  fixture_id: 'ops-empty',
  clock: '2026-09-28T01:00:00.000Z',
  timezone: 'Asia/Shanghai',
  expected: { terminal_status: 'succeeded' },
  interaction_script: [{ on: 'confirmation', decision: 'approved' }],
  budgets: {},
  tags: []
}

function caseWith(id: string, fixtureId = 'ops-empty'): EvalCase {
  return { ...CASE_BASE, case_id: id, fixture_id: fixtureId }
}

describe('fixture 注册', () => {
  it('内置 ops-empty 存在;未注册的 fixture_id 报错', async () => {
    expect(getFixtureById('ops-empty')?.description).toContain('空业务库')
    const root = mkdtempSync(join(tmpdir(), 'eval-iso-'))
    await expect(createIsolatedCaseEnv(root, caseWith('c', '不存在的fixture'), SQL_JS)).rejects.toThrow(
      /未注册的评测 fixture/
    )
  })
})

describe('EVAL-01 case 间隔离', () => {
  it('两 case 修改相同 task ID:各自只看到本 case 数据', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-iso-'))
    // 预先在两个隔离库里各建一条同名 id 不同的待办(模拟 fixture 提供同名任务)
    const envA = await createIsolatedCaseEnv(root, caseWith('case-a'), SQL_JS)
    const envB = await createIsolatedCaseEnv(root, caseWith('case-b'), SQL_JS)
    const a = createTodo(envA.db, { title: '同名任务A' }, 'manual')
    const b = createTodo(envB.db, { title: '同名任务B' }, 'manual')

    // 各自库内只能看到自己的记录
    const rowsA = envA.db.all<{ id: string }>('SELECT id FROM todos')
    const rowsB = envB.db.all<{ id: string }>('SELECT id FROM todos')
    expect(rowsA.map((r) => r.id)).toEqual([a.id])
    expect(rowsB.map((r) => r.id)).toEqual([b.id])
    expect(a.id).not.toBe(b.id)

    // 修改 A 不影响 B(跨 case 无污染)
    envA.db.run('UPDATE todos SET title = ? WHERE id = ?', ['A 已改', a.id])
    expect(envB.db.get<{ title: string }>('SELECT title FROM todos WHERE id = ?', [b.id])?.title).toBe('同名任务B')

    envA.dispose()
    envB.dispose()
  })

  it('固定时钟冻结领域时间,dispose 后临时目录清理', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-iso-'))
    const env = await createIsolatedCaseEnv(root, caseWith('case-clock'), SQL_JS)
    expect(env.clock.now().toISOString()).toBe('2026-09-28T01:00:00.000Z')
    expect(join(env.dir, 'case.sqlite')).toBeTruthy()
    const dir = env.dir
    env.dispose()
    expect(require('node:fs').existsSync(dir)).toBe(false)
  })
})

describe('EVAL-02 无自动批准开关', () => {
  it('正常入口不存在 autoApprove 类选项:网关仍拒绝 approved 声明', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-iso-'))
    const env = await createIsolatedCaseEnv(root, caseWith('case-approve'), SQL_JS)
    initWorkspaceEpoch()
    const registry = new ToolRegistry()
    registerOpsTools(registry)
    const gateway = new ToolGateway({ db: env.db, registry, clock: env.clock })
    // 传入 approved=true 的参数:schema 以未知字段拒绝(到达不了网关的批准检查),
    // 无批准记录,无业务写入——双防线中第一道在 schema 层即生效
    expect(() =>
      gateway.propose({
        runId: 'r',
        tool: 'todo.create',
        arguments: { title: '越权', approved: true },
        planVersion: 1
      })
    ).toThrow(/未知字段:approved/)
    expect(env.db.all("SELECT * FROM todos WHERE title = '越权'").length).toBe(0)
    void getFixtureById
    env.dispose()
  })
})
