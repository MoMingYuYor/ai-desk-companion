// 冻结实验配置存储(EVAL-04,F-13 评测部分):配置从进程内 Map 迁移为目录中的
// 不可变 config JSON。纪律(完成计划 eval.md EVAL-04):
// - 配置文件记录无密钥 target 与 providerId(credential reference),绝不写 API Key;凭据只在
//   运行时由工厂经 credentialOf(providerId) 解析;
// - 同一 configId 不同内容拒绝覆盖:先写先冻结,重跑不漂移;
// - 实际配置 hash 单独保存(<configId>.sha256),重启读回同一 hash,内容被篡改
//   时立即暴露;
// - 配置间允许比较的变量清单显式记录(COMPARABLE_VARIABLES:只允许流程变量
//   pipelineVariant/promptSha256 不同),其余冻结字段必须逐字段一致;
// - 全部写入前做 schema 校验与路径 ID 校验;损坏文件保留并报错,不静默重置。

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, linkSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { safeSegment } from './artifacts'
import type { EvalTargetProfile, FrozenEvalConfig } from '../../shared/evals'
export type { EvalTargetProfile, FrozenEvalConfig, Schema2FrozenEvalConfig } from '../../shared/evals'

/** 新实验使用 schema 2；schema 1 历史对象仅按原内容读取。 */
export const CONFIG_SCHEMA_VERSION = 2 as const

/**
 * 允许在对照两侧不同的变量清单(显式记录):每次对照只改变记录的流程变量——
 * 实验角色标记与冻结提示词模板;同模型、数据、工具、预算、审批脚本与 rubric
 * 必须逐字段一致,否则不可比。
 */
export const COMPARABLE_VARIABLES: readonly string[] = ['pipelineVariant', 'promptSha256']

/** 历史字符串字段；schema 2 的 target/hash 由专门分支校验。 */
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
  return stableValueSha256(config)
}

export function stableValueSha256(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

/** 规范化无密钥目标；错误只说明结构问题，不回显可能含密钥的 URL。 */
export function normalizeEvalTarget(raw: unknown): EvalTargetProfile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new FrozenConfigError('real 必须提供无密钥 target 对象')
  const record = raw as Record<string, unknown>
  if (Object.keys(record).some((key) => !['providerId', 'protocol', 'baseUrl', 'model'].includes(key))) throw new FrozenConfigError('target 含未知字段，禁止凭据落盘')
  for (const field of ['providerId', 'protocol', 'baseUrl', 'model']) {
    if (typeof record[field] !== 'string' || (record[field] as string).trim() !== record[field] || !record[field]) throw new FrozenConfigError(`target ${field} 必须是非空且无边缘空白的字符串`)
  }
  if (record.protocol !== 'chat-completions' && record.protocol !== 'responses') throw new FrozenConfigError('target protocol 不受支持')
  let url: URL
  try { url = new URL(record.baseUrl as string) } catch { throw new FrozenConfigError('target baseUrl 非法') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new FrozenConfigError('target URL 必须使用 HTTP(S) 且不得包含凭据、query 或 fragment')
  }
  return { providerId: record.providerId as string, protocol: record.protocol, baseUrl: url.toString().replace(/\/+$/, ''), model: record.model as string }
}

/** null 对应固定 fake 档案；real 仅对规范化的四字段目标计算 hash。 */
export function evalTargetSha256(target: EvalTargetProfile | null): string {
  return stableValueSha256(target === null ? { executionKind: 'fake' } : normalizeEvalTarget(target))
}

/** 键排序的稳定 JSON 序列化(与 JSON.stringify 的插入序无关) */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/** schema 校验:字段类型、枚举、sha256 形状与未知字段全部严格检查 */
export function validateFrozenConfig(raw: unknown): FrozenEvalConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FrozenConfigError('冻结配置必须是对象')
  }
  const record = raw as Record<string, unknown>
  const allowed = new Set(['schemaVersion', 'configId', ...FROZEN_FIELDS, ...(record.schemaVersion === 2 ? ['targetSha256', 'target'] : [])])
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (!allowed.has(key)) {
      throw new FrozenConfigError(`冻结配置含未知字段:${key}(schema 漂移早失败)`)
    }
  }
  if (record.schemaVersion !== 1 && record.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new FrozenConfigError('schemaVersion 必须是 1 或 2')
  }
  if (record.schemaVersion === 2 && (typeof record.targetSha256 !== 'string' || !SHA256_HEX.test(record.targetSha256))) {
    throw new FrozenConfigError('targetSha256 必须是 64 位十六进制 sha256')
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
  if (record.schemaVersion === 2) {
    const target = record.target === null ? null : normalizeEvalTarget(record.target)
    if ((record.executionKind === 'fake') !== (target === null)) throw new FrozenConfigError('executionKind 与 config.target 不一致')
    if (evalTargetSha256(target) !== record.targetSha256 || stableValueSha256(target) !== stableValueSha256(record.target)) throw new FrozenConfigError('config.target 未规范化或 targetSha256 不一致')
    if (record.providerId !== (target?.providerId ?? 'eval-fake') || record.model !== (target?.model ?? 'fake-model')) throw new FrozenConfigError('config.target 与 providerId/model 不一致')
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
  const prefix = configId.replace(/-(baseline|candidate)$/, '')
  const bundled = join(base, 'freezes', prefix, `${configId}.json`)
  if (existsSync(file) && existsSync(bundled)) throw new FrozenConfigError(`配置 ID 同时存在于历史目录和冻结 bundle:${configId}`)
  return existsSync(join(base, 'freezes', prefix)) ? bundled : file
}

function hashFile(root: string, configId: string): string {
  safeSegment('configId', configId)
  return configFile(root, configId).replace(/\.json$/, '.sha256')
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
    const existing = loadFrozenConfig(configRoot, config.configId)
    if (stableStringify(existing) !== stableStringify(config)) {
      throw new FrozenConfigError(
        `配置 ${config.configId} 已冻结且内容不同,拒绝覆盖(同 ID 不同内容):${file}`,
        file
      )
    }
    return { file, sha256: hash }
  }
  const hashPath = hashFile(configRoot, config.configId)
  if (existsSync(hashPath)) throw new FrozenConfigError(`配置发布不完整，存在孤立 hash:${config.configId}`)
  const tmp = `${file}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  // 实际配置 hash 单独保存:重启读回时逐字节核对内容未被篡改
  const hashTmp = `${hashPath}.${randomUUID()}.tmp`
  writeFileSync(hashTmp, `${hash}\n`, 'utf-8')
  // 排他发布，避免检查与写入之间的竞态覆盖旧配置；中断残留供诊断，不隐式修复。
  linkSync(hashTmp, hashPath)
  linkSync(tmp, file)
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
  if (config.configId !== configId) throw new FrozenConfigError(`文件名与内容 configId 不一致:${configId}`, file)
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
  const prefix = configId.replace(/-(baseline|candidate)$/, '')
  const bundle = join(resolve(configRoot), 'freezes', prefix)
  if (existsSync(bundle)) {
    const manifestFile = join(bundle, 'manifest.json')
    const manifestHash = join(bundle, 'manifest.sha256')
    if (!existsSync(manifestFile) || !existsSync(manifestHash)) throw new FrozenConfigError(`冻结 bundle manifest 或 hash 文件缺失:${prefix}`)
    let manifest: { schemaVersion: number; configs: Record<string, string> }
    try { manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) } catch { throw new FrozenConfigError(`冻结 bundle manifest 损坏:${prefix}`) }
    if (manifest.schemaVersion !== 2 || stableValueSha256(manifest) !== readFileSync(manifestHash, 'utf8').trim()) {
      throw new FrozenConfigError(`冻结 bundle manifest hash 不一致:${prefix}`)
    }
    for (const variant of ['baseline', 'candidate']) {
      const id = `${prefix}-${variant}`
      const memberFile = join(bundle, `${id}.json`)
      const memberHash = join(bundle, `${id}.sha256`)
      if (!existsSync(memberFile) || !existsSync(memberHash)) throw new FrozenConfigError(`冻结配置对发布不完整:${id}`)
      const member = readFrozenConfigRaw(memberFile)
      if (member.configId !== id || manifest.configs?.[id] !== frozenConfigSha256(member) || readFileSync(memberHash, 'utf8').trim() !== manifest.configs[id]) {
        throw new FrozenConfigError(`冻结配置对 hash 不一致:${id}`)
      }
    }
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
  const legacy = readdirSorted(configRoot)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
  const bundles = join(configRoot, 'freezes')
  const frozen = existsSync(bundles) ? readdirSorted(bundles).flatMap((prefix) => {
    safeSegment('freeze prefix', prefix)
    const ids = [`${prefix}-baseline`, `${prefix}-candidate`]
    ids.forEach((id) => loadFrozenConfig(configRoot, id))
    return ids
  }) : []
  return [...legacy, ...frozen].sort()
}

function readdirSorted(dir: string): string[] {
  return readdirSync(dir).sort()
}

/** 读取目录内全部冻结配置(任一损坏即抛错:数据问题必须显式暴露) */
export function loadAllFrozenConfigs(configRoot: string): FrozenEvalConfig[] {
  return listFrozenConfigIds(configRoot).map((id) => loadFrozenConfig(configRoot, id))
}
