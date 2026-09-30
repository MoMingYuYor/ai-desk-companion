// EVAL-04 冻结配置存储测试:不可变目录、同 ID 拒绝改写、重启读回同一 hash、
// 实际配置 hash 单独保存、损坏/篡改报错保留原文件、schema 与路径 ID 校验、
// 首轮 baseline/candidate 冻结配置的 promptSha256 对应实际模板内容。
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  COMPARABLE_VARIABLES,
  FrozenConfigError,
  frozenConfigSha256,
  listFrozenConfigIds,
  loadAllFrozenConfigs,
  loadFrozenConfig,
  saveFrozenConfig,
  validateFrozenConfig,
  type FrozenEvalConfig
} from '../../src/main/evals/configStore'
import { loadTemplateFor, roundOneConfigs } from '../../src/main/evals/completerFactory'
import { PLAN_SYSTEM_PROMPT } from '../../src/main/agent/planner'
import { RESEARCH_EXTRACTION_SYSTEM_PROMPT } from '../../src/main/research/workflow'

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

function sampleConfig(over: Partial<FrozenEvalConfig> = {}): FrozenEvalConfig {
  return {
    schemaVersion: 1,
    configId: 'ops-planning-baseline',
    executionKind: 'fake',
    model: 'fake-model',
    providerId: 'eval-fake',
    pipelineVariant: 'baseline',
    promptSha256: sha('prompt-baseline'),
    toolsVersion: '0.1.0-test',
    codeCommit: 'c0ffee',
    datasetSha256: sha('dataset'),
    fixtureSha256: sha('fixture'),
    budgetSha256: sha('budget'),
    interactionScriptSha256: sha('interaction-script'),
    rubricVersion: 'rubric-v1',
    ...over
  }
}

describe('configStore:不可变冻结配置目录', () => {
  it('写入后重启读回同一 hash;实际配置 hash 单独保存为 sidecar', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-config-'))
    const config = sampleConfig()
    const saved = saveFrozenConfig(root, config)
    expect(saved.sha256).toBe(frozenConfigSha256(config))
    // hash 单独保存(不在 config JSON 内)
    expect((config as unknown as Record<string, unknown>).configSha256).toBeUndefined()
    const sidecar = readFileSync(join(root, 'ops-planning-baseline.sha256'), 'utf-8').trim()
    expect(sidecar).toBe(frozenConfigSha256(config))
    // 重启:重新读取得到同一 hash 与同一内容
    const reloaded = loadFrozenConfig(root, 'ops-planning-baseline')
    expect(frozenConfigSha256(reloaded)).toBe(frozenConfigSha256(config))
    expect(reloaded).toEqual(config)
  })

  it('同 ID 同内容幂等;同 ID 不同内容拒绝且原文件不变', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-config-'))
    const config = sampleConfig()
    saveFrozenConfig(root, config)
    expect(() => saveFrozenConfig(root, config)).not.toThrow()
    const drifted = sampleConfig({ model: 'other-model', promptSha256: sha('other') })
    expect(() => saveFrozenConfig(root, drifted)).toThrow(FrozenConfigError)
    expect(() => saveFrozenConfig(root, drifted)).toThrow(/同 ID 不同内容/)
    // 原文件未被覆盖
    const onDisk = JSON.parse(readFileSync(join(root, 'ops-planning-baseline.json'), 'utf-8')) as FrozenEvalConfig
    expect(onDisk.model).toBe('fake-model')
  })

  it('损坏 JSON:抛可诊断错误并保留原文件,不静默重置', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-config-'))
    const file = join(root, 'ops-planning-baseline.json')
    writeFileSync(file, '{ "configId": "broken', 'utf-8')
    const before = readFileSync(file, 'utf-8')
    expect(() => loadFrozenConfig(root, 'ops-planning-baseline')).toThrow(FrozenConfigError)
    expect(() => loadFrozenConfig(root, 'ops-planning-baseline')).toThrow(/损坏/)
    expect(readFileSync(file, 'utf-8')).toBe(before)
  })

  it('内容被篡改(hash 文件仍为旧值):报错;hash 文件缺失:报错', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-config-'))
    saveFrozenConfig(root, sampleConfig())
    // 篡改内容但保留旧 sidecar → 内容不可信
    writeFileSync(join(root, 'ops-planning-baseline.json'), JSON.stringify(sampleConfig({ model: 'forged' }), null, 2), 'utf-8')
    expect(() => loadFrozenConfig(root, 'ops-planning-baseline')).toThrow(/hash 不一致/)

    // hash sidecar 缺失(如手工误删):内容无法核对可信性
    const root2 = mkdtempSync(join(tmpdir(), 'eval-config-'))
    saveFrozenConfig(root2, sampleConfig({ configId: 'no-sidecar' }))
    unlinkSync(join(root2, 'no-sidecar.sha256'))
    expect(() => loadFrozenConfig(root2, 'no-sidecar')).toThrow(/hash 文件缺失/)
  })

  it('schema 校验:未知字段、坏 sha 形状、非法枚举、缺字段拒绝', () => {
    expect(() => validateFrozenConfig({ ...sampleConfig(), surprise: 1 })).toThrow(/未知字段/)
    expect(() => validateFrozenConfig({ ...sampleConfig(), promptSha256: 'abc' })).toThrow(/sha256/)
    expect(() => validateFrozenConfig({ ...sampleConfig(), executionKind: 'both' })).toThrow(/executionKind/)
    expect(() => validateFrozenConfig({ ...sampleConfig(), pipelineVariant: 'control' })).toThrow(/pipelineVariant/)
    expect(() => validateFrozenConfig({ ...sampleConfig(), rubricVersion: '' })).toThrow(/rubricVersion/)
    expect(() => validateFrozenConfig({ ...sampleConfig(), schemaVersion: 2 })).toThrow(/schemaVersion/)
    expect(() => validateFrozenConfig(null)).toThrow(FrozenConfigError)
    expect(validateFrozenConfig(sampleConfig())).toEqual(sampleConfig())
  })

  it('路径 ID 校验:configId 为 "."/".."/含路径分隔符拒绝', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-config-'))
    expect(() => saveFrozenConfig(root, sampleConfig({ configId: '..' }))).toThrow(FrozenConfigError)
    expect(() => saveFrozenConfig(root, sampleConfig({ configId: 'a/b' }))).toThrow(FrozenConfigError)
    expect(() => saveFrozenConfig(root, sampleConfig({ configId: '.hidden' }))).toThrow(FrozenConfigError)
    expect(existsSync(join(root, 'configs.json'))).toBe(false)
  })

  it('目录发现:listFrozenConfigIds 与 loadAllFrozenConfigs;任一损坏抛错', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-config-'))
    expect(listFrozenConfigIds(root)).toEqual([])
    saveFrozenConfig(root, sampleConfig())
    saveFrozenConfig(root, sampleConfig({ configId: 'ops-planning-candidate', pipelineVariant: 'candidate', promptSha256: sha('p2') }))
    expect(listFrozenConfigIds(root)).toEqual(['ops-planning-baseline', 'ops-planning-candidate'])
    expect(loadAllFrozenConfigs(root)).toHaveLength(2)
    // 目录里出现坏配置:发现即抛错,不静默跳过
    writeFileSync(join(root, 'zz-broken.json'), 'not-json', 'utf-8')
    expect(() => loadAllFrozenConfigs(root)).toThrow(FrozenConfigError)
  })

  it('允许比较的变量清单显式记录:只含流程变量', () => {
    expect(COMPARABLE_VARIABLES).toEqual(['pipelineVariant', 'promptSha256'])
  })
})

describe('EVAL-04 首轮对照冻结配置(roundOneConfigs)', () => {
  const TEMPLATE_ROOT = join(process.cwd(), 'evals', 'prompts')
  const fixedInput = {
    datasetSha256: sha('dataset'),
    fixtureSha256: sha('fixture'),
    budgetSha256: sha('budget'),
    interactionScriptSha256: sha('interaction-script'),
    codeCommit: 'c0ffee',
    toolsVersion: '0.1.0-test',
    rubricVersion: 'rubric-v1'
  }

  it('ops-planning:baseline/candidate 的 promptSha256 对应实际模板文件内容且两版不同', () => {
    const { baseline, candidate } = roundOneConfigs('ops-planning', fixedInput, TEMPLATE_ROOT)
    expect(baseline.configId).toBe('ops-planning-baseline')
    expect(candidate.configId).toBe('ops-planning-candidate')
    expect(baseline.pipelineVariant).toBe('baseline')
    expect(candidate.pipelineVariant).toBe('candidate')
    const tb = loadTemplateFor(TEMPLATE_ROOT, baseline.configId)
    const tc = loadTemplateFor(TEMPLATE_ROOT, candidate.configId)
    expect(baseline.promptSha256).toBe(tb.sha256)
    expect(candidate.promptSha256).toBe(tc.sha256)
    // 两份冻结配置必须实际使用不同模板:内容与 hash 都不同,不是只改标签
    expect(baseline.promptSha256).not.toBe(candidate.promptSha256)
    expect(tb.content).not.toBe(tc.content)
    // 候选模板 = 基准模板 + 开发集示例(共同保留规则;示例只取 dev)
    expect(tc.content.startsWith(tb.content)).toBe(true)
    expect(tc.content).toContain('开发集示例')
    // 除记录的流程变量外逐字段一致(同模型/数据/工具/预算/审批脚本/rubric)
    const strip = (c: FrozenEvalConfig) => ({ ...c, configId: '', pipelineVariant: '', promptSha256: '' })
    expect(strip(candidate)).toEqual(strip(baseline))
  })

  it('research-extraction:同样产出两版不同模板的冻结配置', () => {
    const { baseline, candidate } = roundOneConfigs('research-extraction', fixedInput, TEMPLATE_ROOT)
    const tb = loadTemplateFor(TEMPLATE_ROOT, baseline.configId)
    const tc = loadTemplateFor(TEMPLATE_ROOT, candidate.configId)
    expect(baseline.promptSha256).toBe(tb.sha256)
    expect(candidate.promptSha256).toBe(tc.sha256)
    expect(baseline.promptSha256).not.toBe(candidate.promptSha256)
    expect(tc.content.startsWith(tb.content)).toBe(true)
  })

  it('基准模板与源码内置提示词逐字节一致(冻结基准=现行提示词)', () => {
    expect(readFileSync(join(TEMPLATE_ROOT, 'ops-planning-baseline.txt'), 'utf-8')).toBe(PLAN_SYSTEM_PROMPT)
    expect(readFileSync(join(TEMPLATE_ROOT, 'research-extraction-baseline.txt'), 'utf-8')).toBe(RESEARCH_EXTRACTION_SYSTEM_PROMPT)
  })

  it('未登记的 configId 无法解析模板(配置与模板 manifest 必须对应)', () => {
    expect(() => loadTemplateFor(TEMPLATE_ROOT, 'not-in-manifest')).toThrow(/manifest/)
  })
})
