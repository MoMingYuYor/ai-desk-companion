// 评测报告(E-07 报告部分):确定性 Markdown 生成。
//
// 报告纪律:Fake 结果显著标示非模型能力成绩;未测显示"未测";未知费用/用量
// 为 null 不显示免费;零分母显示 N/A;报告注明评测结果 schema 版本;
// 缺观测项标未测,不用兼容分支重建虚假成绩。
// EVAL-03:结构判分与语义判分分列展示——终态/工具/参数等结构指标不与
// research gold 的语义指标(Recall@k、引用结构有效率、事实引用覆盖率)混算;
// 语义支持度一律"待人工审阅"(EVAL-04 的正式结论),不自动判通过。

import type { EvalRunState } from './runner'
import type { EvalMetrics } from './metrics'
import type { LoadedDataset } from './dataset'
import type { ResearchScoreResult } from './researchRules'

/** 评测结果 schema 版本:报告与产物按此版本解读(规范 EVAL-01 验收要求) */
export const EVAL_RESULT_SCHEMA_VERSION = 1

export interface ReportInput {
  state: EvalRunState
  metrics: EvalMetrics
  dataset: LoadedDataset
  /** 复现命令(按实现核对后的形式) */
  reproduceCommand: string
}

function fmtMetric(label: string, value: { value: number | null; n: number; denominator: number; untested?: boolean }): string {
  const display = value.untested === true
    ? '未测(缺观测)'
    : value.value === null
      ? 'N/A'
      : `${(value.value * 100).toFixed(1)}%`
  return `| ${label} | ${display} | ${value.n}/${value.denominator} |`
}

export function renderEvalReport(input: ReportInput): string {
  const { state, metrics, dataset } = input
  const fake = state.executionKind === 'fake'
  const lines: string[] = []

  lines.push(`# 评测报告:${state.evalRunId}`)
  lines.push('')
  lines.push(
    fake
      ? '> **execution_kind = fake:本报告只验证工程流程与判分逻辑,不代表真实模型能力。**'
      : `> execution_kind = real(模型成绩记录见配置冻结说明)`
  )
  lines.push('')
  lines.push(`- 评测结果 schema 版本:v${EVAL_RESULT_SCHEMA_VERSION}`)
  lines.push(`- 数据集:${state.datasetVersion}(cases sha256 \`${state.casesSha256.slice(0, 16)}…\`,共 ${dataset.cases.length} 条)`)
  lines.push(`- split:${state.splits.join(' / ')};重复:${state.repeats};配置:${state.configIds.join(', ')}`)
  lines.push(`- 状态:${state.status};起止:${state.startedAt} ~ ${state.finishedAt ?? '进行中'}`)
  if (state.stopReason) lines.push(`- 终止原因:${state.stopReason}`)
  if (state.originEvalRunId) lines.push(`- 来源运行(显式重新试验):${state.originEvalRunId}`)
  if (state.lastInterruption && state.lastInterruption.combos.length > 0) {
    lines.push(`- 上次批次中断:检测到 ${state.lastInterruption.combos.length} 个已启动未收尾组合(已保留分母)`)
  }
  lines.push(`- 复现:\`${input.reproduceCommand}\``)
  lines.push('')

  const started = state.results.filter((r) => r.status !== 'not_run').length
  const notRun = state.results.filter((r) => r.status === 'not_run').length
  lines.push('## 覆盖')
  lines.push('')
  lines.push(
    `- 已启动:${started}/${state.results.length};预算外未启动:${notRun}${notRun > 0 ? '(部分批次,不构成完整发布结论)' : ''}`
  )
  lines.push('')

  lines.push('## 指标')
  lines.push('')
  lines.push('| 指标 | 值 | n/N |')
  lines.push('|---|---|---|')
  lines.push(fmtMetric('完成率', metrics.completion))
  lines.push(fmtMetric('启动覆盖率', metrics.coverage))
  lines.push(fmtMetric('工具选择准确率', metrics.toolSelection))
  lines.push(fmtMetric('参数准确率', metrics.argumentAccuracy))
  lines.push(fmtMetric('工具错误率', metrics.toolErrorRate))
  const bypass = metrics.confirmationBypass
  const bypassDisplay = bypass.count === null ? '未测(缺观测)' : `${bypass.count}(必须为 0)`
  const attemptDisplay = bypass.attemptedWrites === null ? '未测' : String(bypass.attemptedWrites)
  lines.push(`| 确认绕过 | ${bypassDisplay} / 已尝试写 ${attemptDisplay} | — |`)
  const lat = metrics.latency
  const latencyDisplay = lat.p50Ms === null ? 'N/A' : `${lat.p50Ms}`
  const latencyP95Display = lat.p95Ms === null ? 'N/A' : `${lat.p95Ms}`
  lines.push(
    `| 延迟 p50/p95(ms) | ${latencyDisplay} / ${latencyP95Display}${lat.smallSample ? '(小样本,n<20)' : ''};超时 ${lat.timeouts}(单列,留在成绩分母) | — |`
  )
  lines.push('')

  if (notRun > 0) {
    lines.push('## not_run(未启动)')
    lines.push('')
    for (const r of state.results.filter((r) => r.status === 'not_run')) {
      lines.push(`- ${r.configId} / ${r.caseId} / repeat ${r.repeatIndex}`)
    }
    lines.push('')
  }

  // EVAL-03:产物可回放性(结构侧)——artifact_failed 的案例未落 manifest,
  // 不能当作可回放结果参与后续复核
  const artifactFailed = state.results.filter((r) => r.artifactStatus === 'artifact_failed')
  if (artifactFailed.length > 0) {
    lines.push('## 产物导出失败(artifact_failed,不可回放)')
    lines.push('')
    for (const r of artifactFailed) {
      lines.push(`- **${r.caseId}**(${r.configId} / repeat ${r.repeatIndex}):${r.failureReasons.filter((x) => x.startsWith('artifact_failed')).join(';') || '导出失败'}`)
    }
    lines.push('')
  }

  const failed = state.results.filter((r) => r.status === 'failed' && r.failureReasons.length > 0)
  if (failed.length > 0) {
    lines.push('## 失败案例(保留在分母内)')
    lines.push('')
    for (const r of failed.slice(0, 5)) {
      lines.push(`- **${r.caseId}**(${r.configId}):${r.failureReasons.join(';')}`)
    }
    lines.push('')
  }

  // EVAL-03:research gold 语义判分(与结构指标分列,不混算)
  const scored = state.results.filter((r) => r.researchScoring)
  if (scored.length > 0) {
    lines.push('## Research 语义判分(gold;结构指标之外单列)')
    lines.push('')
    lines.push('| 案例 | Recall@k(macro) | 引用结构有效率 | 事实引用覆盖率 | 不足识别 |')
    lines.push('|---|---|---|---|---|')
    for (const r of scored) {
      const s = r.researchScoring as ResearchScoreResult
      const recall = !s.applicable
        ? `N/A(${s.notScoredReason ?? 'gold 不可用'})`
        : s.recallMacro === null
          ? 'N/A(无可用 gold claim)'
          : `${(s.recallMacro * 100).toFixed(1)}%`
      const citationPrecision =
        s.citationStructure.precision === null
          ? 'N/A(0 引用)'
          : `${(s.citationStructure.precision * 100).toFixed(1)}%(${s.citationStructure.valid}/${s.citationStructure.total})`
      const coverage =
        s.factCoverage.value === null
          ? 'N/A(零分母)'
          : `${(s.factCoverage.value * 100).toFixed(1)}%(${s.factCoverage.covered}/${s.factCoverage.total})`
      const insufficiency = s.insufficiency.pass === null ? '不适用' : s.insufficiency.pass ? '正确(诚实不足)' : '未正确表达不足'
      lines.push(`| ${r.caseId} | ${recall} | ${citationPrecision} | ${coverage} | ${insufficiency} |`)
    }
    lines.push('')
    lines.push('- 语义支持度一律**待人工审阅**(EVAL-04):本报告不据引用结构与 gold 区间重叠自动判"支持";')
    lines.push(
      fake
        ? '- execution_kind = fake:语义数字只证明判分流程(抽取脚本为通过构造),**不是语义成绩**;'
        : '- 语义数字来自真实运行与 gold 的区间比对;正式 holdout 支持度以 EVAL-04 人工审阅为准;'
    )
    if (scored.some((r) => (r.researchScoring as ResearchScoreResult).goldResolutionErrors.length > 0)) {
      lines.push('- 存在 gold span 无法唯一定位的评分单元([GOLD_SPAN_UNRESOLVABLE]),其 recall 记 N/A 并已在产物中单列;')
    }
    lines.push('')
  }

  lines.push('## 限制说明')
  lines.push('')
  lines.push('- 本数据集为小样本工程验收,不证明开放世界可靠性;')
  lines.push(
    fake
      ? '- Fake Provider 仅证明工程流程,不得在简历或主页中作为模型能力数据引用;'
      : '- 真实模型成绩受供应商与提示词版本影响,复现需同一冻结配置;'
  )
  lines.push('- 观测缺失的指标显示"未测",不以 0 补齐或据案例终态反推;')
  lines.push('- 案例产物 manifest(sha256 齐全 + complete 标记)完整才算可回放;artifact_failed 案例保留临时库待人工复核;')
  lines.push(`- 未知 usage/费用以 null 表示,报告中不出现"免费"。`)
  lines.push('')

  return lines.join('\n')
}
