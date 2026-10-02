import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { resolveEvalPaths } from '../../src/main/evals/resources'
import { listFrozenConfigIds, loadFrozenConfig, saveFrozenConfig, type FrozenEvalConfig } from '../../src/main/evals/configStore'
import { loadTemplateFor } from '../../src/main/evals/completerFactory'
import type { FreezeInput } from '../../src/shared/evals'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync), writeFileSync: vi.fn(actual.writeFileSync) }
})

const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const versions = { codeCommit: 'a'.repeat(40), toolsVersion: 'test-tools-v1', rubricVersion: 'test-rubric-v1' }
const target = { providerId: 'provider-a', protocol: 'responses', baseUrl: 'https://MODEL.example.invalid:443/v1/', model: 'model-a' }

function saveEvidence(name: string, value: unknown): void {
  if (process.env.T14_EVIDENCE_DIR) fs.writeFileSync(join(process.env.T14_EVIDENCE_DIR, name), JSON.stringify(value, null, 2) + '\n')
}

// 新入口尚不存在时报告缺失行为断言，避免把模块加载错误冒充 red。
async function sut(): Promise<typeof import('../../src/main/evals/freeze')> {
  const file = join(process.cwd(), 'src/main/evals/freeze.ts')
  const module = fs.existsSync(file) ? await import(file) : {}
  expect(module.freezeExperiment, 'T14 freezeExperiment 必须提供离线冻结入口').toBeTypeOf('function')
  return module
}

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 't14-freeze-'))
  const sourceRoot = join(root, 'source')
  const paths = resolveEvalPaths({ packaged: false, resourceRoot: sourceRoot, sourceRoot, userData: join(root, 'user') })
  const templates = join(sourceRoot, 'evals/prompts')
  fs.mkdirSync(templates, { recursive: true })
  const configs: Record<string, { template: string; stageMarker: string }> = {}
  for (const stage of ['ops-planning', 'research-extraction']) {
    for (const variant of ['baseline', 'candidate']) {
      const id = `${stage}-${variant}`
      const stageMarker = stage === 'ops-planning' ? '你是个人事务助手的规划器' : '你是证据抽取器'
      configs[id] = { template: `${id}.txt`, stageMarker }
      fs.writeFileSync(join(templates, `${id}.txt`), `${stageMarker}。${variant} 合成模板\r\n`)
    }
  }
  fs.writeFileSync(join(templates, 'manifest.json'), JSON.stringify({ schemaVersion: 1, configs }))
  const seedDataset = (datasetVersion: string, mode: 'personal_ops' | 'research') => {
    const dir = join(paths.datasetRoot, datasetVersion)
    fs.mkdirSync(dir, { recursive: true })
    const caseDef = {
      schema_version: 1, case_id: `${datasetVersion}-case`, dataset_version: datasetVersion, mode,
      category: '合成只读', split: 'dev', input: `合成输入 ${datasetVersion}`, fixture_id: mode === 'research' ? 'research-synthetic' : 'ops-empty',
      clock: '2026-10-02T00:00:00Z', timezone: 'Asia/Shanghai', expected: { terminal_status: 'succeeded' },
      budgets: { max_model_calls: 2, max_active_seconds: 5 }, interaction_script: [], tags: []
    }
    const jsonl = JSON.stringify(caseDef) + '\n'
    fs.writeFileSync(join(dir, 'cases.jsonl'), jsonl)
    fs.writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ dataset_version: datasetVersion, schema_version: 1, cases_sha256: sha(jsonl), total: 1, categories: { 合成只读: { total: 1, dev: 1, holdout: 0 } }, provenance: 'synthetic test' }))
  }
  seedDataset('ops_synthetic_v2', 'personal_ops')
  seedDataset('research_synthetic_v1', 'research')
  fs.mkdirSync(join(paths.fixtureRoot, 'research-synthetic'), { recursive: true })
  fs.writeFileSync(join(paths.fixtureRoot, 'research-synthetic', 'source.txt'), '合成研究资料\r\n')
  const input: FreezeInput = { experimentId: 'adc-test', datasetVersion: 'ops_synthetic_v2', stage: 'ops-planning', executionKind: 'fake', target: null }
  return { root, sourceRoot, paths, input, research: { ...input, datasetVersion: 'research_synthetic_v1', stage: 'research-extraction' as const } }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(fs.renameSync).mockReset()
  vi.mocked(fs.writeFileSync).mockReset()
})

describe('T14 schema 2 离线冻结入口', () => {
  it('主代理使用 freezeEvalExperiment(paths,input,codeCommit,versions) 导出冻结入口', async () => {
    const module = await sut()
    expect(module.freezeEvalExperiment).toBeTypeOf('function')
    const f = fixture()
    const pair = module.freezeEvalExperiment(f.paths, f.input, versions.codeCommit, versions)
    expect(pair.baseline.config.target).toBeNull()
    expect(pair.candidate.config.target).toBeNull()
    expect(pair.baseline.config.configId).toBe('adc-test-ops_synthetic_v2-ops-planning-fake-baseline')
  })

  it('新用户目录先 Ops 后 Research 初始化，ID 不冲突且模板来自只读根', async () => {
    const { freezeExperiment, validateFrozenExperiment } = await sut()
    const f = fixture()
    expect((f.paths as { templateRoot?: string }).templateRoot).toBe(join(f.sourceRoot, 'evals/prompts'))
    expect(fs.existsSync(f.paths.configRoot)).toBe(false)
    const ops = freezeExperiment(f.paths, f.input, versions)
    const research = freezeExperiment(f.paths, f.research, versions)
    expect(ops.baseline.config.configId).toBe('adc-test-ops_synthetic_v2-ops-planning-fake-baseline')
    expect(research.baseline.config.configId).toBe('adc-test-research_synthetic_v1-research-extraction-fake-baseline')
    expect(listFrozenConfigIds(f.paths.configRoot)).toHaveLength(4)
    for (const pair of [ops, research]) {
      for (const frozen of [pair.baseline, pair.candidate]) {
        expect(frozen.config.schemaVersion).toBe(2)
        expect(frozen.config.targetSha256).toBe(sha('{"executionKind":"fake"}'))
        expect(loadFrozenConfig(f.paths.configRoot, frozen.config.configId)).toEqual(frozen.config)
        expect(frozen.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(loadTemplateFor(join(f.paths.configRoot, 'templates'), frozen.config.configId).sha256).toBe(frozen.config.promptSha256)
        expect(validateFrozenExperiment(f.paths, frozen.config.configId, versions).config).toEqual(frozen.config)
      }
    }
    expect(ops.baseline.config.promptSha256).not.toBe(ops.candidate.config.promptSha256)
    expect(freezeExperiment(f.paths, f.input, versions)).toEqual(ops)
    saveEvidence('freeze-inventory.json', { datasetKind: 'synthetic-only', ops, research })
    saveEvidence('resource-paths.json', { development: f.paths, packaged: resolveEvalPaths({ packaged: true, resourceRoot: join(f.root, 'packaged'), sourceRoot: f.sourceRoot, userData: join(f.root, 'packaged-user') }) })
    saveEvidence('ops-freeze-manifest.json', JSON.parse(fs.readFileSync(ops.manifestFile, 'utf8')))
    saveEvidence('research-freeze-manifest.json', JSON.parse(fs.readFileSync(research.manifestFile, 'utf8')))
  })

  it('打包 templateRoot 来自资源根，写入只在 userData', () => {
    const paths = resolveEvalPaths({ packaged: true, resourceRoot: 'C:/resources', sourceRoot: 'C:/source', userData: 'C:/user' })
    expect((paths as { templateRoot?: string }).templateRoot).toBe(join('C:/resources', 'evals/prompts'))
  })

  it.each(['source template', 'frozen template', 'fixture', 'annotation', 'dataset manifest', 'budget', 'interaction', 'code', 'tools', 'rubric'] as const)(
    '%s 内容变化必须即时拒绝，缓存和旧 manifest 不能掩盖漂移', async (changed) => {
      const { freezeExperiment, validateFrozenExperiment } = await sut()
      const f = fixture()
      const pair = freezeExperiment(f.paths, f.research, versions)
      const id = pair.baseline.config.configId
      validateFrozenExperiment(f.paths, id, versions)
      let currentVersions = { ...versions }
      const datasetDir = join(f.paths.datasetRoot, f.research.datasetVersion)
      if (changed === 'source template') fs.appendFileSync(join(f.paths.templateRoot, 'research-extraction-baseline.txt'), 'changed')
      if (changed === 'frozen template') fs.appendFileSync(loadTemplateFor(join(f.paths.configRoot, 'templates'), id).file, 'changed')
      if (changed === 'fixture') fs.appendFileSync(join(f.paths.fixtureRoot, 'research-synthetic/source.txt'), 'changed')
      if (changed === 'annotation') fs.writeFileSync(join(datasetDir, 'annotation.json'), '{"new":"annotation"}')
      if (changed === 'dataset manifest') {
        const file = join(datasetDir, 'manifest.json')
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
        fs.writeFileSync(file, JSON.stringify({ ...manifest, provenance: 'changed' }))
      }
      if (changed === 'budget' || changed === 'interaction') {
        const row = JSON.parse(fs.readFileSync(join(datasetDir, 'cases.jsonl'), 'utf8'))
        if (changed === 'budget') row.budgets.max_model_calls = 3
        else row.interaction_script = [{ on: 'clarification', answer: 'synthetic changed' }]
        const text = JSON.stringify(row) + '\n'
        fs.writeFileSync(join(datasetDir, 'cases.jsonl'), text)
        const manifest = JSON.parse(fs.readFileSync(join(datasetDir, 'manifest.json'), 'utf8'))
        fs.writeFileSync(join(datasetDir, 'manifest.json'), JSON.stringify({ ...manifest, cases_sha256: sha(text) }))
      }
      if (changed === 'code') currentVersions.codeCommit = 'b'.repeat(40)
      if (changed === 'tools') currentVersions.toolsVersion = 'test-tools-v2'
      if (changed === 'rubric') currentVersions.rubricVersion = 'test-rubric-v2'
      expect(() => validateFrozenExperiment(f.paths, id, currentVersions)).toThrow()
      expect(() => freezeExperiment(f.paths, f.research, currentVersions)).toThrow()
    }
  )

  it('real target 无密钥规范化并绑定 hash，fake/real 不共用 ID', async () => {
    const { freezeExperiment, targetProfileSha256, validateFrozenExperiment } = await sut()
    const f = fixture()
    const fake = freezeExperiment(f.paths, f.input, versions)
    const real = freezeExperiment(f.paths, { ...f.input, executionKind: 'real', target }, versions)
    expect(real.baseline.config.configId).toContain('-real-baseline')
    expect(real.baseline.config.configId).not.toBe(fake.baseline.config.configId)
    expect(real.baseline.config.targetSha256).toBe(targetProfileSha256('real', { ...target, baseUrl: 'https://model.example.invalid/v1' }))
    const loaded = validateFrozenExperiment(f.paths, real.baseline.config.configId, versions)
    expect(loaded.target).toEqual({ ...target, baseUrl: 'https://model.example.invalid/v1' })
    expect(loaded.config.target).toEqual(loaded.target)
    expect(loaded.config.model).toBe('model-a')
    expect(loaded.config.providerId).toBe('provider-a')
    saveEvidence('target-profile.json', { config: loaded.config, target: loaded.target, configSha256: loaded.sha256 })
  })

  it('同 ID real target 不同内容拒绝，原配置和模板映射完整保留', async () => {
    const { freezeExperiment } = await sut()
    const f = fixture()
    const input = { ...f.input, executionKind: 'real' as const, target }
    const pair = freezeExperiment(f.paths, input, versions)
    const manifestBefore = fs.readFileSync(join(f.paths.configRoot, 'templates/manifest.json'), 'utf8')
    expect(() => freezeExperiment(f.paths, { ...input, target: { ...target, model: 'other-model' } }, versions)).toThrow(/同 ID 不同内容/)
    expect(loadFrozenConfig(f.paths.configRoot, pair.baseline.config.configId)).toEqual(pair.baseline.config)
    expect(fs.readFileSync(join(f.paths.configRoot, 'templates/manifest.json'), 'utf8')).toBe(manifestBefore)
  })

  it.each([
    { ...target, apiKey: 'synthetic-secret-never-print' },
    { ...target, protocol: 'arbitrary' },
    { ...target, baseUrl: 'file:///tmp/model' },
    { ...target, baseUrl: 'https://user:synthetic-secret-never-print@model.invalid/v1' },
    { ...target, baseUrl: 'https://model.invalid/v1?api_key=synthetic-secret-never-print' },
    { ...target, baseUrl: 'https://model.invalid/v1#synthetic-secret-never-print' }
  ])('非法/含凭据 target 在任何写入前拒绝（%#）', async (bad) => {
    const { freezeExperiment } = await sut()
    const f = fixture()
    let error: unknown
    try { freezeExperiment(f.paths, { ...f.input, executionKind: 'real', target: bad }, versions) } catch (err) { error = err }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain('synthetic-secret-never-print')
    expect(fs.existsSync(f.paths.configRoot)).toBe(false)
  })

  it.each(['../escape', 'CON', 'x/y', 'x\\y', 'bad.'])('危险 ID 段 %s 在写入前拒绝', async (experimentId) => {
    const { freezeExperiment } = await sut()
    const f = fixture()
    expect(() => freezeExperiment(f.paths, { ...f.input, experimentId }, versions)).toThrow()
    expect(fs.existsSync(f.paths.configRoot)).toBe(false)
  })

  it.each(['missing template', 'wrong stage', 'missing research fixture', 'wrong dataset stage', 'missing target', 'fake with target'] as const)(
    '%s 在写入前拒绝', async (invalid) => {
      const { freezeExperiment } = await sut()
      const f = fixture()
      let input = f.research as FreezeInput
      if (invalid === 'missing template') fs.unlinkSync(join(f.paths.templateRoot, 'research-extraction-candidate.txt'))
      if (invalid === 'wrong stage') {
        const file = join(f.paths.templateRoot, 'manifest.json')
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
        manifest.configs['research-extraction-baseline'].stageMarker = '你是个人事务助手的规划器'
        fs.writeFileSync(file, JSON.stringify(manifest))
      }
      if (invalid === 'missing research fixture') fs.renameSync(join(f.paths.fixtureRoot, 'research-synthetic'), join(f.root, 'hidden-fixture'))
      if (invalid === 'wrong dataset stage') input = { ...f.input, stage: 'research-extraction' }
      if (invalid === 'missing target') input = { ...f.input, executionKind: 'real', target: null }
      if (invalid === 'fake with target') input = { ...f.input, target }
      expect(() => freezeExperiment(f.paths, input, versions)).toThrow()
      expect(fs.existsSync(f.paths.configRoot)).toBe(false)
    }
  )

  it('发布中断不暴露半对配置，历史配置仍完整，暂存残留可诊断', async () => {
    const { freezeExperiment } = await sut()
    const f = fixture()
    const existing = freezeExperiment(f.paths, f.input, versions)
    const before = listFrozenConfigIds(f.paths.configRoot)
    const originalRename = (await vi.importActual<typeof fs>('node:fs')).renameSync
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(to).includes('research_synthetic_v1') && !String(to).endsWith('.tmp')) throw new Error('synthetic publish interruption')
      originalRename(from, to)
    })
    expect(() => freezeExperiment(f.paths, f.research, versions)).toThrow('synthetic publish interruption')
    expect(listFrozenConfigIds(f.paths.configRoot)).toEqual(before)
    expect(loadFrozenConfig(f.paths.configRoot, existing.baseline.config.configId)).toEqual(existing.baseline.config)
    expect(() => loadFrozenConfig(f.paths.configRoot, 'adc-test-research_synthetic_v1-research-extraction-fake-baseline')).toThrow()
  })

  it('模板写入被截断时校验暂存副本并拒绝发布新配置对', async () => {
    const { freezeExperiment } = await sut()
    const f = fixture()
    const existing = freezeExperiment(f.paths, f.input, versions)
    const before = listFrozenConfigIds(f.paths.configRoot)
    const write = (await vi.importActual<typeof fs>('node:fs')).writeFileSync
    vi.mocked(fs.writeFileSync).mockImplementation((file, data, options) => {
      if (String(file).endsWith('research-extraction-fake-candidate.txt')) write(file, 'synthetic truncated', options)
      else write(file, data, options)
    })
    expect(() => freezeExperiment(f.paths, f.research, versions)).toThrow(/模板|完整性|hash/)
    expect(listFrozenConfigIds(f.paths.configRoot)).toEqual(before)
    expect(loadFrozenConfig(f.paths.configRoot, existing.baseline.config.configId)).toEqual(existing.baseline.config)
  })

  it('冻结 bundle manifest 缺失或 target 被篡改不能读入或幂等复用', async () => {
    const { freezeExperiment, validateFrozenExperiment } = await sut()
    const f = fixture()
    const pair = freezeExperiment(f.paths, { ...f.input, executionKind: 'real', target }, versions)
    const raw = JSON.parse(fs.readFileSync(pair.manifestFile, 'utf8'))
    raw.target.model = 'forged'
    fs.writeFileSync(pair.manifestFile, JSON.stringify(raw))
    expect(() => validateFrozenExperiment(f.paths, pair.baseline.config.configId, versions)).toThrow()
    fs.unlinkSync(pair.manifestFile)
    expect(() => loadFrozenConfig(f.paths.configRoot, pair.baseline.config.configId)).toThrow()
    expect(() => freezeExperiment(f.paths, { ...f.input, executionKind: 'real', target }, versions)).toThrow()
  })
})
