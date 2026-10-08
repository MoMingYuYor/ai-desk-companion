// EVAL-02 真实请求预检与授权批次台账(realPreflight.ts)。
//
// 规范来源:docs/superpowers/plans/2026-10-08-desk-companion-improvements/evaluation.md EVAL-02。
// 本模块是「未签发/未授权 → 确定性拒绝」的闸门:所有拒绝路径都在创建 runner、
// 发送任何 fetch 之前失败;已批准的请求次数经台账持久化,重启不重置。
//
// 纪律:
// - 授权文件无密钥:出现任何疑似密钥字段即拒绝(密钥只经
//   AI_DESK_EVAL_PROVIDER_ID + AI_DESK_EVAL_API_KEY 进程内注入,不落盘);
// - 授权绑定:允许的具体批次(experimentId/label/splits)、有效期、数据范围
//   (dataset/fixture/rubric hash)、无密钥 target hash、允许的冻结配置 hash、
//   请求数(金额)上限、价格来源与供应商侧限额能力;一次授权不自动涵盖
//   后续新配置或 holdout(splits 未显式列出即拒绝);
// - 七类拒绝路径(各有独立错误码,先到先拒,顺序固定):
//   1) RELEASE_NOT_SIGNED        数据 release 未签发(EVAL-01 状态非 SIGNED)
//   2) COVERAGE_MISSING          真人覆盖缺失(humanReviewed < required)
//   3) RESOURCE_DRIFT            资源/hash 漂移(dataset/fixture/rubric/配置 hash)
//   4) TARGET_MISMATCH           无密钥 target 与授权不符
//   5) AUTHORIZATION_EXPIRED     授权过期(或未生效)
//   6) REQUEST_BUDGET_EXCEEDED   请求数超过授权(maximumRequestCount 现算为准)
//   7) CREDENTIAL_MISMATCH       provider 凭据绑定不符(含未注入)
//   另有辅助拒绝:SPLIT_NOT_ALLOWED(holdout 未显式授权)、
//   AUTHORIZATION_CONTAINS_SECRET(授权文件含密钥材料)、BUDGET_MISMATCH
//   (调用方 maximumRequests 与现算不一致)、COST_CAP_UNAVAILABLE
//   (要求硬费用封顶但供应商侧无硬限额 → 真实执行保持 BLOCKED_INPUT)。
// - 授权批次状态经 <artifactRoot>/approval-intents.jsonl 持久化:先登记
//   intent 再启动;崩溃后出现发送状态不明(state=launching)即暂停核对,
//   后续真实启动一律拒绝,直到人工核对后清理该 intent。

import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import { maximumRequestCount, type ExperimentItem } from './experiment'

// ---------- 错误类型 ----------

/** 预检拒绝码:七类主路径 + 辅助路径;错误信息给具体原因,不回显密钥 */
export type PreflightRejectionCode =
  | 'MALFORMED_INPUT'
  | 'RELEASE_NOT_SIGNED'
  | 'COVERAGE_MISSING'
  | 'RESOURCE_DRIFT'
  | 'TARGET_MISMATCH'
  | 'AUTHORIZATION_EXPIRED'
  | 'REQUEST_BUDGET_EXCEEDED'
  | 'CREDENTIAL_MISMATCH'
  | 'SPLIT_NOT_ALLOWED'
  | 'AUTHORIZATION_CONTAINS_SECRET'
  | 'BUDGET_MISMATCH'
  | 'COST_CAP_UNAVAILABLE'

export class PreflightError extends Error {
  constructor(readonly code: PreflightRejectionCode, message: string) {
    super(message)
    this.name = 'PreflightError'
  }
}

// ---------- 输入与授权/release 契约 ----------

/** 预检输入(规范接口;splits/credentialProviderId 为服务端门注入的扩展) */
export interface RealPreflightInput {
  /** 数据 release(EVAL-01 签发文件)绝对路径 */
  releaseFile: string
  /** 本次授权文件绝对路径(无密钥;其 releaseFile 字段定位 release) */
  authorizationFile: string
  datasetVersion: string
  /** 当前数据集 cases 内容 hash(loadEvalsDataset.casesSha256) */
  datasetSha256: string
  /** 当前 fixture 语料 hash(与授权 dataScope 绑定同源计算) */
  fixtureSha256: string
  rubricVersion: string
  /** 本次启动涉及的 configId → 实际配置 hash(frozenConfigSha256) */
  configHashes: Record<string, string>
  /** 本次启动配置的冻结 target hash(全部配置必须一致) */
  targetSha256: string
  /** 实验任务项(case × config × repeat,含逐项 maxModelCalls) */
  expectedItems: readonly ExperimentItem[]
  /** 调用方声明的请求数上限;必须等于 maximumRequestCount(expectedItems) 现算值 */
  maximumRequests: number
  /** 预检时刻(UTC ISO);测试注入固定值保证确定性 */
  nowUtc: string
  /** 本次启动覆盖的 split(缺省 dev;holdout 必须在授权中显式列出) */
  splits?: ReadonlyArray<'dev' | 'holdout'>
  /** 运行时凭据绑定:已解析的 providerId;null = 凭据未注入 */
  credentialProviderId?: string | null
}

/** 无密钥真实请求授权文件(一次授权绑定一个批次范围,不自动涵盖新配置/holdout) */
export interface RealEvalAuthorization {
  schemaVersion: 1
  kind: 'eval-real-authorization'
  authorizationId: string
  /** 授权文件定位其对应的 release(EVAL-01 签发文件) */
  releaseFile: string
  issuedAtUtc: string
  validUntilUtc: string
  /** 允许的具体批次:实验、批次标签与 split 范围(holdout 必须显式) */
  batch: {
    experimentId: string
    label: string
    splits: ReadonlyArray<'dev' | 'holdout'>
  }
  /** 凭据绑定:AI_DESK_EVAL_PROVIDER_ID 必须等于本 ID,API Key 不出现在本文件 */
  providerId: string
  /** 允许的无密钥 target hash(evalTargetSha256 口径) */
  targetSha256: string
  /** 允许的冻结配置(configId → 实际配置 hash);一次授权不涵盖后续新配置 */
  configHashes: Record<string, string>
  /** 数据范围:datasetVersion → 数据/fixture/rubric hash 绑定 */
  dataScope: Record<string, { casesSha256: string; fixtureSha256: string; rubricVersion: string }>
  /** 请求数(金额)上限:全部已登记 intent 的 maximumRequests 累计不得超过 */
  maxRequests: number
  /** 价格来源/时间与费用估算口径(登记用;不保证最终账单封顶) */
  pricing: {
    source: string
    notedAtUtc: string
    estimateBasis: string
    currency: string | null
    authorizedAmount: number | null
  }
  /** 供应商侧硬限额能力(没有硬限额且要求硬费用封顶 → 保持 BLOCKED_INPUT) */
  providerHardLimit: { available: boolean; note: string }
  /** 用户是否要求应用内/供应商侧硬费用封顶 */
  requiresHardCostCap: boolean
}

/** EVAL-01 数据 release 文件的预检读取形态(防御式解析,缺项给具体拒绝原因) */
export interface ParsedDataRelease {
  status: string
  signing: { status: string; signedBy: string | null; signedAt: string | null } | null
  bindings: Record<string, { datasetTreeSha256?: string; casesJsonlSha256?: string }> & {
    rubric?: { version?: string }
  }
  reviewPackage: { coverage: { humanReviewed: number; required: number } } | null
}

export interface RealPreflightResult {
  approved: true
  authorizationId: string
  maximumRequests: number
  authorization: RealEvalAuthorization
  /** 授权文件原始字节的 sha256(登记进授权批次台账) */
  authorizationSha256: string
}

// ---------- 工具 ----------

function sha256OfBytes(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function parseJsonObject(file: string, text: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new PreflightError('MALFORMED_INPUT', `JSON 解析失败:${file}:${err instanceof Error ? err.message : String(err)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PreflightError('MALFORMED_INPUT', `文件顶层必须是 JSON 对象:${file}`)
  }
  return parsed as Record<string, unknown>
}

/** 授权文件无密钥:出现疑似密钥字段(任意层级)即拒绝 */
const SECRET_KEY_PATTERN = /^(api[-_]?key|apikey|token|secret|password|authorization)$/i

function assertNoSecretMaterial(value: unknown, file: string, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSecretMaterial(item, file, `${path}[${i}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        throw new PreflightError(
          'AUTHORIZATION_CONTAINS_SECRET',
          `授权文件不得包含密钥材料(发现字段 ${path}.${key});凭据只经 AI_DESK_EVAL_PROVIDER_ID + AI_DESK_EVAL_API_KEY 进程内注入:${file}`
        )
      }
      assertNoSecretMaterial(child, file, `${path}.${key}`)
    }
  }
}

function expectString(record: Record<string, unknown>, field: string, file: string, code: PreflightRejectionCode): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PreflightError(code, `授权文件字段 ${field} 必须是非空字符串:${file}`)
  }
  return value
}

function parseIsoTime(value: string, file: string): number {
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) {
    throw new PreflightError('MALFORMED_INPUT', `时间字段不是合法 UTC ISO 字符串:${value}:${file}`)
  }
  return ms
}

/** 严格解析授权文件:未知字段/缺失字段/形态不符全部拒绝(先失败早失败) */
export function parseAuthorizationFile(file: string): { authorization: RealEvalAuthorization; sha256: string } {
  if (!existsSync(file)) {
    throw new PreflightError('MALFORMED_INPUT', `授权文件不存在:${file}`)
  }
  let raw: Buffer
  try {
    raw = readFileSync(file)
  } catch (err) {
    throw new PreflightError('MALFORMED_INPUT', `授权文件不可读:${file}:${err instanceof Error ? err.message : String(err)}`)
  }
  const record = parseJsonObject(file, raw.toString('utf-8'))
  assertNoSecretMaterial(record, file)
  const allowed = new Set([
    'schemaVersion', 'kind', 'authorizationId', 'releaseFile', 'issuedAtUtc', 'validUntilUtc',
    'batch', 'providerId', 'targetSha256', 'configHashes', 'dataScope', 'maxRequests',
    'pricing', 'providerHardLimit', 'requiresHardCostCap'
  ])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new PreflightError('MALFORMED_INPUT', `授权文件含未知字段:${key}(schema 漂移早失败):${file}`)
    }
  }
  if (record.schemaVersion !== 1 || record.kind !== 'eval-real-authorization') {
    throw new PreflightError('MALFORMED_INPUT', `授权文件 schemaVersion/kind 不符:${file}`)
  }
  const authorizationId = expectString(record, 'authorizationId', file, 'MALFORMED_INPUT')
  const releaseFile = expectString(record, 'releaseFile', file, 'MALFORMED_INPUT')
  const issuedAtUtc = expectString(record, 'issuedAtUtc', file, 'MALFORMED_INPUT')
  const validUntilUtc = expectString(record, 'validUntilUtc', file, 'MALFORMED_INPUT')
  const providerId = expectString(record, 'providerId', file, 'MALFORMED_INPUT')
  const targetSha256 = expectString(record, 'targetSha256', file, 'MALFORMED_INPUT')
  if (!/^[0-9a-f]{64}$/.test(targetSha256)) {
    throw new PreflightError('MALFORMED_INPUT', `授权 targetSha256 必须是 64 位十六进制 sha256:${file}`)
  }
  parseIsoTime(issuedAtUtc, file)
  parseIsoTime(validUntilUtc, file)
  const batch = record.batch
  if (batch === null || typeof batch !== 'object' || Array.isArray(batch)) {
    throw new PreflightError('MALFORMED_INPUT', `授权文件 batch 必须是对象:${file}`)
  }
  const batchRecord = batch as Record<string, unknown>
  const experimentId = expectString(batchRecord, 'experimentId', file, 'MALFORMED_INPUT')
  const label = expectString(batchRecord, 'label', file, 'MALFORMED_INPUT')
  const splits = batchRecord.splits
  if (
    !Array.isArray(splits) || splits.length === 0 ||
    splits.some((s) => s !== 'dev' && s !== 'holdout')
  ) {
    throw new PreflightError('MALFORMED_INPUT', `授权 batch.splits 必须是 'dev'/'holdout' 的非空数组:${file}`)
  }
  const configHashes = record.configHashes
  if (configHashes === null || typeof configHashes !== 'object' || Array.isArray(configHashes)) {
    throw new PreflightError('MALFORMED_INPUT', `授权文件 configHashes 必须是对象:${file}`)
  }
  for (const [configId, hash] of Object.entries(configHashes as Record<string, unknown>)) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new PreflightError('MALFORMED_INPUT', `授权 configHashes[${configId}] 必须是 64 位十六进制 sha256:${file}`)
    }
  }
  const dataScope = record.dataScope
  if (dataScope === null || typeof dataScope !== 'object' || Array.isArray(dataScope)) {
    throw new PreflightError('MALFORMED_INPUT', `授权文件 dataScope 必须是对象:${file}`)
  }
  for (const [version, entry] of Object.entries(dataScope as Record<string, unknown>)) {
    const item = entry as Record<string, unknown> | null
    if (
      item === null || typeof item !== 'object' ||
      typeof item.casesSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.casesSha256) ||
      typeof item.fixtureSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.fixtureSha256) ||
      typeof item.rubricVersion !== 'string' || item.rubricVersion === ''
    ) {
      throw new PreflightError('MALFORMED_INPUT', `授权 dataScope[${version}] 必须绑定 casesSha256/fixtureSha256/rubricVersion:${file}`)
    }
  }
  if (typeof record.maxRequests !== 'number' || !Number.isInteger(record.maxRequests) || record.maxRequests < 1) {
    throw new PreflightError('MALFORMED_INPUT', `授权 maxRequests 必须是 ≥1 的整数:${file}`)
  }
  const pricing = record.pricing
  if (pricing === null || typeof pricing !== 'object' || Array.isArray(pricing)) {
    throw new PreflightError('MALFORMED_INPUT', `授权文件 pricing 必须是对象(登记价格来源/时间与估算口径):${file}`)
  }
  const pricingRecord = pricing as Record<string, unknown>
  for (const field of ['source', 'notedAtUtc', 'estimateBasis'] as const) {
    expectString(pricingRecord, field, file, 'MALFORMED_INPUT')
  }
  const hardLimit = record.providerHardLimit
  if (
    hardLimit === null || typeof hardLimit !== 'object' || Array.isArray(hardLimit) ||
    typeof (hardLimit as Record<string, unknown>).available !== 'boolean'
  ) {
    throw new PreflightError('MALFORMED_INPUT', `授权 providerHardLimit 必须是 { available: boolean; note: string }:${file}`)
  }
  if (typeof record.requiresHardCostCap !== 'boolean') {
    throw new PreflightError('MALFORMED_INPUT', `授权 requiresHardCostCap 必须是 boolean:${file}`)
  }
  return {
    authorization: record as unknown as RealEvalAuthorization,
    sha256: sha256OfBytes(raw)
  }
}

/** 读取授权文件内绑定的 release 路径(--approval-file 只给授权文件时定位 release 用) */
export function authorizationReleaseFile(authorizationFile: string): string {
  return parseAuthorizationFile(authorizationFile).authorization.releaseFile
}

/** 解析 EVAL-01 数据 release(防御式:缺项不猜测,交由各拒绝路径判定) */
export function parseDataReleaseFile(file: string): ParsedDataRelease {
  if (!existsSync(file)) {
    throw new PreflightError('RELEASE_NOT_SIGNED', `数据 release 文件不存在(视为未签发):${file}`)
  }
  let raw: string
  try {
    raw = readFileSync(file, 'utf-8')
  } catch (err) {
    throw new PreflightError('RELEASE_NOT_SIGNED', `数据 release 不可读:${file}:${err instanceof Error ? err.message : String(err)}`)
  }
  const record = parseJsonObject(file, raw)
  const signing = (record.signing ?? null) as ParsedDataRelease['signing']
  const bindings = (record.bindings ?? {}) as ParsedDataRelease['bindings']
  const reviewPackage = (record.reviewPackage ?? null) as ParsedDataRelease['reviewPackage']
  return {
    status: typeof record.status === 'string' ? record.status : String(record.status ?? ''),
    signing,
    bindings,
    reviewPackage
  }
}

// ---------- 预检主入口 ----------

/**
 * 真实启动预检:全部拒绝路径在创建 runner / 发送任何 fetch 之前抛出
 * PreflightError。通过时返回授权身份与现算请求数上限。
 */
export function validateRealPreflight(input: RealPreflightInput): RealPreflightResult {
  // 0) 输入自洽:expectedItems 非空且逐项有效;maximumRequests 必须等于现算值
  if (!Array.isArray(input.expectedItems) || input.expectedItems.length === 0) {
    throw new PreflightError('MALFORMED_INPUT', '预检 expectedItems 必须是非空实验任务项清单')
  }
  let computedMaximumRequests: number
  try {
    computedMaximumRequests = maximumRequestCount(input.expectedItems)
  } catch (err) {
    throw new PreflightError('MALFORMED_INPUT', `实验任务项无效:${err instanceof Error ? err.message : String(err)}`)
  }
  if (input.maximumRequests !== computedMaximumRequests) {
    throw new PreflightError(
      'BUDGET_MISMATCH',
      `调用方声明的请求数上限(${input.maximumRequests})与按实际案例预算现算值(${computedMaximumRequests})不一致;请求上限一律以 maximumRequestCount 现算为准`
    )
  }
  const nowMs = parseIsoTime(input.nowUtc, 'nowUtc')

  // 1) 授权文件解析(不存在/损坏/含密钥此前已各自拒绝)
  const { authorization, sha256: authorizationSha256 } = parseAuthorizationFile(input.authorizationFile)

  // 2) 数据 release:未签发即拒绝(EVAL-01 status/signing 必须 SIGNED 且实名)
  const release = parseDataReleaseFile(input.releaseFile)
  if (release.status !== 'SIGNED') {
    throw new PreflightError('RELEASE_NOT_SIGNED', `数据 release 未签发:status=${release.status || '(缺失)'}(期望 SIGNED):${input.releaseFile}`)
  }
  if (!release.signing || release.signing.status !== 'SIGNED' || !release.signing.signedBy) {
    throw new PreflightError('RELEASE_NOT_SIGNED', `数据 release 缺少实名签署(signing.status/signedBy):${input.releaseFile}`)
  }
  // 调用方定位的 release 必须与授权文件内绑定的 release 一致
  if (resolvePath(input.releaseFile) !== resolvePath(authorization.releaseFile)) {
    throw new PreflightError('MALFORMED_INPUT', `release 定位不一致:输入 ${input.releaseFile} ≠ 授权绑定 ${authorization.releaseFile}`)
  }

  // 3) 真人覆盖缺失:humanReviewed 必须达到 required(缺审阅包/覆盖文件同拒)
  const coverage = release.reviewPackage?.coverage
  if (!coverage || typeof coverage.humanReviewed !== 'number' || typeof coverage.required !== 'number') {
    throw new PreflightError('COVERAGE_MISSING', `数据 release 缺少可核查的真人覆盖(reviewPackage.coverage):${input.releaseFile}`)
  }
  if (coverage.required < 1 || coverage.humanReviewed < coverage.required) {
    throw new PreflightError(
      'COVERAGE_MISSING',
      `真人覆盖缺失:${coverage.humanReviewed}/${coverage.required}(不足不签发真实请求)`
    )
  }

  // 4) 授权有效期:notYetValid / expired 都归授权过期路径
  const issuedMs = parseIsoTime(authorization.issuedAtUtc, input.authorizationFile)
  const validUntilMs = parseIsoTime(authorization.validUntilUtc, input.authorizationFile)
  if (validUntilMs < issuedMs) {
    throw new PreflightError('MALFORMED_INPUT', `授权有效期倒挂(validUntilUtc < issuedAtUtc):${input.authorizationFile}`)
  }
  if (nowMs < issuedMs) {
    throw new PreflightError('AUTHORIZATION_EXPIRED', `授权尚未生效:nowUtc=${input.nowUtc} < issuedAtUtc=${authorization.issuedAtUtc}`)
  }
  if (nowMs > validUntilMs) {
    throw new PreflightError('AUTHORIZATION_EXPIRED', `授权已过期:nowUtc=${input.nowUtc} > validUntilUtc=${authorization.validUntilUtc}`)
  }

  // 5) 资源/hash 漂移:release 绑定与授权数据范围双核对
  const releaseBinding = release.bindings[input.datasetVersion]
  if (!releaseBinding || typeof releaseBinding.casesJsonlSha256 !== 'string') {
    throw new PreflightError('RESOURCE_DRIFT', `数据 release 未绑定数据集 ${input.datasetVersion} 的 cases hash(数据版本不在签发范围内):${input.releaseFile}`)
  }
  if (releaseBinding.casesJsonlSha256 !== input.datasetSha256) {
    throw new PreflightError('RESOURCE_DRIFT', `数据 hash 与 release 签发绑定不一致:release ${releaseBinding.casesJsonlSha256.slice(0, 12)}… ≠ 当前 ${input.datasetSha256.slice(0, 12)}…`)
  }
  const scope = authorization.dataScope[input.datasetVersion]
  if (!scope) {
    throw new PreflightError('RESOURCE_DRIFT', `授权数据范围不含数据集 ${input.datasetVersion}(一次授权只涵盖显式绑定的数据):${input.authorizationFile}`)
  }
  if (scope.casesSha256 !== input.datasetSha256) {
    throw new PreflightError('RESOURCE_DRIFT', `数据 hash 与授权绑定不一致:授权 ${scope.casesSha256.slice(0, 12)}… ≠ 当前 ${input.datasetSha256.slice(0, 12)}…`)
  }
  if (scope.fixtureSha256 !== input.fixtureSha256) {
    throw new PreflightError('RESOURCE_DRIFT', `fixture 语料 hash 漂移:授权 ${scope.fixtureSha256.slice(0, 12)}… ≠ 当前 ${input.fixtureSha256.slice(0, 12)}…`)
  }
  if (scope.rubricVersion !== input.rubricVersion) {
    throw new PreflightError('RESOURCE_DRIFT', `rubric 版本漂移:授权 ${scope.rubricVersion} ≠ 当前 ${input.rubricVersion}`)
  }
  const releaseRubric = release.bindings.rubric?.version
  if (releaseRubric !== undefined && releaseRubric !== input.rubricVersion) {
    throw new PreflightError('RESOURCE_DRIFT', `rubric 版本与 release 签发绑定不一致:release ${releaseRubric} ≠ 当前 ${input.rubricVersion}`)
  }
  // 配置 hash:本次启动的每个 configId 都必须在授权中显式允许且 hash 一致
  for (const [configId, hash] of Object.entries(input.configHashes)) {
    const allowed = authorization.configHashes[configId]
    if (allowed === undefined) {
      throw new PreflightError('RESOURCE_DRIFT', `配置 ${configId} 不在本次授权范围内(一次授权不自动涵盖新配置):${input.authorizationFile}`)
    }
    if (allowed !== hash) {
      throw new PreflightError('RESOURCE_DRIFT', `配置 ${configId} hash 漂移:授权 ${allowed.slice(0, 12)}… ≠ 当前 ${hash.slice(0, 12)}…`)
    }
  }

  // 6) 目标不符:无密钥 target hash 必须与授权一致
  if (authorization.targetSha256 !== input.targetSha256) {
    throw new PreflightError('TARGET_MISMATCH', `无密钥 target 与授权不符:授权 ${authorization.targetSha256.slice(0, 12)}… ≠ 当前 ${input.targetSha256.slice(0, 12)}…`)
  }

  // 7) split 范围:holdout 必须在授权 batch.splits 中显式列出(不自动涵盖)
  const requestedSplits = input.splits ?? ['dev']
  for (const split of requestedSplits) {
    if (!authorization.batch.splits.includes(split)) {
      throw new PreflightError('SPLIT_NOT_ALLOWED', `授权未显式允许 split=${split}(batch.splits=[${authorization.batch.splits.join(', ')}];holdout 需独立授权)`)
    }
  }

  // 8) 请求数超授权:现算值不得超过授权上限(逐批授权 + 台账累计在服务层)
  if (computedMaximumRequests > authorization.maxRequests) {
    throw new PreflightError(
      'REQUEST_BUDGET_EXCEEDED',
      `请求数超过授权:现算上限 ${computedMaximumRequests} > 授权 maxRequests ${authorization.maxRequests}`
    )
  }

  // 9) provider 凭据绑定:授权 providerId 必须与运行时注入的凭据绑定一致
  if (input.credentialProviderId === null || input.credentialProviderId === undefined) {
    throw new PreflightError('CREDENTIAL_MISMATCH', 'provider 凭据未注入(AI_DESK_EVAL_PROVIDER_ID / 凭据库均未解析到授权 provider)')
  }
  if (input.credentialProviderId !== authorization.providerId) {
    throw new PreflightError(
      'CREDENTIAL_MISMATCH',
      `provider 凭据绑定不匹配:授权 providerId=${authorization.providerId} ≠ 运行时绑定 ${input.credentialProviderId}`
    )
  }

  // 10) 硬费用封顶:要求硬封顶但供应商侧无硬限额 → 真实执行保持 BLOCKED_INPUT
  if (authorization.requiresHardCostCap && !authorization.providerHardLimit.available) {
    throw new PreflightError(
      'COST_CAP_UNAVAILABLE',
      `要求硬费用封顶但供应商侧无硬限额,真实执行保持 BLOCKED_INPUT:${authorization.providerHardLimit.note || '(无说明)'}`
    )
  }

  return { approved: true, authorizationId: authorization.authorizationId, maximumRequests: computedMaximumRequests, authorization, authorizationSha256 }
}

function resolvePath(p: string): string {
  // 仅用于一致性比较;不校验存在性(存在性由各自的解析步骤负责)
  return p.replace(/\\/g, '/').toLowerCase()
}

// ---------- 授权批次台账(<artifactRoot>/approval-intents.jsonl) ----------

export const APPROVAL_INTENTS_FILE = 'approval-intents.jsonl'

/** 一次真实启动的授权 intent:先登记再启动;状态推进持久化 */
export interface ApprovalIntentRecord {
  intentId: string
  authorizationId: string
  authorizationSha256: string
  evalRunId: string | null
  datasetVersion: string
  split: string
  configIds: string[]
  maximumRequests: number
  /** launching = 已登记未确认启动(崩溃后视为发送状态不明);running;finished */
  state: 'launching' | 'running' | 'finished'
  registeredAtUtc: string
  updatedAtUtc: string
  finishedAtUtc: string | null
}

export function approvalIntentsFile(artifactRoot: string): string {
  return join(artifactRoot, APPROVAL_INTENTS_FILE)
}

/** 读取全部 intent(文件缺失返回空;损坏行原样报错,不静默跳过) */
export function readApprovalIntents(artifactRoot: string): ApprovalIntentRecord[] {
  const file = approvalIntentsFile(artifactRoot)
  if (!existsSync(file)) return []
  let raw: string
  try {
    raw = readFileSync(file, 'utf-8')
  } catch (err) {
    throw new Error(`授权批次台账不可读:${file}:${err instanceof Error ? err.message : String(err)}`)
  }
  const out: ApprovalIntentRecord[] = []
  for (const [index, line] of raw.split('\n').entries()) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line) as ApprovalIntentRecord)
    } catch (err) {
      throw new Error(`授权批次台账第 ${index + 1} 行损坏:${file}:${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return out
}

/** 追加一条 intent(JSONL 追加 + fsync:崩溃后已登记内容不丢) */
export function appendApprovalIntent(artifactRoot: string, record: ApprovalIntentRecord): void {
  const file = approvalIntentsFile(artifactRoot)
  mkdirSync(artifactRoot, { recursive: true })
  // 追加模式写入,写后 fsync 确保落盘(「先登记 intent 再启动」的持久性前提)
  const fd = openSync(file, 'a')
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** 更新一条 intent 的状态:整体重写(tmp 写 + fsync + rename 原子替换) */
export function updateApprovalIntent(
  artifactRoot: string,
  intentId: string,
  patch: Partial<Pick<ApprovalIntentRecord, 'state' | 'evalRunId' | 'updatedAtUtc' | 'finishedAtUtc'>>
): void {
  const records = readApprovalIntents(artifactRoot)
  const index = records.findIndex((r) => r.intentId === intentId)
  if (index < 0) {
    throw new Error(`授权批次台账找不到 intent:${intentId}`)
  }
  records[index] = { ...records[index]!, ...patch }
  const file = approvalIntentsFile(artifactRoot)
  const tmp = `${file}.${intentId}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
}

/**
 * 崩溃暂停核对:存在 launching 状态的 intent(已登记未确认启动)时,
 * 同一授权下的后续真实启动一律拒绝——发送状态不明,必须人工核对后清理。
 */
export function assertNoUnclearApprovalIntents(artifactRoot: string, authorizationId: string): void {
  const unclear = readApprovalIntents(artifactRoot).filter(
    (r) => r.authorizationId === authorizationId && r.state === 'launching'
  )
  if (unclear.length > 0) {
    throw new PreflightError(
      'MALFORMED_INPUT',
      `授权 ${authorizationId} 存在发送状态不明的批次 intent(${unclear.map((r) => r.intentId).join(', ')}),已暂停:请人工核对该批次的运行产物后清理 intent 再重试`
    )
  }
}

/**
 * 已批准请求次数(已登记 intent 的 maximumRequests 累计,含 launching/running/
 * finished):重启或新进程不重置,同一授权累计不得超过 maxRequests。
 */
export function approvedRequestCountFor(artifactRoot: string, authorizationId: string): number {
  return readApprovalIntents(artifactRoot)
    .filter((r) => r.authorizationId === authorizationId)
    .reduce((sum, r) => sum + r.maximumRequests, 0)
}

/** 导出给测试/工具:写一整份台账(仅测试构造反例使用) */
export function writeApprovalIntentsFile(artifactRoot: string, records: readonly ApprovalIntentRecord[]): void {
  mkdirSync(artifactRoot, { recursive: true })
  const file = approvalIntentsFile(artifactRoot)
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : ''), 'utf-8')
}
