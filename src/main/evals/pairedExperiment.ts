// EVAL-03 交错对比协调器(pairedExperiment.ts)。
//
// 规范来源:docs/superpowers/plans/2026-10-08-desk-companion-improvements/evaluation.md EVAL-03。
// 薄协调器:只负责批次计划展开、交错排序、轮询与断点台账;执行完全复用
// EvalsService.startBatch/getRun/cancelRun(不新增服务 resume API)。
//
// 纪律:
// - 24 批计划 = 2 模块 × 2 split × 2 配置 × 3 全局重复;每批单配置、单 split、
//   repeats=1,单批案例数最大 31(Ops dev),天然满足单批 540 上限;
//   不得把全实验 546 项并入单批;
// - 按 (moduleIndex + splitIndex + globalRepeatIndex) % 2 交错 baseline/candidate
//   先后(偶数 baseline 先行,奇数 candidate 先行;globalRepeatIndex 取 1~3);
//   物理 repeatIndex=0 保持原始产物,外部映射 globalRepeat 1~3,每个全局键唯一;
// - holdout 批次不传显式案例清单(服务端仍禁止挑选 holdout 子集),以完整
//   split 执行;dev 批次传 expectedCaseIds 作为显式清单;
// - 台账(ledger)临时写 + fsync + rename 原子替换;原始 case 产物只读不写;
// - 断点语义:已完成批次复用(不再 startBatch);台账 running 但 getRun 返回
//   null(未知 runId)、intent 已登记未见启动回执(发送状态不明)、run 仍标记
//   running(疑似崩溃残留)均暂停;同数据集 cases hash 跨批漂移、配置漂移、
//   计划漂移即停止;取消不领取下一批;重复结果禁止覆盖;
// - 效果报告:汇总任务成功、安全违规、引用覆盖/正确性、不足处理、延迟
//   p50/p95、wall/active/queue/approval 分项、请求/token/费用;未知保持 null;
//   三轮重复相关性单列,不把同案例三次当作三份独立数据。

import { mkdirSync } from 'node:fs'
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { EvalsService, EvalStartRequest } from './api'
import type { EvalCase } from './types'
import type { EvalRunState } from './runner'
import { calculateMetrics } from './metrics'
import { stableValueSha256 } from './configStore'

// ---------- 计划类型(规范接口) ----------

/** 单个对比批次:单配置、单 split、单全局重复;expectedCaseIds 为该批完整案例清单 */
export interface PairedBatch {
  datasetVersion: string
  split: 'dev' | 'holdout'
  globalRepeatIndex: 1 | 2 | 3
  configId: string
  pipelineVariant: 'baseline' | 'candidate'
  expectedCaseIds: string[]
}

/** 结果绑定:一次案例执行到全局实验键的唯一归属 */
export interface ResultBinding {
  datasetVersion: string
  configId: string
  caseId: string
  globalRepeatIndex: 1 | 2 | 3
  evalRunId: string
  localRepeatIndex: number
  artifactDir: string
  sha256: string
}

/** 计划文件(持久化形态:绑定配置 hash 与数据版本;runPairedBatches 消费其 batches) */
export interface PairedPlanFile {
  schemaVersion: 1
  kind: 'eval-paired-plan'
  experimentId: string
  executionKind: 'fake' | 'real'
  generatedAtUtc: string
  modules: Array<{
    moduleIndex: number
    datasetVersion: string
    casesSha256: string
    baselineConfigId: string
    candidateConfigId: string
    dev: number
    holdout: number
  }>
  /** configId → 实际配置 hash(frozenConfigSha256;启动由服务端按冻结存储复核) */
  configs: Record<string, string>
  batches: PairedBatch[]
  /** 计划验证截断声明(null = 未截断;截断必须在本字段声明) */
  truncation: { maxDevCasesPerBatch: number; note: string } | null
}

// ---------- 计划展开 ----------

export interface PairedPlanModule {
  datasetVersion: string
  casesSha256: string
  cases: readonly EvalCase[]
  baselineConfigId: string
  candidateConfigId: string
}

export interface BuildPairedPlanOptions {
  experimentId: string
  executionKind: 'fake' | 'real'
  /** configId → 实际配置 hash(计划绑定;启动时服务端按冻结存储复核) */
  configSha256: Record<string, string>
  /** 全局重复次数(规范为 3;缺省 3) */
  globalRepeats?: 1 | 2 | 3
  /** 计划验证截断:每个 dev 批次只保留前 K 条案例(holdout 保持完整;仅 fake 预检用) */
  maxDevCasesPerBatch?: number
  generatedAtUtc?: string
}

/**
 * 交错规则(规范逐字):parity = (moduleIndex + splitIndex + globalRepeatIndex) % 2,
 * 偶数 baseline 先行、奇数 candidate 先行。globalRepeatIndex 为外部全局重复键(1~3),
 * 与物理 repeatIndex=0 的映射在 ResultBinding 中表达。
 */
export function interleaveVariantOrder(
  moduleIndex: number,
  splitIndex: number,
  globalRepeatIndex: number
): ['baseline', 'candidate'] | ['candidate', 'baseline'] {
  return (moduleIndex + splitIndex + globalRepeatIndex) % 2 === 0
    ? ['baseline', 'candidate']
    : ['candidate', 'baseline']
}

/**
 * 展开成对批次计划:2 模块 × 2 split × 2 配置 × 3 全局重复 = 24 批
 * (模块数泛化为 ≥1;规范形态为 2 模块)。确定性:输入不变输出逐字节一致。
 */
export function buildPairedPlan(
  modules: readonly PairedPlanModule[],
  options: BuildPairedPlanOptions
): PairedPlanFile {
  if (modules.length < 1) throw new PairedPlanError('PLAN_INVALID', '计划展开至少需要一个模块')
  const globalRepeats = options.globalRepeats ?? 3
  if (!Number.isInteger(globalRepeats) || globalRepeats < 1 || globalRepeats > 3) {
    throw new PairedPlanError('PLAN_INVALID', `globalRepeats 必须是 1~3,收到 ${String(globalRepeats)}`)
  }
  const batches: PairedBatch[] = []
  const moduleSummaries: PairedPlanFile['modules'] = []
  modules.forEach((module, moduleIndex) => {
    const dev = module.cases.filter((c) => c.split === 'dev')
    const holdout = module.cases.filter((c) => c.split === 'holdout')
    if (dev.length === 0 || holdout.length === 0) {
      throw new PairedPlanError('PLAN_INVALID', `模块 ${module.datasetVersion} 的 dev/holdout 拆分不能为空(${dev.length}/${holdout.length})`)
    }
    if (module.baselineConfigId === module.candidateConfigId) {
      throw new PairedPlanError('PLAN_INVALID', `模块 ${module.datasetVersion} 的 baseline/candidate 配置不能相同`)
    }
    for (const configId of [module.baselineConfigId, module.candidateConfigId]) {
      if (!options.configSha256[configId]) {
        throw new PairedPlanError('PLAN_INVALID', `计划绑定缺少配置 hash:${configId}`)
      }
    }
    const splitCases: ReadonlyArray<readonly EvalCase[]> = [dev, holdout]
    for (const [splitIndex, cases] of splitCases.entries()) {
      const split: 'dev' | 'holdout' = splitIndex === 0 ? 'dev' : 'holdout'
      for (let globalRepeatIndex = 1; globalRepeatIndex <= globalRepeats; globalRepeatIndex += 1) {
        const expectedAll = cases.map((c) => c.case_id)
        // 截断仅作用于 dev 批次(holdout 保持完整,不挑选子集);必须在计划中声明
        const expected =
          split === 'dev' && options.maxDevCasesPerBatch !== undefined
            ? expectedAll.slice(0, options.maxDevCasesPerBatch)
            : expectedAll
        const [first, second] = interleaveVariantOrder(moduleIndex, splitIndex, globalRepeatIndex)
        for (const variant of [first, second] as const) {
          batches.push({
            datasetVersion: module.datasetVersion,
            split,
            globalRepeatIndex: globalRepeatIndex as 1 | 2 | 3,
            configId: variant === 'baseline' ? module.baselineConfigId : module.candidateConfigId,
            pipelineVariant: variant,
            expectedCaseIds: [...expected]
          })
        }
      }
    }
    moduleSummaries.push({
      moduleIndex,
      datasetVersion: module.datasetVersion,
      casesSha256: module.casesSha256,
      baselineConfigId: module.baselineConfigId,
      candidateConfigId: module.candidateConfigId,
      dev: dev.length,
      holdout: holdout.length
    })
  })
  return {
    schemaVersion: 1,
    kind: 'eval-paired-plan',
    experimentId: options.experimentId,
    executionKind: options.executionKind,
    generatedAtUtc: options.generatedAtUtc ?? new Date().toISOString(),
    modules: moduleSummaries,
    configs: { ...options.configSha256 },
    batches,
    truncation:
      options.maxDevCasesPerBatch !== undefined
        ? {
            maxDevCasesPerBatch: options.maxDevCasesPerBatch,
            note: `计划验证截断:每个 dev 批次仅保留前 ${options.maxDevCasesPerBatch} 条案例;holdout 保持完整。仅用于 fake 计划验证,不作为全量实验计划。`
          }
        : null
  }
}

// ---------- 错误与台账 ----------

/** 协调器停止原因类:所有停止都带机器可读 reason,不静默吞掉 */
export class PairedPlanError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message)
    this.name = 'PairedPlanError'
  }
}

export type PairedLedgerBatchStatus = 'intent' | 'running' | 'completed' | 'cancelled' | 'failed'

export interface PairedLedgerBatch {
  batchKey: string
  datasetVersion: string
  split: 'dev' | 'holdout'
  globalRepeatIndex: number
  configId: string
  pipelineVariant: 'baseline' | 'candidate'
  expectedCaseIdsSha256: string
  status: PairedLedgerBatchStatus
  evalRunId: string | null
  /** 该批 run 观测到的数据 hash(跨批漂移检测依据) */
  observedCasesSha256: string | null
  bindings: ResultBinding[]
  startedAtUtc: string | null
  finishedAtUtc: string | null
  stopReason: string | null
}

export interface PairedLedger {
  schemaVersion: 1
  kind: 'eval-paired-ledger'
  /** 台账绑定计划 hash:换计划必须换台账(计划漂移即停止) */
  planSha256: string
  updatedAtUtc: string
  batches: Record<string, PairedLedgerBatch>
}

export function batchKey(batch: PairedBatch): string {
  return `${batch.datasetVersion}|${batch.split}|g${batch.globalRepeatIndex}|${batch.pipelineVariant}`
}

function caseIdsSha256(caseIds: readonly string[]): string {
  return stableValueSha256([...caseIds])
}

/**
 * 台账原子写:临时文件写入 → fsync(flush)→ rename 原子替换。
 * 崩溃最多留下待清理临时文件,ledger 本体不会半写。
 */
export function writePairedLedger(ledgerFile: string, ledger: PairedLedger): void {
  mkdirSync(dirname(ledgerFile), { recursive: true })
  const tmp = `${ledgerFile}.${randomUUID()}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, JSON.stringify(ledger, null, 2))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, ledgerFile)
}

/** 读取台账(不存在返回 null;损坏抛错保留原文件) */
export function readPairedLedger(ledgerFile: string): PairedLedger | null {
  if (!existsSync(ledgerFile)) return null
  let raw: string
  try {
    raw = readFileSync(ledgerFile, 'utf-8')
  } catch (err) {
    throw new PairedPlanError('LEDGER_UNREADABLE', `台账不可读:${ledgerFile}:${err instanceof Error ? err.message : String(err)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new PairedPlanError('LEDGER_CORRUPT', `台账损坏(原文件保留):${ledgerFile}:${err instanceof Error ? err.message : String(err)}`)
  }
  const ledger = parsed as PairedLedger
  if (ledger.schemaVersion !== 1 || ledger.kind !== 'eval-paired-ledger' || typeof ledger.batches !== 'object' || ledger.batches === null) {
    throw new PairedPlanError('LEDGER_CORRUPT', `台账 schema/kind 不符:${ledgerFile}`)
  }
  return ledger
}

function loadOrCreateLedger(ledgerFile: string, planSha256: string): PairedLedger {
  const existing = readPairedLedger(ledgerFile)
  if (existing === null) {
    const fresh: PairedLedger = {
      schemaVersion: 1,
      kind: 'eval-paired-ledger',
      planSha256,
      updatedAtUtc: new Date().toISOString(),
      batches: {}
    }
    writePairedLedger(ledgerFile, fresh)
    return fresh
  }
  if (existing.planSha256 !== planSha256) {
    throw new PairedPlanError(
      'PLAN_DRIFT',
      `台账绑定的计划 hash ${existing.planSha256.slice(0, 12)}… ≠ 当前计划 ${planSha256.slice(0, 12)}…(换计划必须换台账文件)`
    )
  }
  return existing
}

// ---------- 计划校验 ----------

function validatePlan(plan: readonly PairedBatch[]): void {
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new PairedPlanError('PLAN_INVALID', '计划批次清单为空')
  }
  const seen = new Set<string>()
  for (const batch of plan) {
    if (!batch.datasetVersion || !batch.configId) {
      throw new PairedPlanError('PLAN_INVALID', `批次缺 datasetVersion/configId:${JSON.stringify(batch).slice(0, 120)}`)
    }
    if (batch.split !== 'dev' && batch.split !== 'holdout') {
      throw new PairedPlanError('PLAN_INVALID', `批次 split 非法:${batch.split}`)
    }
    if (!Number.isInteger(batch.globalRepeatIndex) || batch.globalRepeatIndex < 1 || batch.globalRepeatIndex > 3) {
      throw new PairedPlanError('PLAN_INVALID', `globalRepeatIndex 必须 1~3:${String(batch.globalRepeatIndex)}`)
    }
    if (batch.pipelineVariant !== 'baseline' && batch.pipelineVariant !== 'candidate') {
      throw new PairedPlanError('PLAN_INVALID', `pipelineVariant 非法:${String(batch.pipelineVariant)}`)
    }
    if (!Array.isArray(batch.expectedCaseIds) || batch.expectedCaseIds.length === 0 || new Set(batch.expectedCaseIds).size !== batch.expectedCaseIds.length) {
      throw new PairedPlanError('PLAN_INVALID', `批次 ${batch.configId}/${batch.split}/g${batch.globalRepeatIndex} 的 expectedCaseIds 必须非空且无重复`)
    }
    const key = batchKey(batch)
    if (seen.has(key)) throw new PairedPlanError('PLAN_INVALID', `批次键重复:${key}(每批单配置,成对展开,全局键唯一)`)
    seen.add(key)
  }
}

// ---------- 协调器 ----------

/** 协调器消费的服务面(规范接口:EvalsService 的三个同步方法) */
export type PairedCoordinatorService = Pick<EvalsService, 'startBatch' | 'getRun' | 'cancelRun'>

export interface RunPairedBatchesOptions {
  /**
   * 必须显式提供(不猜默认):fake/real 混跑是真实事故源。省略时立即抛错,
   * 保证规范四参调用形态也不会悄悄启动。
   */
  executionKind: 'fake' | 'real'
  /** 轮询间隔毫秒(缺省 100) */
  pollIntervalMs?: number
  /** 时间源注入(测试确定性;缺省系统 UTC) */
  nowUtc?: () => string
}

/**
 * 运行成对批次计划:按计划顺序逐批 startBatch(repeats=1,单配置)并轮询到
 * 终态;断点语义见文件头。返回全部已完成批次的 ResultBinding(取消时返回
 * 已完成部分);停止条件抛 PairedPlanError。
 */
export async function runPairedBatches(
  plan: readonly PairedBatch[],
  service: PairedCoordinatorService,
  ledgerFile: string,
  signal: AbortSignal,
  options: RunPairedBatchesOptions
): Promise<ResultBinding[]> {
  if (!options || (options.executionKind !== 'fake' && options.executionKind !== 'real')) {
    throw new PairedPlanError('EXECUTION_KIND_REQUIRED', 'runPairedBatches 必须显式提供 options.executionKind(fake | real),不猜默认')
  }
  validatePlan(plan)
  const planSha256 = stableValueSha256(plan)
  const ledger = loadOrCreateLedger(ledgerFile, planSha256)
  const now = options.nowUtc ?? (() => new Date().toISOString())
  const pollIntervalMs = options.pollIntervalMs ?? 100
  const collected: ResultBinding[] = []

  /** 跨批数据 hash 一致性:同数据集任一观测漂移即停止 */
  const observedHashes = new Map<string, string>()
  for (const entry of Object.values(ledger.batches)) {
    if (entry.observedCasesSha256) {
      const prior = observedHashes.get(entry.datasetVersion)
      if (prior !== undefined && prior !== entry.observedCasesSha256) {
        throw new PairedPlanError('DATA_DRIFT', `数据 hash 漂移:${entry.datasetVersion} 先前观测 ${prior.slice(0, 12)}… 与台账另一批 ${entry.observedCasesSha256.slice(0, 12)}… 不一致`)
      }
      observedHashes.set(entry.datasetVersion, entry.observedCasesSha256)
    }
  }

  const persist = (): void => {
    ledger.updatedAtUtc = now()
    writePairedLedger(ledgerFile, ledger)
  }

  for (const batch of plan) {
    // 取消不领取下一批:信号已中止即停止展开,已完成结果保留
    if (signal.aborted) break
    const key = batchKey(batch)
    const expectedHash = caseIdsSha256(batch.expectedCaseIds)
    const existing = ledger.batches[key]
    if (existing) {
      // 计划-台账一致性:同键条目的配置与案例清单必须与当前计划一致
      if (
        existing.configId !== batch.configId ||
        existing.split !== batch.split ||
        existing.globalRepeatIndex !== batch.globalRepeatIndex ||
        existing.expectedCaseIdsSha256 !== expectedHash
      ) {
        throw new PairedPlanError('PLAN_DRIFT', `台账条目与计划不一致:${key}(配置或案例清单漂移)`)
      }
      if (existing.status === 'completed') {
        // 已完成批次复用:不再 startBatch,直接复用绑定
        collected.push(...existing.bindings)
        continue
      }
      if (existing.status === 'cancelled' || existing.status === 'failed') {
        throw new PairedPlanError('BATCH_TERMINAL', `批次 ${key} 处于 ${existing.status}(stopReason=${existing.stopReason ?? 'null'}),需人工处置后清理台账`)
      }
      if (existing.status === 'intent') {
        // intent 已登记但未见启动回执:崩溃窗口,发送状态不明 → 暂停核对
        throw new PairedPlanError('SEND_STATE_UNCLEAR', `批次 ${key} 已登记 intent 但未记录启动回执(发送状态不明),暂停核对后清理该条目再重试`)
      }
      if (existing.status === 'running') {
        if (!existing.evalRunId) {
          throw new PairedPlanError('SEND_STATE_UNCLEAR', `批次 ${key} 状态 running 但无 evalRunId(台账损坏),暂停核对`)
        }
        const state = service.getRun(existing.evalRunId)
        if (state === null) {
          throw new PairedPlanError('UNKNOWN_RUN', `未知 runId:${existing.evalRunId}(台账标记 running 但找不到状态文件),停止`)
        }
        if (state.status === 'running') {
          throw new PairedPlanError('SEND_STATE_UNCLEAR', `批次 ${key} 的 run ${existing.evalRunId} 仍标记 running(疑似崩溃残留),暂停核对`)
        }
        // 崩溃前 run 已到终态:按终态回填台账(reconcile)
        const outcome = settleBatch(batch, key, state, ledger, ledgerFile, collected, observedHashes, now, `run ${existing.evalRunId} 崩溃后对账`)
        if (outcome === 'cancelled') break
        continue
      }
    }

    // ---- 全新批次:登记 intent → 启动 → 记录 running ----
    ledger.batches[key] = {
      batchKey: key,
      datasetVersion: batch.datasetVersion,
      split: batch.split,
      globalRepeatIndex: batch.globalRepeatIndex,
      configId: batch.configId,
      pipelineVariant: batch.pipelineVariant,
      expectedCaseIdsSha256: expectedHash,
      status: 'intent',
      evalRunId: null,
      observedCasesSha256: null,
      bindings: [],
      startedAtUtc: null,
      finishedAtUtc: null,
      stopReason: null
    }
    persist()
    const startParams: EvalStartRequest = {
      datasetVersion: batch.datasetVersion,
      split: batch.split,
      executionKind: options.executionKind,
      configIds: [batch.configId],
      repeats: 1,
      maxCases: batch.expectedCaseIds.length,
      // dev 批次以显式清单执行;holdout 批次不传清单(服务端禁止挑选 holdout 子集)
      ...(batch.split === 'dev' ? { caseIds: [...batch.expectedCaseIds] } : {})
    }
    let evalRunId: string
    try {
      const started = service.startBatch(startParams)
      evalRunId = started.evalRunId
    } catch (err) {
      // startBatch 同步抛错 = 服务端在校验阶段拒绝,未创建 runner、未发送任何
      // 请求:回退 intent 条目后原样抛出(崩溃窗口与此不同:崩溃不会走本分支)
      delete ledger.batches[key]
      persist()
      throw err
    }
    ledger.batches[key] = {
      ...ledger.batches[key]!,
      status: 'running',
      evalRunId,
      startedAtUtc: now()
    }
    persist()

    // ---- 轮询到终态(取消经 cancelRun 协作停止) ----
    let cancelRequested = false
    let state: EvalRunState
    for (;;) {
      if (signal.aborted && !cancelRequested) {
        service.cancelRun(evalRunId)
        cancelRequested = true
      }
      const current = service.getRun(evalRunId)
      if (current === null) {
        ledger.batches[key] = { ...ledger.batches[key]!, status: 'failed', stopReason: 'run 状态文件消失(未知 runId)', finishedAtUtc: now() }
        persist()
        throw new PairedPlanError('UNKNOWN_RUN', `未知 runId:${evalRunId}(轮询期间状态文件消失),停止`)
      }
      if (current.status !== 'running') {
        state = current
        break
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }

    const outcome = settleBatch(batch, key, state, ledger, ledgerFile, collected, observedHashes, now, null)
    if (outcome === 'cancelled') break
  }
  return collected
}

/**
 * 终态回填:校验配置/数据 hash 与案例覆盖,生成 ResultBinding 并写台账。
 * 返回 'completed'(继续下一批)或 'cancelled'(停止,不领取下一批);
 * 停止条件抛 PairedPlanError。
 */
function settleBatch(
  batch: PairedBatch,
  key: string,
  state: EvalRunState,
  ledger: PairedLedger,
  ledgerFile: string,
  collected: ResultBinding[],
  observedHashes: Map<string, string>,
  now: () => string,
  context: string | null
): 'completed' | 'cancelled' {
  const fail = (reason: string, status: PairedLedgerBatchStatus, message: string): never => {
    ledger.batches[key] = { ...ledger.batches[key]!, status, stopReason: reason, finishedAtUtc: now() }
    writePairedLedger(ledgerFile, ledger)
    throw new PairedPlanError(reason, message)
  }
  // 配置漂移:run 的配置列表必须就是本批配置
  if (JSON.stringify(state.configIds) !== JSON.stringify([batch.configId])) {
    fail(
      'CONFIG_DRIFT',
      'failed',
      `批次 ${key} 的 run 配置为 [${state.configIds.join(', ')}],期望 [${batch.configId}](配置漂移),停止`
    )
  }
  // 数据 hash 漂移:同数据集跨批观测必须一致
  const prior = observedHashes.get(batch.datasetVersion)
  if (prior !== undefined && prior !== state.casesSha256) {
    fail(
      'DATA_DRIFT',
      'failed',
      `批次 ${key} 观测数据 hash ${state.casesSha256.slice(0, 12)}… 与先前 ${prior.slice(0, 12)}… 不一致(数据漂移),停止`
    )
  }
  observedHashes.set(batch.datasetVersion, state.casesSha256)

  if (state.status === 'cancelled' && state.stopReason === 'user_cancelled') {
    // 用户取消:已完成结果保留为绑定,未启动不补;不领取下一批
    const bindings = bindingsFromState(batch, state)
    assertNoDuplicateBindings(ledger, bindings)
    ledger.batches[key] = {
      ...ledger.batches[key]!,
      status: 'cancelled',
      observedCasesSha256: state.casesSha256,
      bindings: dedupeMerge(ledger.batches[key]!.bindings, bindings),
      finishedAtUtc: now(),
      stopReason: 'user_cancelled'
    }
    writePairedLedger(ledgerFile, ledger)
    collected.push(...bindings)
    return 'cancelled'
  }
  if (state.status !== 'completed') {
    // budget_exhausted / interrupted 等:批次不完整,停止并要求人工处置
    fail(
      'BATCH_INCOMPLETE',
      'failed',
      `批次 ${key} 未完整结束(status=${state.status}, stopReason=${state.stopReason ?? 'null'}${context ? `, ${context}` : ''}),停止`
    )
  }
  // completed:覆盖校验(预期案例全部有结果,物理 repeatIndex=0)
  const actual = new Set(state.results.map((r) => r.caseId))
  const missing = batch.expectedCaseIds.filter((id) => !actual.has(id))
  if (missing.length > 0) {
    fail('BATCH_INCOMPLETE', 'failed', `批次 ${key} 缺少预期案例结果:${missing.join(', ')}`)
  }
  for (const r of state.results) {
    if (r.status === 'not_run') {
      fail('BATCH_INCOMPLETE', 'failed', `批次 ${key} 标记 completed 但案例 ${r.caseId} 为 not_run`)
    }
    if (r.repeatIndex !== 0) {
      fail('PLAN_INVALID', 'failed', `批次 ${key} 出现物理 repeatIndex=${r.repeatIndex}(协调器固定 repeats=1,物理 repeatIndex 必须为 0)`)
    }
  }
  const bindings = bindingsFromState(batch, state)
  assertNoDuplicateBindings(ledger, bindings)
  ledger.batches[key] = {
    ...ledger.batches[key]!,
    status: 'completed',
    observedCasesSha256: state.casesSha256,
    bindings: dedupeMerge(ledger.batches[key]!.bindings, bindings),
    finishedAtUtc: now(),
    stopReason: null
  }
  writePairedLedger(ledgerFile, ledger)
  collected.push(...bindings)
  return 'completed'
}

/** 从 run 状态生成绑定(sha256 绑定结果行的关键内容;原始产物只读不写) */
function bindingsFromState(batch: PairedBatch, state: EvalRunState): ResultBinding[] {
  return state.results
    .filter((r) => r.status !== 'not_run')
    .map((r) => ({
      datasetVersion: batch.datasetVersion,
      configId: r.configId,
      caseId: r.caseId,
      globalRepeatIndex: batch.globalRepeatIndex,
      evalRunId: state.evalRunId,
      localRepeatIndex: r.repeatIndex,
      artifactDir: r.artifactDir ?? '',
      sha256: stableValueSha256({
        evalRunId: state.evalRunId,
        configId: r.configId,
        caseId: r.caseId,
        repeatIndex: r.repeatIndex,
        status: r.status,
        terminalStatus: r.terminalStatus,
        durationMs: r.durationMs ?? null,
        artifactDir: r.artifactDir ?? null
      })
    }))
}

/** 重复结果禁止覆盖:同全局键 (dataset, config, case, globalRepeat) 的绑定已存在即拒绝 */
function assertNoDuplicateBindings(ledger: PairedLedger, bindings: readonly ResultBinding[]): void {
  const owned = new Set<string>()
  for (const entry of Object.values(ledger.batches)) {
    for (const b of entry.bindings) owned.add(bindingKey(b))
  }
  for (const b of bindings) {
    if (owned.has(bindingKey(b))) {
      throw new PairedPlanError('DUPLICATE_RESULT', `重复结果禁止覆盖:${bindingKey(b)} 已有绑定(疑似重复归属)`)
    }
  }
}

function bindingKey(b: ResultBinding): string {
  return `${b.datasetVersion}|${b.configId}|${b.caseId}|g${b.globalRepeatIndex}`
}

/** 幂等合并:同键绑定(崩溃对账重复回填)不重复追加 */
function dedupeMerge(existing: readonly ResultBinding[], incoming: readonly ResultBinding[]): ResultBinding[] {
  const seen = new Set(existing.map(bindingKey))
  const out = [...existing]
  for (const b of incoming) {
    if (!seen.has(bindingKey(b))) {
      out.push(b)
      seen.add(bindingKey(b))
    }
  }
  return out
}

// ---------- 效果报告(汇总层) ----------

/** 报告输入:每个已完成/取消批次的 run 状态(由调用方经 service.getRun 取得) */
export interface PairedRunRecord {
  datasetVersion: string
  split: 'dev' | 'holdout'
  globalRepeatIndex: number
  pipelineVariant: 'baseline' | 'candidate'
  configId: string
  evalRunId: string
  state: EvalRunState
}

export interface PairedVariantSummary {
  pipelineVariant: 'baseline' | 'candidate'
  batches: number
  items: { total: number; passed: number; failed: number; notRun: number }
  /** 任务成功:passed / (passed+failed);零分母 null */
  taskSuccess: { value: number | null; denominator: number }
  /** 安全违规:确认绕过次数(必须为 0);null = 观测缺失未测 */
  safetyViolations: { confirmedBypass: number | null; attemptedWrites: number | null }
  /** 引用覆盖/正确性(research 判分;未知 null) */
  citation: {
    precision: number | null
    factCoverage: number | null
    recallMacro: number | null
    scoredCases: number
  }
  /** 不足处理:gold 判定应有不足的案例中被诚实识别的比例 */
  insufficiency: { expected: number; recognized: number; passRate: number | null }
  /** 延迟与分项:queue/approval 来源未接入,保持 null(不伪造) */
  latency: { p50Ms: number | null; p95Ms: number | null; n: number; smallSample: boolean }
  breakdown: {
    wallMs: number | null
    activeMs: number | null
    queueMs: number | null
    approvalMs: number | null
  }
  /** 请求与 token:usage 未知保持 null;fake 无请求为 0 */
  requests: { attempts: number | null; cases: number }
  tokens: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null }
  /** 费用:价格来源未接入,保持 null */
  cost: { currency: string | null; amount: number | null }
}

export interface PairedComparisonReport {
  schemaVersion: 1
  kind: 'eval-paired-report'
  generatedAtUtc: string
  mode: 'fake' | 'real'
  /** 示例/预检标注(fake 报告必须明确标注,不冒充真实模型能力) */
  note: string
  planSha256: string | null
  perDatasetSplit: Array<{
    datasetVersion: string
    split: 'dev' | 'holdout'
    baseline: PairedVariantSummary
    candidate: PairedVariantSummary
    /** 候选相对 baseline:仅描述性比较,小样本不宣称统计显著 */
    taskSuccessDelta: number | null
    verdict: 'candidate-better' | 'on-par' | 'candidate-worse' | 'insufficient-data'
    safetyRegressed: boolean | null
  }>
  /**
   * 三轮重复相关性(单列):同案例三次重复的一致性诊断。
   * 三次重复是同案例重复观测,不是三份独立数据,不得并入任务成功分母。
   */
  repeatAgreement: Array<{
    datasetVersion: string
    split: 'dev' | 'holdout'
    pipelineVariant: 'baseline' | 'candidate'
    casesWithAllRepeats: number
    meanPairwiseAgreement: number | null
    note: string
  }>
  batches: Array<{
    batchKey: string
    datasetVersion: string
    split: 'dev' | 'holdout'
    globalRepeatIndex: number
    pipelineVariant: 'baseline' | 'candidate'
    configId: string
    evalRunId: string
    status: string
    passed: number
    failed: number
    notRun: number
  }>
}

/** 汇总一组 run 记录为单变体摘要;未知/未测一律 null,不伪造 0(嵌套对象每次全新构造,不得共享) */
function summarizeVariant(variant: 'baseline' | 'candidate', runs: readonly PairedRunRecord[]): PairedVariantSummary {
  const summary: PairedVariantSummary = {
    pipelineVariant: variant,
    batches: runs.length,
    items: { total: 0, passed: 0, failed: 0, notRun: 0 },
    taskSuccess: { value: null, denominator: 0 },
    safetyViolations: { confirmedBypass: null, attemptedWrites: null },
    citation: { precision: null, factCoverage: null, recallMacro: null, scoredCases: 0 },
    insufficiency: { expected: 0, recognized: 0, passRate: null },
    latency: { p50Ms: null, p95Ms: null, n: 0, smallSample: true },
    breakdown: { wallMs: null, activeMs: null, queueMs: null, approvalMs: null },
    requests: { attempts: null, cases: 0 },
    tokens: { inputTokens: null, outputTokens: null, totalTokens: null },
    cost: { currency: null, amount: null }
  }
  summary.batches = runs.length
  const allResults = runs.flatMap((r) => r.state.results)
  summary.items.total = allResults.length
  summary.items.passed = allResults.filter((r) => r.status === 'passed').length
  summary.items.failed = allResults.filter((r) => r.status === 'failed').length
  summary.items.notRun = allResults.filter((r) => r.status === 'not_run').length
  const judged = summary.items.passed + summary.items.failed
  summary.taskSuccess = { value: judged > 0 ? summary.items.passed / judged : null, denominator: judged }

  // 安全违规与延迟:复用 metrics 的分母纪律(观测缺失 → null,不显示 0)
  const metrics = calculateMetrics({ results: allResults }, [])
  summary.safetyViolations = {
    confirmedBypass: metrics.confirmationBypass.count,
    attemptedWrites: metrics.confirmationBypass.attemptedWrites
  }
  summary.latency = {
    p50Ms: metrics.latency.p50Ms,
    p95Ms: metrics.latency.p95Ms,
    n: metrics.latency.n,
    smallSample: metrics.latency.smallSample
  }

  // 引用覆盖/正确性与不足处理:research gold 判分结果的池化汇总
  const scored = allResults.map((r) => r.researchScoring).filter((s): s is NonNullable<typeof s> => s !== null && s !== undefined)
  summary.citation.scoredCases = scored.length
  const validCitations = scored.reduce((sum, s) => sum + s.citationStructure.valid, 0)
  const totalCitations = scored.reduce((sum, s) => sum + s.citationStructure.total, 0)
  summary.citation.precision = totalCitations > 0 ? validCitations / totalCitations : null
  const coveredFacts = scored.reduce((sum, s) => sum + s.factCoverage.covered, 0)
  const totalFacts = scored.reduce((sum, s) => sum + s.factCoverage.total, 0)
  summary.citation.factCoverage = totalFacts > 0 ? coveredFacts / totalFacts : null
  const recalls = scored.map((s) => s.recallMacro).filter((v): v is number => typeof v === 'number')
  summary.citation.recallMacro = recalls.length > 0 ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null
  const insuffExpected = scored.filter((s) => s.insufficiency.expected)
  summary.insufficiency.expected = insuffExpected.length
  summary.insufficiency.recognized = insuffExpected.filter((s) => s.insufficiency.recognized).length
  summary.insufficiency.passRate =
    insuffExpected.length > 0 ? summary.insufficiency.recognized / insuffExpected.length : null

  // wall/active 分项:wall = 各批 finishedAt-startedAt 之和;active = durationMs 之和;
  // queue/approval 的观测来源未接入,保持 null(不伪造分项)
  let wallMs = 0
  let hasWall = false
  for (const run of runs) {
    if (run.state.finishedAt) {
      const ms = Date.parse(run.state.finishedAt) - Date.parse(run.state.startedAt)
      if (Number.isFinite(ms)) {
        wallMs += Math.max(0, ms)
        hasWall = true
      }
    }
  }
  const activeResults = allResults.filter((r) => typeof r.durationMs === 'number')
  summary.breakdown = {
    wallMs: hasWall ? wallMs : null,
    activeMs: activeResults.length > 0 ? activeResults.reduce((sum, r) => sum + (r.durationMs ?? 0), 0) : null,
    queueMs: null,
    approvalMs: null
  }

  // 请求与 token:逐 attempt 结算;usage 字段任一未知即整体保持 null
  const attempts = allResults.flatMap((r) => r.modelAttempts ?? [])
  const casesWithAttempts = allResults.filter((r) => Array.isArray(r.modelAttempts)).length
  summary.requests = { attempts: casesWithAttempts > 0 ? attempts.length : null, cases: casesWithAttempts }
  if (attempts.length > 0) {
    const inputTokens = attempts.map((a) => a.usage.inputTokens)
    const outputTokens = attempts.map((a) => a.usage.outputTokens)
    const totalTokens = attempts.map((a) => a.usage.totalTokens)
    summary.tokens = {
      inputTokens: inputTokens.every((v) => typeof v === 'number') ? inputTokens.reduce((a, b) => a + (b ?? 0), 0) : null,
      outputTokens: outputTokens.every((v) => typeof v === 'number') ? outputTokens.reduce((a, b) => a + (b ?? 0), 0) : null,
      totalTokens: totalTokens.every((v) => typeof v === 'number') ? totalTokens.reduce((a, b) => a + (b ?? 0), 0) : null
    }
  }
  return summary
}

/**
 * 三轮重复一致性(单列诊断):对每个 (数据集, split, variant),统计在全部
 * 三个全局重复中都有结果且已判分的案例,按 (1,2)/(1,3)/(2,3) 成对比较通过
 * 位的一致率。不是统计显著性,不并入任务成功分母。
 */
function repeatAgreementRows(runs: readonly PairedRunRecord[]): PairedComparisonReport['repeatAgreement'] {
  const groups = new Map<string, PairedRunRecord[]>()
  for (const run of runs) {
    const key = `${run.datasetVersion}|${run.split}|${run.pipelineVariant}`
    const list = groups.get(key) ?? []
    list.push(run)
    groups.set(key, list)
  }
  const rows: PairedComparisonReport['repeatAgreement'] = []
  for (const [key, group] of groups) {
    const [datasetVersion, split, pipelineVariant] = key.split('|') as [string, 'dev' | 'holdout', 'baseline' | 'candidate']
    const passBits = new Map<string, Map<number, boolean>>()
    for (const run of group) {
      for (const r of run.state.results) {
        if (r.status === 'not_run') continue
        const byRepeat = passBits.get(r.caseId) ?? new Map<number, boolean>()
        byRepeat.set(run.globalRepeatIndex, r.status === 'passed')
        passBits.set(r.caseId, byRepeat)
      }
    }
    let agreements: number[] = []
    let casesWithAllRepeats = 0
    for (const byRepeat of passBits.values()) {
      if (![1, 2, 3].every((g) => byRepeat.has(g))) continue
      casesWithAllRepeats += 1
      const pairs: Array<[number, number]> = [[1, 2], [1, 3], [2, 3]]
      for (const [a, b] of pairs) {
        agreements.push(byRepeat.get(a) === byRepeat.get(b) ? 1 : 0)
      }
    }
    const mean = agreements.length > 0 ? agreements.reduce((x, y) => x + y, 0) / agreements.length : null
    rows.push({
      datasetVersion,
      split,
      pipelineVariant,
      casesWithAllRepeats,
      meanPairwiseAgreement: mean,
      note: '三轮重复为同案例重复观测(非独立样本),仅作稳定性诊断;不足三轮的案例不参与。'
    })
    agreements = []
  }
  rows.sort((a, b) => `${a.datasetVersion}|${a.split}|${a.pipelineVariant}`.localeCompare(`${b.datasetVersion}|${b.split}|${b.pipelineVariant}`))
  return rows
}

/** 汇总成对实验效果报告:未知 token/价格/分项保持 null;不宣称统计显著 */
export function summarizePairedRuns(input: {
  runs: readonly PairedRunRecord[]
  mode: 'fake' | 'real'
  note?: string
  planSha256?: string | null
  generatedAtUtc?: string
}): PairedComparisonReport {
  const groups = new Map<string, PairedRunRecord[]>()
  for (const run of input.runs) {
    const key = `${run.datasetVersion}|${run.split}`
    const list = groups.get(key) ?? []
    list.push(run)
    groups.set(key, list)
  }
  const perDatasetSplit: PairedComparisonReport['perDatasetSplit'] = []
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [datasetVersion, split] = key.split('|') as [string, 'dev' | 'holdout']
    const baseline = summarizeVariant('baseline', group.filter((r) => r.pipelineVariant === 'baseline'))
    const candidate = summarizeVariant('candidate', group.filter((r) => r.pipelineVariant === 'candidate'))
    const delta =
      baseline.taskSuccess.value !== null && candidate.taskSuccess.value !== null
        ? candidate.taskSuccess.value - baseline.taskSuccess.value
        : null
    const verdict: PairedComparisonReport['perDatasetSplit'][number]['verdict'] =
      delta === null
        ? 'insufficient-data'
        : delta > 0
          ? 'candidate-better'
          : delta < 0
            ? 'candidate-worse'
            : 'on-par'
    // 安全回退:候选确认绕过次数大于 baseline(两侧均已测)→ 回退标记
    const safetyRegressed =
      baseline.safetyViolations.confirmedBypass !== null && candidate.safetyViolations.confirmedBypass !== null
        ? candidate.safetyViolations.confirmedBypass > baseline.safetyViolations.confirmedBypass
        : null
    perDatasetSplit.push({ datasetVersion, split, baseline, candidate, taskSuccessDelta: delta, verdict, safetyRegressed })
  }
  return {
    schemaVersion: 1,
    kind: 'eval-paired-report',
    generatedAtUtc: input.generatedAtUtc ?? new Date().toISOString(),
    mode: input.mode,
    note:
      input.note ??
      (input.mode === 'fake'
        ? 'fake 预检示例:结果来自离线 fake 流程,不代表真实模型能力。'
        : ''),
    planSha256: input.planSha256 ?? null,
    perDatasetSplit,
    repeatAgreement: repeatAgreementRows(input.runs),
    batches: input.runs.map((run) => ({
      batchKey: `${run.datasetVersion}|${run.split}|g${run.globalRepeatIndex}|${run.pipelineVariant}`,
      datasetVersion: run.datasetVersion,
      split: run.split,
      globalRepeatIndex: run.globalRepeatIndex,
      pipelineVariant: run.pipelineVariant,
      configId: run.configId,
      evalRunId: run.evalRunId,
      status: run.state.status,
      passed: run.state.results.filter((r) => r.status === 'passed').length,
      failed: run.state.results.filter((r) => r.status === 'failed').length,
      notRun: run.state.results.filter((r) => r.status === 'not_run').length
    }))
  }
}

/** 效果报告 Markdown 渲染(人工阅读出口;JSON 为机器出口) */
export function renderPairedReport(report: PairedComparisonReport): string {
  const lines: string[] = []
  lines.push(`# 成对实验效果报告(${report.mode === 'fake' ? 'FAKE 预检示例' : 'REAL'})`)
  lines.push('')
  lines.push(`- 生成时间(UTC):${report.generatedAtUtc}`)
  if (report.note) lines.push(`- 标注:${report.note}`)
  if (report.planSha256) lines.push(`- 计划 hash:${report.planSha256}`)
  lines.push('- 口径:小样本描述性比较,不宣称统计显著;未知 token/价格/分项保持 null。')
  lines.push('')
  for (const group of report.perDatasetSplit) {
    lines.push(`## ${group.datasetVersion} / ${group.split}`)
    lines.push('')
    for (const variant of ['baseline', 'candidate'] as const) {
      const s = group[variant]
      lines.push(
        `- **${variant}**(${s.pipelineVariant}):任务成功 ${fmtPct(s.taskSuccess.value)}(${s.items.passed}/${s.taskSuccess.denominator} 已判分;not_run ${s.items.notRun});` +
          `安全绕过 ${s.safetyViolations.confirmedBypass ?? '未测'}(尝试写 ${s.safetyViolations.attemptedWrites ?? '未测'});` +
          `引用结构有效率 ${fmtPct(s.citation.precision)};事实覆盖 ${fmtPct(s.citation.factCoverage)};Recall 宏平均 ${fmtPct(s.citation.recallMacro)}(判分 ${s.citation.scoredCases} 例);` +
          `不足识别 ${s.insufficiency.recognized}/${s.insufficiency.expected}${s.insufficiency.passRate === null ? '' : `(${fmtPct(s.insufficiency.passRate)})`};` +
          `延迟 p50=${s.latency.p50Ms ?? 'null'}ms / p95=${s.latency.p95Ms ?? 'null'}ms(n=${s.latency.n}${s.latency.smallSample ? ',小样本' : ''});` +
          `wall=${s.breakdown.wallMs ?? 'null'}ms / active=${s.breakdown.activeMs ?? 'null'}ms / queue=${s.breakdown.queueMs ?? 'null'}ms / approval=${s.breakdown.approvalMs ?? 'null'}ms;` +
          `请求 ${s.requests.attempts ?? 'null'} 次;token in/out/total=${s.tokens.inputTokens ?? 'null'}/${s.tokens.outputTokens ?? 'null'}/${s.tokens.totalTokens ?? 'null'};` +
          `费用=${s.cost.amount ?? 'null'}${s.cost.currency ?? ''}`
      )
    }
    lines.push(
      `- 比较:任务成功差值(candidate − baseline)= ${group.taskSuccessDelta === null ? 'null(分母不足)' : group.taskSuccessDelta.toFixed(4)};` +
        `判定 ${group.verdict};安全回退 ${group.safetyRegressed === null ? '未测' : group.safetyRegressed ? '是(保留 baseline)' : '否'}。`
    )
    lines.push('')
  }
  lines.push('## 三轮重复一致性(单列诊断,非独立样本)')
  lines.push('')
  for (const row of report.repeatAgreement) {
    lines.push(
      `- ${row.datasetVersion}/${row.split}/${row.pipelineVariant}:三轮齐全案例 ${row.casesWithAllRepeats},成对一致率 ${row.meanPairwiseAgreement === null ? 'null(不足三轮)' : row.meanPairwiseAgreement.toFixed(4)}。${row.note}`
    )
  }
  lines.push('')
  lines.push('## 批次清单')
  lines.push('')
  lines.push('| 批次键 | configId | evalRunId | 状态 | passed | failed | not_run |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const b of report.batches) {
    lines.push(`| ${b.batchKey} | ${b.configId} | ${b.evalRunId} | ${b.status} | ${b.passed} | ${b.failed} | ${b.notRun} |`)
  }
  lines.push('')
  return lines.join('\n')
}

function fmtPct(value: number | null): string {
  return value === null ? 'null' : value.toFixed(4)
}
