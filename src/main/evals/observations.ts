// EVAL-01 观测合并:把网关 ToolObservationV1 的 tool/persistence 两阶段
// 按 (operationId, attempt) 合并为评分投影 ScoringToolObservation。
//
// 合并纪律(完成计划 eval.md / ops.md):
// - 合并后计一次尝试;回执重放单列 attempt 但不算第二次业务写入;
// - 工具原始结果(ok/arguments)来自 tool 阶段,是否提交与保存来自 persistence 阶段;
// - approvalValid 消费执行时的 approvalValidated 快照,不事后重算;
// - businessApplied = 已执行 && 非重放 && 工具成功 && 落盘未失败——
//   单纯存在确认事件或 operationId 不能证明有效批准或真实业务写入;
// - 不把 ok:false 转成成功观测;错误保留原始 AppError code。

import type { ToolObservationV1 } from '../tools/types'

/** 评分投影:rules/metrics 的唯一观测输入形态(规范定义,不承载网关原始字段) */
export interface ScoringToolObservation {
  callIndex: number
  tool: string
  arguments: Record<string, unknown> | null
  riskLevel: RiskLevel | null
  ok: boolean
  errorCode: string | null
  approvalId: string | null
  approvalValid: boolean | null
  businessApplied: boolean
  replayed: boolean
  durationMs: number | null
}

type RiskLevel = NonNullable<ToolObservationV1['riskLevel']>

/** 按 (operationId, attempt) 合并两阶段观测,产出评分投影(按 callIndex 升序) */
export function mergeObservations(records: readonly ToolObservationV1[]): ScoringToolObservation[] {
  // 分组:同一 (operationId, attempt) 只产出一个评分尝试
  const groups = new Map<string, ToolObservationV1[]>()
  for (const record of records) {
    const key = `${record.operationId}#${record.attempt}`
    const group = groups.get(key)
    if (group) group.push(record)
    else groups.set(key, [record])
  }

  const merged: ScoringToolObservation[] = []
  for (const group of groups.values()) {
    // 工具阶段优先作为主记录;缺失时回退 persistence 阶段(网关保证至少一条)
    const toolPhase = group.find((r) => r.phase === 'tool') ?? group[0]!
    const persistPhase = group.find((r) => r.phase === 'persistence')

    // 落盘失败(PERSIST_FAILED)单列:业务变更随事务回滚,不计已应用
    const persistFailed = persistPhase?.outcome === 'persist_error'
    const errorCode =
      toolPhase.error?.code ??
      (persistFailed ? persistPhase?.error?.code ?? 'PERSIST_FAILED' : null)

    merged.push({
      callIndex: toolPhase.callIndex,
      tool: toolPhase.tool,
      // 校验成功后的归一化实参;验证失败为 null(原始实参留在 attemptedArguments)
      arguments: toolPhase.arguments,
      riskLevel: toolPhase.riskLevel,
      ok: toolPhase.outcome === 'success',
      errorCode,
      approvalId: toolPhase.approvalId,
      // 执行时快照:不在运行结束后以已过期状态重算
      approvalValid: toolPhase.approvalValidated,
      businessApplied:
        toolPhase.executed && !toolPhase.replayed && toolPhase.outcome === 'success' && !persistFailed,
      replayed: toolPhase.replayed,
      durationMs: toolPhase.durationMs
    })
  }

  return merged.sort((a, b) => a.callIndex - b.callIndex)
}
