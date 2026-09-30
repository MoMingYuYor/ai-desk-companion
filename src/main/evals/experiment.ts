// EXP-01 实验计划:实验任务项展开、请求上限计算与 smoke 子集选择。
//
// 规范来源:docs/superpowers/plans/2026-09-30-project-completion/delivery.md 的 EXP-01 节。
// 约束:
// - maxModelCalls 复用 Ops/Research 的预算解析结果,不能另写不同默认值
//   (缺省回落到 src/main/agent/config.ts 的 DEFAULT_AGENT_BUDGET.maxModelCalls 与
//    src/main/research/schemas.ts 的 DEFAULT_RESEARCH_BUDGET.max_model_calls,当前均为 6);
// - 网络层重试计入调用上限;540 个案例执行 ≠ 540 个模型请求,启动前按本模块求和;
// - smoke 只用 dev,涵盖读、写、澄清、攻击与研究不足五类,不读取 holdout 输出调参;
// - 本文件不 import EVAL-04 实施中的 configStore/completerFactory/comparison 等模块,
//   配置形态在 experiment-plan.json 以「待接线」字段表达。

import { DEFAULT_AGENT_BUDGET } from '../agent/config'
import { DEFAULT_RESEARCH_BUDGET } from '../research/schemas'
import type { EvalCase } from './types'

/** 实验任务项:一项对应一个 case/config/repeat 三元组(规范逐字) */
export interface ExperimentItem {
  caseId: string
  configId: string
  repeatIndex: number
  maxModelCalls: number
}

/** 实验启动前求和:无效上限抛错,reduce 求和(规范逐字) */
export function maximumRequestCount(items: readonly ExperimentItem[]): number {
  if (items.some(item => !Number.isInteger(item.maxModelCalls) || item.maxModelCalls < 1)) {
    throw new Error('实验清单含无效调用上限')
  }
  return items.reduce((sum, item) => sum + item.maxModelCalls, 0)
}

/**
 * 案例预算解析结果:显式声明 budgets.max_model_calls 时直接采用;
 * 缺省复用现有默认预算(Ops 侧 DEFAULT_AGENT_BUDGET,Research 侧 DEFAULT_RESEARCH_BUDGET),
 * 不在本模块另写默认值来源。
 */
export function resolveCaseMaxModelCalls(c: EvalCase): number {
  if (c.budgets.max_model_calls !== undefined) return c.budgets.max_model_calls
  return c.mode === 'research' ? DEFAULT_RESEARCH_BUDGET.max_model_calls : DEFAULT_AGENT_BUDGET.maxModelCalls
}

/** 冻结配置的引用形态;实际冻结由 EVAL-04 的 configStore 落地后接线 */
export interface ExperimentConfigRef {
  configId: string
  pipelineVariant: 'baseline' | 'candidate'
}

/**
 * 展开 case × config × repeat 三元组。
 * 展开顺序固定为 case → config → repeat,repeatIndex 从 1 起;输入不变则输出逐字节确定,
 * 保证实验清单在启动前可复核、可锁定。
 */
export function expandExperimentItems(
  cases: readonly EvalCase[],
  configs: readonly ExperimentConfigRef[],
  repeats: number
): ExperimentItem[] {
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error('重复次数必须是 ≥1 的整数')
  if (configs.length < 1) throw new Error('实验展开至少需要一个配置')
  const items: ExperimentItem[] = []
  for (const c of cases) {
    for (const config of configs) {
      for (let repeatIndex = 1; repeatIndex <= repeats; repeatIndex += 1) {
        items.push({
          caseId: c.case_id,
          configId: config.configId,
          repeatIndex,
          maxModelCalls: resolveCaseMaxModelCalls(c)
        })
      }
    }
  }
  return items
}

// ---------- smoke 子集选择 ----------

/** smoke 覆盖的五类(交付计划 EXP-01:读、写、澄清、攻击、研究不足) */
export type SmokeCoverage = 'read' | 'write' | 'clarification' | 'attack' | 'research-insufficient'

/** 一条确定性选择规则:从指定数据集/类别的 dev 案例按 case_id 升序取前 count 条 */
export interface SmokeSelectionRule {
  datasetVersion: string
  /** 类别白名单(任一命中即进入候选池) */
  categories: readonly string[]
  /** 可选标签过滤(候选池须全部包含;缺省不按标签过滤) */
  tags?: readonly string[]
  /** 本规则取多少条 */
  count: number
  /** 覆盖五类中的哪一类 */
  coverage: SmokeCoverage
  /** 选择理由,写入计划与测试断言 */
  reason: string
}

export interface SmokeSelection {
  caseId: string
  datasetVersion: string
  category: string
  split: 'dev' | 'holdout'
  coverage: SmokeCoverage
  matchedRule: string
}

export interface SmokeSelectionResult {
  selections: SmokeSelection[]
  /** 每条规则的理由及实际选中的 case_id */
  rationale: string[]
  /** 覆盖的五类(去重) */
  coverage: SmokeCoverage[]
}

/**
 * 交付计划 EXP-01 的 smoke 规则:dev 中 10 条 Ops + 5 条 Research。
 * Ops 类别规模为只读 12/可撤销写 9/歧义澄清 6/注入越权 3,按 4+3+2+1=10 与规模近似成比例;
 * Research 六组中取定位/综合/冲突/注入/证据不足各 1 条(重复来源组在 5 条上限内不占额)。
 * 示例只取 dev,不引入 holdout 材料。
 */
export const SMOKE_SELECTION_RULES: readonly SmokeSelectionRule[] = [
  {
    datasetVersion: 'personal_ops_v1',
    categories: ['只读'],
    count: 4,
    coverage: 'read',
    reason: '读类:Ops 只读类别 dev 案例按 case_id 升序取前 4 条'
  },
  {
    datasetVersion: 'personal_ops_v1',
    categories: ['可撤销写'],
    count: 3,
    coverage: 'write',
    reason: '写类:Ops 可撤销写类别 dev 案例按 case_id 升序取前 3 条'
  },
  {
    datasetVersion: 'personal_ops_v1',
    categories: ['歧义澄清'],
    count: 2,
    coverage: 'clarification',
    reason: '澄清类:Ops 歧义澄清类别 dev 案例按 case_id 升序取前 2 条'
  },
  {
    datasetVersion: 'personal_ops_v1',
    categories: ['注入越权'],
    count: 1,
    coverage: 'attack',
    reason: '攻击类:Ops 注入越权类别 dev 案例按 case_id 升序取前 1 条'
  },
  {
    datasetVersion: 'research_v1',
    categories: ['单文档定位'],
    count: 1,
    coverage: 'read',
    reason: '读类(Research 定位形态):单文档定位组 dev 按 case_id 升序取前 1 条'
  },
  {
    datasetVersion: 'research_v1',
    categories: ['跨文档综合'],
    count: 1,
    coverage: 'read',
    reason: '读类(Research 综合形态):跨文档综合组 dev 按 case_id 升序取前 1 条'
  },
  {
    datasetVersion: 'research_v1',
    categories: ['冲突'],
    count: 1,
    coverage: 'read',
    reason: '读类(Research 冲突形态):冲突组 dev 按 case_id 升序取前 1 条'
  },
  {
    datasetVersion: 'research_v1',
    categories: ['提示注入'],
    count: 1,
    coverage: 'attack',
    reason: '攻击类(Research 侧):提示注入组 dev 按 case_id 升序取前 1 条'
  },
  {
    datasetVersion: 'research_v1',
    categories: ['证据不足'],
    count: 1,
    coverage: 'research-insufficient',
    reason: '研究不足类:证据不足组 dev 按 case_id 升序取前 1 条(gold-empty 诚实不足语义)'
  }
]

/** 按 category/tags 从 dev 中确定性选择 smoke 子集;纯函数,无时间与随机源 */
export function selectSmokeSubset(
  cases: readonly EvalCase[],
  rules: readonly SmokeSelectionRule[] = SMOKE_SELECTION_RULES
): SmokeSelectionResult {
  const selections: SmokeSelection[] = []
  const rationale: string[] = []
  for (const rule of rules) {
    const pool = cases
      .filter(
        (c) =>
          c.split === 'dev' &&
          c.dataset_version === rule.datasetVersion &&
          rule.categories.includes(c.category) &&
          (rule.tags === undefined || rule.tags.every((t) => c.tags.includes(t)))
      )
      .sort((a, b) => (a.case_id < b.case_id ? -1 : a.case_id > b.case_id ? 1 : 0))
    if (pool.length < rule.count) {
      throw new Error(`smoke 规则候选不足:${rule.reason}(需要 ${rule.count},候选仅 ${pool.length})`)
    }
    const picked = pool.slice(0, rule.count)
    for (const c of picked) {
      selections.push({
        caseId: c.case_id,
        datasetVersion: c.dataset_version,
        category: c.category,
        split: c.split,
        coverage: rule.coverage,
        matchedRule: rule.reason
      })
    }
    rationale.push(`${rule.reason} → ${picked.map((c) => c.case_id).join(', ')}`)
  }
  return { selections, rationale, coverage: [...new Set(rules.map((r) => r.coverage))] }
}
