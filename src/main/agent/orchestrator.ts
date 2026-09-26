// RunOrchestrator(A-04):单 Agent 运行的编排入口。
//
// 流程(模块规格第 7 节):
//   queued → planning →(读工具按序执行)→(写工具生成待批准提案)
//     → awaiting_confirmation →(批准)→ executing → succeeded/partial
//     →(拒绝)→ cancelled(既有影响保留并过期其余提案)
//   planning 阶段可携带 clarifications → awaiting_input →(回答)→ queued 重新入队。
//
// 三条硬规则:
// 1. 创建运行不在调用方请求内等待模型(总体规格第 7 节)——startRun 只落库排队,
//    规划由 drivePlanning 驱动(公开方法:测试与 IPC 层都可显式等待);
// 2. 澄清最多一轮:带 answers 的重新规划不再接受新的 clarifications;
// 3. 每个状态转移与工具调用都先落轨迹再广播(AgentEventStream)。

import type { SqliteDb } from '../db/connection'
import type { Clock } from '../../shared/clock'
import { systemClock } from '../../shared/clock'
import { appError } from '../../shared/operations'
import { OperationError } from '../db/operations'
import { getRun, appendTraceEvent, listTraceEvents, transitionRun, expireStaleApprovals, getApproval, decideApproval, createRun, type AgentRunRecord } from '../runs/repository'
import { listRunsByStatus } from '../runs/repository'
import type { RunQueue } from './runQueue'
import type { AgentEventStream } from './eventStream'
import type { StructuredCompleter } from './llm'
import { buildPlanningPrompt, parseModelPlan, PLAN_SYSTEM_PROMPT, type ToolCatalogEntry } from './planner'
import type { ToolRegistry } from '../tools/registry'
import type { ToolGateway } from '../tools/gateway'
import type { RunMode, TraceEventType } from '../../shared/agent'

export const MODEL_UNAVAILABLE = 'MODEL_UNAVAILABLE'
export const MODEL_OUTPUT_INVALID = 'MODEL_OUTPUT_INVALID'
export const PROPOSAL_REJECTED = 'PROPOSAL_REJECTED'

export interface OrchestratorDeps {
  db: SqliteDb
  registry: ToolRegistry
  gateway: ToolGateway
  queue: RunQueue
  events?: AgentEventStream
  /** 结构化补全;缺省时规划以 MODEL_UNAVAILABLE 失败(生产接线见 A-05) */
  completer?: StructuredCompleter
  clock?: Clock
}

export interface StartRunInput {
  mode: RunMode
  input: string
  timezone?: string
}

export interface AnswerItem {
  questionId: string
  answer: string
}

export class RunOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  /** 创建运行:只落库排队,立即返回;规划异步驱动 */
  startRun(input: StartRunInput): AgentRunRecord {
    const run = this.createQueuedRun(input)
    void this.drivePlanning(run.runId).catch((err: unknown) => {
      console.error('[orchestrator] 规划驱动异常:', err instanceof Error ? err.message : String(err))
    })
    return run
  }

  /** 只创建排队运行(不驱动规划):IPC 层先写回执,再异步驱动 */
  createQueuedRun(input: StartRunInput): AgentRunRecord {
    return createRun(this.deps.db, {
      mode: input.mode,
      input: input.input,
      contextClock: this.deps.clock?.now().toISOString() ?? new Date().toISOString(),
      timezone: input.timezone
    })
  }

  /** 工具目录(注册表 → 规划提示词摘要) */
  private catalog(): ToolCatalogEntry[] {
    return this.deps.registry.list().map((name) => {
      const def = this.deps.registry.get(name)
      return {
        name,
        description: def.description,
        requiresConfirmation: def.riskLevel !== 'read',
        fields: def.inputSchema.fields.map((f) => ({
          name: f.name,
          type: f.type,
          required: f.required === true
        }))
      }
    })
  }

  private trace(runId: string, eventType: TraceEventType, payload: Record<string, unknown>): void {
    const event = appendTraceEvent(this.deps.db, { runId, eventType, payload })
    const run = getRun(this.deps.db, runId)
    if (run) this.deps.events?.emit(event, run)
  }

  private failRun(runId: string, errorCode: string, message: string): void {
    const run = getRun(this.deps.db, runId)
    if (!run || run.status === 'failed' || run.finishedAt != null) return
    transitionRun(this.deps.db, runId, 'failed', { errorCode })
    this.trace(runId, 'error', { code: errorCode, message })
  }

  /**
   * 规划与执行驱动。answers 提供时是澄清后的重新规划(最多一轮澄清)。
   * 公开方法:测试与 IPC 层可 await 以确定性地观察终态。
   */
  async drivePlanning(runId: string, answers?: AnswerItem[]): Promise<void> {
    const run = getRun(this.deps.db, runId)
    if (!run || run.status !== 'queued') return

    if (!this.deps.queue.tryStart(runId)) {
      // 执行权被占:保持排队,由当前运行的收尾驱动下一个
      return
    }
    // tryStart 已把状态推进到 planning
    if (!this.deps.completer) {
      this.failRun(runId, MODEL_UNAVAILABLE, '模型服务未配置,无法生成执行计划')
      return
    }

    let plan
    let planModel: string | null = null
    try {
      const result = await this.deps.completer.completeJson({
        system: PLAN_SYSTEM_PROMPT,
        prompt: buildPlanningPrompt({ task: run.input, catalog: this.catalog(), answers }),
        schemaHint: { goal: 'string', steps: 'array' }
      })
      plan = parseModelPlan(result.data)
      planModel = result.model
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.failRun(runId, MODEL_OUTPUT_INVALID, `模型输出无法解析为有效计划:${message}`)
      return
    }

    // 工具合法性:未注册工具在执行前拒绝整个计划(OPS-07)
    for (const step of plan.steps) {
      if (!this.deps.registry.has(step.tool)) {
        this.failRun(runId, MODEL_OUTPUT_INVALID, `计划引用了未注册的工具:${step.tool}`)
        return
      }
    }

    this.trace(runId, 'plan', {
      goal: plan.goal,
      steps: plan.steps,
      assumptions: plan.assumptions,
      model: planModel
    })

    // 澄清(最多一轮):本轮未带回答且模型要求澄清 → 等待人工,释放执行权
    if (plan.clarifications.length > 0 && (!answers || answers.length === 0)) {
      this.trace(runId, 'input', { questions: plan.clarifications })
      transitionRun(this.deps.db, runId, 'awaiting_input')
      return
    }

    await this.executePlan(runId, plan.steps)
  }

  /** 顺序执行计划:读工具直接执行;写工具生成待批准提案 */
  private async executePlan(
    runId: string,
    steps: Array<{ tool: string; arguments: Record<string, unknown> }>
  ): Promise<void> {
    let callIndex = 0
    let failed = 0
    const writeApprovals: string[] = []

    for (const step of steps) {
      const def = this.deps.registry.get(step.tool)
      if (def.riskLevel === 'read') {
        const result = await this.deps.gateway.execute({
          runId,
          tool: step.tool,
          arguments: step.arguments,
          planVersion: 1,
          callIndex: callIndex
        })
        callIndex += 1
        if (!result.ok) failed += 1
        this.trace(runId, 'tool_call', {
          tool: step.tool,
          ok: result.ok,
          error: result.ok ? null : result.error.code
        })
      } else {
        try {
          const proposal = this.deps.gateway.propose({
            runId,
            tool: step.tool,
            arguments: step.arguments,
            planVersion: 1
          })
          writeApprovals.push(proposal.approvalId!)
          this.trace(runId, 'confirmation', {
            tool: step.tool,
            approvalId: proposal.approvalId,
            expiresAt: proposal.expiresAt,
            requiresConfirmation: true
          })
        } catch (err) {
          // 虚构 ID 等提案期拒绝:整个计划失败,已生成的提案保留待审(审计痕迹)
          this.failRun(
            runId,
            'PROPOSAL_INVALID',
            err instanceof Error ? err.message : String(err)
          )
          return
        }
        callIndex += 1
      }
    }

    if (writeApprovals.length > 0) {
      transitionRun(this.deps.db, runId, 'awaiting_confirmation')
      return
    }
    this.finishRun(runId, failed)
  }

  /** 收尾:全部成功 → succeeded;存在工具级失败 → partial(保留已完成影响) */
  private finishRun(runId: string, failedSteps: number): void {
    transitionRun(this.deps.db, runId, failedSteps > 0 ? 'partial' : 'succeeded', {
      resultRef: JSON.stringify({ failedSteps })
    })
    this.trace(runId, 'output', { failedSteps })
    this.driveNextQueued()
  }

  private driveNextQueued(): void {
    const next = this.deps.queue.nextQueued()
    if (next) {
      void this.drivePlanning(next.runId).catch((err: unknown) => {
        console.error('[orchestrator] 后续运行驱动异常:', err instanceof Error ? err.message : String(err))
      })
    }
  }

  /**
   * 受理澄清回答(同步):校验、落轨迹、重新入队。不等待模型——
   * 调用方受理后自行以 drivePlanning(runId, answers) 异步驱动。
   */
  acceptAnswers(runId: string, answers: AnswerItem[]): AgentRunRecord {
    const run = getRun(this.deps.db, runId)
    if (!run) throw new OperationError(appError('VALIDATION', `运行不存在:${runId}`, { retryable: false }))
    if (run.status !== 'awaiting_input') {
      throw new OperationError(appError('CONFLICT', '运行不在等待输入状态', { retryable: false }))
    }
    if (answers.length === 0) {
      throw new OperationError(appError('VALIDATION', '回答不能为空', { retryable: false }))
    }
    this.trace(runId, 'input', { answers })
    return transitionRun(this.deps.db, runId, 'queued')
  }

  /** 提交澄清回答并等待重新规划完成(测试与 CLI 用;IPC 层用 acceptAnswers) */
  async submitAnswers(runId: string, answers: AnswerItem[]): Promise<void> {
    this.acceptAnswers(runId, answers)
    await this.drivePlanning(runId, answers)
  }

  /**
   * 审批决定。approved → 执行该写步骤(参数从审批记录还原,重启安全);
   * rejected → 运行取消、其余待批提案过期(既有影响保留)。
   * 条件更新保证重复决定只生效一次;重复请求返回 already=true。
   */
  async decide(approvalId: string, decision: 'approved' | 'rejected'): Promise<{ already: boolean }> {
    const approval = getApproval(this.deps.db, approvalId)
    if (!approval) {
      throw new OperationError(appError('VALIDATION', `审批记录不存在:${approvalId}`, { retryable: false }))
    }
    const run = getRun(this.deps.db, approval.runId)
    if (!run) throw new OperationError(appError('VALIDATION', '运行不存在', { retryable: false }))

    if (!decideApproval(this.deps.db, approvalId, decision)) {
      // 决定未生效:同一决定的重放视为幂等成功;不同决定或已过期即冲突
      const current = getApproval(this.deps.db, approvalId)
      if (current && current.decision === decision) return { already: true }
      throw new OperationError(
        appError('CONFLICT', `审批决定冲突:当前状态 ${current?.decision ?? '未知'}`, { retryable: false })
      )
    }

    if (decision === 'rejected') {
      // 用户拒绝:取消运行并过期其余待批提案(已执行的写入不受影响)
      if (run.status === 'awaiting_confirmation') {
        transitionRun(this.deps.db, run.runId, 'cancelled', { errorCode: PROPOSAL_REJECTED })
        this.deps.db.run(
          "UPDATE approvals SET decision = 'expired' WHERE run_id = ? AND decision = 'pending'",
          [run.runId]
        )
        this.trace(run.runId, 'output', { rejected: approvalId })
      }
      return { already: false }
    }

    // 批准:执行该写步骤。运行必须仍在等待确认(已取消/已终态的批准拒绝执行)
    if (run.status !== 'awaiting_confirmation') {
      throw new OperationError(appError('CONFLICT', '运行不在等待确认状态,无法执行提案', { retryable: false }))
    }
    transitionRun(this.deps.db, run.runId, 'executing')

    const args = approval.argumentsJson ? (JSON.parse(approval.argumentsJson) as Record<string, unknown>) : {}
    // callIndex 取该运行已有工具调用数,与规划期连续编号衔接
    const callIndex = listTraceEvents(this.deps.db, run.runId).filter((e) => e.eventType === 'tool_call').length
    let failed = 0
    try {
      const result = await this.deps.gateway.execute({
        runId: run.runId,
        tool: approval.toolName,
        arguments: args,
        planVersion: approval.planVersion,
        callIndex,
        approvalId
      })
      if (!result.ok) failed += 1
      this.trace(run.runId, 'tool_call', {
        tool: approval.toolName,
        ok: result.ok,
        error: result.ok ? null : result.error.code
      })
    } catch (err) {
      // 网关级拒绝(如目标版本变化,OPS-06)→ 运行失败
      failed += 1
      const message = err instanceof Error ? err.message : String(err)
      this.failRun(run.runId, 'CONFLICT', message)
      return { already: false }
    }

    // 其余待批提案:仍在等待 → 回到 awaiting_confirmation;全部已决 → 收尾
    expireStaleApprovals(this.deps.db, new Date().toISOString())
    const remaining = this.pendingCount(run.runId)
    if (remaining > 0) {
      // 还有别的写提案在等:回到等待确认
      transitionRun(this.deps.db, run.runId, 'awaiting_confirmation')
      return { already: false }
    }
    this.finishRun(run.runId, failed)
    return { already: false }
  }

  private pendingCount(runId: string): number {
    return (
      this.deps.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM approvals WHERE run_id = ? AND decision = 'pending'",
        [runId]
      )?.n ?? 0
    )
  }

  /** 请求取消:非终态可取消;既有写入保留,待批提案过期 */
  cancel(runId: string): AgentRunRecord {
    const run = getRun(this.deps.db, runId)
    if (!run) throw new OperationError(appError('VALIDATION', `运行不存在:${runId}`, { retryable: false }))
    const updated = transitionRun(this.deps.db, runId, 'cancelled', { errorCode: 'CANCELLED' })
    expireStaleApprovals(this.deps.db, new Date().toISOString())
    this.deps.db.run(
      "UPDATE approvals SET decision = 'expired' WHERE run_id = ? AND decision = 'pending'",
      [runId]
    )
    this.trace(runId, 'output', { cancelled: true })
    return updated
  }

  /** 当前活跃运行(占执行权)与排队数,供界面与诊断 */
  snapshot(): { active: AgentRunRecord | null; queued: number } {
    return {
      active: this.deps.queue.currentActive(),
      queued: listRunsByStatus(this.deps.db, 'queued').length
    }
  }
}

