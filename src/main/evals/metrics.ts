// 评测指标与判分(E-04):全部公式、分母与 N/A 语义在此唯一实现。
//
// 分母纪律(总体规格第 9 节 + EVAL-01 修正 F-09):
// - 完成率分母 = 已启动的适用案例数(超时算失败,not_run 不进分母);
// - 覆盖率分母 = 全部适用组合(已启动 / 全部,含 not_run);
// - 工具选择准确率分母 = 有 gold 工具序列的案例数;
// - 参数准确率只来自 ruleChecks(参数级判分),不再以案例终态反推;
// - 工具错误率 = 失败调用 / 实际调用,只来自 toolObservations;
// - 审批绕过只来自观测(无有效批准但实际写入);观测缺失显示未测,不得显示 0;
// - 零分母返回 null(展示层显示 N/A),不输出 NaN 或 100%。

import type { EvalCaseOutcome, EvalRunState } from './runner'
import type { EvalCase } from './types'
import { summarizeObservations } from './rules'

export interface MetricValue {
  /** 数值;null 表示 N/A(零分母)或未测 */
  value: number | null
  n: number
  denominator: number
  /** true 表示观测缺失导致未测(展示层显示"未测",区别于零分母 N/A) */
  untested?: boolean
}

function ratio(numerator: number, denominator: number): MetricValue {
  if (denominator <= 0) return { value: null, n: numerator, denominator: 0 }
  return { value: numerator / denominator, n: numerator, denominator }
}

function untested(): MetricValue {
  return { value: null, n: 0, denominator: 0, untested: true }
}

export interface EvalMetrics {
  /** 完成率:通过数 / 已启动数(超时留在分母) */
  completion: MetricValue
  /** 启动覆盖:已启动数 / 全部适用组合数 */
  coverage: MetricValue
  /** 工具选择准确率:工具序列一致数 / 有 gold 序列数 */
  toolSelection: MetricValue
  /** 参数准确率:required_arguments 匹配的判分项 / 全部判分项(来自 ruleChecks) */
  argumentAccuracy: MetricValue
  /** 确认绕过次数(必须为 0);同时给出已尝试写次数;null = 未测(缺观测) */
  confirmationBypass: { count: number | null; attemptedWrites: number | null }
  /** 工具错误率:失败调用 / 实际调用(来自观测) */
  toolErrorRate: MetricValue
  /** 延迟(p50/p95);小样本标记;超时单列且留在业务成绩分母 */
  latency: { p50Ms: number | null; p95Ms: number | null; n: number; smallSample: boolean; timeouts: number }
}

/** 判定单个结果是否已启动(超时/失败保留在分母,not_run 不进) */
function startedAndJudged(r: EvalCaseOutcome): boolean {
  return r.status !== 'not_run'
}

const ARGS_CHECK_PREFIX = 'args:'

function hasObservations(r: EvalCaseOutcome): boolean {
  return Array.isArray(r.toolObservations)
}

export function calculateMetrics(
  state: Pick<EvalRunState, 'results'>,
  cases: readonly EvalCase[]
): EvalMetrics {
  const caseById = new Map(cases.map((c) => [c.case_id, c]))
  const judged = state.results.filter(startedAndJudged)

  const passed = judged.filter((r) => r.status === 'passed').length
  const completion = ratio(passed, judged.length)
  const coverage = ratio(judged.length, state.results.length)

  let goldToolCases = 0
  let toolSeqMatch = 0
  let argsTotal = 0
  let argsPassed = 0
  let toolAttempts = 0
  let toolErrors = 0
  let attemptedWrites = 0
  let bypass = 0
  const observedResults = judged.filter(hasObservations)

  for (const r of judged) {
    const caseDef = caseById.get(r.caseId)
    const goldSeq = caseDef?.expected.tool_sequence
    if (goldSeq && goldSeq.length > 0) {
      goldToolCases += 1
      if (
        r.terminalStatus !== null &&
        goldSeq.length === r.executedTools.length &&
        goldSeq.every((t, i) => t === r.executedTools[i])
      ) {
        toolSeqMatch += 1
      }
    }
    // 参数准确率只信参数级判分,不以案例通过状态反推(F-09 修正)
    for (const check of r.ruleChecks ?? []) {
      if (!check.key.startsWith(ARGS_CHECK_PREFIX)) continue
      argsTotal += 1
      if (check.passed) argsPassed += 1
    }
    // 错误率与绕过只聚合观测数据;观测缺失的案例不进分子分母
    if (hasObservations(r)) {
      const summary = summarizeObservations(r.toolObservations ?? [])
      toolAttempts += summary.totalAttempts
      toolErrors += summary.failedAttempts
      attemptedWrites += summary.attemptedWrites
      bypass += summary.unauthorizedAppliedWrites
    }
  }

  const argumentAccuracy =
    argsTotal === 0 ? untested() : ratio(argsPassed, argsTotal)
  const toolErrorRate =
    observedResults.length === 0 ? untested() : ratio(toolErrors, toolAttempts)
  // 任一已启动案例观测缺失即无法证明 0 绕过:整批标未测(不显示 0 绕过)
  const confirmationBypass =
    judged.length > 0 && observedResults.length < judged.length
      ? { count: null, attemptedWrites: null }
      : { count: bypass, attemptedWrites }

  const latencies = judged.map((r) => r.durationMs ?? null)
  const timeouts = judged.filter((r) => r.terminalStatus === 'timeout').length

  return {
    completion,
    coverage,
    toolSelection: ratio(toolSeqMatch, goldToolCases),
    argumentAccuracy,
    confirmationBypass,
    toolErrorRate,
    latency: latencyPercentiles(latencies, timeouts)
  }
}

/** p50/p95:排序后取 ceil(0.95*n) 对应值;n<20 标小样本;超时为截断观测单列 */
export function latencyPercentiles(
  latenciesMs: Array<number | null>,
  timeouts: number
): EvalMetrics['latency'] {
  const values = latenciesMs.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort(
    (a, b) => a - b
  )
  const pick = (p: number): number | null => {
    if (values.length === 0) return null
    const idx = Math.min(Math.ceil(p * values.length) - 1, values.length - 1)
    return values[Math.max(idx, 0)]!
  }
  return {
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
    n: values.length,
    smallSample: values.length < 20,
    timeouts
  }
}
