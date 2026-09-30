// 冻结实验配置存储(EVAL-04,F-13 评测部分):配置从进程内 Map 迁移为目录中的
// 不可变 config JSON。纪律(完成计划 eval.md EVAL-04):
// - 配置文件只记录 providerId(credential reference),绝不写 API Key;凭据只在
//   运行时由工厂经 credentialOf(providerId) 解析;
// - 同一 configId 不同内容拒绝覆盖:先写先冻结,重跑不漂移;
// - 实际配置 hash 单独保存(<configId>.sha256),重启读回同一 hash,内容被篡改
//   时立即暴露;
// - 配置间允许比较的变量清单显式记录(COMPARABLE_VARIABLES:只允许流程变量
//   pipelineVariant/promptSha256 不同),其余冻结字段必须逐字段一致;
// - 全部写入前做 schema 校验与路径 ID 校验;损坏文件保留并报错,不静默重置。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { safeSegment } from './artifacts'

/** 冻结实验配置(完成计划 eval.md EVAL-04 接口原样) */
export interface FrozenEvalConfig {
  schemaVersion: 1
  configId: string
  executionKind: 'fake' | 'real'
  model: string
  providerId: string
  pipelineVariant: 'baseline' | 'candidate'
  promptSha256: string
  toolsVersion: string
  codeCommit: string
  datasetSha256: string
  fixtureSha256: string
  budgetSha256: string
  interactionScriptSha256: string
  rubricVersion: string
}

export const CONFIG_SCHEMA_VERSION = 1 as const

/**
 * 允许在对照两侧不同的变量清单(显式记录):每次对照只改变记录的流程变量——
 * 实验角色标记与冻结提示词模板;同模型、数据、工具、预算、审批脚本与 rubric
 * 必须逐字段一致,否则不可比。
 */
export const COMPARABLE_VARIABLES: readonly string[] = ['pipelineVariant', 'promptSha256']

/** 冻结字段清单(除 configId 与 schemaVersion 外全部参与可比性校验) */
const FROZEN_FIELDS: readonly (keyof Omit<FrozenEvalConfig, 'schemaVersion' | 'configId'>)[] = [
  'executionKind',
  'model',
  'providerId',
  'pipelineVariant',
  'promptSha256',
  'toolsVersion',
  'codeCommit',
  'datasetSha256',
  'fixtureSha256',
  'budgetSha256',
  'interactionScriptSha256',
  'rubricVersion'
]

const SHA256_HEX = /^[0-9a-f]{64}$/

/** 配置存储错误:文件损坏、schema 非法或内容被篡改(原文件保留) */
export class FrozenConfigError extends Error {
  constructor(message: string, readonly file?: string) {
    super(message)
    this.name = 'FrozenConfigError'
  }
}

/** 稳定序列化(键排序)后的 sha256:实际配置 hash 的唯一来源 */
export function frozenConfigSha256(config: FrozenEvalConfig): string {
  return createHash('sha256')
    .update(stableStringify(config))
    .digest('hex')
}

/** 键排序的稳定 JSON 序列化(与 JSON.stringify 的插入序无关) */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/** schema 校验:字段类型、枚举、sha256 形状与未知字段全部严格检查 */
export function validateFrozenConfig(raw: unknown): FrozenEvalConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FrozenConfigError('冻结配置必须是对象')
  }
  const allowed = new Set(['schemaVersion', 'configId', ...FROZEN_FIELDS])
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (!allowed.has(key)) {
      throw new FrozenConfigError(`冻结配置含未知字段:${key}(schema 漂移早失败)`)
    }
  }
  const record = raw as Record<string, unknown>
  if (record.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new FrozenConfigError(`schemaVersion 必须是 ${CONFIG_SCHEMA_VERSION},收到 ${String(record.schemaVersion)}`)
  }
  if (typeof record.configId !== 'string' || record.configId.trim() === '') {
    throw new FrozenConfigError('缺少 configId')
  }
  // 路径 ID 校验:configId 直接作为配置文件名,必须通过安全段检查(拒绝 '.'/'..' 等)
  try {
    safeSegment('configId', record.configId)
  } catch (err) {
    throw new FrozenConfigError(err instanceof Error ? err.message : String(err))
  }
  for (const field of FROZEN_FIELDS) {
    if (typeof record[field] !== 'string' || (record[field] as string).trim() === '') {
      throw new FrozenConfigError(`冻结配置 ${field} 必须是非空字符串`)
    }
  }
  const shaFields: readonly (keyof FrozenEvalConfig)[] = [
    'promptSha256', 'datasetSha256', 'fixtureSha256', 'budgetSha256', 'interactionScriptSha256'
  ]
  for (const field of shaFields) {
    if (!SHA256_HEX.test(record[field] as string)) {
      throw new FrozenConfigError(`${field} 必须是 64 位十六进制 sha256`)
    }
  }
  if (record.executionKind !== 'fake' && record.executionKind !== 'real') {
    throw new FrozenConfigError(`executionKind 非法:${String(record.executionKind)}`)
  }
  if (record.pipelineVariant !== 'baseline' && record.pipelineVariant !== 'candidate') {
    throw new FrozenConfigError(`pipelineVariant 非法:${String(record.pipelineVariant)}`)
  }
  return raw as FrozenEvalConfig
}

function configFile(root: string, configId: string): string {
  // 路径守卫:configId 先过安全段检查,解析后必须仍在配置根目录内(防穿越)
  safeSegment('configId', configId)
  const base = resolve(root)
  const file = resolve(base, `${configId}.json`)
  if (!file.startsWith(base + sep)) {
    throw new FrozenConfigError(`配置文件解析后越出配置根目录:${file}`)
  }
  return file
}

function hashFile(root: string, configId: string): string {
  safeSegment('configId', configId)
  return resolve(root, `${configId}.sha256`)
}

/**
 * 冻结写入:<configRoot>/<configId>.json 原子写 + 实际内容 hash 单独保存到
 * <configId>.sha256。同 ID 同内容幂等;同 ID 不同内容拒绝(先写先冻结)。
 */
export function saveFrozenConfig(
  configRoot: string,
  config: FrozenEvalConfig
): { file: string; sha256: string } {
  validateFrozenConfig(config)
  const file = configFile(configRoot, config.configId)
  const hash = frozenConfigSha256(config)
  mkdirSync(configRoot, { recursive: true })
  if (existsSync(file)) {
    // 同 ID 已冻结:同内容幂等返回;不同内容拒绝覆盖(重跑不得漂移配置)
    const existing = readFrozenConfigRaw(file)
    if (stableStringify(existing) !== stableStringify(config)) {
      throw new FrozenConfigError(
        `配置 ${config.configId} 已冻结且内容不同,拒绝覆盖(同 ID 不同内容):${file}`,
        file
      )
    }
    return { file, sha256: hash }
  }
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  renameSync(tmp, file)
  // 实际配置 hash 单独保存:重启读回时逐字节核对内容未被篡改
  const hashTmp = `${hashFile(configRoot, config.configId)}.tmp`
  writeFileSync(hashTmp, `${hash}\n`, 'utf-8')
  renameSync(hashTmp, hashFile(configRoot, config.configId))
  return { file, sha256: hash }
}

function readFrozenConfigRaw(file: string): FrozenEvalConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (err) {
    throw new FrozenConfigError(
      `配置文件损坏,无法解析(原文件保留,不重置):${file}:${err instanceof Error ? err.message : String(err)}`,
      file
    )
  }
  try {
    return validateFrozenConfig(parsed)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new FrozenConfigError(`配置 schema 非法:${file}:${message}`, file)
  }
}

/**
 * 读取冻结配置:文件损坏、schema 非法或内容 hash 与单独保存的 hash 不一致
 * 一律抛 FrozenConfigError;原文件保留,禁止静默重置为新配置。
 */
export function loadFrozenConfig(configRoot: string, configId: string): FrozenEvalConfig {
  const file = configFile(configRoot, configId)
  if (!existsSync(file)) {
    throw new FrozenConfigError(`冻结配置不存在:${configId}(期望 ${file})`, file)
  }
  const config = readFrozenConfigRaw(file)
  const hashPath = hashFile(configRoot, configId)
  if (!existsSync(hashPath)) {
    throw new FrozenConfigError(`配置 hash 文件缺失(内容不可信):${hashPath}`, hashPath)
  }
  const recorded = readFileSync(hashPath, 'utf-8').trim()
  if (recorded !== frozenConfigSha256(config)) {
    throw new FrozenConfigError(
      `配置内容 hash 与单独保存的 hash 不一致(配置被篡改):${file}`,
      file
    )
  }
  return config
}

/** 读取失败返回 null(发现类调用);损坏/被篡改仍抛错,不静默吞掉 */
export function findFrozenConfig(configRoot: string, configId: string): FrozenEvalConfig | null {
  try {
    return loadFrozenConfig(configRoot, configId)
  } catch (err) {
    if (err instanceof FrozenConfigError && err.message.includes('不存在')) return null
    throw err
  }
}

/** 目录内全部配置 ID(排序);目录不存在返回空 */
export function listFrozenConfigIds(configRoot: string): string[] {
  if (!existsSync(configRoot)) return []
  return readdirSorted(configRoot)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
}

function readdirSorted(dir: string): string[] {
  return readdirSync(dir).sort()
}

/** 读取目录内全部冻结配置(任一损坏即抛错:数据问题必须显式暴露) */
export function loadAllFrozenConfigs(configRoot: string): FrozenEvalConfig[] {
  return listFrozenConfigIds(configRoot).map((id) => loadFrozenConfig(configRoot, id))
}
