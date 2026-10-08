// EVAL-03 交错对比协调器测试(pairedExperiment.test.ts)。
//
// 覆盖:
// - 计划展开:2 模块 × 2 split × 2 配置 × 3 全局重复 = 24 批;真实数据集
//   (personal_ops_v3 51 条 + research_v1 40 条)展开 546 项(dev 330 / holdout 216);
//   单批最大 31 条(Ops dev),满足单批 540 上限;交错顺序
//   (moduleIndex+splitIndex+globalRepeatIndex)%2;全局键唯一;确定性;
// - runPairedBatches 断点反例(桩服务,零真实请求):已完成批次复用;未知
//   runId;发送不明 intent;run 仍 running(崩溃残留);数据/配置/计划漂移;
//   取消不领取下一批;重复结果禁止覆盖;台账临时写+fsync+rename 原子替换;
// - 真实 EvalsService(fake 执行)mini 集成:dev 显式清单、holdout 完整 split、
//   绑定 artifact 可回放、二次运行复用、效果报告汇总(fake 标注);
// - 效果报告:三轮重复一致性单列;未知 token/费用保持 null;
// - CLI 参数面:compare 子命令与 --plan-file/--ledger/--approval-file 等参数存在。
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  batchKey,
  buildPairedPlan,
  interleaveVariantOrder,
  readPairedLedger,
  renderPairedReport,
  runPairedBatches,
  summarizePairedRuns,
  writePairedLedger,
  type PairedBatch,
  type PairedCoordinatorService,
  type PairedLedger,
  type PairedRunRecord
} from '../../src/main/evals/pairedExperiment'
import { EvalsService, loadEvalsDataset } from '../../src/main/evals/api'
import { resolveEvalPaths } from '../../src/main/evals/resources'
import { loadDatasetFromDir } from '../../src/main/evals/dataset'
import type { EvalCase } from '../../src/main/evals/types'
import type { EvalRunState } from '../../src/main/evals/runner'
import type { EvalStartRequest } from '../../src/main/evals/api'
import { parseArgs, usage } from '../../src/main/eval-cli'

const REPO_ROOT = resolve(__dirname, '..', '..')
const SQL_JS_DIST = join(REPO_ROOT, 'node_modules', 'sql.js', 'dist')
const VERSIONS = { codeCommit: 'b'.repeat(40), toolsVersion: 'ops-tools-v1', rubricVersion: 'rubric-v1' }
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SHA_C = 'c'.repeat(64)

function stubCase(id: string, split: 'dev' | 'holdout', datasetVersion = 'stub-v1'): EvalCase {
  return {
    schema_version: 1,
    case_id: id,
    dataset_version: datasetVersion,
    mode: 'personal_ops',
    category: '只读',
    split,
    input: '输入',
    fixture_id: 'ops-empty',
    clock: '2026-09-28T01:00:00.000Z',
    timezone: 'Asia/Shanghai',
    expected: { terminal_status: 'succeeded' },
    interaction_script: [{ on: 'confirmation', decision: 'approved' }],
    budgets: {},
    tags: []
  }
}

// ---------- 计划展开 ----------

describe('EVAL-03 buildPairedPlan 计划展开', () => {
  const opsDataset = loadDatasetFromDir(join(REPO_ROOT, 'evals', 'datasets', 'personal_ops_v3'))
  const researchDataset = loadDatasetFromDir(join(REPO_ROOT, 'evals', 'datasets', 'research_v1'))
  const configs = {
    'ops-baseline': SHA_A,
    'ops-candidate': SHA_B,
    'res-baseline': SHA_C,
    'res-candidate': SHA_B
  }
  const planOptions = {
    experimentId: 'adc-improvements-20261008',
    executionKind: 'fake' as const,
    configSha256: configs,
    generatedAtUtc: '2026-10-08T00:00:00.000Z'
  }

  it('24 批展开:真实 91 条数据 → 546 项(dev 330 / holdout 216);单批最大 31 ≤ 540', () => {
    const plan = buildPairedPlan(
      [
        { datasetVersion: 'personal_ops_v3', casesSha256: opsDataset.casesSha256, cases: opsDataset.cases, baselineConfigId: 'ops-baseline', candidateConfigId: 'ops-candidate' },
        { datasetVersion: 'research_v1', casesSha256: researchDataset.casesSha256, cases: researchDataset.cases, baselineConfigId: 'res-baseline', candidateConfigId: 'res-candidate' }
      ],
      planOptions
    )
    expect(plan.batches).toHaveLength(24)
    expect(plan.modules).toHaveLength(2)
    const totalItems = plan.batches.reduce((sum, b) => sum + b.expectedCaseIds.length, 0)
    expect(totalItems).toBe(546)
    const devItems = plan.batches.filter((b) => b.split === 'dev').reduce((sum, b) => sum + b.expectedCaseIds.length, 0)
    const holdoutItems = plan.batches.filter((b) => b.split === 'holdout').reduce((sum, b) => sum + b.expectedCaseIds.length, 0)
    expect(devItems).toBe(330)
    expect(holdoutItems).toBe(216)
    expect(Math.max(...plan.batches.map((b) => b.expectedCaseIds.length))).toBe(31)
    expect(plan.truncation).toBeNull()
  })

  it('交错顺序:(moduleIndex+splitIndex+globalRepeatIndex)%2 决定先后;每 (数据集,split,重复) 恰好一对', () => {
    expect(interleaveVariantOrder(0, 0, 1)).toEqual(['candidate', 'baseline'])
    expect(interleaveVariantOrder(0, 0, 2)).toEqual(['baseline', 'candidate'])
    expect(interleaveVariantOrder(0, 0, 3)).toEqual(['candidate', 'baseline'])
    expect(interleaveVariantOrder(0, 1, 1)).toEqual(['baseline', 'candidate'])
    expect(interleaveVariantOrder(1, 1, 3)).toEqual(['candidate', 'baseline'])
    const cases = [stubCase('d1', 'dev'), stubCase('d2', 'dev'), stubCase('h1', 'holdout')]
    const plan = buildPairedPlan(
      [{ datasetVersion: 'stub-v1', casesSha256: SHA_A, cases, baselineConfigId: 'cfg-baseline', candidateConfigId: 'cfg-candidate' }],
      { ...planOptions, configSha256: { 'cfg-baseline': SHA_A, 'cfg-candidate': SHA_B } }
    )
    // 1 模块 × 2 split × 3 重复 × 2 变体 = 12 批
    expect(plan.batches).toHaveLength(12)
    expect(plan.batches[0]!.globalRepeatIndex).toBe(1)
    expect(plan.batches[0]!.pipelineVariant).toBe('candidate')
    expect(plan.batches[1]!.pipelineVariant).toBe('baseline')
    expect(plan.batches[2]!.pipelineVariant).toBe('baseline')
    expect(plan.batches[3]!.pipelineVariant).toBe('candidate')
    // 每个全局键恰好一个 baseline + 一个 candidate,且全局键唯一
    const byKey = new Map<string, Set<string>>()
    for (const batch of plan.batches) {
      const key = `${batch.datasetVersion}|${batch.split}|g${batch.globalRepeatIndex}`
      const variants = byKey.get(key) ?? new Set<string>()
      variants.add(batch.pipelineVariant)
      byKey.set(key, variants)
    }
    expect([...byKey.values()].every((v) => v.size === 2 && v.has('baseline') && v.has('candidate'))).toBe(true)
    expect(new Set(plan.batches.map(batchKey)).size).toBe(plan.batches.length)
  })

  it('截断仅作用于 dev 批次且必须在计划中声明;holdout 保持完整', () => {
    const cases = [stubCase('d1', 'dev'), stubCase('d2', 'dev'), stubCase('d3', 'dev'), stubCase('h1', 'holdout'), stubCase('h2', 'holdout')]
    const plan = buildPairedPlan(
      [{ datasetVersion: 'stub-v1', casesSha256: SHA_A, cases, baselineConfigId: 'cfg-baseline', candidateConfigId: 'cfg-candidate' }],
      { ...planOptions, configSha256: { 'cfg-baseline': SHA_A, 'cfg-candidate': SHA_B }, maxDevCasesPerBatch: 2 }
    )
    for (const batch of plan.batches) {
      if (batch.split === 'dev') expect(batch.expectedCaseIds).toEqual(['d1', 'd2'])
      else expect(batch.expectedCaseIds).toEqual(['h1', 'h2'])
    }
    expect(plan.truncation).not.toBeNull()
    expect(plan.truncation!.maxDevCasesPerBatch).toBe(2)
  })

  it('确定性:同一输入两次展开逐字节一致;计划漂移输入被拒绝', () => {
    const cases = [stubCase('d1', 'dev'), stubCase('h1', 'holdout')]
    const module = { datasetVersion: 'stub-v1', casesSha256: SHA_A, cases, baselineConfigId: 'cfg-baseline', candidateConfigId: 'cfg-candidate' }
    const options = { ...planOptions, configSha256: { 'cfg-baseline': SHA_A, 'cfg-candidate': SHA_B } }
    expect(JSON.stringify(buildPairedPlan([module], options))).toBe(JSON.stringify(buildPairedPlan([module], options)))
    expect(() => buildPairedPlan([], options)).toThrow(/至少需要一个模块/)
    expect(() =>
      buildPairedPlan([{ ...module, baselineConfigId: 'ghost', candidateConfigId: 'cfg-candidate' }], options)
    ).toThrow(/计划绑定缺少配置 hash:ghost/)
  })
})

// ---------- runPairedBatches:桩服务断点反例(零真实请求) ----------

interface StubSpec {
  casesSha256?: string
  configIds?: string[]
  results?: Array<{ caseId: string; status: 'passed' | 'failed' }>
  hangUntilCancel?: boolean
}

/** 桩服务:实现 Pick<EvalsService,'startBatch'|'getRun'|'cancelRun'> 的同步语义 */
class StubService implements PairedCoordinatorService {
  startCalls = 0
  cancelCalls = 0
  readonly startParams: EvalStartRequest[] = []
  private readonly runs = new Map<string, { spec: StubSpec; cancelled: boolean; params: EvalStartRequest }>()

  constructor(private readonly specOf: (callIndex: number, params: EvalStartRequest) => StubSpec) {}

  startBatch(params: EvalStartRequest): { evalRunId: string; status: string } {
    this.startCalls += 1
    const evalRunId = `stub-run-${this.startCalls}`
    this.startParams.push(params)
    this.runs.set(evalRunId, { spec: this.specOf(this.startCalls, params), cancelled: false, params })
    return { evalRunId, status: 'running' }
  }

  getRun(evalRunId: string): EvalRunState | null {
    const run = this.runs.get(evalRunId)
    if (!run) return null
    if (run.spec.hangUntilCancel && !run.cancelled) {
      return { ...this.terminalState(run, evalRunId), status: 'running', stopReason: null, results: [], finishedAt: null }
    }
    return this.terminalState(run, evalRunId)
  }

  cancelRun(evalRunId: string): { cancelled: boolean } {
    this.cancelCalls += 1
    const run = this.runs.get(evalRunId)
    if (!run) return { cancelled: false }
    run.cancelled = true
    return { cancelled: true }
  }

  /** 测试预置一个运行(构造崩溃残留反例) */
  seedRun(evalRunId: string, params: EvalStartRequest, spec: StubSpec): void {
    this.runs.set(evalRunId, { spec, cancelled: false, params })
  }

  private terminalState(run: { spec: StubSpec; cancelled: boolean; params: EvalStartRequest }, evalRunId: string): EvalRunState {
    const cancelled = run.spec.hangUntilCancel && run.cancelled
    const configId = run.spec.configIds ?? [...run.params.configIds]
    return {
      evalRunId,
      datasetVersion: run.params.datasetVersion,
      casesSha256: run.spec.casesSha256 ?? SHA_A,
      splits: [run.params.split],
      configIds: configId,
      executionKind: run.params.executionKind,
      repeats: run.params.repeats,
      maxCases: run.params.maxCases,
      status: cancelled ? 'cancelled' : 'completed',
      stopReason: cancelled ? 'user_cancelled' : null,
      startedAt: '2026-10-08T00:00:00.000Z',
      finishedAt: '2026-10-08T00:00:01.000Z',
      results: (run.spec.results ?? []).map((r) => ({
        configId: configId[0]!,
        caseId: r.caseId,
        repeatIndex: 0,
        status: r.status,
        runId: null,
        terminalStatus: 'succeeded',
        failureReasons: [],
        executedTools: [],
        confirmedBypass: false,
        durationMs: 5,
        artifactDir: `${evalRunId}/${configId[0]}/${r.caseId}/0`,
        artifactStatus: 'ok' as const
      }))
    }
  }
}

/** 全部案例通过的桩规格:按批参数的案例清单生成结果 */
function passAllSpec(params: EvalStartRequest, casesSha256 = SHA_A): StubSpec {
  return {
    casesSha256,
    results: (params.caseIds ?? []).map((caseId) => ({ caseId, status: 'passed' as const }))
  }
}

function twoBatchPlan(): PairedBatch[] {
  return [
    { datasetVersion: 'stub-v1', split: 'dev', globalRepeatIndex: 1, configId: 'cfg-baseline', pipelineVariant: 'baseline', expectedCaseIds: ['d1', 'd2'] },
    { datasetVersion: 'stub-v1', split: 'dev', globalRepeatIndex: 1, configId: 'cfg-candidate', pipelineVariant: 'candidate', expectedCaseIds: ['d1', 'd2'] }
  ]
}

describe('EVAL-03 runPairedBatches 断点语义(桩服务)', () => {
  it('24 批 fake 完整跑通:交错顺序、dev 显式清单、holdout 不传清单、台账全部 completed、无临时残留', async () => {
    const opsDataset = loadDatasetFromDir(join(REPO_ROOT, 'evals', 'datasets', 'personal_ops_v3'))
    const researchDataset = loadDatasetFromDir(join(REPO_ROOT, 'evals', 'datasets', 'research_v1'))
    const plan = buildPairedPlan(
      [
        { datasetVersion: 'personal_ops_v3', casesSha256: opsDataset.casesSha256, cases: opsDataset.cases, baselineConfigId: 'ops-baseline', candidateConfigId: 'ops-candidate' },
        { datasetVersion: 'research_v1', casesSha256: researchDataset.casesSha256, cases: researchDataset.cases, baselineConfigId: 'res-baseline', candidateConfigId: 'res-candidate' }
      ],
      { experimentId: 'e', executionKind: 'fake', configSha256: { 'ops-baseline': SHA_A, 'ops-candidate': SHA_B, 'res-baseline': SHA_A, 'res-candidate': SHA_B }, generatedAtUtc: '2026-10-08T00:00:00.000Z' }
    )
    const service = new StubService((callIndex) => {
      const batch = plan.batches[callIndex - 1]!
      return { casesSha256: batch.datasetVersion === 'personal_ops_v3' ? SHA_A : SHA_B, results: batch.expectedCaseIds.map((caseId) => ({ caseId, status: 'passed' as const })) }
    })
    const dir = mkdtempSync(join(tmpdir(), 'eval-paired-'))
    const ledgerFile = join(dir, 'ledger.json')
    const bindings = await runPairedBatches(plan.batches, service, ledgerFile, new AbortController().signal, { executionKind: 'fake', pollIntervalMs: 10 })
    expect(service.startCalls).toBe(24)
    expect(bindings).toHaveLength(546)
    // 每全局键唯一
    expect(new Set(bindings.map((b) => `${b.datasetVersion}|${b.configId}|${b.caseId}|g${b.globalRepeatIndex}`)).size).toBe(546)
    // dev 批次传显式清单;holdout 批次不传(服务端禁止挑选 holdout 子集)
    plan.batches.forEach((batch, index) => {
      const params = service.startParams[index]!
      expect(params.repeats).toBe(1)
      expect(params.configIds).toEqual([batch.configId])
      expect(params.maxCases).toBe(batch.expectedCaseIds.length)
      expect(params.split).toBe(batch.split)
      if (batch.split === 'dev') expect(params.caseIds).toEqual(batch.expectedCaseIds)
      else expect(params.caseIds).toBeUndefined()
    })
    // 台账:24 批全部 completed;插入顺序 = 计划交错顺序;绑定 evalRunId 与 run 对应
    const ledger = readPairedLedger(ledgerFile)!
    const entries = Object.values(ledger.batches)
    expect(entries).toHaveLength(24)
    expect(entries.every((e) => e.status === 'completed')).toBe(true)
    expect(entries.map((e) => e.batchKey)[0]).toBe(batchKey(plan.batches[0]!))
    expect(entries.map((e) => e.batchKey)[1]).toBe(batchKey(plan.batches[1]!))
    expect(Object.keys(ledger.batches)).toEqual(plan.batches.map(batchKey))
    expect(entries.every((e) => e.observedCasesSha256 !== null)).toBe(true)
    // 台账原子写:目录内无 .tmp 残留
    expect(readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('已完成批次复用:第二次运行零 startBatch,绑定逐字节一致', async () => {
    const plan = twoBatchPlan()
    const dir = mkdtempSync(join(tmpdir(), 'eval-paired-'))
    const ledgerFile = join(dir, 'ledger.json')
    const first = new StubService((_, params) => passAllSpec(params))
    const firstBindings = await runPairedBatches(plan, first, ledgerFile, new AbortController().signal, { executionKind: 'fake', pollIntervalMs: 10 })
    expect(first.startCalls).toBe(2)
    const second = new StubService((_, params) => passAllSpec(params))
    const secondBindings = await runPairedBatches(plan, second, ledgerFile, new AbortController().signal, { executionKind: 'fake', pollIntervalMs: 10 })
    expect(second.startCalls).toBe(0)
    expect(JSON.stringify(secondBindings)).toBe(JSON.stringify(firstBindings))
  })

  it('未知 runId:台账 running 但状态文件不存在 → UNKNOWN_RUN 停止且不领取下一批', async () => {
    const plan = twoBatchPlan().slice(0, 1)
    const dir = mkdtempSync(join(tmpdir(), 'eval-paired-'))
    const ledgerFile = join(dir, 'ledger.json')
    await runPairedBatches(plan, new StubService((_, params) => passAllSpec(params)), ledgerFile, new AbortController().signal, { executionKind: 'fake', pollIntervalMs: 10 })
    // 篡改台账:第一批标记 running 且 evalRunId 指向不存在的 run
    const ledger = readPairedLedger(ledgerFile)!
    const key = Object.keys(ledger.batches)[0]!
    ledger.batches[key] = { ...ledger.batches[key]!, status: 'running', evalRunId: 'eval-gone', bindings: [] }
    writePairedLedger(ledgerFile, ledger)
    const fresh = new StubService((_, params) => passAllSpec(params))
    await expect(
      runPairedBatches(plan, fresh, ledgerFile, new AbortController().signal, { executionKind: 'fake', pollIntervalMs: 10 })
    ).rejects.toMatchObject({ reason: 'UNKNOWN_RUN', message: expect.stringContaining('eval-gone') })
    expect(fresh.startCalls).toBe(0)
  })

  it('发送不明 intent:intent 已登记但无启动回执 → SEND_STATE_UNCLEAR 暂停', async () => {
    const plan = twoBatchPlan().slice(0, 1)
    const dir = mkdtempSync(join(tmpdir(), 'eval-paired-'))
    const ledgerFile = join(dir, 'ledger.json')
    await runPairedBatches(plan, new StubService((_, params) => passAllSpec(params)), ledgerFile, new AbortController().signal, { executionKind: 'fake', pollIntervalMs: 10 })
    const ledger = readPairedLedger(ledgerFile)!
    const key = Object.keys(ledger.batches)[0]!
    ledger.batches[key] = { ...ledger.batches[key]!, status: 'intent', evalRunId: null }
    writePairedLedger(ledgerFile, ledger)
    await expect(
      runPairedBatches(plan, new StubService((_, params) => passAllSpec(params)), ledgerFile, new AbortController().signal, { executionKind: 'fake', pollIntervalMs: 10 })
    ).rejects.toMatchObject({ reason: 'SEND_STATE_UNCLEAR' })
  })

  it('run 仍标记 running(疑似崩溃残留)→ SEND_STATE_UNCLEAR 暂停核对', async () => {
    const plan = twoBatchPlan().slice(0, 1)
    const dir = mkdtempSync(join(tmpdir(), 'eval-paired-'))
    const ledgerFile = join(dir, 'ledger.json')
    await runPairedBatches(plan, new StubService((_, params) => passAllSpec(params)), ledgerFile, new AbortController().signal, { executionKind: 'fake', pollIntervalMs: 10 })
    const ledger = readPairedLedger(ledgerFile)!
    const key = Object.keys(ledger.batches)[0]!
    // 预置一个永远 running 的残留 run
    const crashParams: EvalStartRequest = { datasetVersion: 'stub-v1', split: 'dev', executionKind: 'fake', configIds: ['cfg-baseline'], repeats: 1, maxCases: 2 }
    const service = new StubService((_, params) => passAllSpec(params))
    service.seedRun('stub-run-crash', crashParams, { hangUntilCancel: true, results: [] })
    ledger.batches[key] = { ...ledger.batches[key]!, status: 'running', evalRunId: 'stub-run-crash' }
    writePairedLedger(ledgerFile, ledger)
    await expect(
      runPairedBatches(plan, service, ledgerFile, new AbortController().signal, { executionKind: 'fake', pollIntervalMs: 10 })
    ).rejects.toMatchObject({ reason: 'SEND_STATE_UNCLEAR', message: expect.stringContaining('崩溃残留') })
  })

  it('数据 hash 漂移:同数据集两批观测不一致 → DATA_DRIFT 停止', async () => {
    const plan = twoBatchPlan()
    const dir = mkdtempSync(join(tmpdir(), 'eval-paired-'))
    const ledgerFile = join(dir, 'ledger.json')
    const service = new StubService((callIndex, params) => passAllSpec(params, callIndex === 1 ? SHA_A : SHA_C))
    await expect(
      runPairedBatches(plan, service, ledgerFile, new AbortController().signal, { executionKind: 'fake', pollIntervalMs: 10 })
    ).rejects.toMatchObject({ reason: 'DATA_DRIFT' })
    const ledger = readPairedLedger(ledgerFile)!
    expect(Object.values(ledger.batches).find((b) => b.status === 'failed')).toBeTruthy()
  })

  it('配置漂移:run 配置与批次配置不一致 → CONFIG_DRIFT 停止', async () => {
    const plan = twoBatchPlan()
    const dir = mkdtempSync(join(tmpdir(), 'eval-paired-'))
    const ledgerFile = join(dir, 'ledger.json')
    const service = new StubService((_, params) => ({ ...passAllSpec(params), configIds: ['other-config'] }))
    await expect(
      runPairedBatches(plan, service, ledgerFile, new AbortController().signal, { executionKind: 'fake', pollIntervalMs: 10 })
    ).rejects.toMatchObject({ reason: 'CONFIG_DRIFT' })
  })

  it('计划漂移:同一台账换计划 → PLAN_DRIFT 停止', async () => {
    const plan = twoBatchPlan()
    const dir = mkdtempSync(join(tmpdir(), 'eval-paired-'))
    const ledgerFile = join(dir, 'ledger.json')
    await runPairedBatches(plan, new StubService((_, params) => passAllSpec(params)), ledgerFile, new AbortController().signal, { executionKind: 'fake', pollIntervalMs: 10 })
    const drifted = plan.map((b) => ({ ...b, expectedCaseIds: [...b.expectedCaseIds, 'd3'] }))
    await expect(
      runPairedBatches(drifted, new StubService((_, params) => passAllSpec(params)), ledgerFile, new AbortController().signal, { executionKind: 'fake', pollIntervalMs: 10 })
    ).rejects.toMatchObject({ reason: 'PLAN_DRIFT' })
  })

  it('取消不领取下一批:中断信号 → cancelRun、终态 cancelled、已完成绑定保留', async () => {
    const plan = twoBatchPlan()
    const dir = mkdtempSync(join(tmpdir(), 'eval-paired-'))
    const ledgerFile = join(dir, 'ledger.json')
    const service = new StubService((callIndex) =>
      callIndex === 1
        ? { hangUntilCancel: true, results: [{ caseId: 'd1', status: 'passed' as const }] }
        : passAllSpec({ caseIds: ['d1', 'd2'] } as EvalStartRequest)
    )
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const bindings = await runPairedBatches(plan, service, ledgerFile, controller.signal, { executionKind: 'fake', pollIntervalMs: 10 })
    expect(service.startCalls).toBe(1)
    expect(service.cancelCalls).toBeGreaterThanOrEqual(1)
    expect(bindings).toHaveLength(1)
    const ledger = readPairedLedger(ledgerFile)!
    const entries = Object.values(ledger.batches)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.status).toBe('cancelled')
    expect(entries[0]!.stopReason).toBe('user_cancelled')
  }, 15000)

  it('重复结果禁止覆盖:同全局键已有不同 run 的绑定 → DUPLICATE_RESULT 拒绝', async () => {
    const plan = twoBatchPlan().slice(0, 1)
    const dir = mkdtempSync(join(tmpdir(), 'eval-paired-'))
    const ledgerFile = join(dir, 'ledger.json')
    await runPairedBatches(plan, new StubService((_, params) => passAllSpec(params)), ledgerFile, new AbortController().signal, { executionKind: 'fake', pollIntervalMs: 10 })
    const ledger: PairedLedger = readPairedLedger(ledgerFile)!
    const key = Object.keys(ledger.batches)[0]!
    // 保留一条来自其他 run 的同键绑定,并把批次标记为 running(对账回填路径)
    const foreign = { ...ledger.batches[key]!.bindings[0]!, evalRunId: 'eval-foreign' }
    ledger.batches[key] = { ...ledger.batches[key]!, status: 'running', evalRunId: 'stub-run-1', bindings: [foreign] }
    writePairedLedger(ledgerFile, ledger)
    const service = new StubService((_, params) => passAllSpec(params))
    service.seedRun(
      'stub-run-1',
      { datasetVersion: 'stub-v1', split: 'dev', executionKind: 'fake', configIds: ['cfg-baseline'], repeats: 1, maxCases: 2, caseIds: ['d1', 'd2'] },
      passAllSpec({ caseIds: ['d1', 'd2'] } as EvalStartRequest)
    )
    await expect(
      runPairedBatches(plan, service, ledgerFile, new AbortController().signal, { executionKind: 'fake', pollIntervalMs: 10 })
    ).rejects.toMatchObject({ reason: 'DUPLICATE_RESULT' })
  })

  it('executionKind 未显式提供即拒绝(不猜默认)', async () => {
    const plan = twoBatchPlan()
    const dir = mkdtempSync(join(tmpdir(), 'eval-paired-'))
    await expect(
      runPairedBatches(plan, new StubService((_, params) => passAllSpec(params)), join(dir, 'l.json'), new AbortController().signal, {} as never)
    ).rejects.toMatchObject({ reason: 'EXECUTION_KIND_REQUIRED' })
  })
})

// ---------- 效果报告(汇总层) ----------

describe('EVAL-03 效果报告汇总层', () => {
  function recordOf(variant: 'baseline' | 'candidate', globalRepeatIndex: number, bits: Array<[string, 'passed' | 'failed']>): PairedRunRecord {
    return {
      datasetVersion: 'stub-v1',
      split: 'dev',
      globalRepeatIndex,
      pipelineVariant: variant,
      configId: variant === 'baseline' ? 'cfg-baseline' : 'cfg-candidate',
      evalRunId: `run-${variant}-${globalRepeatIndex}`,
      state: {
        evalRunId: `run-${variant}-${globalRepeatIndex}`,
        datasetVersion: 'stub-v1',
        casesSha256: SHA_A,
        splits: ['dev'],
        configIds: [variant === 'baseline' ? 'cfg-baseline' : 'cfg-candidate'],
        executionKind: 'fake',
        repeats: 1,
        maxCases: bits.length,
        status: 'completed',
        startedAt: '2026-10-08T00:00:00.000Z',
        finishedAt: '2026-10-08T00:00:02.000Z',
        results: bits.map(([caseId, status]) => ({
          configId: variant === 'baseline' ? 'cfg-baseline' : 'cfg-candidate',
          caseId,
          repeatIndex: 0,
          status,
          runId: null,
          terminalStatus: 'succeeded',
          failureReasons: [],
          executedTools: [],
          confirmedBypass: false
        }))
      }
    }
  }

  it('三轮重复一致性单列:同案例三次重复按对比较,不并入任务成功分母', () => {
    const runs = [
      recordOf('baseline', 1, [['c1', 'passed'], ['c2', 'failed']]),
      recordOf('baseline', 2, [['c1', 'passed'], ['c2', 'passed']]),
      recordOf('baseline', 3, [['c1', 'failed'], ['c2', 'passed']]),
      // candidate 重复 2 轮:不足三轮 → null
      recordOf('candidate', 1, [['c1', 'passed']]),
      recordOf('candidate', 2, [['c1', 'passed']])
    ]
    const report = summarizePairedRuns({ runs, mode: 'fake', generatedAtUtc: '2026-10-08T00:00:00.000Z' })
    const baselineAgreement = report.repeatAgreement.find((r) => r.pipelineVariant === 'baseline')!
    // c1(g1 过,g2 过,g3 败):(1,2)=1,(1,3)=0,(2,3)=0;c2(g1 败,g2 过,g3 过):(1,2)=0,(1,3)=0,(2,3)=1 → 2/6
    expect(baselineAgreement.casesWithAllRepeats).toBe(2)
    expect(baselineAgreement.meanPairwiseAgreement).toBeCloseTo(2 / 6, 6)
    const candidateAgreement = report.repeatAgreement.find((r) => r.pipelineVariant === 'candidate')!
    expect(candidateAgreement.casesWithAllRepeats).toBe(0)
    expect(candidateAgreement.meanPairwiseAgreement).toBeNull()
    // 任务成功分母不受重复次数膨胀:baseline 已判分 6(2 案例 × 3 重复,如实呈现)
    expect(report.perDatasetSplit[0]!.baseline.taskSuccess.denominator).toBe(6)
  })

  it('分组独立性:researchScoring 只计入所在组,不串组(回归)', () => {
    const base = recordOf('baseline', 1, [['c1', 'passed']])
    const scoredRow = {
      ...base.state.results[0]!,
      researchScoring: {
        applicable: true,
        recallMacro: 0.5,
        questions: [],
        citationStructure: { valid: 2, total: 4, precision: 0.5 },
        factCoverage: { covered: 1, total: 2, value: 0.5 },
        insufficiency: { expected: true, recognized: true, pass: true },
        semanticSupport: 'pending_human_review' as const,
        goldResolutionErrors: []
      }
    }
    const researchRun: PairedRunRecord = {
      ...base,
      datasetVersion: 'research_v1',
      state: { ...base.state, datasetVersion: 'research_v1', results: [scoredRow] }
    }
    const report = summarizePairedRuns({ runs: [base, researchRun], mode: 'fake' })
    const ops = report.perDatasetSplit.find((g) => g.datasetVersion === 'stub-v1')!
    const research = report.perDatasetSplit.find((g) => g.datasetVersion === 'research_v1')!
    expect(ops.baseline.citation.scoredCases).toBe(0)
    expect(research.baseline.citation.scoredCases).toBe(1)
    expect(research.baseline.citation.precision).toBeCloseTo(0.5, 6)
    expect(research.baseline.insufficiency.passRate).toBe(1)
  })

  it('未知 token/费用/分项保持 null;fake 报告明确标注;判定与安全回退可见', () => {
    const runs = [
      recordOf('baseline', 1, [['c1', 'passed'], ['c2', 'failed']]),
      recordOf('candidate', 1, [['c1', 'passed'], ['c2', 'passed']])
    ]
    const report = summarizePairedRuns({ runs, mode: 'fake' })
    expect(report.note).toMatch(/fake 预检示例/)
    for (const variant of ['baseline', 'candidate'] as const) {
      const s = report.perDatasetSplit[0]![variant]
      expect(s.tokens).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null })
      expect(s.cost).toEqual({ currency: null, amount: null })
      expect(s.breakdown.queueMs).toBeNull()
      expect(s.breakdown.approvalMs).toBeNull()
      expect(s.breakdown.wallMs).toBe(2000)
      // 结果行无工具观测:确认绕过属于"未测"(null),不得显示 0(metrics 分母纪律)
      expect(s.safetyViolations.confirmedBypass).toBeNull()
    }
    expect(report.perDatasetSplit[0]!.taskSuccessDelta).toBeCloseTo(0.5, 6)
    expect(report.perDatasetSplit[0]!.verdict).toBe('candidate-better')
    const markdown = renderPairedReport(report)
    expect(markdown).toContain('FAKE 预检示例')
    expect(markdown).toContain('三轮重复一致性')
    expect(markdown).toContain('不宣称统计显著')
  })
})

// ---------- 真实 EvalsService(fake 执行)mini 集成 ----------

describe('EVAL-03 runPairedBatches × EvalsService(fake;离线)', () => {
  it('dev 显式清单 + holdout 完整 split:跑通、绑定可回放、二次运行复用、报告汇总', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'eval-paired-real-'))
    const paths = resolveEvalPaths({ packaged: false, resourceRoot: REPO_ROOT, sourceRoot: REPO_ROOT, userData })
    const service = new EvalsService({ paths, sqlJsDistDir: SQL_JS_DIST, versionsOf: () => ({ ...VERSIONS }) })
    const pair = service.freeze({
      experimentId: 'eval03-mini',
      datasetVersion: 'personal_ops_v3',
      stage: 'ops-planning',
      executionKind: 'fake',
      target: null
    })
    const baselineId = pair.baseline.config.configId
    const candidateId = pair.candidate.config.configId
    const dataset = loadEvalsDataset(paths.datasetRoot, 'personal_ops_v3')
    const holdoutIds = dataset.holdout.map((c) => c.case_id)
    const plan: PairedBatch[] = [
      { datasetVersion: 'personal_ops_v3', split: 'dev', globalRepeatIndex: 1, configId: baselineId, pipelineVariant: 'baseline', expectedCaseIds: ['ops-read-01', 'ops-write-01'] },
      { datasetVersion: 'personal_ops_v3', split: 'dev', globalRepeatIndex: 1, configId: candidateId, pipelineVariant: 'candidate', expectedCaseIds: ['ops-read-01', 'ops-write-01'] },
      { datasetVersion: 'personal_ops_v3', split: 'holdout', globalRepeatIndex: 1, configId: baselineId, pipelineVariant: 'baseline', expectedCaseIds: [...holdoutIds] }
    ]
    const calls = { start: 0 }
    const proxy: PairedCoordinatorService = {
      startBatch: (params) => {
        calls.start += 1
        return service.startBatch(params)
      },
      getRun: (evalRunId) => service.getRun(evalRunId),
      cancelRun: (evalRunId) => service.cancelRun(evalRunId)
    }
    const ledgerFile = join(userData, 'paired-ledger.json')
    const bindings = await runPairedBatches(plan, proxy, ledgerFile, new AbortController().signal, { executionKind: 'fake', pollIntervalMs: 50 })
    expect(calls.start).toBe(3)
    expect(bindings).toHaveLength(2 + 2 + holdoutIds.length)
    // holdout 批次未传显式清单(服务端禁止挑选 holdout 子集)
    const ledger = readPairedLedger(ledgerFile)!
    const entries = Object.values(ledger.batches)
    expect(entries.every((e) => e.status === 'completed')).toBe(true)
    // 绑定指向可回放产物目录(原始产物只读,未被协调器改写)
    for (const binding of bindings.slice(0, 4)) {
      expect(binding.artifactDir).not.toBe('')
      expect(existsSync(join(paths.artifactRoot, binding.artifactDir))).toBe(true)
    }
    // 二次运行:全部批次复用,零新启动
    const secondBindings = await runPairedBatches(plan, proxy, ledgerFile, new AbortController().signal, { executionKind: 'fake', pollIntervalMs: 50 })
    expect(calls.start).toBe(3)
    expect(JSON.stringify(secondBindings)).toBe(JSON.stringify(bindings))
    // 报告汇总(fake 标注;任务成功/绑定一致)
    const runs: PairedRunRecord[] = entries.map((entry) => ({
      datasetVersion: entry.datasetVersion,
      split: entry.split,
      globalRepeatIndex: entry.globalRepeatIndex,
      pipelineVariant: entry.pipelineVariant,
      configId: entry.configId,
      evalRunId: entry.evalRunId!,
      state: service.getRun(entry.evalRunId!)!
    }))
    const report = summarizePairedRuns({ runs, mode: 'fake' })
    expect(report.perDatasetSplit.map((g) => `${g.datasetVersion}/${g.split}`)).toEqual(['personal_ops_v3/dev', 'personal_ops_v3/holdout'])
    expect(report.batches).toHaveLength(3)
    expect(report.perDatasetSplit[0]!.baseline.items.total).toBe(2)
        expect(report.perDatasetSplit[1]!.baseline.items.total).toBe(holdoutIds.length)
    expect(report.perDatasetSplit[0]!.candidate.items.total).toBe(2)
  }, 90000)
})

// ---------- CLI 参数面 ----------

describe('EVAL-03 eval-cli compare 参数面', () => {
  it('--help 与 parseArgs 确认 compare/--plan-file/--ledger/--approval-file/--case-ids-file 存在', () => {
    const help = usage()
    for (const token of ['compare', '--plan-file', '--ledger', '--approval-file', '--case-ids-file', '--user-data', '--artifact-root']) {
      expect(help).toContain(token)
    }
    const parsed = parseArgs(['compare', '--plan-file', 'plan.json', '--ledger', 'l.json', '--user-data', '/tmp/u'])
    expect(parsed).toEqual({
      command: 'compare',
      flags: { 'plan-file': 'plan.json', ledger: 'l.json', 'user-data': '/tmp/u' }
    })
    expect(parseArgs(['compare'])).toEqual({ command: 'compare', flags: {} })
    expect(parseArgs(['--plan-file', 'p'])).toBeNull()
  })
})
