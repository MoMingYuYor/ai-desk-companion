// 离线冻结：先验证全部只读资源，再暂存配置对，最后以目录 rename 一次发布。
// 每次启动重读实际内容，缓存与旧 manifest 不能替代当前字节的完整性检查。
import { randomUUID, createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { EvalFreezeStage, EvalFreezeVersions, EvalTargetProfile, FreezeInput, Schema2FrozenEvalConfig } from '../../shared/evals'
import { defaultCodeVersion, safeSegment } from './artifacts'
import { evalTargetSha256, normalizeEvalTarget, FrozenConfigError, frozenConfigSha256, loadFrozenConfig, saveFrozenConfig, stableValueSha256, validateFrozenConfig } from './configStore'
import { loadDatasetFromDir, type LoadedDataset } from './dataset'
import { getFixtureById } from './isolation'
import { loadPromptTemplateManifest, loadTemplateFor, type PromptTemplateManifest } from './completerFactory'
import type { EvalResourcePaths } from './resources'

export type { EvalTargetProfile, FreezeInput, EvalFreezeVersions } from '../../shared/evals'
export { normalizeEvalTarget as normalizeTargetProfile } from './configStore'

export interface FrozenConfigRef {
  config: Schema2FrozenEvalConfig
  sha256: string
}

export interface FrozenExperimentPair {
  baseline: FrozenConfigRef
  candidate: FrozenConfigRef
  manifestFile: string
  manifestSha256: string
}

interface ResourceHashes {
  datasetSha256: string
  datasetTreeSha256: string
  fixtureSha256: string
  budgetSha256: string
  interactionScriptSha256: string
  sourceTemplatesSha256: string
}

interface FreezeManifest {
  schemaVersion: 2
  input: FreezeInput
  versions: EvalFreezeVersions
  target: EvalTargetProfile | null
  hashes: ResourceHashes
  configs: Record<string, string>
  templates: Record<string, { template: string; stageMarker: string; sha256: string }>
}

const stageMarkers: Record<EvalFreezeStage, string> = {
  'ops-planning': '你是个人事务助手的规划器',
  'research-extraction': '你是证据抽取器'
}
const bytesSha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** 文件名可跨平台复用，拒绝 Windows 保留名及尾点别名。 */
function segment(label: string, value: string): string {
  safeSegment(label, value)
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) || value.endsWith('.')) {
    throw new FrozenConfigError(`${label} 含平台保留路径段`)
  }
  return value
}

export function targetProfileSha256(executionKind: 'fake' | 'real', target: EvalTargetProfile | null): string {
  if (executionKind === 'fake') {
    if (target !== null) throw new FrozenConfigError('fake target 必须为 null')
    return evalTargetSha256(null)
  }
  if (executionKind !== 'real') throw new FrozenConfigError('executionKind 非法')
  return evalTargetSha256(normalizeEvalTarget(target))
}

function checkedInput(input: FreezeInput): FreezeInput {
  if (!input || Object.keys(input).some((key) => !['experimentId', 'datasetVersion', 'stage', 'executionKind', 'target'].includes(key))) throw new FrozenConfigError('冻结输入含未知字段')
  segment('experimentId', input.experimentId)
  segment('datasetVersion', input.datasetVersion)
  if (!(input.stage in stageMarkers)) throw new FrozenConfigError('stage 非法')
  segment('stage', input.stage)
  targetProfileSha256(input.executionKind, input.target)
  return { ...input, target: input.executionKind === 'real' ? normalizeEvalTarget(input.target) : null }
}

function checkVersions(versions: EvalFreezeVersions): void {
  if (!versions || !/^[0-9a-f]{40}$/.test(versions.codeCommit)) throw new FrozenConfigError('codeCommit 必须是已提交代码的 40 位 hash')
  if (!versions.toolsVersion?.trim() || !versions.rubricVersion?.trim()) throw new FrozenConfigError('toolsVersion/rubricVersion 必须明确提供')
  if (Object.keys(versions).some((key) => !['codeCommit', 'toolsVersion', 'rubricVersion'].includes(key))) throw new FrozenConfigError('代码版本输入含未知字段')
}

export function freezeConfigIdPrefix(input: FreezeInput): string {
  const valid = checkedInput(input)
  return segment('configId prefix', `${valid.experimentId}-${valid.datasetVersion}-${valid.stage}-${valid.executionKind}`)
}

function checkPaths(paths: EvalResourcePaths): void {
  const writable = resolve(paths.configRoot)
  for (const root of [paths.datasetRoot, paths.fixtureRoot, paths.templateRoot]) {
    const readonly = resolve(root)
    if (writable === readonly || writable.startsWith(readonly + sep) || readonly.startsWith(writable + sep)) throw new FrozenConfigError('configRoot 与只读资源目录不得重叠')
  }
}

/** 按实际字节收集文件内容；拒绝符号链接，防止读取越出受控资源根。 */
function treeFiles(root: string, prefix = ''): Array<{ name: string; sha256: string }> {
  const stat = fs.lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new FrozenConfigError('资源根必须是普通目录')
  return fs.readdirSync(root).sort().flatMap((name) => {
    segment('resource file', name)
    const file = join(root, name)
    const entry = fs.lstatSync(file)
    if (entry.isSymbolicLink()) throw new FrozenConfigError('资源中禁止符号链接')
    const relative = prefix ? `${prefix}/${name}` : name
    if (entry.isDirectory()) return treeFiles(file, relative)
    if (!entry.isFile()) throw new FrozenConfigError('资源必须是普通文件')
    return [{ name: relative, sha256: bytesSha256(fs.readFileSync(file)) }]
  })
}

function resourceSnapshot(paths: EvalResourcePaths, input: FreezeInput): { hashes: ResourceHashes; dataset: LoadedDataset } {
  const datasetDir = join(paths.datasetRoot, input.datasetVersion)
  const datasetTree = treeFiles(datasetDir)
  const dataset = loadDatasetFromDir(datasetDir)
  const mode = input.stage === 'ops-planning' ? 'personal_ops' : 'research'
  if (dataset.manifest.dataset_version !== input.datasetVersion || !dataset.cases.length || dataset.cases.some((item) => item.mode !== mode)) throw new FrozenConfigError('数据集版本或模式与冻结 stage 不一致')
  const sorted = [...dataset.cases].sort((a, b) => a.case_id.localeCompare(b.case_id, 'en'))
  const fixtureIds = [...new Set(sorted.map((item) => item.fixture_id))].sort()
  const fixtureEntries = fixtureIds.map((id) => {
    segment('fixtureId', id)
    const dir = join(paths.fixtureRoot, id)
    if (!fs.existsSync(dir)) {
      if (mode === 'research' || !getFixtureById(id)) throw new FrozenConfigError(`fixture 不存在或未注册:${id}`)
      return { fixture: id, corpus: null }
    }
    const corpus = treeFiles(dir)
    if (!corpus.length) throw new FrozenConfigError(`fixture 目录为空:${id}`)
    return { fixture: id, corpus }
  })
  const templates = readStageTemplates(paths.templateRoot, input.stage)
  return {
    dataset,
    hashes: {
      datasetSha256: dataset.casesSha256,
      datasetTreeSha256: stableValueSha256(datasetTree),
      fixtureSha256: stableValueSha256(fixtureEntries),
      budgetSha256: stableValueSha256(sorted.map((item) => ({ case_id: item.case_id, budgets: item.budgets }))),
      interactionScriptSha256: stableValueSha256(sorted.map((item) => ({ case_id: item.case_id, script: item.interaction_script }))),
      sourceTemplatesSha256: stableValueSha256(templates.map((item) => ({ variant: item.variant, sha256: item.sha256, stageMarker: item.stageMarker })))
    }
  }
}

function readStageTemplates(templateRoot: string, stage: EvalFreezeStage) {
  return (['baseline', 'candidate'] as const).map((variant) => {
    const template = loadTemplateFor(templateRoot, `${stage}-${variant}`)
    if (fs.lstatSync(template.file).isSymbolicLink() || template.stageMarker !== stageMarkers[stage] || !template.content.includes(template.stageMarker)) throw new FrozenConfigError('模板与冻结 stage 不对应')
    const bytes = fs.readFileSync(template.file)
    return { ...template, variant, bytes, sha256: bytesSha256(bytes) }
  })
}

/** 明确前缀的 schema 2 构造器；组合入口替换旧首轮构造器时使用本接口。 */
export function roundOneConfigs(
  idPrefix: string, stage: EvalFreezeStage,
  common: Omit<Schema2FrozenEvalConfig, 'schemaVersion' | 'configId' | 'pipelineVariant' | 'promptSha256'>,
  templateRoot: string
): { baseline: Schema2FrozenEvalConfig; candidate: Schema2FrozenEvalConfig } {
  segment('configId prefix', idPrefix)
  const templates = readStageTemplates(templateRoot, stage)
  const build = (variant: 'baseline' | 'candidate') => validateFrozenConfig({
    ...common, schemaVersion: 2, configId: `${idPrefix}-${variant}`, pipelineVariant: variant,
    promptSha256: templates.find((template) => template.variant === variant)!.sha256
  }) as Schema2FrozenEvalConfig
  return { baseline: build('baseline'), candidate: build('candidate') }
}

function bundleRoot(paths: EvalResourcePaths, prefix: string): string {
  return join(paths.configRoot, 'freezes', segment('configId prefix', prefix))
}

function pairResult(paths: EvalResourcePaths, prefix: string): FrozenExperimentPair {
  const manifestFile = join(bundleRoot(paths, prefix), 'manifest.json')
  const baseline = loadFrozenConfig(paths.configRoot, `${prefix}-baseline`) as Schema2FrozenEvalConfig
  const candidate = loadFrozenConfig(paths.configRoot, `${prefix}-candidate`) as Schema2FrozenEvalConfig
  return { baseline: { config: baseline, sha256: frozenConfigSha256(baseline) }, candidate: { config: candidate, sha256: frozenConfigSha256(candidate) }, manifestFile, manifestSha256: fs.readFileSync(join(bundleRoot(paths, prefix), 'manifest.sha256'), 'utf8').trim() }
}

/** 暂存目录和 manifest/hash 中断时保留，已发布的配置对完全不受影响。 */
export function freezeExperiment(paths: EvalResourcePaths, rawInput: FreezeInput, versions: EvalFreezeVersions): FrozenExperimentPair {
  const input = checkedInput(rawInput)
  checkVersions(versions)
  checkPaths(paths)
  const prefix = freezeConfigIdPrefix(input)
  const snapshot = resourceSnapshot(paths, input)
  const templates = readStageTemplates(paths.templateRoot, input.stage)
  const configs = roundOneConfigs(prefix, input.stage, {
    executionKind: input.executionKind, model: input.target?.model ?? 'fake-model', providerId: input.target?.providerId ?? 'eval-fake',
    ...versions, datasetSha256: snapshot.hashes.datasetSha256, fixtureSha256: snapshot.hashes.fixtureSha256,
    budgetSha256: snapshot.hashes.budgetSha256, interactionScriptSha256: snapshot.hashes.interactionScriptSha256,
    target: input.target, targetSha256: targetProfileSha256(input.executionKind, input.target)
  }, paths.templateRoot)
  const final = bundleRoot(paths, prefix)
  if (fs.existsSync(final)) {
    const existing = pairResult(paths, prefix)
    for (const variant of ['baseline', 'candidate'] as const) {
      validateFrozenExperiment(paths, existing[variant].config.configId, versions)
      if (existing[variant].sha256 !== frozenConfigSha256(configs[variant])) throw new FrozenConfigError('同 ID 不同内容，拒绝覆盖冻结配置')
    }
    return existing
  }
  for (const config of Object.values(configs)) {
    if (fs.existsSync(join(paths.configRoot, `${config.configId}.json`)) || fs.existsSync(join(paths.configRoot, `${config.configId}.sha256`))) throw new FrozenConfigError('同 ID 已存在历史配置，拒绝覆盖')
  }
  const frozenTemplates = join(paths.configRoot, 'templates')
  const currentManifest: PromptTemplateManifest = fs.existsSync(join(frozenTemplates, 'manifest.json')) ? loadPromptTemplateManifest(frozenTemplates) : { schemaVersion: 1, configs: {} }
  const manifest: FreezeManifest = { schemaVersion: 2, input, versions: { ...versions }, target: input.target, hashes: snapshot.hashes, configs: {}, templates: {} }
  for (const template of templates) {
    const config = configs[template.variant]
    const id = config.configId
    const name = `${id}.txt`
    const entry = { template: name, stageMarker: template.stageMarker }
    const existing = currentManifest.configs[id]
    if (existing && stableValueSha256(existing) !== stableValueSha256(entry)) throw new FrozenConfigError('同 ID 模板映射冲突，拒绝覆盖')
    const file = join(frozenTemplates, name)
    if (fs.existsSync(file) && bytesSha256(fs.readFileSync(file)) !== template.sha256) throw new FrozenConfigError('同 ID 模板内容不同，拒绝覆盖')
    currentManifest.configs[id] = entry
    manifest.templates[id] = { ...entry, sha256: template.sha256 }
    manifest.configs[id] = frozenConfigSha256(config)
  }
  fs.mkdirSync(paths.configRoot, { recursive: true })
  const staging = join(paths.configRoot, `.staging-${prefix}-${randomUUID()}`)
  fs.mkdirSync(staging)
  for (const config of Object.values(configs)) saveFrozenConfig(staging, config)
  fs.writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  fs.writeFileSync(join(staging, 'manifest.sha256'), stableValueSha256(manifest) + '\n', { flag: 'wx' })
  // 暂存内容全部读回校验；资源发生变化则禁止发布。
  for (const config of Object.values(configs)) loadFrozenConfig(staging, config.configId)
  const stagedManifest = JSON.parse(fs.readFileSync(join(staging, 'manifest.json'), 'utf8'))
  if (stableValueSha256(stagedManifest) !== stableValueSha256(manifest) || fs.readFileSync(join(staging, 'manifest.sha256'), 'utf8').trim() !== stableValueSha256(manifest)) throw new FrozenConfigError('暂存 manifest 完整性 hash 不一致')
  if (stableValueSha256(resourceSnapshot(paths, input).hashes) !== stableValueSha256(snapshot.hashes)) throw new FrozenConfigError('冻结准备期间资源变化，拒绝发布')
  fs.mkdirSync(frozenTemplates, { recursive: true })
  for (const template of templates) {
    const file = join(frozenTemplates, `${configs[template.variant].configId}.txt`)
    if (!fs.existsSync(file)) fs.writeFileSync(file, template.bytes, { flag: 'wx' })
  }
  const templateManifestTmp = join(frozenTemplates, `manifest.${randomUUID()}.tmp`)
  fs.writeFileSync(templateManifestTmp, JSON.stringify(currentManifest, null, 2) + '\n', { flag: 'wx' })
  if (stableValueSha256(JSON.parse(fs.readFileSync(templateManifestTmp, 'utf8'))) !== stableValueSha256(currentManifest)) throw new FrozenConfigError('暂存模板 manifest 完整性 hash 不一致')
  for (const [id, entry] of Object.entries(manifest.templates)) {
    const file = join(frozenTemplates, entry.template)
    if (fs.lstatSync(file).isSymbolicLink() || bytesSha256(fs.readFileSync(file)) !== configs[id.endsWith('-baseline') ? 'baseline' : 'candidate'].promptSha256) throw new FrozenConfigError('冻结模板副本完整性 hash 不一致')
  }
  fs.renameSync(templateManifestTmp, join(frozenTemplates, 'manifest.json'))
  fs.mkdirSync(join(paths.configRoot, 'freezes'), { recursive: true })
  // 配置对与校验 manifest 同目录，最后一步 rename 才使整个实验可发现。
  fs.renameSync(staging, final)
  return pairResult(paths, prefix)
}

/** 启动前必须调用，返回可信冻结配置与规范化无密钥 target，不发生网络或业务库 IO。 */
export function validateFrozenExperiment(paths: EvalResourcePaths, configId: string, versions: EvalFreezeVersions): FrozenConfigRef & { target: EvalTargetProfile | null } {
  checkVersions(versions)
  checkPaths(paths)
  const config = loadFrozenConfig(paths.configRoot, configId)
  if (config.schemaVersion !== 2) throw new FrozenConfigError('新实验启动要求 schema 2 重新冻结')
  const prefix = configId.replace(/-(baseline|candidate)$/, '')
  const manifestFile = join(bundleRoot(paths, prefix), 'manifest.json')
  let manifest: FreezeManifest
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) } catch { throw new FrozenConfigError('冻结 bundle manifest 缺失或损坏') }
  const input = checkedInput(manifest.input)
  if (freezeConfigIdPrefix(input) !== prefix || manifest.configs[configId] !== frozenConfigSha256(config)) throw new FrozenConfigError('冻结清单与配置 ID/hash 不一致')
  if (stableValueSha256(manifest.versions) !== stableValueSha256(versions)) throw new FrozenConfigError('代码/tools/rubric 版本与冻结清单不一致')
  const targetHash = targetProfileSha256(input.executionKind, manifest.target)
  if (targetHash !== config.targetSha256 || stableValueSha256(input.target) !== stableValueSha256(manifest.target)) throw new FrozenConfigError('无密钥 target 与冻结 hash 不一致')
  if (config.executionKind !== input.executionKind || config.model !== (manifest.target?.model ?? 'fake-model') || config.providerId !== (manifest.target?.providerId ?? 'eval-fake')) throw new FrozenConfigError('配置路由与冻结 target 不一致')
  const current = resourceSnapshot(paths, input).hashes
  if (stableValueSha256(current) !== stableValueSha256(manifest.hashes)) throw new FrozenConfigError('dataset/fixture/budget/interaction/prompt 资源发生漂移')
  for (const field of ['datasetSha256', 'fixtureSha256', 'budgetSha256', 'interactionScriptSha256'] as const) {
    if (config[field] !== current[field]) throw new FrozenConfigError(`配置 ${field} 与实际资源不一致`)
  }
  const template = loadTemplateFor(join(paths.configRoot, 'templates'), configId)
  const declared = manifest.templates[configId]
  if (!declared || template.sha256 !== config.promptSha256 || template.sha256 !== declared.sha256 || template.stageMarker !== stageMarkers[input.stage] || template.stageMarker !== declared.stageMarker || template.file !== resolve(paths.configRoot, 'templates', declared.template)) throw new FrozenConfigError('冻结模板内容或映射被篡改')
  return { config: config as Schema2FrozenEvalConfig, sha256: frozenConfigSha256(config), target: manifest.target }
}

/** CLI/API 组合入口。未提供 codeCommit 时显式拒绝；tools/rubric 可由入口覆盖。 */
export function freezeEvalExperiment(
  paths: EvalResourcePaths, input: FreezeInput, codeCommit?: string,
  versions: Partial<EvalFreezeVersions> = {}
): FrozenExperimentPair {
  if (codeCommit && versions.codeCommit && codeCommit !== versions.codeCommit) throw new FrozenConfigError('codeCommit 参数与版本输入不一致')
  return freezeExperiment(paths, input, {
    codeCommit: codeCommit ?? versions.codeCommit ?? '',
    toolsVersion: versions.toolsVersion ?? defaultCodeVersion(),
    rubricVersion: versions.rubricVersion ?? 'rubric-v1'
  })
}
