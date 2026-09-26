// 评测 Runner(E-03):按"案例 × 配置 × 重复"执行,隔离环境,结果持久化可续跑。
//
// 关键规则(LLM Eval Lab 规格第 6 节):
// - fake/real 分离:fake 结果标 execution_kind='fake',不得当真实模型能力;
// - 已启动后失败或超时的案例保留在分母;预算停止后未启动案例标 not_run;
// - 重启续跑:按 (eval_run_id, config_id, case_id, repeat_index) 唯一组合
//   跳过已完成结果,不覆盖原记录;
// - interaction_script 经 runner 驱动真实入口(decide/acceptAnswers),
//   不存在"评测模式自动批准"开关;
// - 每个案例的临时环境用后即弃。

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LoadedDataset } from './dataset'
import type { EvalCase, EvalSplit } from './types'
import { createIsolatedCaseEnv, type IsolatedCaseEnv } from './isolation'
import { RunOrchestrator } from '../agent/orchestrator'
import { RunQueue } from '../agent/runQueue'
import { ToolGateway } from '../tools/gateway'
import { ToolRegistry } from '../tools/registry'
import { registerOpsTools } from '../tools/definitions'
import { FakeProvider } from '../providers/fake'
import { getRun, listTraceEvents, transitionRun, listApprovals } from '../runs/repository'
import { initWorkspaceEpoch } from '../db/operations'

export type ExecutionKind = 'fake' | 'real'

export interface EvalExperimentConfig {
  /** 冻结配置标识(如 fts_single_pass / bounded_research) */
  config_id: string
  description: string
  execution_kind: ExecutionKind
  /** 冻结说明:代码版本、提示词 hash、工具版本等 */
  freeze_note: string
}

export type CaseOutcomeStatus = 'passed' | 'failed' | 'not_run'

export interface EvalCaseOutcome {
  configId: string
  caseId: string
  repeatIndex: number
  status: CaseOutcomeStatus
  /** 关联的 AgentRun(未启动为空) */
  runId: string | null
  terminalStatus: string | null
  failureReasons: string[]
  executedTools: string[]
  confirmedBypass: boolean
}

export interface EvalRunState {
  evalRunId: string
  datasetVersion: string
  casesSha256: string
  splits: EvalSplit[]
  configIds: string[]
  executionKind: ExecutionKind
  repeats: number
  maxCases: number
  status: 'running' | 'completed' | 'cancelled'
  startedAt: string
  finishedAt: string | null
  results: EvalCaseOutcome[]
}


export interface RunnerDeps {
  /** 评测根目录(artifacts 之下),状态与临时目录都在其中 */
  artifactRoot: string
  sqlJsDistDir: string
  /** 已加载并校验的数据集 */
  dataset: LoadedDataset
  /** 真实模式的结构化补全;fake 模式忽略 */
  realCompleter?: unknown
}

function outcomeKey(configId: string, caseId: string, repeat: number): string {
  return `${configId}::${caseId}::${repeat}`
}

function nowIso(): string {
  return new Date().toISOString()
}

/** 从案例 expected 推导 fake 模式的模型脚本(歧义类先澄清后执行) */
function fakeScriptFor(caseDef: EvalCase): Array<unknown> {
  const steps = (caseDef.expected.tool_sequence ?? []).map((tool) => ({
    tool,
    arguments: caseDef.expected.required_arguments?.[tool] ?? {}
  }))
  const isAmbiguous = caseDef.category.includes('歧义') || caseDef.category.includes('clarification')
  if (isAmbiguous) {
    return [
      {
        goal: caseDef.input,
        steps: [],
        assumptions: [],
        clarifications: [{ question_id: 'q-1', question: '请补充缺失的时间或范围信息' }]
      },
      { goal: caseDef.input, steps, assumptions: [], clarifications: [] }
    ]
  }
  return [{ goal: caseDef.input, steps, assumptions: [], clarifications: [] }]
}

/** 快照业务表行数(状态断言的基线与事后值) */
function tableCounts(db: import('../db/connection').SqliteDb, tables: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const table of tables) {
    try {
      out[table] = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0
    } catch {
      out[table] = -1
    }
  }
  return out
}

export class EvalRunner {
  private state: EvalRunState

  constructor(
    private readonly deps: RunnerDeps,
    state: EvalRunState
  ) {
    // 续跑:同目录已有状态则载入,跳过已完成组合
    const stateFile = join(deps.artifactRoot, state.evalRunId, 'state.json')
    if (existsSync(stateFile)) {
      try {
        this.state = JSON.parse(readFileSync(stateFile, 'utf-8')) as EvalRunState
        return
      } catch {
        /* 损坏状态按新运行处理 */
      }
    }
    this.state = { ...state, results: [] }
  }

  /** 只读访问当前状态(报告与测试用) */
  get snapshot(): Readonly<EvalRunState> {
    return this.state
  }

  private persist(): void {
    const dir = join(this.deps.artifactRoot, this.state.evalRunId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'state.json'), JSON.stringify(this.state, null, 2), 'utf-8')
  }

  private outcome(configId: string, caseId: string, repeat: number): EvalCaseOutcome | undefined {
    return this.state.results.find(
      (r) => r.configId === configId && r.caseId === caseId && r.repeatIndex === repeat
    )
  }

  /** 执行整批;返回最终状态(单案例失败不会中断批次) */
  async run(): Promise<EvalRunState> {
    mkdirSync(this.deps.artifactRoot, { recursive: true })
    // case 临时目录的父目录:createIsolatedCaseEnv 的 mkdtemp 需要它存在
    mkdirSync(join(this.deps.artifactRoot, 'cases'), { recursive: true })
    this.state.status = 'running'
    this.persist()

    let started = 0
    const maxCases = this.state.maxCases

    for (const configId of this.state.configIds) {
      for (const caseDef of this.selectedCases()) {
        for (let repeat = 0; repeat < this.state.repeats; repeat += 1) {
          if (this.outcome(configId, caseDef.case_id, repeat)) continue
          if (started >= maxCases) {
            this.state.results.push({
              configId,
              caseId: caseDef.case_id,
              repeatIndex: repeat,
              status: 'not_run',
              runId: null,
              terminalStatus: null,
              failureReasons: ['预算内未启动(预算已用尽)'],
              executedTools: [],
              confirmedBypass: false
            })
            continue
          }
          started += 1
          const outcome = await this.runSingle(configId, caseDef, repeat)
          this.state.results.push(outcome)
          this.persist()
        }
      }
    }

    const hasNotRun = this.state.results.some((r) => r.status === 'not_run')
    this.state.status = hasNotRun ? 'cancelled' : 'completed'
    this.state.finishedAt = nowIso()
    this.persist()
    return this.state
  }

  private selectedCases(): EvalCase[] {
    return this.deps.dataset.cases.filter((c) => this.state.splits.includes(c.split))
  }

  /** 取消:停止领取新 case,已完成的保留 */
  cancel(): void {
    if (this.state.status === 'running') this.state.status = 'cancelled'
    this.persist()
  }

  private async runSingle(configId: string, caseDef: EvalCase, repeat: number): Promise<EvalCaseOutcome> {
    const base: EvalCaseOutcome = {
      configId,
      caseId: caseDef.case_id,
      repeatIndex: repeat,
      status: 'failed',
      runId: null,
      terminalStatus: null,
      failureReasons: [],
      executedTools: [],
      confirmedBypass: false
    }
    let env: IsolatedCaseEnv | null = null
    try {
      env = await createIsolatedCaseEnv(join(this.deps.artifactRoot, 'cases'), caseDef, this.deps.sqlJsDistDir)
      initWorkspaceEpoch()
      // 基线:fixture 播种后的行数(状态断言的 countDelta 相对此基线)
      const baselineTables = (caseDef.expected.state_assertions ?? []).map((a) => a.table)
      const baseline = tableCounts(env.db, baselineTables)

      const registry = new ToolRegistry()
      registerOpsTools(registry)
      const gateway = new ToolGateway({ db: env.db, registry, clock: env.clock })
      const queue = new RunQueue(env.db)
      const provider =
        this.state.executionKind === 'fake'
          ? new FakeProvider({ responses: fakeScriptFor(caseDef), clock: env.clock })
          : (this.deps.realCompleter as never)
      const orchestrator = new RunOrchestrator({
        db: env.db,
        registry,
        gateway,
        queue,
        completer: provider as never
      })

      const run = orchestrator.createQueuedRun({
        mode: caseDef.mode,
        input: caseDef.input,
        timezone: caseDef.timezone
      })
      base.runId = run.runId

      // 驱动规划,然后按脚本驱动真实入口(批准/回答)
      const script = [...caseDef.interaction_script]
      await orchestrator.drivePlanning(run.runId)
      for (let guard = 0; guard < script.length + 2; guard += 1) {
        const current = getRun(env.db, run.runId)
        if (!current || current.finishedAt != null) break
        if (current.status === 'awaiting_confirmation') {
          const pending = listApprovals(env.db, run.runId).find((a) => a.decision === 'pending')
          const step = script.find((s) => s.on === 'confirmation')
          if (!pending || !step) break
          await orchestrator.decide(pending.approvalId, step.decision ?? 'approved')
          script.splice(script.indexOf(step), 1)
          continue
        }
        if (current.status === 'awaiting_input') {
          const step = script.find((s) => s.on === 'clarification')
          if (!step) break
          await orchestrator.submitAnswers(run.runId, [
            { questionId: step.answer ? 'q-1' : 'q-1', answer: step.answer ?? '按建议执行' }
          ])
          script.splice(script.indexOf(step), 1)
          continue
        }
        // queued/planning:等待规划微任务
        await new Promise((resolve) => setTimeout(resolve, 0))
      }

      const after = getRun(env.db, run.runId)
      base.terminalStatus = after?.status ?? null

      // 规则判定
      const trace = listTraceEvents(env.db, run.runId)
      base.executedTools = trace
        .filter((e) => e.eventType === 'tool_call')
        .map((e) => String((e.payload as { tool?: string }).tool ?? ''))
      const errorEvents = trace.filter((e) => e.eventType === 'error')
      if (after?.status === 'failed' || after?.status === 'partial') {
        base.failureReasons.push(
          ...errorEvents.map((e) => `运行错误:${String((e.payload as { code?: string; message?: string }).code ?? '')} ${String((e.payload as { message?: string }).message ?? '')}`)
        )
      }

      const reasons = base.failureReasons
      if (after?.status !== caseDef.expected.terminal_status) {
        reasons.push(`终态 ${after?.status ?? '未知'} ≠ 期望 ${caseDef.expected.terminal_status}`)
      }
      if (caseDef.expected.tool_sequence) {
        const gold = caseDef.expected.tool_sequence
        const actual = base.executedTools
        if (gold.length !== actual.length || gold.some((t, i) => t !== actual[i])) {
          reasons.push(`工具序列不一致:期望 [${gold.join(', ')}],实际 [${actual.join(', ')}]`)
        }
      }
      if (caseDef.expected.requires_confirmation === true) {
        const hasConfirmation = trace.some((e) => e.eventType === 'confirmation')
        if (!hasConfirmation) reasons.push('期望确认流程但未发生')
      }
      for (const forbidden of caseDef.expected.forbidden_tools ?? []) {
        if (base.executedTools.includes(forbidden)) {
          reasons.push(`出现禁止的工具:${forbidden}`)
        }
      }
      // 状态断言:行数变化相对 fixture 播种后的基线
      if (caseDef.expected.state_assertions) {
        const afterCounts = tableCounts(env.db, caseDef.expected.state_assertions.map((a) => a.table))
        for (const assertion of caseDef.expected.state_assertions) {
          const delta = afterCounts[assertion.table]! - baseline[assertion.table]!
          if (delta !== assertion.countDelta) {
            reasons.push(
              `状态断言 ${assertion.table}:期望变化 ${assertion.countDelta},实际 ${delta}`
            )
          }
        }
      }
      base.status = reasons.length === 0 ? 'passed' : 'failed'
      return base
    } catch (err) {
      base.failureReasons.push(err instanceof Error ? err.message : String(err))
      return base
    } finally {
      env?.dispose()
    }
  }

}
