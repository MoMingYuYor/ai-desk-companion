// 评测 IPC 服务层(EVAL-05 重写,F-08 修复):数据集发现、批次启动、取消、
// 只读查询、case 产物查询、配置发现、人工审阅读写与报告生成。
//
// 与旧版(E-07 过渡形态)的差异:
// - EvalsDeps 消费 EvalResourcePaths 路径对象(只读 datasetRoot/fixtureRoot 与
//   可写 artifactRoot/configRoot/reviewRoot 拆开),不再把读写都压在 evalsRoot,
//   也不再用 process.cwd() 推导 fixture 路径(researchAdapter 经
//   setResearchFixtureRoot 注入);
// - 数据集缓存键 = 绝对数据根 + 版本 + cases_sha256 + manifest 内容 hash:
//   不同资源根的同名版本不会共享错误缓存,数据文件改动后缓存自动失效;
// - start 请求扩展 datasetVersion/split/executionKind/configIds/repeats/maxCases;
//   服务端校验配置冻结(configStore 加载 + hash 比对)、数据 hash、预算与最大
//   启动数量;请求契约不含任何自动批准标志——批准脚本只来自数据集
//   interaction_script,且仅由隔离 runner 读取;
// - 管理正在运行的 runner(取消、并发上限);缺资源显示具体路径错误,
//   不静默返回空数据集掩盖打包问题。
//
// 本模块与其依赖(runner/dataset/configStore/reviewStore/artifacts/…)不导入
// Electron,桌面 IPC、CLI 与纯 Node 测试共用同一服务层。

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadDatasetFromText, type LoadedDataset } from './dataset'
import { EvalRunner, type BeforeClaimHook, type EvalRunState, type ExecutionKind } from './runner'
import { calculateMetrics } from './metrics'
import { renderEvalReport } from './report'
import { appError } from '../../shared/operations'
import { OperationError } from '../db/operations'
import type { EvalResourcePaths } from './resources'
import { setResearchFixtureRoot } from './researchAdapter'
import {
  ArtifactPathError,
  caseArtifactDir,
  defaultCodeVersion,
  loadCaseArtifacts,
  verifyCaseArtifacts,
  safeSegment
} from './artifacts'
import {
  findFrozenConfig,
  frozenConfigSha256,
  listFrozenConfigIds,
  loadFrozenConfig,
  saveFrozenConfig,
  type FrozenEvalConfig
} from './configStore'
import {
  createEvalCompleterFactory,
  loadPromptTemplateManifest,
  type EvalCompleterFactory,
  type PromptTemplateManifest
} from './completerFactory'
import {
  enumerateClaimEvidenceSubjects,
  parseReviewSubjectKey,
  reviewSubjectKey,
  FileReviewStore,
  NO_EVIDENCE_SEGMENT,
  reviewHoldoutStatus
} from './reviewStore'
import type { ReviewAnnotation, ReviewDecision } from './reviews'
import type { EvalFreezeVersions, FreezeInput } from '../../shared/evals'
import type { RealCompleterFor } from './realAdapter'
import { freezeExperiment, validateFrozenExperiment, type FrozenExperimentPair } from './freeze'
import {
  expandExperimentItems,
  maximumRequestCount,
  selectExplicitSmokeCases,
  type ExperimentConfigRef
} from './experiment'
import {
  appendApprovalIntent,
  assertNoUnclearApprovalIntents,
  approvedRequestCountFor,
  authorizationReleaseFile,
  PreflightError,
  updateApprovalIntent,
  validateRealPreflight,
  type ApprovalIntentRecord
} from './realPreflight'

// ---------- 依赖契约 ----------

export interface EvalsDeps {
  /** 评测资源路径(组合入口经 resolveEvalPaths 构造;CLI/desktop 各自注入) */
  paths: EvalResourcePaths
  /** sql.js 的 dist 目录(隔离案例临时库;desktop 由 index.ts 按打包态解析) */
  sqlJsDistDir: string
  /**
   * real 执行的底层补全适配器(RES-01 组合入口注入);缺省时服务端拒绝 real 启动
   * (fake 离线运行不受影响)。
   */
  realCompleterFor?: RealCompleterFor
  versionsOf?: () => EvalFreezeVersions
  /**
   * 运行时凭据解析门(providerId → 凭据是否可解析):desktop 查凭据库,
   * CLI 只认环境变量 AI_DESK_EVAL_API_KEY。凭据绝不落盘。
   */
  credentialOf?: (providerId: string) => string | null
}

/** 启动请求契约:渲染层不传、服务端也不接收任何自动批准标志 */
export interface EvalStartRequest {
  datasetVersion: string
  split: 'dev' | 'holdout'
  executionKind: ExecutionKind
  configIds: string[]
  repeats: number
  maxCases: number
  caseIds?: string[]
  /**
   * EVAL-02 真实启动门:real 执行必须提供授权文件(其 releaseFile 字段定位
   * 数据 release);fake 不要求。缺省或文件无效在服务层确定性拒绝——CLI 与
   * 桌面调用经过同一道门。授权文件无密钥,密钥只经进程内凭据注入。
   */
  approval?: {
    authorizationFile: string
    /** 可选显式定位;与授权文件内绑定的 releaseFile 不一致即拒绝 */
    releaseFile?: string
  }
}

/** 服务端启动上限(渲染层输入不可信,预算与数量在此收口) */
export const EVAL_START_LIMITS = {
  /** 同时运行的评测批次上限 */
  maxConcurrentBatches: 3,
  maxRepeats: 10,
  /** 单批最大启动案例数(两套数据集全集 540 组合为物理上限) */
  maxCases: 540
} as const

/** 数据集概览(发现接口返回形态) */
export interface EvalDatasetSummary {
  version: string
  total: number
  dev: number
  holdout: number
}

/** 冻结配置的发现形态(不含任何凭据) */
export interface EvalConfigSummary {
  configId: string
  executionKind: ExecutionKind
  pipelineVariant: string
  model: string
  providerId: string
  rubricVersion: string
}

// ---------- 数据集加载与缓存(键含绝对数据根 + 版本 + hash) ----------

const datasetCache = new Map<string, LoadedDataset>()
/** 缓存上限:数据集文件被改动会产生新键,防止无界增长 */
const DATASET_CACHE_MAX = 8

function validationError(message: string): OperationError {
  return new OperationError(appError('VALIDATION', message, { retryable: false }))
}

function sha256OfText(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

/**
 * 从指定数据根加载并校验数据集。缓存键包含绝对数据根、版本、manifest 声明的
 * cases_sha256 与 manifest 文件内容 hash——不同资源根的同名版本互不共享缓存,
 * 数据或 manifest 改动后自然失效。缺资源抛出带具体路径的错误,不静默返回空。
 */
export function loadEvalsDataset(datasetRoot: string, version: string): LoadedDataset {
  safeSegment('datasetVersion', version)
  const dir = join(datasetRoot, version)
  const casesFile = join(dir, 'cases.jsonl')
  const manifestFile = join(dir, 'manifest.json')
  if (!existsSync(casesFile) || !existsSync(manifestFile)) {
    throw validationError(
      `评测数据集不存在:${version}(已查找 ${casesFile} 与 ${manifestFile};请检查数据集资源是否已部署到该根目录)`
    )
  }
  let manifestRaw: string
  try {
    manifestRaw = readFileSync(manifestFile, 'utf-8')
  } catch (err) {
    throw validationError(`评测数据集 manifest 不可读:${manifestFile}:${err instanceof Error ? err.message : String(err)}`)
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(manifestRaw)
  } catch (err) {
    throw validationError(`评测数据集 manifest 损坏:${manifestFile}:${err instanceof Error ? err.message : String(err)}`)
  }
  const declaredHash = (manifest as { cases_sha256?: unknown } | null)?.cases_sha256
  if (typeof declaredHash !== 'string') {
    throw validationError(`评测数据集 manifest 缺少 cases_sha256:${manifestFile}`)
  }
  let jsonl: string
  try {
    jsonl = readFileSync(casesFile, 'utf-8')
  } catch (err) {
    throw validationError(`评测数据集 cases 不可读:${casesFile}:${err instanceof Error ? err.message : String(err)}`)
  }
  const key = `${datasetRoot}|${version}|${declaredHash}|${sha256OfText(manifestRaw)}|${sha256OfText(jsonl)}`
  const cached = datasetCache.get(key)
  if (cached) return cached
  let dataset: LoadedDataset
  try {
    dataset = loadDatasetFromText(jsonl, manifest)
  } catch (err) {
    throw validationError(`评测数据集校验失败:${dir}:${err instanceof Error ? err.message : String(err)}`)
  }
  if (datasetCache.size >= DATASET_CACHE_MAX) {
    const oldest = datasetCache.keys().next().value
    if (oldest !== undefined) datasetCache.delete(oldest)
  }
  datasetCache.set(key, dataset)
  return dataset
}

// ---------- 冻结 hash 工具(fake-flow-v1 自动注册使用) ----------

function stableSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf-8').digest('hex')
}


/**
 * fixture 冻结 hash:引用的 fixture_id 全集 + 磁盘语料内容 hash 的稳定序列化。
 * 磁盘上存在的 fixture(研究语料)按目录名+文件名+内容 hash 参与;
 * 代码内置的 ops fixture(不在磁盘)以 id 固定进 hash(其行为由
 * toolsVersion/codeCommit 冻结字段承载)。研究语料目录缺失仍显式报错。
 * (导出:EVAL-02 真实启动预检与授权 dataScope 绑定使用同一口径。)
 */
export function fixtureCorpusSha256(fixtureRoot: string, fixtureIds: readonly string[]): string {
  const entries: Array<{ fixture: string; corpus: Array<{ name: string; sha256: string }> | null }> = []
  for (const fixtureId of [...fixtureIds].sort()) {
    const dir = join(fixtureRoot, fixtureId)
    if (!existsSync(dir)) {
      // 内置 fixture(代码定义)没有磁盘目录:只按 id 固定
      entries.push({ fixture: fixtureId, corpus: null })
      continue
    }
    const files = readdirSync(dir).sort().map((name) => ({
      name,
      sha256: sha256OfText(readFileSync(join(dir, name), 'utf-8'))
    }))
    if (files.length === 0) {
      throw validationError(`研究 fixture 语料目录为空:${dir}(fixtureRoot=${fixtureRoot})`)
    }
    entries.push({ fixture: fixtureId, corpus: files })
  }
  const hash = stableSha256(entries)
  return hash
}

/** 数据集冻结 hash 组(预算脚本 / 交互脚本 / fixture 语料,稳定序列化) */
function datasetFreezeHashes(
  dataset: LoadedDataset,
  fixtureRoot: string
): { fixtureSha256: string; budgetSha256: string; interactionScriptSha256: string } {
  const sorted = [...dataset.cases].sort((a, b) => (a.case_id < b.case_id ? -1 : 1))
  return {
    budgetSha256: stableSha256(sorted.map((c) => ({ case_id: c.case_id, budgets: c.budgets }))),
    interactionScriptSha256: stableSha256(
      sorted.map((c) => ({ case_id: c.case_id, script: c.interaction_script }))
    ),
    fixtureSha256: fixtureCorpusSha256(
      fixtureRoot,
      [...new Set(dataset.cases.map((c) => c.fixture_id))]
    )
  }
}

// ---------- fake-flow-v1 自动注册并冻结(EVAL-05) ----------

/** 唯一允许由服务端自动注册的冻结配置(fake 离线流程验证) */
export const AUTO_FAKE_CONFIG_ID = 'fake-flow-v1'

const AUTO_FAKE_STAGE_MARKER = '你是个人事务助手的规划器'

function atomicWriteText(file: string, data: string): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, data, 'utf-8')
  renameSync(tmp, file)
}

/**
 * 自动注册并冻结 fake-flow-v1:同 ID 已冻结则幂等跳过(内容不漂移)。
 * 模板写入可写模板目录 <configRoot>/templates 并登记 manifest——只读资源目录
 * (evals/prompts)保持冻结,运行时不改写。
 */
function ensureAutoFakeConfig(configRoot: string, dataset: LoadedDataset, fixtureRoot: string): void {
  if (findFrozenConfig(configRoot, AUTO_FAKE_CONFIG_ID)) return
  const templateRoot = join(configRoot, 'templates')
  mkdirSync(templateRoot, { recursive: true })
  const templateName = `${AUTO_FAKE_CONFIG_ID}.txt`
  const templateFile = join(templateRoot, templateName)
  const templateContent =
    '你是个人事务助手的规划器。fake-flow-v1 冻结流程模板:本配置只用于离线 fake 流程验证,不携带真实模型提示词。'
  atomicWriteText(templateFile, templateContent)
  const manifestFile = join(templateRoot, 'manifest.json')
  const manifest: PromptTemplateManifest = existsSync(manifestFile)
    ? loadPromptTemplateManifest(templateRoot)
    : { schemaVersion: 1, configs: {} }
  manifest.configs[AUTO_FAKE_CONFIG_ID] = { template: templateName, stageMarker: AUTO_FAKE_STAGE_MARKER }
  atomicWriteText(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
  const hashes = datasetFreezeHashes(dataset, fixtureRoot)
  const config: FrozenEvalConfig = {
    schemaVersion: 1,
    configId: AUTO_FAKE_CONFIG_ID,
    executionKind: 'fake',
    model: 'fake-model',
    providerId: 'eval-fake',
    pipelineVariant: 'baseline',
    promptSha256: sha256OfText(templateContent),
    toolsVersion: defaultCodeVersion(),
    codeCommit: 'unknown',
    datasetSha256: dataset.casesSha256,
    fixtureSha256: hashes.fixtureSha256,
    budgetSha256: hashes.budgetSha256,
    interactionScriptSha256: hashes.interactionScriptSha256,
    rubricVersion: 'rubric-v1'
  }
  saveFrozenConfig(configRoot, config)
}

// ---------- 服务 ----------

/** 人工审阅提交契约(渲染层可见;服务端重组 subjectKey 并校验) */
export interface EvalReviewInput {
  evalRunId: string
  configId: string
  caseId: string
  repeatIndex: number
  claimId: string
  /** 引用的证据 ID;无引用传空串(归一为 NO_EVIDENCE_SEGMENT) */
  evidenceId: string
  decision: ReviewDecision
  reason: string
  reviewer: string
  rubricVersion?: string
}

/** 审阅总览(未审对象显式可见;coverage 不足 100% 即 holdout 未完成) */
export interface EvalReviewOverview {
  evalRunId: string
  subjects: Array<{
    subjectKey: string
    configId: string
    caseId: string
    repeatIndex: number
    claimId: string
    evidenceId: string
    latest: ReviewAnnotation | null
  }>
  coverage: { value: number | null; reviewed: number; expected: number }
  supportPrecision: { value: number | null; reviewed: number; supported: number }
  holdoutComplete: boolean
  unreviewed: string[]
}

/** case 产物查询结果(完整性校验失败时 ok=false 并给出原因,不抛异常) */
export interface EvalCaseArtifactsResult {
  ok: boolean
  manifest: Record<string, unknown> | null
  manifestError: string | null
  mismatched: string[]
  missing: string[]
  artifacts: ReturnType<typeof loadCaseArtifacts> | null
}

export class EvalsService {
  private readonly running = new Map<string, EvalRunner>()
  private reviewStore: FileReviewStore | null = null

  constructor(private readonly deps: EvalsDeps) {}

  get paths(): EvalResourcePaths {
    return this.deps.paths
  }

  // ---- 数据集与配置发现(缺资源显式报错,不静默返回空) ----

  listDatasets(): EvalDatasetSummary[] {
    const root = this.deps.paths.datasetRoot
    if (!existsSync(root)) {
      throw validationError(
        `评测数据集根目录不存在:${root}(打包资源缺失或路径未接线,不静默返回空清单)`
      )
    }
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
    if (dirs.length === 0) {
      throw validationError(`评测数据集根目录为空:${root}(资源部署不完整,拒绝掩盖)`)
    }
    return dirs.map((name) => {
      const dataset = loadEvalsDataset(root, name)
      return {
        version: dataset.manifest.dataset_version,
        total: dataset.cases.length,
        dev: dataset.dev.length,
        holdout: dataset.holdout.length
      }
    })
  }

  /** 配置发现:枚举冻结配置;损坏/被篡改的配置抛错(数据问题必须显式暴露) */
  listConfigs(): EvalConfigSummary[] {
    const root = this.deps.paths.configRoot
    return listFrozenConfigIds(root).map((configId) => {
      const config = loadFrozenConfig(root, configId)
      return {
        configId: config.configId,
        executionKind: config.executionKind,
        pipelineVariant: config.pipelineVariant,
        model: config.model,
        providerId: config.providerId,
        rubricVersion: config.rubricVersion
      }
    })
  }

  freeze(input: FreezeInput): FrozenExperimentPair {
    const versions = this.deps.versionsOf?.()
    if (!versions) throw validationError('冻结需要明确的当前代码版本')
    return freezeExperiment(this.deps.paths, input, versions)
  }

  private validateExperiment(configId: string) {
    const versions = this.deps.versionsOf?.()
    if (!versions) throw validationError('新实验启动需要明确的当前代码版本')
    return validateFrozenExperiment(this.deps.paths, configId, versions)
  }

  // ---- 批次启动与取消 ----

  /**
   * 启动评测批次:服务端校验(数据集存在、配置冻结与执行类型/数据 hash 一致、
   * 凭据门、预算与数量上限)通过后创建 runner 并异步执行。调用方立即拿到
   * evalRunId,状态经 getRun 轮询。
   */
  startBatch(
    params: EvalStartRequest,
    hooks?: { beforeClaim?: BeforeClaimHook }
  ): { evalRunId: string; status: string } {
    // 并发上限:正在运行的批次达到上限即拒绝(收口启动数量)
    if (this.running.size >= EVAL_START_LIMITS.maxConcurrentBatches) {
      throw new OperationError(
        appError('CONFLICT', `评测批次并发上限已达 ${EVAL_START_LIMITS.maxConcurrentBatches},请等待或取消现有批次`, { retryable: true })
      )
    }
    const { datasetRoot, configRoot, fixtureRoot, artifactRoot } = this.deps.paths
    // 1) 廉价参数先行:执行类型与预算/数量上限(不产生任何写入)
    if (params.executionKind !== 'fake' && params.executionKind !== 'real') {
      throw validationError(`executionKind 非法:${String(params.executionKind)}(只允许 fake | real)`)
    }
    if (!Number.isInteger(params.repeats) || params.repeats < 1 || params.repeats > EVAL_START_LIMITS.maxRepeats) {
      throw validationError(`repeats 必须是 1~${EVAL_START_LIMITS.maxRepeats} 的整数,收到 ${String(params.repeats)}`)
    }
    if (!Number.isInteger(params.maxCases) || params.maxCases < 1 || params.maxCases > EVAL_START_LIMITS.maxCases) {
      throw validationError(`maxCases 必须是 1~${EVAL_START_LIMITS.maxCases} 的整数,收到 ${String(params.maxCases)}`)
    }
    // 2) 数据集:缺失/损坏给出具体路径
    const dataset = loadEvalsDataset(datasetRoot, params.datasetVersion)
    if (params.caseIds !== undefined) {
      if (params.split !== 'dev') throw validationError('显式 smoke 清单仅允许 dev')
      selectExplicitSmokeCases(dataset.cases, params.caseIds)
    }
    // 3) 配置冻结校验
    if (!Array.isArray(params.configIds) || params.configIds.length === 0) {
      throw validationError('至少选择一个冻结配置')
    }
    if (new Set(params.configIds).size !== params.configIds.length) {
      throw validationError('配置列表存在重复 configId')
    }
    // fake-flow-v1 是唯一允许自动注册的配置:服务端冻结,渲染层不能注入任意配置
    if (params.executionKind === 'fake' && params.configIds.includes(AUTO_FAKE_CONFIG_ID)) {
      ensureAutoFakeConfig(configRoot, dataset, fixtureRoot)
    }
    const configs = params.configIds.map((configId) => {
      const config = findFrozenConfig(configRoot, configId)
      if (!config) {
        throw validationError(`冻结配置不存在:${configId}(期望 ${join(configRoot, `${configId}.json`)})`)
      }
      if (config.executionKind !== params.executionKind) {
        throw validationError(
          `配置 ${configId} 冻结 executionKind=${config.executionKind},与请求 executionKind=${params.executionKind} 不一致(fake/real 不可混跑)`
        )
      }
      if (config.datasetSha256 !== dataset.casesSha256) {
        throw validationError(
          `配置 ${configId} 冻结的数据 hash 与当前数据集不一致(数据已更新或配置冻结于其他数据版本):配置 ${config.datasetSha256.slice(0, 12)}… ≠ 数据集 ${dataset.casesSha256.slice(0, 12)}…`
        )
      }
      return config
    })
    // 3) real:底层适配器与运行时凭据门(凭据只在运行时解析,绝不落盘)
    if (params.executionKind === 'real') {
      if (!this.deps.realCompleterFor) {
        throw validationError('real 执行需要注入真实补全适配器(RES-01);当前服务仅支持 fake 离线运行')
      }
      for (const config of configs) {
        const credential = this.deps.credentialOf?.(config.providerId) ?? null
        if (credential === null || credential.trim() === '') {
          throw validationError(
            `real 配置 ${config.configId} 的凭据引用无法在运行时解析:providerId=${config.providerId}`
          )
        }
      }
    }
    for (const config of configs) {
      if (config.schemaVersion === 2) this.validateExperiment(config.configId)
      else if (params.executionKind === 'real') throw validationError('real 新实验需要 schema 2 和冻结 target')
    }
    // 3.5) EVAL-02 真实启动门(EvalsService 层,CLI 与桌面同门):预检全部
    //      拒绝路径都在创建 runner / 发送任何请求之前失败;fake 不走本门,
    //      保留上方的数据 hash 一致性检查。
    interface RegisteredApproval {
      intentId: string
      authorizationId: string
      authorizationSha256: string
      maximumRequests: number
    }
    let approval: RegisteredApproval | null = null
    if (params.executionKind === 'real') {
      if (!params.approval?.authorizationFile) {
        throw validationError(
          'real 执行需要授权文件(startBatch approval.authorizationFile,其 releaseFile 字段定位数据 release;CLI 传 --approval-file;桌面同门,不提供即拒绝)'
        )
      }
      const providerIds = new Set(configs.map((c) => c.providerId))
      if (providerIds.size !== 1) {
        throw validationError(
          `real 一次批次只允许单一 providerId(凭据按 providerId 精确绑定),收到:${[...providerIds].join(', ')}`
        )
      }
      const rubricVersions = new Set(configs.map((c) => c.rubricVersion))
      if (rubricVersions.size !== 1) {
        throw validationError(`real 批次配置的 rubricVersion 必须一致,收到:${[...rubricVersions].join(', ')}`)
      }
      const targetSha256s = new Set(configs.map((c) => c.targetSha256 ?? ''))
      if (targetSha256s.size !== 1 || targetSha256s.has('')) {
        throw validationError('real 批次配置必须共享同一冻结 targetSha256(schema 2)')
      }
      try {
        // 请求数上限以 maximumRequestCount 按实际案例预算现算(默认预算 6 的
        // 全量算术上界 3276 仅为参照;现算值随 budgets 与 case 清单变化)
        const selectedCases =
          params.caseIds !== undefined
            ? selectExplicitSmokeCases(dataset.cases, params.caseIds)
            : dataset.cases.filter((c) => c.split === params.split)
        const configRefs: ExperimentConfigRef[] = configs.map((c) => ({
          configId: c.configId,
          pipelineVariant: c.pipelineVariant
        }))
        const expectedItems = expandExperimentItems(selectedCases, configRefs, params.repeats)
        const maximumRequests = maximumRequestCount(expectedItems)
        const preflight = validateRealPreflight({
          releaseFile: params.approval.releaseFile ?? authorizationReleaseFile(params.approval.authorizationFile),
          authorizationFile: params.approval.authorizationFile,
          datasetVersion: params.datasetVersion,
          datasetSha256: dataset.casesSha256,
          fixtureSha256: fixtureCorpusSha256(fixtureRoot, [...new Set(dataset.cases.map((c) => c.fixture_id))]),
          rubricVersion: configs[0]!.rubricVersion,
          configHashes: Object.fromEntries(configs.map((c) => [c.configId, frozenConfigSha256(c)])),
          targetSha256: configs[0]!.targetSha256!,
          expectedItems,
          maximumRequests,
          nowUtc: new Date().toISOString(),
          splits: [params.split],
          // 凭据门:credentialOf 已在上面解析过全部配置的 providerId
          credentialProviderId: configs[0]!.providerId
        })
        // 授权批次台账:已批准次数累计不重置;发送状态不明(launching)即暂停核对
        assertNoUnclearApprovalIntents(artifactRoot, preflight.authorizationId)
        const approvedSoFar = approvedRequestCountFor(artifactRoot, preflight.authorizationId)
        if (approvedSoFar + preflight.maximumRequests > preflight.authorization.maxRequests) {
          throw new PreflightError(
            'REQUEST_BUDGET_EXCEEDED',
            `授权 ${preflight.authorizationId} 请求数累计超限:已批准 ${approvedSoFar} + 本次 ${preflight.maximumRequests} > 授权上限 ${preflight.authorization.maxRequests}`
          )
        }
        approval = {
          intentId: `intent-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
          authorizationId: preflight.authorizationId,
          authorizationSha256: preflight.authorizationSha256,
          maximumRequests: preflight.maximumRequests
        }
        console.error(
          `[evals] 真实启动预检通过:authorization=${preflight.authorizationId} maximumRequests=${preflight.maximumRequests} releases=${params.approval.authorizationFile}`
        )
      } catch (err) {
        if (err instanceof PreflightError) {
          throw validationError(`真实启动预检拒绝(${err.code}):${err.message}`)
        }
        throw err
      }
    }
    // 4) fixture 语料根注入:case 执行器不再从 cwd 推导(打包/CLI 关键)
    setResearchFixtureRoot(fixtureRoot)

    const evalRunId = `eval-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    if (approval !== null) {
      // 先登记 intent(launching)再创建 runner:崩溃后该状态即发送状态不明,
      // 后续真实启动会被 assertNoUnclearApprovalIntents 暂停,直到人工核对
      const nowUtc = new Date().toISOString()
      const record: ApprovalIntentRecord = {
        intentId: approval.intentId,
        authorizationId: approval.authorizationId,
        authorizationSha256: approval.authorizationSha256,
        evalRunId,
        datasetVersion: params.datasetVersion,
        split: params.split,
        configIds: [...params.configIds],
        maximumRequests: approval.maximumRequests,
        state: 'launching',
        registeredAtUtc: nowUtc,
        updatedAtUtc: nowUtc,
        finishedAtUtc: null
      }
      appendApprovalIntent(artifactRoot, record)
    }
    const runner = new EvalRunner(
      {
        artifactRoot,
        sqlJsDistDir: this.deps.sqlJsDistDir,
        dataset,
        completerFactory: this.completerFactory(),
        // EVAL-03 契约:research gold 标注从 <datasetRoot>/<datasetVersion>/annotations
        // 读取(runner.goldFor 与 researchIntegration 同一口径;传版本目录,不传父根)
        datasetRoot: join(datasetRoot, dataset.manifest.dataset_version),
        // 领取前控制点(IPC 不传;测试注入确定性取消时机)
        beforeClaim: hooks?.beforeClaim
      },
      {
        evalRunId,
        datasetVersion: dataset.manifest.dataset_version,
        casesSha256: dataset.casesSha256,
        splits: [params.split],
        configIds: [...params.configIds],
        executionKind: params.executionKind,
        repeats: params.repeats,
        maxCases: params.maxCases,
        ...(params.caseIds === undefined ? {} : { caseIds: [...params.caseIds] }),
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        results: []
      }
    )
    this.running.set(evalRunId, runner)
    if (approval !== null) {
      // runner 已创建并即将调度:确认启动(launching → running)。
      // run() 的同步段不发送任何请求,此更新必然先于第一次真实发送落盘。
      updateApprovalIntent(artifactRoot, approval.intentId, {
        state: 'running',
        updatedAtUtc: new Date().toISOString()
      })
    }
    void runner
      .run()
      .then((state) => {
        console.error(
          `[evals] 批次结束:${state.evalRunId} status=${state.status}${state.stopReason ? ` stopReason=${state.stopReason}` : ''} results=${state.results.length}`
        )
      })
      .catch((err: unknown) => {
        console.error('[evals] 批次异常:', err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        this.running.delete(evalRunId)
        if (approval !== null) {
          try {
            updateApprovalIntent(artifactRoot, approval.intentId, {
              state: 'finished',
              updatedAtUtc: new Date().toISOString(),
              finishedAtUtc: new Date().toISOString()
            })
          } catch (err) {
            console.error('[evals] 授权 intent 收尾更新失败:', err instanceof Error ? err.message : String(err))
          }
        }
      })
    return { evalRunId, status: 'running' }
  }

  /** 补全工厂:按冻结配置创建;模板目录在可写配置根的 templates/ 下 */
  private completerFactory(): EvalCompleterFactory {
    return createEvalCompleterFactory({
      configRoot: this.deps.paths.configRoot,
      templateRoot: join(this.deps.paths.configRoot, 'templates'),
      realCompleterFor: this.deps.realCompleterFor,
      targetOf: configId => this.validateExperiment(configId).target,
      credentialOf: this.deps.credentialOf
    })
  }

  /** 取消:停止领取新组合,正在执行的案例协作停止;已完成结果保留 */
  cancelRun(evalRunId: string): { cancelled: boolean } {
    const runner = this.running.get(evalRunId)
    if (!runner) return { cancelled: false }
    runner.cancel()
    return { cancelled: true }
  }

  // ---- 只读查询 ----

  /** 批次状态(状态文件缺失返回 null;损坏给出具体路径) */
  getRun(evalRunId: string): EvalRunState | null {
    const stateFile = join(this.deps.paths.artifactRoot, evalRunId, 'state.json')
    if (!existsSync(stateFile)) return null
    let raw: string
    try {
      raw = readFileSync(stateFile, 'utf-8')
    } catch (err) {
      throw validationError(`评测状态文件不可读:${stateFile}:${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      return JSON.parse(raw) as EvalRunState
    } catch (err) {
      throw validationError(`评测状态文件损坏:${stateFile}:${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** case 产物查询:完整性校验失败返回 ok=false 与原因(篡改/缺失可见) */
  getCaseArtifacts(
    evalRunId: string,
    configId: string,
    caseId: string,
    repeatIndex: number
  ): EvalCaseArtifactsResult {
    let dir: string
    try {
      dir = caseArtifactDir(this.deps.paths.artifactRoot, evalRunId, configId, caseId, repeatIndex)
    } catch (err) {
      if (err instanceof ArtifactPathError) {
        throw validationError(`产物查询路径非法:${err.message}`)
      }
      throw err
    }
    const verified = verifyCaseArtifacts(dir)
    if (!verified.ok) {
      return {
        ok: false,
        manifest: verified.manifest as unknown as Record<string, unknown> | null,
        manifestError: verified.manifestError,
        mismatched: verified.mismatched,
        missing: verified.missing,
        artifacts: null
      }
    }
    return {
      ok: true,
      manifest: verified.manifest as unknown as Record<string, unknown>,
      manifestError: null,
      mismatched: [],
      missing: [],
      artifacts: loadCaseArtifacts(dir)
    }
  }

  /** 报告生成(可对任意已有状态文件重新生成,CLI report 复用) */
  getReport(evalRunId: string): string | null {
    const state = this.getRun(evalRunId)
    if (!state) return null
    const dataset = loadEvalsDataset(this.deps.paths.datasetRoot, state.datasetVersion)
    const metrics = calculateMetrics(state, dataset.cases)
    return renderEvalReport({
      state,
      metrics,
      dataset,
      frozenConfigs: Object.fromEntries(state.configIds.flatMap(configId => {
        try {
          const config = findFrozenConfig(this.deps.paths.configRoot, configId)
          if (!config) return []
          return [[configId, { config, sha256: frozenConfigSha256(config) }]]
        } catch { return [] }
      })),
      reproduceCommand: `npm run eval:run -- --dataset ${state.datasetVersion} --split ${state.splits.join(',')} --execution ${state.executionKind} --config ${state.configIds.join(',')} --repeats ${state.repeats} --max-cases ${state.maxCases}`
    })
  }

  // ---- 人工审阅读写(FileReviewStore:追加式 JSONL,先持久写成功再返回) ----

  private reviews(): FileReviewStore {
    this.reviewStore ??= new FileReviewStore(this.deps.paths.reviewRoot, 'reviews.jsonl', this.deps.paths.artifactRoot)
    return this.reviewStore
  }

  /** 记录一次人工审阅:服务端重组并校验 subjectKey(六段路径 ID 校验) */
  saveReview(input: EvalReviewInput): ReviewAnnotation {
    const subjectKey = reviewSubjectKey({
      evalRunId: input.evalRunId,
      configId: input.configId,
      caseId: input.caseId,
      repeatIndex: input.repeatIndex,
      claimId: input.claimId,
      evidenceId: input.evidenceId === '' ? NO_EVIDENCE_SEGMENT : input.evidenceId
    })
    return this.reviews().annotate({
      subjectKey,
      decision: input.decision,
      reason: input.reason,
      reviewer: input.reviewer,
      rubricVersion: input.rubricVersion ?? 'rubric-v1',
      reviewedAt: new Date().toISOString()
    })
  }

  /** 审阅历史(按 evalRunId 过滤;不传返回全部) */
  listReviews(evalRunId?: string): ReviewAnnotation[] {
    const all = this.reviews().all()
    if (!evalRunId) return [...all]
    const prefix = `${evalRunId}::`
    return all.filter((r) => r.subjectKey.startsWith(prefix))
  }

  /**
   * 审阅总览:从可回放产物枚举应审的 claim-evidence 对(ops 案例无研究证据,
   * 自然产生空集),给出 coverage/supportPrecision/holdoutComplete 与未审清单;
   * 观测缺失与产物损坏的案例不计入分母,由案例详情显式展示。
   */
  getReviewOverview(evalRunId: string): EvalReviewOverview {
    const state = this.getRun(evalRunId)
    if (!state) {
      throw validationError(`评测运行不存在或没有状态文件:${evalRunId}`)
    }
    const store = this.reviews()
    const subjects: EvalReviewOverview['subjects'] = []
    for (const result of state.results) {
      if (result.status === 'not_run' || result.artifactStatus !== 'ok') continue
      let dir: string
      try {
        dir = caseArtifactDir(this.deps.paths.artifactRoot, evalRunId, result.configId, result.caseId, result.repeatIndex)
      } catch {
        continue
      }
      if (!verifyCaseArtifacts(dir).ok) continue
      const evidence = loadCaseArtifacts(dir).evidence as {
        applicable?: boolean
        claims?: Array<{ claim_id: string; claim_type: string }>
        citations?: Array<{ claim_id: string; evidence_id: string; relation: string }>
      }
      if (!evidence?.applicable) continue
      const keys = enumerateClaimEvidenceSubjects({
        evalRunId,
        configId: result.configId,
        caseId: result.caseId,
        repeatIndex: result.repeatIndex,
        claims: evidence.claims ?? [],
        citations: evidence.citations ?? []
      })
      for (const subjectKey of keys) {
        const ref = parseReviewSubjectKey(subjectKey)
        subjects.push({
          subjectKey,
          configId: ref.configId,
          caseId: ref.caseId,
          repeatIndex: ref.repeatIndex,
          claimId: ref.claimId,
          evidenceId: ref.evidenceId,
          latest: store.latestFor(subjectKey)
        })
      }
    }
    const status = reviewHoldoutStatus(store, subjects.map((s) => s.subjectKey))
    return {
      evalRunId,
      subjects,
      coverage: status.coverage,
      supportPrecision: status.supportPrecision,
      holdoutComplete: status.holdoutComplete,
      unreviewed: status.unreviewed
    }
  }
}
