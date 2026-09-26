// 评测报告(E-07 报告部分):确定性 Markdown 生成。
//
// 报告纪律:Fake 结果显著标示非模型能力成绩;未测显示"未测";未知费用/用量
// 为 null 不显示免费;零分母显示 N/A;报告附限制说明与产物 hash。

import type { EvalRunState } from './runner'
import type { EvalMetrics } from './metrics'
import type { LoadedDataset } from './dataset'

export interface ReportInput {
  state: EvalRunState
  metrics: EvalMetrics
  dataset: LoadedDataset
  /** 复现命令(按实现核对后的形式) */
  reproduceCommand: string
}

function fmtMetric(label: string, value: { value: number | null; n: number; denominator: number }): string {
  const display = value.value === null ? 'N/A' : `${(value.value * 100).toFixed(1)}%`
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
  lines.push(`- 数据集:${state.datasetVersion}(cases sha256 \`${state.casesSha256.slice(0, 16)}…\`,共 ${dataset.cases.length} 条)`)
  lines.push(`- split:${state.splits.join(' / ')};重复:${state.repeats};配置:${state.configIds.join(', ')}`)
  lines.push(`- 状态:${state.status};起止:${state.startedAt} ~ ${state.finishedAt ?? '进行中'}`)
  lines.push(`- 复现:\`${input.reproduceCommand}\``)
  lines.push('')

  const started = state.results.filter((r) => r.status !== 'not_run').length
  const notRun = state.results.filter((r) => r.status === 'not_run').length
  lines.push('## 覆盖')
  lines.push('')
  lines.push(`- 已启动:${started};预算外未启动:${notRun}${notRun > 0 ? '(部分批次,不构成完整发布结论)' : ''}`)
  lines.push('')

  lines.push('## 指标')
  lines.push('')
  lines.push('| 指标 | 值 | n/N |')
  lines.push('|---|---|---|')
  lines.push(fmtMetric('完成率', metrics.completion))
  lines.push(fmtMetric('工具选择准确率', metrics.toolSelection))
  lines.push(fmtMetric('参数准确率', metrics.argumentAccuracy))
  lines.push(fmtMetric('工具错误率', metrics.toolErrorRate))
  lines.push(
    `| 确认绕过 | ${metrics.confirmationBypass.count}(必须为 0)/ 已尝试写 ${metrics.confirmationBypass.attemptedWrites} | — |`
  )
  const lat = metrics.latency
  lines.push(
    `| 延迟 p50/p95 | ${lat.p50Ms ?? 'N/A'} / ${lat.p95Ms ?? 'N/A'} ms${lat.smallSample ? '(小样本,n<20)' : ''};超时 ${lat.timeouts} | — |`
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

  const failed = state.results.filter((r) => r.status === 'failed' && r.failureReasons.length > 0)
  if (failed.length > 0) {
    lines.push('## 失败案例(保留在分母内)')
    lines.push('')
    for (const r of failed.slice(0, 5)) {
      lines.push(`- **${r.caseId}**(${r.configId}):${r.failureReasons.join(';')}`)
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
  lines.push(`- 未知 usage/费用以 null 表示,报告中不出现"免费"。`)
  lines.push('')

  return lines.join('\n')
}
