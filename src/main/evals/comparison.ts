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
import { COMPARABLE_VARIABLES, frozenConfigSha256, type FrozenEvalConfig } from './configStore'

/** 允许在对照两侧不同的变量清单(显式记录;其余冻结字段必须一致) */
export const comparableVariables = COMPARABLE_VARIABLES

export interface ComparisonCandidate {
  configId: string
  datasetVersion: string
  casesSha256: string
  splits: readonly EvalSplit[]
  executionKind: ExecutionKind
  /**
   * EVAL-04:冻结配置(可选)。两侧都提供时接入冻结 hash 逐字段校验——
   * 只允许 comparableVariables 内的变量不同。
   */
  frozen?: FrozenEvalConfig
  /** 冻结配置实际内容 hash(configStore 单独保存的 <configId>.sha256) */
  configSha256?: string
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
    'interactionScriptSha256', 'rubricVersion'
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
  // EVAL-04:冻结配置逐字段核对;只允许记录的流程变量不同
  if (a.frozen && b.frozen) {
    if (frozenConfigSha256(a.frozen) !== a.configSha256) {
      reasons.push(`配置 A 的实际 hash 与冻结内容不一致:${a.configId}`)
    }
    if (frozenConfigSha256(b.frozen) !== b.configSha256) {
      reasons.push(`配置 B 的实际 hash 与冻结内容不一致:${b.configId}`)
    }
    for (const diff of frozenVariableDiff(a.frozen, b.frozen)) {
      if (!diff.equal && !diff.allowedToDiffer) {
        reasons.push(`冻结变量不可比:${diff.variable}:${diff.a} vs ${diff.b}(只允许 ${comparableVariables.join('/')} 不同)`)
      }
    }
  }
  return { comparable: reasons.length === 0, reasons }
}
