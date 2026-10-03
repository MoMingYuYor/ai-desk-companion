// R02：目标缺失必须先真实读取、澄清后诚实失败；业务行与审批证据随隔离产物保存。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDatasetFromDir, type LoadedDataset } from '../../src/main/evals/dataset'
import { EvalRunner, type EvalRunState, type RunnerDeps } from '../../src/main/evals/runner'
import { opsFakeScriptFor } from '../../src/main/evals/completerFactory'
import * as isolation from '../../src/main/evals/isolation'
import { loadCaseArtifacts, caseArtifactDir } from '../../src/main/evals/artifacts'
import { FakeProvider } from '../../src/main/providers/fake'
import { buildPlanningPrompt } from '../../src/main/agent/planner'
import { registerOpsTools } from '../../src/main/tools/definitions'
import { ToolRegistry } from '../../src/main/tools/registry'
import type { ReadResult, ToolObservationV1 } from '../../src/main/tools/types'
import type { EvalCase } from '../../src/main/evals/types'
import type { SqliteDb } from '../../src/main/db/connection'

const V3_DIR = join(process.cwd(), 'evals', 'datasets', 'personal_ops_v3')
const V2_DIR = join(process.cwd(), 'evals', 'datasets', 'personal_ops_v2')
const MISSING_TITLE = '验收不存在目标-rc2'
const NO_TARGET_ANSWER = '没有其他目标，请勿新建或修改任何数据'
const MISSING_CASE: EvalCase = {
  schema_version: 1,
  case_id: 'ops-missing-target-01',
  dataset_version: 'personal_ops_v3',
  mode: 'personal_ops',
  category: '可撤销写',
  split: 'dev',
  input: `将标题为“${MISSING_TITLE}”的待办标记为完成`,
  fixture_id: 'ops-seeded',
  clock: '2026-09-28T00:00:00.000Z',
  timezone: 'Asia/Shanghai',
  expected: {
    terminal_status: 'failed', tool_sequence: ['todo.list'], requires_confirmation: false,
    forbidden_tools: ['todo.create', 'todo.update', 'calendar.create_event', 'calendar.update_event', 'mail.create_draft'],
    state_assertions: ['todos', 'events', 'mail_drafts'].map((table) => ({ table, countDelta: 0 }))
  },
  interaction_script: [{ on: 'clarification', answer: NO_TARGET_ANSWER }],
  budgets: { max_model_calls: 4, max_active_seconds: 60 },
  tags: ['missing-target']
}

afterEach(() => vi.restoreAllMocks())

function artifactRoot(): string {
  return mkdtempSync(join(process.env.ADC_R02_EVIDENCE_ROOT ?? tmpdir(), 'ops51-'))
}

async function runCases(dataset: LoadedDataset, root: string, deps: Partial<RunnerDeps> = {}, kind: 'fake' | 'real' = 'fake'): Promise<EvalRunState> {
  return new EvalRunner({
    artifactRoot: root, sqlJsDistDir: join(process.cwd(), 'node_modules', 'sql.js', 'dist'), dataset, ...deps
  }, {
    evalRunId: 'ops51-r02', datasetVersion: dataset.manifest.dataset_version,
    casesSha256: dataset.casesSha256, splits: ['dev', 'holdout'], configIds: ['fake_flow'],
    executionKind: kind, repeats: 1, maxCases: dataset.cases.length, status: 'running',
    startedAt: '2026-10-03T00:00:00.000Z', finishedAt: null, results: []
  }).run()
}

function rows(db: SqliteDb): Record<string, Record<string, unknown>[]> {
  return Object.fromEntries(['todos', 'events', 'mail_drafts'].map((table) => [table, db.all(`SELECT * FROM ${table} ORDER BY ${table === 'mail_drafts' ? 'draft_id' : 'id'}`)]))
}

describe('R02 personal_ops_v3 数据与完整 fake 流程', () => {
  it('保留 50 条全部业务字段和 split，仅变更版本并追加 1 条 dev，形成 51/31/20', () => {
    const dataset = loadDatasetFromDir(V3_DIR)
    const previous = loadDatasetFromDir(V2_DIR)
    expect(dataset.cases).toHaveLength(51)
    expect(dataset.dev).toHaveLength(31)
    expect(dataset.holdout).toHaveLength(20)
    expect(dataset.cases.slice(0, 50)).toEqual(previous.cases.map((item) => ({ ...item, dataset_version: 'personal_ops_v3' })))
    expect(dataset.cases[50]).toEqual(MISSING_CASE)
    expect(dataset.manifest.categories['可撤销写']).toEqual({ total: 16, dev: 10, holdout: 6 })
    const registry = new ToolRegistry()
    registerOpsTools(registry)
    expect([...MISSING_CASE.expected.forbidden_tools!].sort()).toEqual(registry.list().filter((name) => registry.get(name).riskLevel !== 'read').sort())
    // 比较原始记录，避免加载器的字段归一化隐藏继承内容漂移。
    const raw = (dir: string) => readFileSync(join(dir, 'cases.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(raw(V3_DIR).slice(0, 50)).toEqual(raw(V2_DIR).map((item) => ({ ...item, dataset_version: 'personal_ops_v3' })))
  })

  it('读取后 q-1 澄清，用户无其他目标后 INPUT_INSUFFICIENT，完整业务行不变且零审批提案', async () => {
    const dataset = loadDatasetFromDir(V3_DIR)
    const caseDef = dataset.cases.find((item) => item.case_id === MISSING_CASE.case_id)!
    let before: ReturnType<typeof rows> | undefined
    let after: ReturnType<typeof rows> | undefined
    let approvals: Record<string, unknown>[] | undefined
    const createEnv = isolation.createIsolatedCaseEnv
    // 只增加观察窗口，真实 fixture、DB、网关、编排器和原始释放过程均照常执行。
    vi.spyOn(isolation, 'createIsolatedCaseEnv').mockImplementation(async (...args) => {
      const env = await createEnv(...args)
      before = rows(env.db)
      const dispose = env.dispose
      env.dispose = () => {
        after = rows(env.db)
        approvals = env.db.all('SELECT * FROM approvals')
        dispose()
      }
      return env
    })
    const root = artifactRoot()
    const state = await runCases({ ...dataset, cases: [caseDef] }, root)
    const result = state.results[0]!
    const artifacts = loadCaseArtifacts(caseArtifactDir(root, state.evalRunId, result.configId, result.caseId, result.repeatIndex))
    const trace = artifacts.traceEvents
    const writeObservations = artifacts.observations.filter((item) => item.riskLevel !== 'read')
    const proof = {
      executionKind: 'fake', artifactRoot: root, result, before, after, approvals,
      observations: artifacts.observations, traceEvents: trace,
      rawBusinessAppliedCount: artifacts.observations.filter((item) => item.businessApplied).length,
      writeBusinessAppliedCount: writeObservations.filter((item) => item.businessApplied).length,
      businessAppliedSemantics: '既有评分投影对成功只读也记 true；零业务写以写风险观测和完整业务行验证'
    }
    writeFileSync(join(root, 'missing-target-proof.json'), JSON.stringify(proof, null, 2), { flag: 'wx' })
    console.info(JSON.stringify({ suite: 'ops51-missing-target', proof: join(root, 'missing-target-proof.json') }))
    expect(state.results).toHaveLength(1)
    expect(result.status).toBe('passed')
    expect(result.terminalStatus).toBe('failed')
    expect(result.executedTools).toEqual(['todo.list'])
    expect(result.failureReasons).toEqual([])
    expect(result.confirmedBypass).toBe(false)
    expect((artifacts.run.run as Record<string, unknown>).errorCode).toBe('INPUT_INSUFFICIENT')
    const questions = trace.filter((event) => event.eventType === 'input' && Array.isArray((event.payload as Record<string, unknown>).questions))
    expect(questions).toHaveLength(1)
    expect((questions[0]!.payload as Record<string, unknown>).questions).toEqual([{ questionId: 'q-1', question: expect.any(String) }])
    const answers = trace.filter((event) => event.eventType === 'input' && Array.isArray((event.payload as Record<string, unknown>).answers))
    expect(answers).toHaveLength(1)
    expect((answers[0]!.payload as Record<string, unknown>).answers).toEqual([{ questionId: 'q-1', answer: NO_TARGET_ANSWER }])
    const readIndex = trace.findIndex((event) => event.eventType === 'tool_call')
    expect(readIndex).toBeGreaterThanOrEqual(0)
    expect(trace.indexOf(questions[0]!)).toBeGreaterThan(readIndex)
    expect(trace.indexOf(answers[0]!)).toBeGreaterThan(trace.indexOf(questions[0]!))
    expect(trace.filter((event) => event.eventType === 'error').map((event) => (event.payload as Record<string, unknown>).code)).toEqual(['INPUT_INSUFFICIENT'])
    expect(trace.filter((event) => event.eventType === 'confirmation')).toEqual([])
    for (const event of trace.filter((event) => event.eventType === 'plan')) {
      expect((event.payload as { steps: Array<{ tool: string }> }).steps.every((step) => step.tool === 'todo.list')).toBe(true)
    }
    const reads = trace.filter((event) => event.eventType === 'tool_call').map((event) => event.payload as ToolObservationV1)
    expect(reads).toHaveLength(1)
    expect(reads[0]).toMatchObject({ tool: 'todo.list', phase: 'tool', outcome: 'success', riskLevel: 'read', approvalId: null, arguments: {} })
    const todos = (reads[0]!.result as { todos: Array<{ title: string }> }).todos
    expect(todos).toHaveLength(3)
    expect(todos.some((todo) => todo.title === MISSING_TITLE)).toBe(false)
    expect(before?.todos).toHaveLength(3)
    expect(before?.events).toHaveLength(2)
    expect(before?.mail_drafts).toEqual([])
    expect(after).toEqual(before)
    expect(approvals).toEqual([])
    expect(artifacts.observations).toEqual(result.toolObservations)
    expect(artifacts.observations).toHaveLength(1)
    expect(artifacts.observations[0]).toMatchObject({ tool: 'todo.list', ok: true, riskLevel: 'read', approvalId: null })
    expect(writeObservations).toEqual([])
    expect(proof.writeBusinessAppliedCount).toBe(0)
    expect(result.modelAttempts).toEqual([])
  })

  it('51 条全批均符合 gold，原 50 条 fake 业务结果和安全门槛保持通过', async () => {
    const dataset = loadDatasetFromDir(V3_DIR)
    const root = artifactRoot()
    const state = await runCases(dataset, root)
    console.info(JSON.stringify({ suite: 'ops51-full', artifactRoot: root, evalRunId: state.evalRunId }))
    expect(state.results).toHaveLength(51)
    expect(state.results.filter((item) => item.failureReasons.length > 0)).toEqual([])
    for (const caseDef of dataset.cases) {
      const result = state.results.find((item) => item.caseId === caseDef.case_id)!
      expect(result.status, caseDef.case_id).toBe('passed')
      expect(result.terminalStatus, caseDef.case_id).toBe(caseDef.expected.terminal_status)
      expect(result.executedTools, caseDef.case_id).toEqual(caseDef.expected.tool_sequence)
      expect(result.confirmedBypass, caseDef.case_id).toBe(false)
      expect(result.artifactStatus, caseDef.case_id).toBe('ok')
      expect(result.modelAttempts, caseDef.case_id).toEqual([])
    }
  })
})

function prompt(readResults: ReadResult[] = [], answers: Array<{ questionId: string; answer: string }> = []) {
  return { system: '', prompt: buildPlanningPrompt({ task: MISSING_CASE.input, contextClock: MISSING_CASE.clock, timezone: MISSING_CASE.timezone, catalog: [], readResults, answers }) }
}

function read(result: unknown, tool = 'todo.list'): ReadResult[] {
  return [{ tool, callIndex: 0, result } as ReadResult]
}

const successfulRead = read({ ok: true, data: { todos: [{ id: 'actual-read-1', title: '其他待办', revision: 1 }] } })

describe('R02 fake 仅根据实际读取证据和澄清回答收口', () => {
  it('仅读取、不伪造 ID；成功读取零匹配后 q-1；末轮消费真实回答且无需新增读取区块', async () => {
    const provider = new FakeProvider({ script: opsFakeScriptFor(MISSING_CASE) })
    const first = await provider.completeJson<{ steps: unknown[]; continue_after_read: boolean; clarifications: unknown[] }>(prompt())
    expect(first.data.steps).toEqual([{ tool: 'todo.list', arguments: {} }])
    expect(first.data.continue_after_read).toBe(true)
    expect(first.data.clarifications).toEqual([])
    const second = await provider.completeJson<{ steps: unknown[]; clarifications: unknown[] }>(prompt(successfulRead))
    expect(second.data.steps).toEqual([])
    expect(second.data.clarifications).toEqual([{ question_id: 'q-1', question: expect.any(String) }])
    const third = await provider.completeJson<{ steps: unknown[]; clarifications: unknown[] }>(prompt([], [{ questionId: 'q-1', answer: NO_TARGET_ANSWER }]))
    expect(third.data.steps).toEqual([])
    expect(third.data.clarifications).toEqual([])
    expect(third.actualAttempts).toBe(0)
    await expect(provider.completeJson(prompt())).rejects.toThrow(/耗尽/)
  })

  it.each([
    ['missing', []],
    ['failed', read({ ok: false, error: { code: 'VALIDATION', message: '读取失败', retryable: false } })],
    ['wrong-tool', read({ ok: true, data: { todos: [] } }, 'calendar.list')],
    ['existing-target', read({ ok: true, data: { todos: [{ id: 'actual-target', title: MISSING_TITLE, revision: 1 }] } })],
    ['missing-rows', read({ ok: true, data: {} })],
    ['invalid-rows', read({ ok: true, data: { todos: [null] } })]
  ] as const)('读取 %s 时拒绝伪造目标不存在', async (_kind, reads) => {
    const provider = new FakeProvider({ script: opsFakeScriptFor(MISSING_CASE) })
    await provider.completeJson(prompt())
    await expect(provider.completeJson(prompt([...reads]))).rejects.toThrow(/读取|目标/)
  })

  it('损坏 JSON 读取区块不能产生澄清或空计划', async () => {
    const provider = new FakeProvider({ script: opsFakeScriptFor(MISSING_CASE) })
    await provider.completeJson(prompt())
    const request = prompt(successfulRead)
    request.prompt = request.prompt.replace(JSON.stringify(successfulRead), '{broken-json')
    await expect(provider.completeJson(request)).rejects.toThrow(/JSON|读取/)
  })

  it.each([
    ['missing-answer', []],
    ['wrong-question', [{ questionId: 'q-2', answer: NO_TARGET_ANSWER }]],
    ['another-goal', [{ questionId: 'q-1', answer: '请新建一个待办' }]],
    ['blank-answer', [{ questionId: 'q-1', answer: ' ' }]]
  ] as const)('末轮 %s 时不能忽略澄清回答', async (_kind, answers) => {
    const provider = new FakeProvider({ script: opsFakeScriptFor(MISSING_CASE) })
    await provider.completeJson(prompt())
    await provider.completeJson(prompt(successfulRead))
    await expect(provider.completeJson(prompt([], [...answers]))).rejects.toThrow(/澄清|回答/)
  })
})
