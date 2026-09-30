// R1(Task 4):备份先验校验——缺表/坏行/未来版本必须在替换前拒绝,原数据不变;
// 合法的完整空库(v4 全部表存在但行数为空)允许通过;validateBackup 按文件自身版本校验。
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { BACKUP_TABLE_ORDER, validateBackup } from '../../src/main/backup/validate'
import { OperationError } from '../../src/main/db/operations'
import { createTodo, listTodos } from '../../src/main/db/dao'
import { exportBackup, importBackup } from '../../src/main/services/backup'
import { createApproval, createRun, decideApproval } from '../../src/main/runs/repository'
import { argumentsHash } from '../../src/main/tools/schema'
import { makeTestDb } from '../helpers'

const V4_TABLE_NAMES = [
  'conversations', 'messages', 'materials', 'analyses',
  'events', 'todos', 'pending_items',
  'semesters', 'courses', 'course_overrides', 'school_events',
  'profile_facts',
  'mail_analysis_links', 'mail_analysis_versions', 'mail_confirmations',
  'operation_receipts'
]

const TS = '2026-09-20T00:00:00.000Z'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'backup-validation-'))
}

function writeBackupFile(name: string, content: unknown): string {
  const dir = tempDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, JSON.stringify(content), 'utf-8')
  return file
}

/** 当前版本(v4)的完整表清单:全部为空数组的合法空库 */
function v4EmptyTables(): Record<string, unknown[]> {
  return Object.fromEntries(V4_TABLE_NAMES.map((t) => [t, []]))
}

/** 旧版本(v3)的完整表清单:没有 operation_receipts(旧 JSON 无回执) */
function v3EmptyTables(): Record<string, unknown[]> {
  return Object.fromEntries(V4_TABLE_NAMES.filter((t) => t !== 'operation_receipts').map((t) => [t, []]))
}

function todoRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'todo-1', title: 't', notes: null, due_at: null, priority: 'normal', completed_at: null,
    linked_event_id: null, source: 'manual', source_ref: null, fingerprint: null, revision: 1,
    created_at: TS, updated_at: TS, ...over
  }
}

function messageRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg-1', conversation_id: 'conv-1', role: 'user', content: 'c',
    model_label: null, meta: null, created_at: TS, ...over
  }
}

function backup(tables: Record<string, unknown[]>, schemaVersion = 4): unknown {
  return { app: 'ai-desk-companion', schemaVersion, exportedAt: TS, tables }
}

// ---------- Step 1:importBackup 的先验拒绝(替换前) ----------

it('R1: 缺表备份在替换前拒绝且原待办仍在', async () => {
  const db = await makeTestDb()
  const existingTodo = createTodo(db, { title: '保留我' })
  const invalidPath = join(mkdtempSync(join(tmpdir(), 'backup-invalid-')), 'missing.json')
  writeFileSync(invalidPath, JSON.stringify({
    app: 'ai-desk-companion', schemaVersion: 3,
    exportedAt: '2026-09-20T00:00:00.000Z', tables: {}
  }))
  expect(() => importBackup(db, invalidPath)).toThrow()
  expect(listTodos(db).map((item) => item.id)).toEqual([existingTodo.id])
})

it('R1: 当前版本缺少必需业务表(缺 events)在替换前拒绝', async () => {
  const db = await makeTestDb()
  const existingTodo = createTodo(db, { title: '保留我' })
  const tables = v4EmptyTables()
  delete tables.events
  const file = writeBackupFile('missing-events.json', backup(tables))
  expect(() => importBackup(db, file)).toThrow()
  expect(listTodos(db).map((item) => item.id)).toEqual([existingTodo.id])
})

it('R1: 未来版本的备份拒绝导入且原数据不变', async () => {
  const db = await makeTestDb()
  const existingTodo = createTodo(db, { title: '保留我' })
  const file = writeBackupFile('future.json', backup(v4EmptyTables(), 99))
  expect(() => importBackup(db, file)).toThrow()
  expect(listTodos(db).map((item) => item.id)).toEqual([existingTodo.id])
})

it('R1: 坏行(NOT NULL 列缺失)在替换前拒绝且原待办仍在', async () => {
  const db = await makeTestDb()
  const existingTodo = createTodo(db, { title: '保留我' })
  const tables = v4EmptyTables()
  // events 行缺少 NOT NULL 的 title 与 start_at
  tables.events = [{ id: 'evt-1', created_at: TS, updated_at: TS }]
  const file = writeBackupFile('bad-row.json', backup(tables))
  expect(() => importBackup(db, file)).toThrow()
  expect(listTodos(db).map((item) => item.id)).toEqual([existingTodo.id])
})

it('R1: 合法的完整空库通过校验并按替换语义导入', async () => {
  const db = await makeTestDb()
  createTodo(db, { title: '将被替换' })
  const file = writeBackupFile('empty-full.json', backup(v4EmptyTables()))
  const { imported } = importBackup(db, file)
  // 完整空库是合法备份:替换后业务表为空
  expect(listTodos(db)).toHaveLength(0)
  expect(Object.values(imported).every((n) => n === 0)).toBe(true)

  // 再导入一次到全新库:全空表计数为 0,不报错
  const db2 = await makeTestDb()
  const { imported: imported2 } = importBackup(db2, file)
  expect(Object.values(imported2).every((n) => n === 0)).toBe(true)
})

it('R1: 导出的当前格式备份可回导(往返基础)', async () => {
  const db = await makeTestDb()
  createTodo(db, { title: '往返' })
  const file = join(tempDir(), 'roundtrip.json')
  exportBackup(db, file)
  const db2 = await makeTestDb()
  importBackup(db2, file)
  expect(listTodos(db2).map((t) => t.title)).toEqual(['往返'])
})

it('R1: 无效备份以 BACKUP_INVALID 错误拒绝', async () => {
  const db = await makeTestDb()
  const file = writeBackupFile('bad.json', { app: 'ai-desk-companion', schemaVersion: 3, tables: {} })
  expect(() => importBackup(db, file)).toThrow(OperationError)
  try {
    importBackup(db, file)
    expect.unreachable('应当拒绝')
  } catch (err) {
    expect(err).toBeInstanceOf(OperationError)
    expect((err as OperationError).appError.code).toBe('BACKUP_INVALID')
    expect((err as OperationError).appError.retryable).toBe(false)
  }
})

// ---------- validateBackup 规则直测 ----------

it('validateBackup: 完整空库通过并规格化全部表键(含可选表补空数组)', () => {
  const parsed = validateBackup(backup(v4EmptyTables()), [3, 4])
  expect(parsed.schemaVersion).toBe(4)
  // 输出统一为全量表清单(BACKUP_TABLE_ORDER),替换流程按同一份清单清空/写入;
  // v5 起该清单比 v4 版本规格多出 Agent 三表,故基准取 BACKUP_TABLE_ORDER 而非 V4 清单
  expect(Object.keys(parsed.tables).sort()).toEqual([...BACKUP_TABLE_ORDER].sort())
})

it('validateBackup: v5 备份含 Agent 三表且缺 agent_runs 时拒绝', () => {
  const v5Tables = Object.fromEntries(BACKUP_TABLE_ORDER.map((t) => [t, []]))
  const parsed = validateBackup(backup(v5Tables, 5), [3, 4, 5])
  expect(parsed.schemaVersion).toBe(5)
  expect(Object.keys(parsed.tables).sort()).toEqual([...BACKUP_TABLE_ORDER].sort())

  const missingRuns = { ...v5Tables }
  delete (missingRuns as Record<string, unknown>).agent_runs
  expect(() => validateBackup(backup(missingRuns, 5), [3, 4, 5])).toThrow(/agent_runs/)
})

it('validateBackup: 应用标识不符 / 缺 schemaVersion / tables 非对象均拒绝', () => {
  expect(() => validateBackup({ schemaVersion: 4, tables: {} }, [3, 4])).toThrow()
  expect(() => validateBackup({ app: 'other-app', schemaVersion: 4, tables: {} }, [3, 4])).toThrow()
  expect(() => validateBackup({ app: 'ai-desk-companion', schemaVersion: 4, tables: 'x' }, [3, 4])).toThrow()
  expect(() => validateBackup({ app: 'ai-desk-companion', schemaVersion: '4', tables: {} }, [3, 4])).toThrow()
})

it('validateBackup: 未来版本拒绝且错误码为 BACKUP_INVALID', () => {
  expect(() => validateBackup(backup(v4EmptyTables(), 5), [3, 4])).toThrow(OperationError)
})

it('validateBackup: v4 缺 operation_receipts 拒绝;v3 不要求回执且不判坏文件', () => {
  const noReceipts = v4EmptyTables()
  delete noReceipts.operation_receipts
  expect(() => validateBackup(backup(noReceipts, 4), [3, 4])).toThrow(/operation_receipts/)
  // 旧版本按其自身版本要求的表集合校验:没有回执表不是坏文件
  const parsed = validateBackup(backup(v3EmptyTables(), 3), [3, 4])
  expect(parsed.tables.operation_receipts).toEqual([])
  // 规格外(未来)表键被忽略,不影响旧文件校验
  const withFutureTable = v3EmptyTables() as Record<string, unknown[]>
  withFutureTable.reminder_jobs = []
  expect(() => validateBackup(backup(withFutureTable, 3), [3, 4])).not.toThrow()
})

it('validateBackup: 文件内重复主键拒绝', () => {
  const tables = v4EmptyTables()
  tables.todos = [todoRow({ id: 'same' }), todoRow({ id: 'same', title: '另一行' })]
  expect(() => validateBackup(backup(tables), [3, 4])).toThrow(/重复主键/)
})

it('validateBackup: 复合主键重复拒绝(mail_confirmations)', () => {
  const tables = v4EmptyTables()
  tables.mail_confirmations = [
    { analysis_id: 'a1', candidate_index: 0, source_key: 's1', ref_type: 'todo', ref_id: 't1' },
    { analysis_id: 'a1', candidate_index: 0, source_key: 's2', ref_type: 'todo', ref_id: 't2' }
  ]
  expect(() => validateBackup(backup(tables), [3, 4])).toThrow(/重复主键/)
})

it('validateBackup: 悬空引用拒绝(消息引用不存在的会话)', () => {
  const tables = v4EmptyTables()
  tables.messages = [messageRow()]
  expect(() => validateBackup(backup(tables), [3, 4])).toThrow(/引用/)
})

it('validateBackup: 运行时容忍的悬空引用不拒绝(pending_items.conversation_id)', () => {
  const tables = v4EmptyTables()
  tables.pending_items = [
    { id: 'p1', conversation_id: 'ghost', title: '遗留条目', notes: null, status: 'dismissed', revision: 1, created_at: TS, updated_at: TS }
  ]
  expect(() => validateBackup(backup(tables), [3, 4])).not.toThrow()
})

it('validateBackup: 列型错误拒绝(非整数 INTEGER / revision 非正数 / 非文本 TEXT)', () => {
  const floatSize = v4EmptyTables()
  floatSize.materials = [{ id: 'm1', conversation_id: 'c1', name: 'n', type: 'txt', size: 1.5, created_at: TS }]
  expect(() => validateBackup(backup(floatSize), [3, 4])).toThrow(/size/)

  const badRevision = v4EmptyTables()
  badRevision.todos = [todoRow({ revision: 0 })]
  expect(() => validateBackup(backup(badRevision), [3, 4])).toThrow(/revision/)

  const badTitle = v4EmptyTables()
  badTitle.todos = [todoRow({ title: 42 })]
  expect(() => validateBackup(backup(badTitle), [3, 4])).toThrow(/title/)
})

it('validateBackup: 表内容不是数组拒绝', () => {
  const tables = v4EmptyTables() as Record<string, unknown>
  tables.conversations = 'not-an-array'
  expect(() => validateBackup(backup(tables as Record<string, unknown[]>), [3, 4])).toThrow(/数组/)
})

// ---------- OPS-01(2026-09-30 完成计划):备份兼容矩阵 v3~v9 与审批冻结参数 ----------

const OPS_SUPPORTED: readonly number[] = [3, 4, 5, 6, 7, 8, 9]

/** 全量表清单(全空):validateBackup 忽略规格外表键,因此同一清单覆盖 v3~v9 全部必需集合 */
function allTablesEmpty(): Record<string, unknown[]> {
  return Object.fromEntries(BACKUP_TABLE_ORDER.map((t) => [t, []]))
}

function agentRunRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: 'run-1', mode: 'personal_ops', status: 'awaiting_confirmation', input: '整理任务',
    timezone: 'Asia/Shanghai', context_clock: TS, config_version: '', budget_json: '{}',
    result_ref: null, error_code: null, started_at: TS, finished_at: null, ...over
  }
}

function approvalRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    approval_id: 'ap-1', run_id: 'run-1', tool_name: 'todo.create', arguments_hash: 'hash-1',
    arguments_json: null, plan_version: 1, target_version: null,
    expires_at: '2026-10-01T00:00:00.000Z', decision: 'pending', decided_at: null, ...over
  }
}

it('OPS-01: 受支持版本明确为 v3~v9,未来版本 10 拒绝', () => {
  for (const version of OPS_SUPPORTED) {
    expect(() => validateBackup(backup(allTablesEmpty(), version), OPS_SUPPORTED)).not.toThrow()
  }
  expect(() => validateBackup(backup(allTablesEmpty(), 10), OPS_SUPPORTED)).toThrow(/10/)
})

it('OPS-01: v7/v8/v9 备份的审批冻结参数恢复后保持一致', async () => {
  const args = { title: '冻结参数' }
  const hash = argumentsHash({ tool: 'todo.create', arguments: args })
  for (const version of [7, 8, 9] as const) {
    const db = await makeTestDb()
    const tables = allTablesEmpty()
    tables.agent_runs = [agentRunRow()]
    tables.approvals = [approvalRow({ arguments_hash: hash, arguments_json: JSON.stringify(args) })]
    const file = writeBackupFile(`v${version}-params.json`, backup(tables, version))
    const { imported } = importBackup(db, file)
    expect(imported.approvals).toBe(1)
    const approval = db.get<{ arguments_json: string | null; decision: string; arguments_hash: string }>(
      'SELECT arguments_json, decision, arguments_hash FROM approvals WHERE approval_id = ?',
      ['ap-1']
    )
    // 参数按规格列恢复,不因按列 INSERT 被丢弃;决定保持,禁止用 {} 冒充
    expect(approval?.arguments_json).toBe(JSON.stringify(args))
    expect(approval?.decision).toBe('pending')
    expect(approval?.arguments_hash).toBe(hash)
  }
})

it('OPS-01: v5/v6 旧备份缺参数的待执行审批恢复后置 expired 并记录原因', async () => {
  for (const version of [5, 6] as const) {
    const db = await makeTestDb()
    const tables = allTablesEmpty()
    tables.agent_runs = [agentRunRow()]
    // 历史形态:行内没有 arguments_json 键
    const legacy = approvalRow()
    delete legacy.arguments_json
    tables.approvals = [legacy]
    const file = writeBackupFile(`v${version}-legacy.json`, backup(tables, version))
    importBackup(db, file)
    const approval = db.get<{ arguments_json: string | null; decision: string }>(
      'SELECT arguments_json, decision FROM approvals WHERE approval_id = ?',
      ['ap-1']
    )
    // 缺失参数恢复为 null(不是 {}),未执行的待批审批失效并要求重新规划
    expect(approval?.arguments_json).toBeNull()
    expect(approval?.decision).toBe('expired')
    const reason = db.get<{ payload: string }>(
      "SELECT payload FROM trace_events WHERE run_id = 'run-1' AND event_type = 'error'"
    )
    expect(reason?.payload).toContain('ap-1')
  }
})

it('OPS-01: 参数为 null 的已批准审批恢复后失效,不再继续执行', async () => {
  const db = await makeTestDb()
  const tables = allTablesEmpty()
  tables.agent_runs = [agentRunRow()]
  tables.approvals = [approvalRow({ decision: 'approved', decided_at: TS, arguments_json: null })]
  const file = writeBackupFile('v9-null-params.json', backup(tables, 9))
  importBackup(db, file)
  const approval = db.get<{ decision: string; arguments_json: string | null }>(
    'SELECT decision, arguments_json FROM approvals WHERE approval_id = ?',
    ['ap-1']
  )
  expect(approval?.decision).toBe('expired')
  expect(approval?.arguments_json).toBeNull()
})

it('OPS-01: 非对象参数、坏 JSON 或与 arguments_hash 不对应的参数拒绝导入', () => {
  const base = (): Record<string, unknown[]> => {
    const tables = allTablesEmpty()
    tables.agent_runs = [agentRunRow()]
    return tables
  }
  const hash = argumentsHash({ tool: 'todo.create', arguments: { title: 'x' } })
  // 参数必须是 JSON 对象(数组拒绝)
  expect(() =>
    validateBackup(backup({ ...base(), approvals: [approvalRow({ arguments_hash: hash, arguments_json: '["x"]' })] }, 9), OPS_SUPPORTED)
  ).toThrow(/对象/)
  // 参数必须是有效 JSON
  expect(() =>
    validateBackup(backup({ ...base(), approvals: [approvalRow({ arguments_hash: hash, arguments_json: '{bad' })] }, 9), OPS_SUPPORTED)
  ).toThrow()
  // 参数必须与工具名及 arguments_hash 对应
  expect(() =>
    validateBackup(backup({ ...base(), approvals: [approvalRow({ arguments_hash: hash, arguments_json: '{"title":"y"}' })] }, 9), OPS_SUPPORTED)
  ).toThrow(/arguments_hash/)
  // 与 hash 对应的合法参数通过
  expect(() =>
    validateBackup(backup({ ...base(), approvals: [approvalRow({ arguments_hash: hash, arguments_json: '{"title":"x"}' })] }, 9), OPS_SUPPORTED)
  ).not.toThrow()
})

it('OPS-01: 当前版本导出→恢复往返保留审批冻结参数与决定', async () => {
  const src = await makeTestDb()
  const run = createRun(src, { mode: 'personal_ops', input: '建任务', contextClock: TS })
  const args = { title: '往返参数' }
  const approval = createApproval(src, {
    runId: run.runId,
    toolName: 'todo.create',
    argumentsHash: argumentsHash({ tool: 'todo.create', arguments: args }),
    argumentsJson: JSON.stringify(args),
    planVersion: 1,
    expiresAt: '2026-10-01T00:00:00.000Z'
  })
  decideApproval(src, approval.approvalId, 'approved', TS)
  const file = join(tempDir(), 'roundtrip-approval.json')
  exportBackup(src, file)

  const dst = await makeTestDb()
  createTodo(dst, { title: '将被替换' })
  importBackup(dst, file)
  const restored = dst.get<{ arguments_json: string | null; decision: string }>(
    'SELECT arguments_json, decision FROM approvals'
  )
  expect(restored?.arguments_json).toBe(JSON.stringify(args))
  expect(restored?.decision).toBe('approved')
  // 替换语义:目标库原有业务行清空
  expect(listTodos(dst)).toHaveLength(0)
})
