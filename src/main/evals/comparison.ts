// 可比基线(E-05):配置冻结与可比性守卫。
//
// 规则(LLM Eval Lab 规格第 7 节):
// - config_ids 必须引用已注册且冻结的配置;
// - 拒绝不同数据 split 或不同数据快照直接比较;
// - Fake 与 real 不在同一排行榜合并;
// - 每次只改变一个主要变量。

import type { EvalSplit } from './types'
import type { ExecutionKind } from './runner'

export interface FrozenConfig {
  config_id: string
  description: string
  execution_kind: ExecutionKind
  /** 冻结说明:代码版本、提示词 hash、工具版本、数据 hash */
  freeze_note: string
}

const CONFIGS = new Map<string, FrozenConfig>()

/** 注册冻结配置;重名抛错,注册后不可改写 */
export function registerFrozenConfig(config: FrozenConfig): void {
  if (CONFIGS.has(config.config_id)) {
    throw new Error(`配置重复注册:${config.config_id}`)
  }
  CONFIGS.set(config.config_id, { ...config })
}

export function getFrozenConfig(configId: string): FrozenConfig | undefined {
  return CONFIGS.get(configId)
}

export function listFrozenConfigs(): string[] {
  return [...CONFIGS.keys()].sort()
}

export interface ComparisonCandidate {
  configId: string
  datasetVersion: string
  casesSha256: string
  splits: readonly EvalSplit[]
  executionKind: ExecutionKind
}

export interface ComparisonVerdict {
  comparable: boolean
  reasons: string[]
}

/** 可比性守卫:不满足直接拒绝比较,而不是给出误导性数字 */
export function checkComparable(a: ComparisonCandidate, b: ComparisonCandidate): ComparisonVerdict {
  const reasons: string[] = []
  if (a.datasetVersion !== b.datasetVersion) {
    reasons.push(`数据集版本不同:${a.datasetVersion} vs ${b.datasetVersion}`)
  }
  if (a.casesSha256 !== b.casesSha256) {
    reasons.push('数据快照 hash 不同(案例内容被改动)')
  }
  const sameSplits =
    a.splits.length === b.splits.length && a.splits.every((s) => b.splits.includes(s))
  if (!sameSplits) {
    reasons.push(`数据 split 不同:[${a.splits.join(',')}] vs [${b.splits.join(',')}]`)
  }
  if (a.executionKind !== b.executionKind) {
    reasons.push('fake 与 real 不在同一排行榜合并')
  }
  if (a.configId === b.configId) {
    reasons.push('配置与自身比较无可比性结论')
  }
  return { comparable: reasons.length === 0, reasons }
}
