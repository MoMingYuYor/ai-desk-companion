// 可比基线(E-05 + EVAL-04):配置冻结与可比性守卫。
//
// 规则(LLM Eval Lab 规格第 7 节 + EVAL-04 修正 F-13):
// - config_ids 必须引用已冻结的配置(冻结配置存于目录,见 configStore.ts;
//   进程内 CONFIGS Map 已迁移,不再有内存注册表);
// - 拒绝不同数据 split 或不同数据快照直接比较;
// - Fake 与 real 不在同一排行榜合并;
// - 每次对照只改变记录的流程变量(COMPARABLE_VARIABLES:pipelineVariant/
//   promptSha256),其余冻结字段逐字段一致;发生备用切换时在结果里单列路由
//   (runner 的 actualProvider/modelAttempts),无法保持可比条件的案例标明
//   偏离,不混算同模型提升。

import type { EvalSplit } from './types'
import type { ExecutionKind } from './runner'
import { COMPARABLE_VARIABLES, frozenConfigSha256, validateFrozenConfig, type FrozenEvalConfig } from './configStore'
import type { ActualProvider } from '../services/modelRequest'

/** 允许在对照两侧不同的变量清单(显式记录;其余冻结字段必须一致) */
export const comparableVariables = COMPARABLE_VARIABLES

export interface ComparisonCandidate {
  configId: string
  datasetVersion: string
  casesSha256: string
  splits: readonly EvalSplit[]
  executionKind: ExecutionKind
  /**
   * 缺失或不完整时拒绝比较；可选类型用于给历史结果返回可诊断的拒绝原因。
   */
  frozen?: FrozenEvalConfig
  /** 冻结配置实际内容 hash(configStore 单独保存的 <configId>.sha256) */
  configSha256?: string
  /** real 必须列出全部实际路由（含发送尝试）；缺失或偏离冻结目标时不可比。 */
  actualProviders?: readonly (ActualProvider | null)[]
}

export function actualRoutingReasons(config: FrozenEvalConfig, providers: readonly (ActualProvider | null)[] | undefined): string[] {
  if (config.executionKind !== 'real') return []
  if (!providers?.length) return ['实际 provider/model 缺观测，不可比']
  return [...new Set(providers.flatMap((provider) => {
    if (!provider?.providerId || !provider.model) return ['实际 provider/model 缺观测，不可比']
    return provider.providerId === config.providerId && provider.model === config.model
      ? []
      : [`实际 provider/model 偏离冻结配置，不可比:${provider.providerId} / ${provider.model}（冻结 ${config.providerId} / ${config.model}）`]
  }))]
}

export interface ComparisonVerdict {
  comparable: boolean
  reasons: string[]
}

/** 可比性差异表:逐冻结字段给出两侧取值与是否允许不同(报告/工具用) */
export interface FrozenVariableDiff {
  variable: string
  a: string
  b: string
  /** 该变量是否在允许比较的流程变量清单内 */
  allowedToDiffer: boolean
  equal: boolean
}

/** 对两个冻结配置逐字段生成差异表(configId/pipelineVariant 之外全部需一致) */
export function frozenVariableDiff(a: FrozenEvalConfig, b: FrozenEvalConfig): FrozenVariableDiff[] {
  const fields: Array<keyof FrozenEvalConfig> = [
    'schemaVersion', 'executionKind', 'model', 'providerId', 'pipelineVariant', 'promptSha256',
    'toolsVersion', 'codeCommit', 'datasetSha256', 'fixtureSha256', 'budgetSha256',
    'interactionScriptSha256', 'rubricVersion', 'targetSha256'
  ]
  return fields.map((field) => {
    const va = String(a[field])
    const vb = String(b[field])
    return {
      variable: field,
      a: va,
      b: vb,
      allowedToDiffer: COMPARABLE_VARIABLES.includes(field),
      equal: va === vb
    }
  })
}

/**
 * 可比性守卫:不满足直接拒绝比较,而不是给出误导性数字。
 * 基础语义(split/数据 hash/fake-real 分列/自身比较)保持;
 * EVAL-04 接入冻结 hash:两侧都带 frozen 时逐冻结字段核对,
 * 且 configSha256 必须与 frozen 实际内容 hash 一致(防配置对象被篡改后传入)。
 */
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
  const frozen = [a, b].map((candidate, index) => {
    const label = index === 0 ? 'A' : 'B'
    try {
      const config = validateFrozenConfig(candidate.frozen)
      if (config.configId !== candidate.configId || config.executionKind !== candidate.executionKind) {
        reasons.push(`配置 ${label} 的标识或执行类型与冻结内容不一致`)
      }
      if (frozenConfigSha256(config) !== candidate.configSha256) {
        reasons.push(`配置 ${label} 的实际 hash 与冻结内容不一致:${candidate.configId}`)
      }
      reasons.push(...actualRoutingReasons(config, candidate.actualProviders))
      return config
    } catch {
      reasons.push(`配置 ${label} 缺完整冻结配置，不可比:${candidate.configId}`)
      return null
    }
  })
  // 两侧均完整才可生成差异表；缺失对象本身就是拒绝原因。
  if (frozen[0] && frozen[1]) {
    for (const diff of frozenVariableDiff(frozen[0], frozen[1])) {
      if (!diff.equal && !diff.allowedToDiffer) {
        reasons.push(`冻结变量不可比:${diff.variable}:${diff.a} vs ${diff.b}(只允许 ${comparableVariables.join('/')} 不同)`)
      }
    }
  }
  return { comparable: reasons.length === 0, reasons }
}
