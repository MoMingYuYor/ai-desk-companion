import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { loadDatasetFromText } from '../../src/main/evals/dataset'
import { EvalRunner, EvalStateError } from '../../src/main/evals/runner'
import type { EvalRunState } from '../../src/main/evals/runner'
import { getWorkspaceEpoch } from '../../src/main/db/operations'
import { openDatabase } from '../../src/main/db/connection'
import { createTodo, initSchema } from '../../src/main/db/dao'
import { registerFixtureById } from '../../src/main/evals/isolation'
import type { LoadedDataset } from '../../src/main/evals/dataset'
import type { EvalCase } from '../../src/main/evals/types'
import { fixedClock } from '../../src/shared/clock'
import { loadCaseArtifacts } from '../../src/main/evals/artifacts'
import { calculateMetrics } from '../../src/main/evals/metrics'
import {
  createEvalCompleterFactory,
  loadTemplateFor,
  roundOneConfigs,
  type EvalCompleterContext,
  type EvalCompleterFactory
} from '../../src/main/evals/completerFactory'
import { frozenConfigSha256, saveFrozenConfig, type FrozenEvalConfig } from '../../src/main/evals/configStore'
import type {
  StructuredCompleteRequest,
  StructuredCompleteResult,
  StructuredCompleter
} from '../../src/main/agent/llm'

// E-03:Runner。覆盖:EVAL-03 变体(失败保留在分母)、EVAL-07 预算停止
// not_run 单列、EVAL-10 重启续跑不覆盖、EVAL-02 取消探针/中断检测/
// 状态文件原子替换与校验/案例局部 epoch 隔离(F-10/F-12)。

const NOW = '2026-09-28T01:00:00.000Z'
const SQL_JS = join(process.cwd(), 'node_modules', 'sql.js', 'dist')

function caseLine(id: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    case_id: id,
    dataset_version: 'personal_ops_v1',
    mode: 'personal_ops',
    category: '可撤销写',
    split: 'dev',
    input: `任务 ${id}`,
    fixture_id: 'ops-empty',
    clock: NOW,
    timezone: 'Asia/Shanghai',
    expected: {
      terminal_status: 'succeeded',
      tool_sequence: ['todo.create'],
      required_arguments: { 'todo.create': { title: `任务 ${id}` } },
      requires_confirmation: true
    },
    interaction_script: [{ on: 'confirmation', decision: 'approved' }],
    budgets: {},
    tags: [],
    ...over
  })
}

function makeDataset(lines: string[]): LoadedDataset {
  return loadDatasetFromText(lines.join('\n'), manifestFor(lines))
}

function manifestFor(lines: string[]): Record<string, unknown> {
  const categories: Record<string, { total: number; dev: number; holdout: number }> = {}
  for (const line of lines) {
    const parsed = JSON.parse(line) as { category: string; split: string }
    const stat = categories[parsed.category] ?? { total: 0, dev: 0, holdout: 0 }
    stat.total += 1
    if (parsed.split === 'dev') stat.dev += 1
    else stat.holdout += 1
    categories[parsed.category] = stat
  }
  return {
    dataset_version: 'personal_ops_v1',
    schema_version: 1,
    cases_sha256: sha(lines.join('\n')),
    categories,
    total: lines.length,
    provenance: '测试'
  }
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

interface RunnerForOpts {
  caseIds?: string[]
  repeats?: number
  maxCases?: number
  splits?: ('dev' | 'holdout')[]
  beforeClaim?: (combo: { configId: string; caseId: string; repeatIndex: number }) => void | Promise<void>
  originEvalRunId?: string
  evalRunId?: string
}

function runnerFor(
  lines: string[],
  over: RunnerForOpts = {}
): { runner: EvalRunner; artifactRoot: string } {
  const dataset = makeDataset(lines)
  const artifactRoot = mkdtempSync(join(tmpdir(), 'eval-run-'))
  const runner = new EvalRunner(
    {
      artifactRoot,
      sqlJsDistDir: SQL_JS,
      dataset,
      beforeClaim: over.beforeClaim
    },
    {
      evalRunId: over.evalRunId ?? `eval-${Math.random().toString(36).slice(2, 8)}`,
      datasetVersion: dataset.manifest.dataset_version,
      casesSha256: dataset.casesSha256,
      splits: over.splits ?? ['dev'],
      ...(over.caseIds ? { caseIds: over.caseIds } : {}),
      configIds: ['fake_flow'],
      executionKind: 'fake',
      repeats: over.repeats ?? 1,
      maxCases: over.maxCases ?? 100,
      status: 'running',
      startedAt: NOW,
      finishedAt: null,
      results: [],
      originEvalRunId: over.originEvalRunId ?? null
    }
  )
  return { runner, artifactRoot }
}

/** 轮询直到条件成立(取消探针的确定性时序控制) */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (cond()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待超时:${what}`)
}

/** 安全读取生产 epoch:未初始化返回 'uninitialized' */
function safeEpoch(): string {
  try {
    return getWorkspaceEpoch()
  } catch {
    return 'uninitialized'
  }
}

/** 业务库全表摘要:全部用户表的全部行按稳定顺序序列化后取 sha256 */
function digestDb(db: import('../../src/main/db/connection').SqliteDb): string {
  const tables = db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  )
  const hash = createHash('sha256')
  for (const { name } of tables) {
    const rows = db.all<Record<string, unknown>>(`SELECT * FROM ${name} ORDER BY rowid`)
    hash.update(`${name}=${JSON.stringify(rows)};`)
  }
  return hash.digest('hex')
}

describe('EvalRunner 基本执行', () => {
  it('系统日期变化不改变案例冻结时间、审批与执行结果', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const results = []
      for (const systemDate of ['2027-02-01T00:00:00Z', '2028-02-01T00:00:00Z']) {
        vi.setSystemTime(new Date(systemDate))
        const { runner, artifactRoot } = runnerFor([caseLine('frozen-clock', {
          expected: {
            terminal_status: 'succeeded', tool_sequence: ['todo.create', 'mail.create_draft'],
            required_arguments: {
              'todo.create': { title: '任务 frozen-clock' },
              'mail.create_draft': { body: '冻结时钟草稿' }
            },
            requires_confirmation: true
          },
          interaction_script: [
            { on: 'confirmation', decision: 'approved' },
            { on: 'confirmation', decision: 'approved' }
          ]
        })])
        const state = await runner.run()
        const outcome = state.results[0]!
        const artifact = JSON.parse(readFileSync(join(artifactRoot, outcome.artifactDir!, 'run.json'), 'utf8'))
        expect(artifact.run.contextClock).toBe(NOW)
        expect(outcome.status, JSON.stringify(outcome.failureReasons)).toBe('passed')
        results.push({ status: outcome.terminalStatus, tools: outcome.executedTools })
      }
      expect(results[0]).toEqual(results[1])
    } finally {
      vi.useRealTimers()
    }
  })

  it('写案例经批准后通过;轨迹与审批可追溯;记录真实耗时', async () => {
    const { runner } = runnerFor([caseLine('w1')])
    const state = await runner.run()
    expect(state.status).toBe('completed')
    expect(state.results).toHaveLength(1)
    const r = state.results[0]!
    expect(r.status).toBe('passed')
    expect(r.terminalStatus).toBe('succeeded')
    expect(r.executedTools).toEqual(['todo.create'])
    expect(r.runId).toBeTruthy()
    // p50/p95 的样本:真实单调时长(毫秒,非负)
    expect(typeof r.durationMs).toBe('number')
    expect(r.durationMs!).toBeGreaterThanOrEqual(0)
  })

  it('终态不符与工具序列不符:failed 并给出原因', async () => {
    const lines = [
      // 期望 partial 但实际成功:终态不符
      caseLine('w-status', { expected: { terminal_status: 'partial', tool_sequence: ['todo.create'], requires_confirmation: true } }),
      // 期望错误工具序列
      caseLine('w-seq', { expected: { terminal_status: 'succeeded', tool_sequence: ['todo.update'], requires_confirmation: true } })
    ]
    const { runner } = runnerFor(lines)
    const state = await runner.run()
    expect(state.results[0]!.status).toBe('failed')
    expect(state.results[0]!.failureReasons.some((x) => x.includes('终态'))).toBe(true)
    expect(state.results[1]!.status).toBe('failed')
    expect(state.results[1]!.failureReasons.some((x) => x.includes('工具序列'))).toBe(true)
  })

  it('重复执行 repeats=2:每个 repeat 独立隔离环境,都通过', async () => {
    const { runner } = runnerFor([caseLine('w-rep')], { repeats: 2 })
    const state = await runner.run()
    expect(state.results).toHaveLength(2)
    expect(state.results.every((r) => r.status === 'passed')).toBe(true)
    expect(state.results[0]!.runId).not.toBe(state.results[1]!.runId)
  })
})

describe('EVAL-07 预算停止:not_run 单列,终止原因 budget_exhausted', () => {
  it('maxCases=1 时第二个案例标 not_run,批次 cancelled', async () => {
    const { runner } = runnerFor([caseLine('w1'), caseLine('w2')], { maxCases: 1 })
    const state = await runner.run()
    expect(state.results.filter((r) => r.status === 'passed')).toHaveLength(1)
    const notRun = state.results.filter((r) => r.status === 'not_run')
    expect(notRun).toHaveLength(1)
    expect(state.status).toBe('cancelled')
    expect(state.stopReason).toBe('budget_exhausted')
    expect(notRun[0]!.failureReasons[0]).toContain('预算')
  })
})

describe('EVAL-02 取消控制(F-10)', () => {
  it('取消探针:首条完成后请求取消,后续组合不进入案例执行器,终态不被覆盖', async () => {
    // fixture 计数器:进入案例执行器(创建隔离环境)的次数
    let seedCount = 0
    registerFixtureById('spy-cancel', {
      description: '取消探针计数 fixture',
      seed: () => {
        seedCount += 1
      }
    })
    const lines = [
      caseLine('w1', { fixture_id: 'spy-cancel' }),
      caseLine('w2', { fixture_id: 'spy-cancel' }),
      caseLine('w3', { fixture_id: 'spy-cancel' })
    ]
    // w2 领取前挂起:测试在 w1 完成后请求取消,再放行
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { runner } = runnerFor(lines, {
      beforeClaim: async (combo) => {
        if (combo.caseId === 'w2') await gate
      }
    })
    const runPromise = runner.run()
    await until(() => runner.snapshot.results.length === 1, '首条案例完成')
    expect(runner.snapshot.results[0]!.caseId).toBe('w1')
    runner.cancel()
    release()
    const state = await runPromise

    expect(state.status).toBe('cancelled')
    expect(state.stopReason).toBe('user_cancelled')
    // 原已完成结果保留,不被取消覆盖
    expect(state.results.find((r) => r.caseId === 'w1')!.status).toBe('passed')
    // 后两条不进入案例执行器,标 not_run(用户取消)
    const notRun = state.results.filter((r) => r.status === 'not_run')
    expect(notRun.map((r) => r.caseId).sort()).toEqual(['w2', 'w3'])
    expect(notRun.every((r) => r.failureReasons.some((x) => x.includes('用户取消')))).toBe(true)
    expect(seedCount).toBe(1)
  })
})

describe('EVAL-10 重启续跑', () => {
  it('指定用例按清单顺序运行，重启时不能换清单或扩大为全量', async () => {
    const lines = [caseLine('w1'), caseLine('w2'), caseLine('w3')]
    const { runner, artifactRoot } = runnerFor(lines, { caseIds: ['w3', 'w1'] })
    const state = await runner.run()
    expect(state.results.map(row => row.caseId)).toEqual(['w3', 'w1'])
    const deps = { artifactRoot, sqlJsDistDir: SQL_JS, dataset: makeDataset(lines) }
    expect(() => new EvalRunner(deps, { ...state, caseIds: ['w1', 'w3'] })).toThrow()
    expect(() => new EvalRunner(deps, { ...state, caseIds: undefined })).toThrow()
    const resumed = await new EvalRunner(deps, state).run()
    expect(resumed.results).toEqual(state.results)
  })
  it('同 evalRunId 重建 runner:跳过已完成组合,不覆盖', async () => {
    const lines = [caseLine('w1'), caseLine('w2')]
    const dataset = makeDataset(lines)
    const artifactRoot = mkdtempSync(join(tmpdir(), 'eval-resume-'))
    const evalRunId = 'eval-resume-test'
    const common = {
      evalRunId,
      datasetVersion: dataset.manifest.dataset_version,
      casesSha256: dataset.casesSha256,
      splits: ['dev' as const],
      configIds: ['fake_flow'],
      executionKind: 'fake' as const,
      repeats: 1,
      maxCases: 100,
      startedAt: NOW,
      finishedAt: null
    }

    const first = new EvalRunner(
      { artifactRoot, sqlJsDistDir: SQL_JS, dataset },
      { ...common, status: 'running', results: [] }
    )
    await first.run()
    const afterFirst = first.snapshot
    expect(afterFirst.results).toHaveLength(2)

    // 重启:同状态目录重建,所有组合已有结果 → 不重跑
    const second = new EvalRunner(
      { artifactRoot, sqlJsDistDir: SQL_JS, dataset },
      { ...common, status: 'running', results: [] }
    )
    const state = await second.run()
    expect(state.results).toEqual(afterFirst.results)
  })

  it('显式重新试验:新 evalRunId 记录来源 originEvalRunId', async () => {
    const { runner, artifactRoot } = runnerFor([caseLine('w1')], { originEvalRunId: 'eval-previous-failed' })
    const state = await runner.run()
    expect(state.originEvalRunId).toBe('eval-previous-failed')
    // 来源记录持久化到状态文件,不覆盖原失败运行
    const parsed = JSON.parse(
      readFileSync(join(artifactRoot, state.evalRunId, 'state.json'), 'utf-8')
    ) as EvalRunState
    expect(parsed.originEvalRunId).toBe('eval-previous-failed')
    expect(parsed.evalRunId).not.toBe('eval-previous-failed')
  })
})

describe('EVAL-02 状态文件:原子替换、损坏报错、续跑校验', () => {
  it('运行后无 .tmp 残留;state.json 含 schemaVersion 与领取日志', async () => {
    const { runner, artifactRoot } = runnerFor([caseLine('w1')])
    await runner.run()
    const dir = join(artifactRoot, runner.snapshot.evalRunId)
    const files = readdirSync(dir)
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([])
    const parsed = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8')) as EvalRunState
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.claims).toHaveLength(1)
    expect(parsed.results).toHaveLength(1)
  })

  it('损坏状态文件:抛可诊断错误并保留原文件,不静默重置', () => {
    const dataset = makeDataset([caseLine('w1')])
    const artifactRoot = mkdtempSync(join(tmpdir(), 'eval-corrupt-'))
    const dir = join(artifactRoot, 'eval-corrupt')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'state.json')
    writeFileSync(file, '{ "status": "runn', 'utf-8')
    const before = readFileSync(file, 'utf-8')
    expect(
      () =>
        new EvalRunner(
          { artifactRoot, sqlJsDistDir: SQL_JS, dataset },
          {
            evalRunId: 'eval-corrupt',
            datasetVersion: dataset.manifest.dataset_version,
            casesSha256: dataset.casesSha256,
            splits: ['dev'],
            configIds: ['fake_flow'],
            executionKind: 'fake',
            repeats: 1,
            maxCases: 10,
            status: 'running',
            startedAt: NOW,
            finishedAt: null,
            results: []
          }
        )
    ).toThrow(EvalStateError)
    expect(readFileSync(file, 'utf-8')).toBe(before)
  })

  function stateBase(dataset: LoadedDataset, over: Partial<EvalRunState> = {}): EvalRunState {
    return {
      evalRunId: 'eval-check',
      datasetVersion: dataset.manifest.dataset_version,
      casesSha256: dataset.casesSha256,
      splits: ['dev'],
      configIds: ['fake_flow'],
      executionKind: 'fake',
      repeats: 1,
      maxCases: 10,
      status: 'running',
      startedAt: NOW,
      finishedAt: null,
      results: [],
      schemaVersion: 1,
      stopReason: null,
      claims: [],
      lastInterruption: null,
      originEvalRunId: null,
      ...over
    }
  }

  function writeState(artifactRoot: string, state: EvalRunState): string {
    const dir = join(artifactRoot, state.evalRunId)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'state.json')
    writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8')
    return file
  }

  function construct(dataset: LoadedDataset, artifactRoot: string, state: EvalRunState): EvalRunner {
    return new EvalRunner({ artifactRoot, sqlJsDistDir: SQL_JS, dataset }, state)
  }

  it('跨配置续跑被拒绝:configIds 不一致抛错', () => {
    const dataset = makeDataset([caseLine('w1')])
    const artifactRoot = mkdtempSync(join(tmpdir(), 'eval-config-'))
    writeState(artifactRoot, stateBase(dataset, { configIds: ['other_config'] }))
    expect(() => construct(dataset, artifactRoot, stateBase(dataset))).toThrow(/配置/)
  })

  it('数据 hash 不一致(cases 变更)拒绝续跑', () => {
    const dataset = makeDataset([caseLine('w1')])
    const artifactRoot = mkdtempSync(join(tmpdir(), 'eval-hash-'))
    writeState(artifactRoot, stateBase(dataset, { casesSha256: 'deadbeef' }))
    expect(() => construct(dataset, artifactRoot, stateBase(dataset))).toThrow(/hash/)
  })

  it('split 与重复次数不一致拒绝续跑', () => {
    const dataset = makeDataset([caseLine('w1')])
    const rootA = mkdtempSync(join(tmpdir(), 'eval-split-'))
    writeState(rootA, stateBase(dataset, { splits: ['holdout'] }))
    expect(() => construct(dataset, rootA, stateBase(dataset))).toThrow(/split/)

    const rootB = mkdtempSync(join(tmpdir(), 'eval-repeats-'))
    writeState(rootB, stateBase(dataset, { repeats: 2 }))
    expect(() => construct(dataset, rootB, stateBase(dataset))).toThrow(/重复次数/)
  })

  it('结果唯一键重复:抛错不续跑', () => {
    const dataset = makeDataset([caseLine('w1')])
    const artifactRoot = mkdtempSync(join(tmpdir(), 'eval-dup-'))
    const dup = (i: number) => ({
      configId: 'fake_flow',
      caseId: 'w1',
      repeatIndex: 0,
      status: 'passed' as const,
      runId: `r${i}`,
      terminalStatus: 'succeeded',
      failureReasons: [],
      executedTools: ['todo.create'],
      confirmedBypass: false
    })
    writeState(artifactRoot, stateBase(dataset, { results: [dup(1), dup(2)] }))
    expect(() => construct(dataset, artifactRoot, stateBase(dataset))).toThrow(/唯一键重复/)
  })

  it('缺 schemaVersion 的旧状态文件拒绝续跑', () => {
    const dataset = makeDataset([caseLine('w1')])
    const artifactRoot = mkdtempSync(join(tmpdir(), 'eval-schema-'))
    const state = stateBase(dataset)
    delete (state as Partial<EvalRunState>).schemaVersion
    writeState(artifactRoot, state)
    expect(() => construct(dataset, artifactRoot, stateBase(dataset))).toThrow(/schema/)
  })

  it('重启中断检测:已领取未收尾组合记 interrupted,预算不重置,该组合重跑', async () => {
    const lines = [caseLine('w1'), caseLine('w2')]
    const dataset = makeDataset(lines)
    const artifactRoot = mkdtempSync(join(tmpdir(), 'eval-interrupt-'))
    // 模拟崩溃残留:状态文件 status=running,claims 有 w1 但无结果行
    writeState(
      artifactRoot,
      stateBase(dataset, {
        maxCases: 1,
        claims: [{ configId: 'fake_flow', caseId: 'w1', repeatIndex: 0, startedAt: NOW }]
      })
    )
    const runner = construct(dataset, artifactRoot, stateBase(dataset, { maxCases: 1 }))
    // 重启即检测中断:终止原因 interrupted,组合清单可诊断
    expect(runner.snapshot.stopReason).toBe('interrupted')
    expect(runner.snapshot.lastInterruption?.combos).toEqual(['fake_flow::w1::0'])
    const state = await runner.run()
    // w1 无完整产物 → 重跑(不跳过);w2 预算外 not_run
    expect(state.results.find((r) => r.caseId === 'w1')!.status).toBe('passed')
    expect(state.results.find((r) => r.caseId === 'w2')!.status).toBe('not_run')
    expect(state.status).toBe('cancelled')
    expect(state.stopReason).toBe('budget_exhausted')
    // 重启不重复计分:领取日志仍只有 w1 一条
    expect(state.claims).toHaveLength(1)
    // 中断信息保留在状态中供报告引用
    expect(state.lastInterruption?.combos).toEqual(['fake_flow::w1::0'])
  })
})

describe('EVAL-02 隔离回归:生产 epoch 与生产业务库不受评测影响(F-12)', () => {
  it('创建评测前后生产 epoch 相同:runner 不再初始化全局 epoch', async () => {
    const before = safeEpoch()
    const { runner } = runnerFor([caseLine('w1'), caseLine('w2')])
    await runner.run()
    expect(safeEpoch()).toBe(before)
  })

  it('评测前后生产业务库全表摘要不变', async () => {
    const prodRoot = mkdtempSync(join(tmpdir(), 'eval-proddb-'))
    const { db } = await openDatabase(join(prodRoot, 'prod.sqlite'), SQL_JS)
    initSchema(db)
    createTodo(db, { title: '生产数据:评测不得触碰' }, 'manual')
    const before = digestDb(db)
    const { runner } = runnerFor([caseLine('w1'), caseLine('w2')])
    await runner.run()
    expect(digestDb(db)).toBe(before)
    db.close()
  })
})

describe('歧义类案例:澄清轮', () => {
  it('fake 脚本先澄清,脚本回答后继续执行', async () => {
    const lines = [
      caseLine('amb-1', {
        category: '歧义澄清',
        input: '安排项目整理',
        interaction_script: [
          { on: 'clarification', answer: '下周一上午' },
          { on: 'confirmation', decision: 'approved' }
        ],
        expected: {
          terminal_status: 'succeeded',
          tool_sequence: ['todo.create'],
          required_arguments: { 'todo.create': { title: '安排项目整理' } },
          requires_confirmation: true
        }
      })
    ]
    const { runner } = runnerFor(lines)
    const state = await runner.run()
    expect(state.results[0]!.status).toBe('passed')
  })
})

// ---------- EVAL-04:配置冻结工厂、gold 类型隔离与路由透传 ----------

const TEMPLATE_ROOT = join(process.cwd(), 'evals', 'prompts')
const roundOneInput = {
  datasetSha256: sha('dataset'),
  fixtureSha256: sha('fixture'),
  budgetSha256: sha('budget'),
  interactionScriptSha256: sha('interaction-script'),
  codeCommit: 'c0ffee',
  toolsVersion: '0.1.0-test',
  rubricVersion: 'rubric-v1'
}

function caseDefOf(id: string): EvalCase {
  return JSON.parse(caseLine(id)) as EvalCase
}

function stateFor(dataset: LoadedDataset, over: Partial<EvalRunState> = {}): EvalRunState {
  return {
    evalRunId: `eval-${Math.random().toString(36).slice(2, 8)}`,
    datasetVersion: dataset.manifest.dataset_version,
    casesSha256: dataset.casesSha256,
    splits: ['dev'],
    configIds: ['fake_flow'],
    executionKind: 'fake',
    repeats: 1,
    maxCases: 100,
    status: 'running',
    startedAt: NOW,
    finishedAt: null,
    results: [],
    ...over
  }
}

describe('EVAL-04 配置冻结工厂与路由透传', () => {
  it('T16 参数规则失败必须使案例失败，不能被succeeded终态覆盖', async () => {
    const dataset = makeDataset([caseLine('wrong-args')])
    const factory: EvalCompleterFactory = {
      create: () => ({ async completeJson<T>(): Promise<StructuredCompleteResult<T>> {
        return { data: { goal: '合成反例', steps: [{ tool: 'todo.create', arguments: { title: 'wrong-title' } }], assumptions: [], clarifications: [] } as T, model: 'fake', latencyMs: 0, usage: { inputTokens: null, outputTokens: null, totalTokens: null, source: null }, actualProvider: null, actualAttempts: 0, attempts: [] }
      } })
    }
    const runner = new EvalRunner({ artifactRoot: mkdtempSync(join(tmpdir(), 't16-wrong-args-')), sqlJsDistDir: SQL_JS, dataset, completerFactory: factory }, stateFor(dataset))
    const state = await runner.run()
    expect(state.results[0]!.terminalStatus).toBe('succeeded')
    expect(state.results[0]!.ruleChecks!.some(c => !c.passed)).toBe(true)
    expect(state.results[0]!.status).toBe('failed')
    expect(state.results[0]!.failureReasons.join(';')).toMatch(/参数/)
  })

  it('T16 隔离库关闭移除后仅用case产物重建关键记录与全部指标', async () => {
    const lines = [caseLine('replay-ok'), caseLine('replay-failed', { expected: { ...JSON.parse(caseLine('replay-failed')).expected, terminal_status: 'failed' } })]
    const { runner, artifactRoot } = runnerFor(lines)
    const state = await runner.run()
    const temporary = join(artifactRoot, state.evalRunId, 'temporary')
    expect(readdirSync(temporary)).toEqual([])
    const replayed = state.results.map(result => {
      const loaded = loadCaseArtifacts(join(artifactRoot, result.artifactDir!))
      expect(loaded.run.outcome).toEqual(result)
      expect(loaded.observations).toEqual(result.toolObservations)
      expect(loaded.ruleChecks).toEqual(result.ruleChecks)
      return loaded.run.outcome as typeof result
    })
    const actual = calculateMetrics({ results: replayed }, makeDataset(lines).cases)
    const original = calculateMetrics(state, makeDataset(lines).cases)
    expect(actual).toEqual(original)
    if (process.env.T16_EVIDENCE_DIR) writeFileSync(join(process.env.T16_EVIDENCE_DIR, 'database-free-replay.json'), JSON.stringify({ temporary, remainingDatabases: readdirSync(temporary), originalResults: state.results, replayed, originalMetrics: original, replayedMetrics: actual }, null, 2))
  })
  function freezePair(configRoot: string): ReturnType<typeof roundOneConfigs> {
    const pair = roundOneConfigs('ops-planning', roundOneInput, TEMPLATE_ROOT)
    saveFrozenConfig(configRoot, pair.baseline)
    saveFrozenConfig(configRoot, pair.candidate)
    return pair
  }

  it('工厂按冻结配置实际替换冻结阶段 system:两配置请求携带不同模板,非冻结阶段透传', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-factory-'))
    const pair = freezePair(join(root, 'configs'))
    const seen: Array<string | undefined> = []
    const probe: StructuredCompleter = {
      async completeJson<T>(request: StructuredCompleteRequest): Promise<StructuredCompleteResult<T>> {
        seen.push(request.system)
        return {
          data: {} as T,
          model: 'probe',
          usage: { inputTokens: null, outputTokens: null, totalTokens: null, source: null },
          latencyMs: 0,
          actualProvider: null,
          actualAttempts: 0,
          attempts: []
        }
      }
    }
    const factory = createEvalCompleterFactory({
      configRoot: join(root, 'configs'),
      templateRoot: TEMPLATE_ROOT,
      fakeInnerFor: () => probe
    })
    const baseline = factory.create({ role: 'fake', configId: pair.baseline.configId, caseDef: caseDefOf('w1'), clock: fixedClock(NOW) })
    const candidate = factory.create({ role: 'fake', configId: pair.candidate.configId, caseDef: caseDefOf('w1'), clock: fixedClock(NOW) })
    await baseline.completeJson({ system: '你是个人事务助手的规划器。(测试请求)', prompt: 'p' })
    await candidate.completeJson({ system: '你是个人事务助手的规划器。(测试请求)', prompt: 'p' })
    const tb = loadTemplateFor(TEMPLATE_ROOT, pair.baseline.configId)
    const tc = loadTemplateFor(TEMPLATE_ROOT, pair.candidate.configId)
    // 两个冻结配置实际使用不同 prompt 模板:请求 system 被替换为各自模板内容
    expect(seen[0]).toBe(tb.content)
    expect(seen[1]).toBe(tc.content)
    expect(seen[0]).not.toBe(seen[1])
    // 非冻结阶段(其他 system)原样透传
    seen.length = 0
    await baseline.completeJson({ system: '你是证据审核员。其他阶段', prompt: 'p' })
    expect(seen[0]).toBe('你是证据审核员。其他阶段')
  })

  it('冻结配置 promptSha256 与模板内容不一致:工厂拒绝执行(模板漂移早失败)', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-factory-'))
    freezePair(join(root, 'configs'))
    // 篡改配置内容并按稳定序列化重算 sidecar(使配置本身可载入,只让模板漂移暴露)
    const file = join(root, 'configs', 'ops-planning-baseline.json')
    const forged = { ...JSON.parse(readFileSync(file, 'utf-8')), promptSha256: sha('forged-prompt') } as unknown as FrozenEvalConfig
    writeFileSync(file, JSON.stringify(forged, null, 2), 'utf-8')
    writeFileSync(join(root, 'configs', 'ops-planning-baseline.sha256'), `${frozenConfigSha256(forged)}\n`, 'utf-8')
    const factory = createEvalCompleterFactory({ configRoot: join(root, 'configs'), templateRoot: TEMPLATE_ROOT })
    expect(() =>
      factory.create({ role: 'fake', configId: 'ops-planning-baseline', caseDef: caseDefOf('w1'), clock: fixedClock(NOW) })
    ).toThrow(/promptSha256/)
  })

  it('runner 接工厂:冻结配置下的 fake 案例照常通过;actualProvider/modelAttempts 如实为 null/空', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-factory-'))
    freezePair(join(root, 'configs'))
    const factory = createEvalCompleterFactory({ configRoot: join(root, 'configs'), templateRoot: TEMPLATE_ROOT })
    const dataset = makeDataset([caseLine('w1')])
    const runner = new EvalRunner(
      { artifactRoot: root, sqlJsDistDir: SQL_JS, dataset, completerFactory: factory },
      stateFor(dataset, { configIds: ['ops-planning-baseline'] })
    )
    const state = await runner.run()
    expect(state.results[0]!.status).toBe('passed')
    // fake 无网络:实际路由为 null,发送尝试为空(不冒充)
    expect(state.results[0]!.actualProvider).toBeNull()
    expect(state.results[0]!.modelAttempts).toEqual([])
  })

  it('real 执行无工厂:案例失败并给出可诊断原因(拒绝未注入工厂的 real 运行)', async () => {
    const dataset = makeDataset([caseLine('w1')])
    const root = mkdtempSync(join(tmpdir(), 'eval-realfail-'))
    const runner = new EvalRunner(
      { artifactRoot: root, sqlJsDistDir: SQL_JS, dataset },
      stateFor(dataset, { executionKind: 'real', configIds: ['real-x'] })
    )
    const state = await runner.run()
    expect(state.results[0]!.status).toBe('failed')
    expect(state.results[0]!.failureReasons.some((r) => r.includes('completerFactory'))).toBe(true)
  })

  it('real 工厂:任务上下文类型上不含 gold;actualProvider/modelAttempts 透传到结果', async () => {
    const captured: EvalCompleterContext[] = []
    const attempt = {
      providerId: 'stub-backup',
      providerName: 'StubBackup',
      model: 'm-backup',
      requestId: 'req-1',
      attemptId: 'att-1',
      ordinal: 1,
      outcome: 'succeeded' as const,
      latencyMs: 1,
      httpStatus: 200,
      responseModel: null,
      usage: { inputTokens: null, outputTokens: null, totalTokens: null, source: null }
    }
    const plan = {
      goal: '任务 w1',
      steps: [{ tool: 'todo.create', arguments: { title: '任务 w1' } }],
      assumptions: [],
      clarifications: []
    }
    const stub: StructuredCompleter = {
      async completeJson<T>(_request: StructuredCompleteRequest): Promise<StructuredCompleteResult<T>> {
        return {
          data: plan as T,
          model: 'stub-model',
          usage: { inputTokens: null, outputTokens: null, totalTokens: null, source: null },
          latencyMs: 1,
          // 备用路由:与冻结配置 model 不同,报告可单列
          actualProvider: { providerId: 'stub-backup', providerName: 'StubBackup', model: 'm-backup' },
          actualAttempts: 1,
          attempts: [attempt]
        }
      }
    }
    const factory: EvalCompleterFactory = {
      create: (ctx) => {
        captured.push(ctx)
        return stub
      }
    }
    const dataset = makeDataset([caseLine('w1')])
    const root = mkdtempSync(join(tmpdir(), 'eval-realstub-'))
    const runner = new EvalRunner(
      { artifactRoot: root, sqlJsDistDir: SQL_JS, dataset, completerFactory: factory },
      stateFor(dataset, { executionKind: 'real', configIds: ['real-stub'] })
    )
    const state = await runner.run()
    expect(state.results[0]!.status).toBe('passed')
    // real 上下文只有任务原文与时区:caseDef/expected/seed 都不在类型与运行时形态上
    expect(captured).toHaveLength(1)
    const ctx = captured[0]!
    expect(ctx.role).toBe('real')
    expect('caseDef' in ctx).toBe(false)
    expect('seed' in ctx).toBe(false)
    if (ctx.role === 'real') {
      expect(ctx.task.input).toBe('任务 w1')
      expect(ctx.task.timezone).toBe('Asia/Shanghai')
      expect(ctx.task).not.toHaveProperty('expected')
    }
    // 实际路由与发送尝试透传到结果(备用切换可单列)
    expect(state.results[0]!.actualProvider).toEqual({ providerId: 'stub-backup', providerName: 'StubBackup', model: 'm-backup' })
    expect(state.results[0]!.modelAttempts).toHaveLength(1)
    expect(state.results[0]!.modelAttempts![0]!.attemptId).toBe('att-1')
  })
})
