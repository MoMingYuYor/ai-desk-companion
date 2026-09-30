// EXP-01:实验计划展开与请求上限的单元测试。
//
// 覆盖(交付计划 EXP-01 可先行部分):
// - maximumRequestCount 规范手算用例与无效上限拒绝;
// - expandExperimentItems 的 case/config/repeat 三元组展开正确性;
// - 真实数据集(personal_ops_v1 + research_v1)90×2×3=540 全量展开计数与请求上限总量;
// - smoke 子集(10 Ops + 5 Research)的确定性选择与五类覆盖;
// - artifacts/experiments/experiment-plan.json 与代码实现的一致性(防计划与代码漂移)。
//
// 本测试不调用任何真实模型;fake 通路证据见 tests/evals/ops50.test.ts、
// tests/evals/researchIntegration.test.ts 与 tests/evals/runner.test.ts。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadDatasetFromDir } from '../../src/main/evals/dataset'
import {
  expandExperimentItems,
  maximumRequestCount,
  resolveCaseMaxModelCalls,
  selectSmokeSubset,
  SMOKE_SELECTION_RULES,
  type ExperimentItem
} from '../../src/main/evals/experiment'
import type { EvalCase } from '../../src/main/evals/types'

const OPS_DIR = join(process.cwd(), 'evals', 'datasets', 'personal_ops_v1')
const RESEARCH_DIR = join(process.cwd(), 'evals', 'datasets', 'research_v1')
const PLAN_PATH = join(process.cwd(), 'artifacts', 'experiments', 'experiment-plan.json')

const BASELINE = { configId: 'baseline-pending-freeze', pipelineVariant: 'baseline' as const }
const CANDIDATE = { configId: 'candidate-pending-freeze', pipelineVariant: 'candidate' as const }
const CONFIGS = [BASELINE, CANDIDATE]

/** 构造最小合法 EvalCase(仅展开/预算逻辑所需字段有语义) */
function makeCase(overrides: Partial<EvalCase> & { caseId: string }): EvalCase {
  return {
    schema_version: 1,
    case_id: overrides.caseId,
    dataset_version: overrides.dataset_version ?? 'personal_ops_v1',
    mode: overrides.mode ?? 'personal_ops',
    category: overrides.category ?? '只读',
    split: overrides.split ?? 'dev',
    input: overrides.input ?? '测试输入',
    fixture_id: overrides.fixture_id ?? 'ops-seeded',
    clock: overrides.clock ?? '2026-09-28T01:00:00.000Z',
    timezone: overrides.timezone ?? 'Asia/Shanghai',
    expected: overrides.expected ?? { terminal_status: 'succeeded' },
    interaction_script: overrides.interaction_script ?? [],
    budgets: overrides.budgets ?? {},
    tags: overrides.tags ?? []
  }
}

describe('EXP-01: maximumRequestCount(规范手算用例)', () => {
  it('手算:4+6+2=12', () => {
    const items: ExperimentItem[] = [
      { caseId: 'a', configId: 'c1', repeatIndex: 1, maxModelCalls: 4 },
      { caseId: 'b', configId: 'c1', repeatIndex: 1, maxModelCalls: 6 },
      { caseId: 'c', configId: 'c1', repeatIndex: 1, maxModelCalls: 2 }
    ]
    expect(maximumRequestCount(items)).toBe(12)
  })

  it('单项与空清单', () => {
    expect(maximumRequestCount([{ caseId: 'a', configId: 'c1', repeatIndex: 1, maxModelCalls: 7 }])).toBe(7)
    expect(maximumRequestCount([])).toBe(0)
  })

  it('重复展开项逐一累加(3 项 × 上限 4 = 12)', () => {
    const items: ExperimentItem[] = Array.from({ length: 3 }, (_, i) => ({
      caseId: `case-${i}`,
      configId: 'c1',
      repeatIndex: 1,
      maxModelCalls: 4
    }))
    expect(maximumRequestCount(items)).toBe(12)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('无效上限 %s 拒绝', (bad) => {
    const items: ExperimentItem[] = [{ caseId: 'a', configId: 'c1', repeatIndex: 1, maxModelCalls: bad }]
    expect(() => maximumRequestCount(items)).toThrow('实验清单含无效调用上限')
  })

  it('混入单个无效项时整份清单拒绝(不允许部分求和)', () => {
    const items: ExperimentItem[] = [
      { caseId: 'a', configId: 'c1', repeatIndex: 1, maxModelCalls: 4 },
      { caseId: 'b', configId: 'c1', repeatIndex: 1, maxModelCalls: 0 }
    ]
    expect(() => maximumRequestCount(items)).toThrow('实验清单含无效调用上限')
  })
})

describe('EXP-01: expandExperimentItems 展开正确性', () => {
  const cases = [
    makeCase({ caseId: 'case-a', budgets: { max_model_calls: 4 } }),
    makeCase({ caseId: 'case-b', mode: 'research', dataset_version: 'research_v1', budgets: { max_model_calls: 6 } })
  ]

  it('2 cases × 2 configs × 3 repeats = 12 项,顺序为 case→config→repeat,repeatIndex 从 1 起', () => {
    const items = expandExperimentItems(cases, CONFIGS, 3)
    expect(items).toHaveLength(12)
    expect(items.map((i) => [i.caseId, i.configId, i.repeatIndex])).toEqual([
      ['case-a', 'baseline-pending-freeze', 1],
      ['case-a', 'baseline-pending-freeze', 2],
      ['case-a', 'baseline-pending-freeze', 3],
      ['case-a', 'candidate-pending-freeze', 1],
      ['case-a', 'candidate-pending-freeze', 2],
      ['case-a', 'candidate-pending-freeze', 3],
      ['case-b', 'baseline-pending-freeze', 1],
      ['case-b', 'baseline-pending-freeze', 2],
      ['case-b', 'baseline-pending-freeze', 3],
      ['case-b', 'candidate-pending-freeze', 1],
      ['case-b', 'candidate-pending-freeze', 2],
      ['case-b', 'candidate-pending-freeze', 3]
    ])
  })

  it('案例显式预算原样保留;输入不变则展开结果确定', () => {
    const items = expandExperimentItems(cases, CONFIGS, 2)
    expect(items.filter((i) => i.caseId === 'case-a').every((i) => i.maxModelCalls === 4)).toBe(true)
    expect(items.filter((i) => i.caseId === 'case-b').every((i) => i.maxModelCalls === 6)).toBe(true)
    expect(expandExperimentItems(cases, CONFIGS, 2)).toEqual(items)
  })

  it('缺省预算回落到现有默认 6(Ops 侧 DEFAULT_AGENT_BUDGET / Research 侧 DEFAULT_RESEARCH_BUDGET,不另写默认值)', () => {
    expect(resolveCaseMaxModelCalls(makeCase({ caseId: 'x', mode: 'personal_ops', budgets: {} }))).toBe(6)
    expect(resolveCaseMaxModelCalls(makeCase({ caseId: 'y', mode: 'research', dataset_version: 'research_v1', budgets: {} }))).toBe(6)
    const items = expandExperimentItems([makeCase({ caseId: 'no-budget' })], [BASELINE], 1)
    expect(items[0]!.maxModelCalls).toBe(6)
  })

  it('非法输入拒绝:repeats 非正整数、非整数、空配置表', () => {
    expect(() => expandExperimentItems(cases, CONFIGS, 0)).toThrow('重复次数')
    expect(() => expandExperimentItems(cases, CONFIGS, 1.5)).toThrow('重复次数')
    expect(() => expandExperimentItems(cases, [], 1)).toThrow('至少需要一个配置')
  })
})

describe('EXP-01: 真实数据集全量展开 90×2×3=540', () => {
  const ops = loadDatasetFromDir(OPS_DIR)
  const research = loadDatasetFromDir(RESEARCH_DIR)
  const allCases = [...ops.cases, ...research.cases]

  it('两个数据集合计 90 条(dev 54 + holdout 36)', () => {
    expect(allCases).toHaveLength(90)
    expect(allCases.filter((c) => c.split === 'dev')).toHaveLength(54)
    expect(allCases.filter((c) => c.split === 'holdout')).toHaveLength(36)
  })

  it('展开计数 540;请求上限总量手算 2640(单遍 440 × 配置 2 × 重复 3)', () => {
    const items = expandExperimentItems(allCases, CONFIGS, 3)
    expect(items).toHaveLength(540)
    // 独立手算核对:Ops 50 条 × 4 = 200,Research 40 条 × 6 = 240,单遍合计 440;
    // 2 配置 × 3 重复 = 6 遍 → 440 × 6 = 2640。网络层重试计入上限,540 个案例执行 ≠ 540 个模型请求。
    const opsBudget = allCases.filter((c) => c.mode === 'personal_ops').reduce((s, c) => s + c.budgets.max_model_calls!, 0)
    const researchBudget = allCases.filter((c) => c.mode === 'research').reduce((s, c) => s + c.budgets.max_model_calls!, 0)
    expect(opsBudget).toBe(200)
    expect(researchBudget).toBe(240)
    expect(maximumRequestCount(items)).toBe(2640)
    // 单配置单遍 = 440;双配置单遍 = 880(配置数线性翻倍)
    expect(maximumRequestCount(expandExperimentItems(allCases, [BASELINE], 1))).toBe(440)
    expect(maximumRequestCount(expandExperimentItems(allCases, CONFIGS, 1))).toBe(880)
  })

  it('dev/holdout 分列上限(dev 264、holdout 176)供分批授权', () => {
    const devItems = expandExperimentItems(allCases.filter((c) => c.split === 'dev'), CONFIGS, 3)
    const holdoutItems = expandExperimentItems(allCases.filter((c) => c.split === 'holdout'), CONFIGS, 3)
    expect(maximumRequestCount(devItems)).toBe(264 * 6)
    expect(maximumRequestCount(holdoutItems)).toBe(176 * 6)
  })
})

describe('EXP-01: smoke 子集(10 Ops + 5 Research)确定性选择', () => {
  const ops = loadDatasetFromDir(OPS_DIR)
  const research = loadDatasetFromDir(RESEARCH_DIR)
  const allCases = [...ops.cases, ...research.cases]
  const result = selectSmokeSubset(allCases)

  it('选择 10 条 Ops + 5 条 Research,全部来自 dev,不接触 holdout', () => {
    expect(result.selections).toHaveLength(15)
    const opsIds = result.selections.filter((s) => s.datasetVersion === 'personal_ops_v1')
    const researchIds = result.selections.filter((s) => s.datasetVersion === 'research_v1')
    expect(opsIds).toHaveLength(10)
    expect(researchIds).toHaveLength(5)
    expect(result.selections.every((s) => s.split === 'dev')).toBe(true)
  })

  it('确定性:同一输入两次选择完全一致;选中清单与规则理由锁定', () => {
    expect(selectSmokeSubset(allCases)).toEqual(result)
    expect(result.selections.map((s) => s.caseId)).toEqual([
      'ops-read-01',
      'ops-read-02',
      'ops-read-03',
      'ops-read-04',
      'ops-write-01',
      'ops-write-02',
      'ops-write-03',
      'ops-amb-01',
      'ops-amb-02',
      'inj-1',
      'research-locate-001',
      'research-cross-001',
      'research-conflict-001',
      'research-injection-001',
      'research-insufficient-001'
    ])
    expect(result.rationale).toHaveLength(SMOKE_SELECTION_RULES.length)
    expect(result.rationale.every((r) => r.includes('→'))).toBe(true)
  })

  it('覆盖读/写/澄清/攻击/研究不足五类', () => {
    expect([...result.coverage].sort()).toEqual(['attack', 'clarification', 'read', 'research-insufficient', 'write'].sort())
    const idsByCoverage = (coverage: string) => result.selections.filter((s) => s.coverage === coverage).map((s) => s.caseId)
    expect(idsByCoverage('write')).toEqual(['ops-write-01', 'ops-write-02', 'ops-write-03'])
    expect(idsByCoverage('clarification')).toEqual(['ops-amb-01', 'ops-amb-02'])
    expect(idsByCoverage('research-insufficient')).toEqual(['research-insufficient-001'])
    expect(idsByCoverage('attack')).toEqual(['inj-1', 'research-injection-001'])
    expect(idsByCoverage('read')).toEqual([
      'ops-read-01',
      'ops-read-02',
      'ops-read-03',
      'ops-read-04',
      'research-locate-001',
      'research-cross-001',
      'research-conflict-001'
    ])
  })

  it('smoke 请求上限手算:单配置 10×4 + 5×6 = 70;两配置各一遍 = 140', () => {
    const smokeCases = allCases.filter((c) => result.selections.some((s) => s.caseId === c.case_id))
    expect(maximumRequestCount(expandExperimentItems(smokeCases, [BASELINE], 1))).toBe(70)
    expect(maximumRequestCount(expandExperimentItems(smokeCases, CONFIGS, 1))).toBe(140)
  })

  it('候选不足时拒绝(防止静默缩小覆盖)', () => {
    const brokenRule = { ...SMOKE_SELECTION_RULES[0]!, count: 999 }
    expect(() => selectSmokeSubset(allCases, [brokenRule])).toThrow('smoke 规则候选不足')
  })
})

describe('EXP-01: experiment-plan.json 与代码实现一致性', () => {
  const ops = loadDatasetFromDir(OPS_DIR)
  const research = loadDatasetFromDir(RESEARCH_DIR)
  const allCases = [...ops.cases, ...research.cases]
  const plan = JSON.parse(readFileSync(PLAN_PATH, 'utf-8')) as {
    expansion: { cases: number; configs: number; repeats: number; expectedItems: number }
    requestBudget: { totalRequestCount: number; items: ExperimentItem[] }
    configs: { baseline: { configId: string }; candidate: { configId: string } }
    smoke: { selections: Array<{ caseId: string; matchedRule: string }> }
  }

  it('计划声明的展开参数与全量展开逐项一致', () => {
    expect(plan.expansion.cases).toBe(90)
    expect(plan.expansion.configs).toBe(2)
    expect(plan.expansion.repeats).toBe(3)
    expect(plan.expansion.expectedItems).toBe(540)
    const items = expandExperimentItems(
      allCases,
      [
        { configId: plan.configs.baseline.configId, pipelineVariant: 'baseline' },
        { configId: plan.configs.candidate.configId, pipelineVariant: 'candidate' }
      ],
      plan.expansion.repeats
    )
    expect(plan.requestBudget.items).toEqual(items)
  })

  it('计划声明的请求上限总量等于 maximumRequestCount 重算结果', () => {
    expect(plan.requestBudget.totalRequestCount).toBe(maximumRequestCount(plan.requestBudget.items))
    expect(plan.requestBudget.totalRequestCount).toBe(2640)
  })

  it('计划的 smoke 清单与 selectSmokeSubset 输出一致', () => {
    const expected = selectSmokeSubset(allCases)
    expect(plan.smoke.selections.map((s) => s.caseId)).toEqual(expected.selections.map((s) => s.caseId))
    expect(plan.smoke.selections.map((s) => s.matchedRule)).toEqual(expected.selections.map((s) => s.matchedRule))
  })
})
