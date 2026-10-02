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
// 2. 澄清最多一轮:带 answers 的重新规划不再接受新的 clarifications,仍缺信息
//    以 INPUT_INSUFFICIENT 显式失败(OPS-03);
// 3. 每个状态转移与工具调用都先落轨迹再广播(AgentEventStream);
//    tool_call 轨迹由网关观察单一出口写入,编排器不再重复写简略工具事件。
//
// OPS-02:注入 RunScheduler 后,批准/收尾/取消/澄清重入统一经调度器接力
// (受理批准即排队,不承诺该请求已完成业务执行);驱动从答案轨迹恢复回答,
// 不依赖 IPC 闭包参数;await 后重读运行状态,取消的旧结果不得继续提案或覆写终态。
// 未注入调度器时保持既有"收尾驱动下一个"的接力行为(既有测试与旧组合兼容)。
//
// OPS-03 读后规划(F-02):规划输入携带冻结 contextClock/时区与真实读取结果;
// 混合计划只执行读取、丢弃依赖未执行读取的写参数后重规划(冻结原 task/时区/时钟,
// 恢复已有回答);每轮 planVersion 递增,callIndex 用 OPS-02 持久索引;相同读调用
// 与结果重复无进展即 PLAN_NO_PROGRESS 停止;修改类 ID 必须来自本运行成功读取结果。
//
// OPS-03 预算收口:创建时冻结 resolveAgentBudget 进 budgetJson(旧运行 {} 用默认上限);
// 逻辑计数覆盖首轮/澄清重入/读后规划轮,物理发送准入经 RES-01 ModelRequestControl
// (单发送、beforeSend 检查 signal/活动时间/发送数,准入持久化,重启不重置);
// 逻辑次数与真实发送次数分列,不重复扣同一次请求。OPS 的规则/审核槽位语义不适用。
//
// OPS-04(F-03):澄清回答按最后一批未回答 questions 校验(必答/ID 集合/trim 非空/
// 码点上限),接受后写答案轨迹再 queued;状态转移类事件先落库、转移完成后才广播
// ——事件快照是转移后的状态(awaiting_input 先转状态再发 input;确认卡事件在
// 状态转 awaiting_confirmation 且审批行全部写入后才广播)。

import type { SqliteDb } from '../db/connection'
import type { Clock } from '../../shared/clock'
import { systemClock } from '../../shared/clock'
import { appError } from '../../shared/operations'
import {
  OperationError,
  createPersistenceCoordinator,
  getOperationReceipt,
  type PersistenceCoordinator
} from '../db/operations'
import {
  getRun,
  appendTraceEvent,
  listTraceEvents,
  transitionRun,
  expireStaleApprovals,
  getApproval,
  decideApproval,
  createRun,
  listApprovals,
  isApprovalExecuted,
  maxAssignedCallIndex,
  readApprovalCallIndex,
  appendCallIndexMapping,
  expireUnexecutedApprovals,
  summarizeRunToolResults,
  type AgentRunRecord,
  type Approval
} from '../runs/repository'
import { listRunsByStatus } from '../runs/repository'
import type { RunQueue } from './runQueue'
import type { RunDriver, RunScheduler } from './runScheduler'
import type { AgentEventStream } from './eventStream'
import type { StructuredCompleter } from './llm'
import {
  buildPlanningPrompt,
  parseModelPlan,
  PLAN_SYSTEM_PROMPT,
  type AgentPlan,
  type ToolCatalogEntry
} from './planner'
import type { ToolRegistry } from '../tools/registry'
import type { ToolGateway } from '../tools/gateway'
import type { ToolDefinition, ToolObservationV1, ReadResult } from '../tools/types'
import { stableStringify } from '../tools/schema'
import type { RunMode, TokenUsage, TraceEvent, TraceEventType } from '../../shared/agent'
import { resolveAgentBudget, type AgentBudget } from './config'
import type { ModelAttemptEvent } from '../services/modelRequest'

export const MODEL_UNAVAILABLE = 'MODEL_UNAVAILABLE'
export const MODEL_OUTPUT_INVALID = 'MODEL_OUTPUT_INVALID'
export const PROPOSAL_REJECTED = 'PROPOSAL_REJECTED'
/** OPS-03:澄清后仍缺必填信息 / 修改类 ID 无读取证据 */
export const INPUT_INSUFFICIENT = 'INPUT_INSUFFICIENT'
/** OPS-03:相同读调用与结果重复无进展(含读后规划轮次耗尽) */
export const PLAN_NO_PROGRESS = 'PLAN_NO_PROGRESS'
/**
 * 读后规划的轮次上限(结构性终止守卫,防无限循环):首轮 + 读后重规划 + 澄清重规划。
 * 预算账本(冻结 AgentBudget/control.beforeSend)按 OPS-03 收口接线,通常先于本上限触发。
 */
const MAX_PLANNING_ROUNDS = 6

/** 每条澄清回答的码点上限;UI 与 acceptAnswers 使用一致规则(OPS-04) */
export const MAX_ANSWER_CODEPOINTS = 1000

/**
 * 预算准入拒绝(control.beforeSend 内抛出):上层捕获后按 PLAN 停止语义收尾,
 * 保留已完成影响,不伪装成功。错误码沿用 CONFLICT(词表无 BUDGET_EXHAUSTED)。
 */
export class BudgetAdmissionError extends OperationError {
  constructor(message: string) {
    super(appError('CONFLICT', message, { retryable: false }))
    this.name = 'BudgetAdmissionError'
  }
}

/**
 * 冻结进 budgetJson 的预算账本形态(OPS-03 预算收口):
 * budget 为创建时冻结的 AgentBudget;usage 分列逻辑次数(规划轮)与
 * 真实发送次数(beforeSend 准入),不重复扣同一次请求;activeMs 用单调钟累加,
 * 排除排队与人工等待。旧运行 budgetJson 为空/{} 时按默认上限与零计数处理。
 */
interface FrozenBudgetState {
  budget: AgentBudget
  usage: { logicalModelCalls: number; sentModelAttempts: number; activeMs: number }
}

const ZERO_USAGE: FrozenBudgetState['usage'] = { logicalModelCalls: 0, sentModelAttempts: 0, activeMs: 0 }

/** 单次模型请求超时上限(毫秒);取 min(该上限, 剩余活动时间) */
const MAX_MODEL_CALL_TIMEOUT_MS = 30_000

export interface OrchestratorDeps {
  db: SqliteDb
  registry: ToolRegistry
  gateway: ToolGateway
  queue: RunQueue
  events?: AgentEventStream
  /** 结构化补全;缺省时规划以 MODEL_UNAVAILABLE 失败(生产接线见 A-05) */
  completer?: StructuredCompleter
  clock?: Clock
  /**
   * R-06 收口:队列接力钩子——Ops 收尾驱动下一个排队运行时,
   * 若下一个是其他 mode(如 research)则转交组合层,避免用 Ops 规划路径误驱。
   * 注入 RunScheduler 后由调度器统一接力,本钩子不再被调用。
   */
  onNonOpsQueued?: (runId: string) => void
  /**
   * OPS-02:共享调度器。注入后批准受理只排队(受理批准即排队,执行由调度器派发),
   * 收尾/取消/澄清重入经 request() 合并唤醒,删除与旧接力的双轨竞争。
   */
  scheduler?: RunScheduler
  /** OPS-02:重复批准仅重试保存时使用的持久化协调器;缺省时按库自建(仅 flush 语义) */
  persistCoordinator?: PersistenceCoordinator
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

/** 审批冻结参数解码:缺失或不可解码一律 CONFLICT,禁止用 {} 冒充冻结参数继续执行 */
function parseFrozenArguments(approval: Approval): Record<string, unknown> {
  if (!approval.argumentsJson) {
    throw new OperationError(
      appError('CONFLICT', '审批缺少冻结参数,无法执行;需重新规划生成提案', { retryable: false })
    )
  }
  try {
    const parsed: unknown = JSON.parse(approval.argumentsJson)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('冻结参数不是 JSON 对象')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new OperationError(
      appError('CONFLICT', '审批冻结参数无法解码,无法执行;需重新规划生成提案', { retryable: false })
    )
  }
}

// ---------- 修改类 ID 的读取证据(OPS-03) ----------

/** 工具的实体类别:取工具名首段(todo.update → todo;calendar.update_event → calendar) */
function entityKeyOf(tool: string): string {
  const dot = tool.indexOf('.')
  return dot === -1 ? tool : tool.slice(0, dot)
}

/** 修改类工具(引用已存在记录):注册表以 resolveTargetVersion 标记 */
function hasTargetId(def: ToolDefinition): boolean {
  return typeof def.resolveTargetVersion === 'function'
}

/** 提取读取结果数据里的记录 ID:任一数组属性中对象的 string id 字段 */
function extractRecordIds(data: unknown): string[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  for (const value of Object.values(data as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    const ids = value
      .filter(
        (item): item is { id: string } =>
          typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string'
      )
      .map((item) => item.id)
    if (ids.length > 0) return ids
  }
  return []
}

/** 从本运行成功读取结果中收集各实体类别的真实记录 ID(修改类提案的证据) */
function collectReadEvidence(readResults: ReadonlyArray<ReadResult>): Map<string, Set<string>> {
  const evidence = new Map<string, Set<string>>()
  for (const read of readResults) {
    if (!read.result.ok) continue
    const entity = entityKeyOf(read.tool)
    const ids = extractRecordIds(read.result.data)
    if (ids.length === 0) continue
    const bucket = evidence.get(entity) ?? new Set<string>()
    for (const id of ids) bucket.add(id)
    evidence.set(entity, bucket)
  }
  return evidence
}

/** 修改类步骤的目标 ID 是否有读取证据:即使虚构 ID 恰好存在数据库,无证据也不能提案 */
function evidenceHasId(
  evidence: Map<string, Set<string>>,
  tool: string,
  args: Record<string, unknown>
): boolean {
  const id = args.id
  if (typeof id !== 'string') return false
  return evidence.get(entityKeyOf(tool))?.has(id) ?? false
}

export class RunOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  private get clock(): Clock {
    return this.deps.clock ?? systemClock
  }

  /** 重复批准仅重试保存所用的协调器:依赖未注入时按库自建(flush 语义等价) */
  private saveCoordinator(): PersistenceCoordinator {
    return this.deps.persistCoordinator ?? createPersistenceCoordinator(this.deps.db)
  }

  /**
   * R-06 收口:组合层在两套工作流都构造完成后注入接力钩子
   * (构造期互相引用,构造后再注入比在 deps 里传更简单)。
   */
  setOnNonOpsQueued(hook: (runId: string) => void): void {
    this.deps.onNonOpsQueued = hook
  }

  /**
   * OPS-02:本编排器作为 RunScheduler 驱动的入口。
   * 组合层接线:scheduler.register('personal_ops', orchestrator.asRunDriver())。
   * plan 意图 → drivePlanning(回答从轨迹恢复);approved 意图 → executeApproved。
   */
  asRunDriver(): RunDriver {
    return async (runId, intent, signal) => {
      if (intent.kind === 'plan') {
        await this.drivePlanning(runId, undefined, signal)
        return
      }
      await this.executeApproved(runId, intent.approvalId, signal)
    }
  }

  /** 创建运行:只落库排队,立即返回;规划异步驱动 */
  startRun(input: StartRunInput): AgentRunRecord {
    const run = this.createQueuedRun(input)
    if (this.deps.scheduler) {
      // 调度器模式:只入队,由调度器派发驱动
      this.deps.scheduler.request()
      return run
    }
    void this.drivePlanning(run.runId).catch((err: unknown) => {
      console.error('[orchestrator] 规划驱动异常:', err instanceof Error ? err.message : String(err))
    })
    return run
  }

  /** 只创建排队运行(不驱动规划):IPC 层先写回执,再异步驱动。
   *  OPS-03 预算收口:创建时冻结解析后的 AgentBudget(只可下调的默认上限)进 budgetJson,
   *  计数从零开始;旧运行保持 {} 由读取侧按默认上限兼容。 */
  createQueuedRun(input: StartRunInput): AgentRunRecord {
    return createRun(this.deps.db, {
      mode: input.mode,
      input: input.input,
      contextClock: this.deps.clock?.now().toISOString() ?? new Date().toISOString(),
      timezone: input.timezone,
      budgetJson: JSON.stringify({ budget: resolveAgentBudget(), usage: { ...ZERO_USAGE } })
    })
  }

  // ---------- 预算账本(OPS-03 预算收口) ----------

  /** 读取冻结预算账本:空/旧格式({})回退默认上限与零计数 */
  private readBudgetState(run: AgentRunRecord): FrozenBudgetState {
    const fallback = (): FrozenBudgetState => ({ budget: resolveAgentBudget(), usage: { ...ZERO_USAGE } })
    if (!run.budgetJson || run.budgetJson === '{}' || run.budgetJson === '') return fallback()
    try {
      const parsed = JSON.parse(run.budgetJson) as Partial<FrozenBudgetState>
      if (!parsed || typeof parsed !== 'object') return fallback()
      const budget =
        parsed.budget && typeof (parsed.budget as AgentBudget).maxModelCalls === 'number'
          ? (parsed.budget as AgentBudget)
          : resolveAgentBudget()
      const rawUsage = parsed.usage ?? ZERO_USAGE
      return {
        budget,
        usage: {
          logicalModelCalls: typeof rawUsage.logicalModelCalls === 'number' ? rawUsage.logicalModelCalls : 0,
          sentModelAttempts: typeof rawUsage.sentModelAttempts === 'number' ? rawUsage.sentModelAttempts : 0,
          activeMs: typeof rawUsage.activeMs === 'number' ? rawUsage.activeMs : 0
        }
      }
    } catch {
      return fallback()
    }
  }

  /**
   * 以增量方式持久化预算计数(先重读最新状态再合并写入,避免覆盖并发写入的
   * 其他计数项);落 runs 表 budgetJson,重启后不重置。
   */
  private addBudgetUsage(
    runId: string,
    delta: { logicalModelCalls?: number; sentModelAttempts?: number; activeMs?: number }
  ): void {
    const run = getRun(this.deps.db, runId)
    if (!run) return
    const state = this.readBudgetState(run)
    const usage = {
      logicalModelCalls: state.usage.logicalModelCalls + (delta.logicalModelCalls ?? 0),
      sentModelAttempts: state.usage.sentModelAttempts + (delta.sentModelAttempts ?? 0),
      activeMs: state.usage.activeMs + (delta.activeMs ?? 0)
    }
    this.deps.db.run('UPDATE agent_runs SET budget_json = ? WHERE run_id = ?', [
      JSON.stringify({ budget: state.budget, usage }),
      runId
    ])
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

  private trace(
    runId: string,
    eventType: TraceEventType,
    payload: Record<string, unknown>,
    durationMs: number | null = null,
    tokenUsage: TokenUsage | null = null
  ): void {
    const event = appendTraceEvent(this.deps.db, { runId, eventType, payload, durationMs, tokenUsage })
    const run = getRun(this.deps.db, runId)
    if (run) this.deps.events?.emit(event, run)
  }

  /** 只落库不广播:状态转移类事件先写轨迹,转移完成后经 emitDeferred 统一广播(OPS-04) */
  private append(runId: string, eventType: TraceEventType, payload: Record<string, unknown>): TraceEvent {
    return appendTraceEvent(this.deps.db, { runId, eventType, payload })
  }

  /** 广播已落库的事件:每条附带当前(转移后)运行快照,快照滞后于状态写入 */
  private emitDeferred(runId: string, events: readonly TraceEvent[]): void {
    if (events.length === 0) return
    const run = getRun(this.deps.db, runId)
    if (!run) return
    for (const event of events) this.deps.events?.emit(event, run)
  }

  private failRun(runId: string, errorCode: string, message: string): void {
    const run = getRun(this.deps.db, runId)
    if (!run || run.status === 'failed' || run.finishedAt != null) return
    transitionRun(this.deps.db, runId, 'failed', { errorCode })
    this.trace(runId, 'error', { code: errorCode, message })
  }

  /** 从答案轨迹恢复最近一次澄清回答(调度器派发不携带闭包参数) */
  private loadAnswersFromTrace(runId: string): AnswerItem[] {
    const events = listTraceEvents(this.deps.db, runId)
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!
      if (event.eventType !== 'input') continue
      const answers = (event.payload as { answers?: unknown }).answers
      if (!Array.isArray(answers) || answers.length === 0) continue
      const items: AnswerItem[] = []
      for (const item of answers) {
        if (!item || typeof item !== 'object') continue
        const questionId = (item as { questionId?: unknown }).questionId
        const answer = (item as { answer?: unknown }).answer
        if (typeof questionId === 'string' && typeof answer === 'string') {
          items.push({ questionId, answer })
        }
      }
      if (items.length > 0) return items
    }
    return []
  }

  /**
   * 规划与执行驱动。answers 提供时是澄清后的重新规划(最多一轮澄清);
   * 缺省时从答案轨迹恢复(调度器派发路径)。signal 取消时停止写入并让出执行权。
   * 公开方法:测试与 IPC 层可 await 以确定性地观察终态。
   *
   * OPS-03 读后规划循环:每轮 planVersion 递增;提示词携带冻结 contextClock/
   * 时区与真实读取结果;混合计划只执行读取后重规划;相同读调用与结果重复
   * 无进展即 PLAN_NO_PROGRESS 停止。所有重规划只生成新提案,不执行写入。
   *
   * OPS-03 预算收口:每轮先检查冻结预算(逻辑计数/活动时间)再扣减逻辑计数;
   * 模型调用携带 RES-01 ModelRequestControl(单发送,beforeSend 准入持久化,
   * onAttempt 落 model 轨迹);超限停止新规划并保留已完成影响。
   * OPS-04:awaiting_input 先转状态再广播 input(事件快照是转移后的状态)。
   */
  async drivePlanning(runId: string, answers?: AnswerItem[], signal?: AbortSignal): Promise<void> {
    const run = getRun(this.deps.db, runId)
    if (!run || run.status !== 'queued') return
    // R-06 收口:研究运行由 ResearchWorkflow 驱动,不走 Ops 规划路径
    if (run.mode !== 'personal_ops') {
      if (!this.deps.scheduler) this.deps.onNonOpsQueued?.(runId)
      return
    }

    const effectiveAnswers = answers ?? this.loadAnswersFromTrace(runId)

    if (!this.deps.queue.tryStart(runId)) {
      // 执行权被占:保持排队,由当前运行的收尾(或调度器唤醒)驱动下一个
      return
    }
    // tryStart 已把状态推进到 planning
    if (!this.deps.completer) {
      this.failRun(runId, MODEL_UNAVAILABLE, '模型服务未配置,无法生成执行计划')
      return
    }

    // 本运行的读取证据:澄清重入时从观察轨迹恢复,保证重规划拿到同一份真实结果
    const readResults: ReadResult[] = this.loadReadResultsFromTrace(runId)
    let prevReadFingerprint: string | null = null
    let failedSteps = 0

    // 本次驱动的取消控制器:链接调度器/调用方 signal(调度器 abort 的接入已有,勿重复造);
    // 模型发送的 control.signal 使用本次驱动新建的 controller
    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', forwardAbort)

    try {
      for (let round = 1; round <= MAX_PLANNING_ROUNDS; round += 1) {
        if (signal?.aborted) return
        const current = getRun(this.deps.db, runId)
        if (!current || current.status !== 'planning') return

        // 预算守卫(逻辑计数):达到上限停止新规划,保留已完成影响(PLAN 停止原因落轨迹)
        const budget = this.readBudgetState(current)
        if (budget.usage.logicalModelCalls >= budget.budget.maxModelCalls) {
          this.failRun(
            runId,
            PLAN_NO_PROGRESS,
            `模型调用预算已用尽(逻辑计数 ${budget.usage.logicalModelCalls}/${budget.budget.maxModelCalls}),停止新规划;已完成影响保留`
          )
          return
        }
        // 预算守卫(活动时间):剩余不足不发起新请求(排队/人工等待不占用活动时间)
        const remainingActiveMs = budget.budget.maxActiveSeconds * 1000 - budget.usage.activeMs
        if (remainingActiveMs <= 0) {
          this.failRun(runId, PLAN_NO_PROGRESS, '活动时间预算已用尽,停止新规划;已完成影响保留')
          return
        }
        // 逻辑计数:每轮规划调用扣一次(覆盖首轮/澄清重入/读后规划轮),先持久化再调用
        this.addBudgetUsage(runId, { logicalModelCalls: 1 })

        const planVersion = this.countPlanEvents(runId) + 1
        const roundStarted = this.clock.monotonicMs()
        let plan: AgentPlan
        let planModel: string | null = null
        try {
          const result = await this.deps.completer.completeJson({
            system: PLAN_SYSTEM_PROMPT,
            prompt: buildPlanningPrompt({
              task: current.input,
              catalog: this.catalog(),
              answers: effectiveAnswers,
              // 冻结原 task/timezone/clock:全部取自运行记录,不用执行机器当前时间
              contextClock: current.contextClock,
              timezone: current.timezone,
              readResults
            }),
            schemaHint: { goal: 'string', steps: 'array', continue_after_read: 'boolean' },
            // RES-01 单发送控制:policy 恒为单次/禁用备用;准入与观测见 beforeSend/onAttempt
            control: {
              requestId: `${runId}:plan:${planVersion}`,
              signal: controller.signal,
              timeoutMs: Math.max(1, Math.min(MAX_MODEL_CALL_TIMEOUT_MS, remainingActiveMs)),
              policy: { maxAttempts: 1, fallback: 'disabled' },
              beforeSend: () => {
                // 准入:检查取消信号与冻结预算,拒绝则不发送;通过则持久化本次发送准入
                if (controller.signal.aborted) {
                  throw new BudgetAdmissionError('发送前已取消,未派发请求')
                }
                const freshRun = getRun(this.deps.db, runId)
                if (!freshRun) throw new BudgetAdmissionError('运行不存在,拒绝发送')
                const fresh = this.readBudgetState(freshRun)
                if (fresh.usage.sentModelAttempts >= fresh.budget.maxModelCalls) {
                  throw new BudgetAdmissionError(
                    `实际发送预留数已达上限 ${fresh.budget.maxModelCalls},拒绝发送;已完成影响保留`
                  )
                }
                const freshRemainingMs = fresh.budget.maxActiveSeconds * 1000 - fresh.usage.activeMs
                if (freshRemainingMs <= 0) {
                  throw new BudgetAdmissionError('活动时间预算已用尽,拒绝发送')
                }
                this.addBudgetUsage(runId, { sentModelAttempts: 1 })
              },
              onAttempt: (event: ModelAttemptEvent) => {
                // 真实发送观测:sent/settled 落 model 轨迹;settled 记 outcome/latency/usage(缺失 null)
                this.traceModelAttempt(runId, event)
              }
            }
          })
          plan = parseModelPlan(result.data)
          planModel = result.model
        } catch (err) {
          // 活动时间照实累计(含失败尝试;真实发送准入已在 beforeSend 扣减)
          this.addBudgetUsage(runId, { activeMs: this.clock.monotonicMs() - roundStarted })
          if (signal?.aborted) return
          if (err instanceof BudgetAdmissionError) {
            this.failRun(runId, PLAN_NO_PROGRESS, `${err.message};停止新规划,已完成影响保留`)
            return
          }
          const message = err instanceof Error ? err.message : String(err)
          this.failRun(runId, MODEL_OUTPUT_INVALID, `模型输出无法解析为有效计划:${message}`)
          return
        }
        this.addBudgetUsage(runId, { activeMs: this.clock.monotonicMs() - roundStarted })

        // await 后重读状态:取消/终结的运行不得继续提案或覆写终态
        if (signal?.aborted) return
        const resumed = getRun(this.deps.db, runId)
        if (!resumed || resumed.status !== 'planning') return

        // 工具合法性:未注册工具在执行前拒绝整个计划(OPS-07)
        for (const step of plan.steps) {
          if (!this.deps.registry.has(step.tool)) {
            this.failRun(runId, MODEL_OUTPUT_INVALID, `计划引用了未注册的工具:${step.tool}`)
            return
          }
        }

        // 空计划不能伪装成功(含澄清后仍缺必填信息的情形)
        if (plan.steps.length === 0 && plan.clarifications.length === 0) {
          this.failRun(runId, INPUT_INSUFFICIENT, '计划没有任何可执行步骤;仍缺少必要信息时应显式失败')
          return
        }

        this.trace(runId, 'plan', {
          goal: plan.goal,
          steps: plan.steps,
          assumptions: plan.assumptions,
          model: planModel,
          planVersion,
          continueAfterRead: plan.continueAfterRead
        })

        // 澄清(最多一轮):已有回答仍要求澄清 → INPUT_INSUFFICIENT,不再阻塞。
        // OPS-04:先落轨迹并转 awaiting_input,再广播(事件快照是转移后的状态)
        if (plan.clarifications.length > 0) {
          if (effectiveAnswers.length > 0) {
            this.failRun(runId, INPUT_INSUFFICIENT, '澄清回答后计划仍缺少必要信息,不能继续')
            return
          }
          const deferred = [this.append(runId, 'input', { questions: plan.clarifications })]
          transitionRun(this.deps.db, runId, 'awaiting_input')
          this.emitDeferred(runId, deferred)
          return
        }

        const readSteps = plan.steps.filter((s) => this.deps.registry.get(s.tool).riskLevel === 'read')
        const writeSteps = plan.steps.filter((s) => this.deps.registry.get(s.tool).riskLevel !== 'read')

        if (readSteps.length === 0) {
          // 纯写计划:校验修改类 ID 的读取证据后生成提案(不执行写入)
          this.proposeWritePlan(runId, writeSteps, planVersion, readResults, signal)
          return
        }

        // mixed-plan 规则:含读取的计划只执行读取,写参数(依赖未执行读取)被丢弃;
        // 相同读调用与结果重复且无进展时停止(同一运行内本地读取是确定性的)
        const fingerprint = readSteps.map((s) => `${s.tool}:${stableStringify(s.arguments)}`).join('|')
        if (prevReadFingerprint !== null && fingerprint === prevReadFingerprint) {
          this.failRun(runId, PLAN_NO_PROGRESS, '重复的读取调用与结果未带来进展,停止重新规划')
          return
        }

        const phase = await this.executeReadPhase(runId, readSteps, planVersion, signal)
        failedSteps += phase.failed
        readResults.push(...phase.results)
        prevReadFingerprint = fingerprint

        // 纯读且模型未请求继续 → 收尾;否则带着读取结果重规划(不执行写入)
        if (writeSteps.length === 0 && !plan.continueAfterRead) {
          this.finishRun(runId, failedSteps)
          return
        }
      }
      this.failRun(runId, PLAN_NO_PROGRESS, '读后规划轮次达到上限,停止重新规划')
    } finally {
      signal?.removeEventListener('abort', forwardAbort)
    }
  }

  /** 真实发送观测落 model 轨迹:payload 精简(标识/序号/outcome/耗时/用量,缺失 null) */
  private traceModelAttempt(runId: string, event: ModelAttemptEvent): void {
    if (event.type === 'sent') {
      this.trace(runId, 'model', {
        event: 'sent',
        requestId: event.attempt.requestId,
        attemptId: event.attempt.attemptId,
        ordinal: event.attempt.ordinal,
        providerId: event.attempt.providerId,
        model: event.attempt.model
      })
      return
    }
    const attempt = event.attempt
    this.trace(
      runId,
      'model',
      {
        event: 'settled',
        attemptId: attempt.attemptId,
        ordinal: attempt.ordinal,
        outcome: attempt.outcome,
        latencyMs: attempt.latencyMs,
        usage: attempt.usage
      },
      attempt.latencyMs,
      attempt.usage ?? null
    )
  }

  /** 从观察轨迹恢复本运行已成功的读取结果(同参去重,重放折叠;澄清重入后重规划用) */
  private loadReadResultsFromTrace(runId: string): ReadResult[] {
    const byKey = new Map<string, ReadResult>()
    for (const event of listTraceEvents(this.deps.db, runId)) {
      if (event.eventType !== 'tool_call') continue
      const payload = event.payload as Partial<ToolObservationV1>
      if (payload.phase !== 'tool' || payload.outcome !== 'success') continue
      if (typeof payload.tool !== 'string' || typeof payload.callIndex !== 'number') continue
      const key = `${payload.tool}:${stableStringify(payload.arguments ?? {})}`
      byKey.set(key, {
        tool: payload.tool,
        callIndex: payload.callIndex,
        result: { ok: true, data: payload.result ?? null }
      })
    }
    return [...byKey.values()]
  }

  private countPlanEvents(runId: string): number {
    return listTraceEvents(this.deps.db, runId).filter((e) => e.eventType === 'plan').length
  }

  /** 执行读取阶段:顺序执行读工具;tool_call 轨迹由网关观察单一出口写入 */
  private async executeReadPhase(
    runId: string,
    readSteps: Array<{ tool: string; arguments: Record<string, unknown> }>,
    planVersion: number,
    signal?: AbortSignal
  ): Promise<{ failed: number; results: ReadResult[] }> {
    // 稳定调用索引:从既有轨迹的索引最大值分配下一个(澄清重入/重启不重号)
    let callIndex = maxAssignedCallIndex(this.deps.db, runId) + 1
    let failed = 0
    const results: ReadResult[] = []
    for (const step of readSteps) {
      // 取消竞态守卫:每步前重读状态,取消后不得继续执行
      const current = getRun(this.deps.db, runId)
      if (!current || current.status !== 'planning' || signal?.aborted) return { failed, results }

      let result: ReadResult['result']
      try {
        result = await this.deps.gateway.execute({
          runId,
          tool: step.tool,
          arguments: step.arguments,
          planVersion,
          callIndex
        })
      } catch (err) {
        if (err instanceof OperationError && (err.appError.code === 'OBSERVATION_FAILED' || err.appError.code === 'PERSIST_FAILED')) {
          try { this.failRun(runId, err.appError.code, err.message) }
          catch { console.error('[agent] 基础设施失败留痕未确认') }
          throw err
        }
        // 网关级拒绝(如参数校验)按失败读取继续,让重规划看到真实错误
        result = {
          ok: false,
          error: err instanceof OperationError ? err.appError : appError('VALIDATION', err instanceof Error ? err.message : String(err))
        }
      }
      results.push({ tool: step.tool, callIndex, result })
      callIndex += 1
      if (!result.ok) failed += 1
    }
    return { failed, results }
  }

  /**
   * 纯写计划:校验修改类 ID 的读取证据后生成提案;全部只生成提案,不执行写入。
   * OPS-04:所有审批行完整写入、状态转 awaiting_confirmation 后才广播确认卡事件
   * (事件快照是转移后的状态,禁止先广播 planning 状态的确认卡)。
   * 中途失败的路径:已写入的确认轨迹留在库中不即时广播,由 UI 按 seq 补发恢复,
   * 避免 finished 之后仍有事件广播。
   */
  private proposeWritePlan(
    runId: string,
    writeSteps: Array<{ tool: string; arguments: Record<string, unknown> }>,
    planVersion: number,
    readResults: ReadonlyArray<ReadResult>,
    signal?: AbortSignal
  ): void {
    const evidence = collectReadEvidence(readResults)
    let callIndex = maxAssignedCallIndex(this.deps.db, runId) + 1
    const deferred: TraceEvent[] = []
    for (const step of writeSteps) {
      const current = getRun(this.deps.db, runId)
      if (!current || current.status !== 'planning' || signal?.aborted) return

      const def = this.deps.registry.get(step.tool)
      if (hasTargetId(def) && !evidenceHasId(evidence, step.tool, step.arguments)) {
        this.failRun(
          runId,
          INPUT_INSUFFICIENT,
          `修改类工具 ${step.tool} 的目标 ID 未出现在本运行的读取结果中,拒绝生成提案;需先读取真实记录`
        )
        return
      }
      try {
        const proposal = this.deps.gateway.propose({
          runId,
          tool: step.tool,
          arguments: step.arguments,
          planVersion
        })
        // confirmation 轨迹保存稳定 callIndex/planVersion/operationId:
        // 审批重复或重开使用同索引(OPS-02 持久索引);先落库,转移后统一广播
        deferred.push(
          this.append(runId, 'confirmation', {
            tool: step.tool,
            approvalId: proposal.approvalId,
            expiresAt: proposal.expiresAt,
            requiresConfirmation: true,
            callIndex,
            planVersion: proposal.planVersion,
            operationId: `${runId}:${step.tool}:${callIndex}`
          })
        )
      } catch (err) {
        // 虚构 ID 等提案期拒绝:整个计划失败,已生成的提案保留待审(审计痕迹)
        this.failRun(runId, 'PROPOSAL_INVALID', err instanceof Error ? err.message : String(err))
        return
      }
      callIndex += 1
    }
    // 全部审批行写入后转移,再以转移后的快照广播确认卡事件
    transitionRun(this.deps.db, runId, 'awaiting_confirmation')
    this.emitDeferred(runId, deferred)
  }

  /** 收尾:全部成功 → succeeded;存在工具级失败 → partial(保留已完成影响) */
  private finishRun(runId: string, failedSteps: number): void {
    failedSteps = Math.max(failedSteps, summarizeRunToolResults(this.deps.db, runId).failed)
    transitionRun(this.deps.db, runId, failedSteps > 0 ? 'partial' : 'succeeded', {
      resultRef: JSON.stringify({ failedSteps })
    })
    this.trace(runId, 'output', { failedSteps })
    if (this.deps.scheduler) return // 调度器在驱动 finally 统一唤醒,避免两套调度竞争
    this.driveNextQueued()
  }

  private driveNextQueued(): void {
    const next = this.deps.queue.nextQueued()
    if (!next) return
    // R-06 收口:接力按 mode 分发——研究运行转交组合层钩子
    if (next.mode !== 'personal_ops') {
      this.deps.onNonOpsQueued?.(next.runId)
      return
    }
    void this.drivePlanning(next.runId).catch((err: unknown) => {
      console.error('[orchestrator] 后续运行驱动异常:', err instanceof Error ? err.message : String(err))
    })
  }

  /**
   * 读取最后一批未回答的澄清问题:最后一条携带非空 questions 的 input 轨迹
   * (答案事件同为 input 类型但无 questions,向后扫描时自然跳过)。
   */
  private loadPendingQuestions(runId: string): Array<{ questionId: string; question: string }> {
    const events = listTraceEvents(this.deps.db, runId)
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!
      if (event.eventType !== 'input') continue
      const questions = (event.payload as { questions?: unknown }).questions
      if (!Array.isArray(questions) || questions.length === 0) continue
      const items: Array<{ questionId: string; question: string }> = []
      for (const raw of questions) {
        if (!raw || typeof raw !== 'object') continue
        const questionId = (raw as { questionId?: unknown }).questionId
        const question = (raw as { question?: unknown }).question
        if (typeof questionId === 'string' && typeof question === 'string') {
          items.push({ questionId, question })
        }
      }
      if (items.length > 0) return items
    }
    return []
  }

  /**
   * 受理澄清回答(同步):按最后一批未回答 questions 校验全部必答、ID 集合、
   * trim 非空与每条 1000 码点上限(与 UI 一致);接受后写答案轨迹再转 queued,
   * 状态转移完成后才广播答案事件(事件快照是转移后的状态,OPS-04)。
   * 不等待模型——注入调度器时经 request() 接力(驱动从轨迹恢复回答);
   * 否则由调用方自行驱动。
   */
  acceptAnswers(runId: string, answers: AnswerItem[]): AgentRunRecord {
    const run = getRun(this.deps.db, runId)
    if (!run) throw new OperationError(appError('VALIDATION', `运行不存在:${runId}`, { retryable: false }))
    if (run.status !== 'awaiting_input') {
      throw new OperationError(appError('CONFLICT', '运行不在等待输入状态', { retryable: false }))
    }
    if (!Array.isArray(answers) || answers.length === 0) {
      throw new OperationError(appError('VALIDATION', '回答不能为空', { retryable: false }))
    }
    const pending = this.loadPendingQuestions(runId)
    if (pending.length === 0) {
      throw new OperationError(appError('VALIDATION', '运行没有待回答的澄清问题', { retryable: false }))
    }
    const required = new Set(pending.map((q) => q.questionId))
    const seen = new Set<string>()
    for (const item of answers) {
      const questionId = (item as { questionId?: unknown } | null)?.questionId
      if (!item || typeof questionId !== 'string' || !required.has(questionId)) {
        throw new OperationError(
          appError('VALIDATION', `未知的问题 ID:${String(questionId)}`, { retryable: false })
        )
      }
      if (seen.has(questionId)) {
        throw new OperationError(
          appError('VALIDATION', `重复的问题 ID:${questionId}`, { retryable: false })
        )
      }
      seen.add(questionId)
      if (typeof item.answer !== 'string' || item.answer.trim() === '') {
        throw new OperationError(
          appError('VALIDATION', `问题 ${questionId} 的回答不能为空白`, { retryable: false })
        )
      }
      if ([...item.answer].length > MAX_ANSWER_CODEPOINTS) {
        throw new OperationError(
          appError('VALIDATION', `问题 ${questionId} 的回答超过 ${MAX_ANSWER_CODEPOINTS} 码点上限`, { retryable: false })
        )
      }
    }
    for (const question of pending) {
      if (!seen.has(question.questionId)) {
        throw new OperationError(
          appError('VALIDATION', `缺少必答问题:${question.questionId}`, { retryable: false })
        )
      }
    }
    // 接受:答案轨迹先落库,转 queued 后再广播(快照为转移后的状态)
    const deferred = [this.append(runId, 'input', { answers })]
    const queued = transitionRun(this.deps.db, runId, 'queued')
    this.emitDeferred(runId, deferred)
    if (this.deps.scheduler) this.deps.scheduler.request()
    return queued
  }

  /** 提交澄清回答并等待重新规划完成(测试与 CLI 用;IPC 层用 acceptAnswers) */
  async submitAnswers(runId: string, answers: AnswerItem[]): Promise<void> {
    this.acceptAnswers(runId, answers)
    await this.drivePlanning(runId, answers)
  }

  /**
   * 审批决定。approved → 受理后执行该写步骤(参数从审批记录还原,重启安全);
   * rejected → 运行取消、其余待批提案过期(既有影响保留)。
   * 条件更新保证重复决定只生效一次;重复请求返回 already=true。
   * 注入调度器时:受理批准即排队(调度器派发),不承诺本请求已完成业务执行;
   * 已提交回执的重复批准只重试保存,不再次校验已被本次更新改变的目标 revision。
   */
  async decide(approvalId: string, decision: 'approved' | 'rejected'): Promise<{ already: boolean }> {
    const approval = getApproval(this.deps.db, approvalId)
    if (!approval) {
      throw new OperationError(appError('VALIDATION', `审批记录不存在:${approvalId}`, { retryable: false }))
    }
    const run = getRun(this.deps.db, approval.runId)
    if (!run) throw new OperationError(appError('VALIDATION', '运行不存在', { retryable: false }))

    if (this.deps.scheduler) {
      return await this.decideWithScheduler(approval, run, decision)
    }
    return await this.decideInline(approval, run, decision)
  }

  /** 调度器模式:决定与执行解耦;受理批准即排队 */
  private async decideWithScheduler(
    approval: Approval,
    run: AgentRunRecord,
    decision: 'approved' | 'rejected'
  ): Promise<{ already: boolean }> {
    if (decision === 'rejected') {
      if (!decideApproval(this.deps.db, approval.approvalId, 'rejected')) {
        const current = getApproval(this.deps.db, approval.approvalId)
        if (current && current.decision === 'rejected') return { already: true }
        throw new OperationError(
          appError('CONFLICT', `审批决定冲突:当前状态 ${current?.decision ?? '未知'}`, { retryable: false })
        )
      }
      // 用户拒绝:取消运行并过期其余待批提案(已执行的写入不受影响)
      if (run.status === 'awaiting_confirmation') {
        transitionRun(this.deps.db, run.runId, 'cancelled', { errorCode: PROPOSAL_REJECTED })
        this.deps.db.run(
          "UPDATE approvals SET decision = 'expired' WHERE run_id = ? AND decision = 'pending'",
          [run.runId]
        )
        this.trace(run.runId, 'output', { rejected: approval.approvalId })
      }
      this.deps.scheduler?.request()
      return { already: false }
    }

    // approved:重复决定短路(同一决定重放视为幂等;非法批准不得先改 decision)
    if (approval.decision !== 'pending') {
      if (approval.decision === 'approved') {
        // 已批准:已执行的只重试保存;未执行的保持排队(调度器会派发)
        await this.retrySaveExecutedApproval(approval)
        return { already: true }
      }
      throw new OperationError(
        appError('CONFLICT', `审批决定冲突:当前状态 ${approval.decision}`, { retryable: false })
      )
    }
    // 首次批准:决定落库前校验 run 状态与 TTL;冻结参数由执行路径再次校验。
    // awaiting_confirmation(等待确认)与 executing(同运行的兄弟审批在途)均可受理:
    // 在途执行完成回到等待确认后,调度器接力派发本次批准
    if (run.status !== 'awaiting_confirmation' && run.status !== 'executing') {
      throw new OperationError(appError('CONFLICT', '运行不在等待确认状态,无法执行提案', { retryable: false }))
    }
    if (this.clock.now().getTime() >= new Date(approval.expiresAt).getTime()) {
      throw new OperationError(appError('CONFLICT', '提案已过有效期,需重新生成', { retryable: false }))
    }
    if (!decideApproval(this.deps.db, approval.approvalId, 'approved')) {
      const current = getApproval(this.deps.db, approval.approvalId)
      if (current && current.decision === 'approved') {
        await this.retrySaveExecutedApproval(approval)
        return { already: true }
      }
      throw new OperationError(
        appError('CONFLICT', `审批决定冲突:当前状态 ${current?.decision ?? '未知'}`, { retryable: false })
      )
    }
    // 受理批准即排队;执行由调度器派发(approved 意图),完成时机不承诺
    this.deps.scheduler?.request()
    return { already: false }
  }

  /** 已提交回执的重复批准:返回 already 前确认关键保存状态(只重试保存,不再次执行) */
  private async retrySaveExecutedApproval(approval: Approval): Promise<void> {
    const callIndex = readApprovalCallIndex(this.deps.db, approval.runId, approval.approvalId)
    if (callIndex === null) return // 无索引映射:从未领取执行,保持排队由调度器处理
    const operationId = `${approval.runId}:${approval.toolName}:${callIndex}`
    const receipt = getOperationReceipt(this.deps.db, operationId)
    if (!receipt) return // 已批准尚未执行:调度器会派发
    try {
      const decoded = JSON.parse(receipt.resultRef) as { kind: string; value: unknown }
      await this.saveCoordinator().commitCritical(operationId, decoded.value)
    } catch (err) {
      // 保存仍未确认:按原错误码向上传播(携带 operationId,可重试)
      if (err instanceof OperationError) throw err
      throw err
    }
  }

  /** 未注入调度器时的既有内联执行路径(行为保持;索引改用持久映射) */
  private async decideInline(
    approval: Approval,
    run: AgentRunRecord,
    decision: 'approved' | 'rejected'
  ): Promise<{ already: boolean }> {
    if (!decideApproval(this.deps.db, approval.approvalId, decision)) {
      // 决定未生效:同一决定的重放视为幂等成功;不同决定或已过期即冲突
      const current = getApproval(this.deps.db, approval.approvalId)
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
        this.trace(run.runId, 'output', { rejected: approval.approvalId })
      }
      return { already: false }
    }

    // 批准:执行该写步骤。运行必须仍在等待确认(已取消/已终态的批准拒绝执行)
    if (run.status !== 'awaiting_confirmation') {
      throw new OperationError(appError('CONFLICT', '运行不在等待确认状态,无法执行提案', { retryable: false }))
    }
    transitionRun(this.deps.db, run.runId, 'executing')

    const args = parseFrozenArguments(approval)
    // 稳定 callIndex:从 confirmation/tool_call 轨迹映射读取;旧轨迹在事务内补映射
    const callIndex = this.resolveApprovalCallIndex(run.runId, approval)
    let failed = 0
    try {
      const result = await this.deps.gateway.execute({
        runId: run.runId,
        tool: approval.toolName,
        arguments: args,
        planVersion: approval.planVersion,
        callIndex,
        approvalId: approval.approvalId
      })
      if (!result.ok) failed += 1
      // tool_call 轨迹由网关观察单一出口写入(OPS-03),编排器不再重复记录
    } catch (err) {
      // 网关级拒绝(如目标版本变化,OPS-06)→ 运行失败
      failed += 1
      const message = err instanceof Error ? err.message : String(err)
      this.failRun(run.runId, err instanceof OperationError ? err.appError.code : 'CONFLICT', message)
      return { already: false }
    }

    // 其余待批/已批准未执行提案:仍在等待 → 回到 awaiting_confirmation;全部已决 → 收尾
    expireStaleApprovals(this.deps.db, this.clock.now().toISOString())
    const remaining = this.pendingCount(run.runId)
    const remainingApproved = listApprovals(this.deps.db, run.runId).filter(
      (a) => a.decision === 'approved' && !isApprovalExecuted(this.deps.db, run.runId, a)
    ).length
    if (remaining > 0 || remainingApproved > 0) {
      // 还有别的写提案在等:回到等待确认
      transitionRun(this.deps.db, run.runId, 'awaiting_confirmation')
      return { already: false }
    }
    this.finishRun(run.runId, failed)
    return { already: false }
  }

  /** 审批的稳定调用索引:从轨迹映射读取;旧轨迹无索引时在事务内分配并写映射事件 */
  private resolveApprovalCallIndex(runId: string, approval: Approval): number {
    const mapped = readApprovalCallIndex(this.deps.db, runId, approval.approvalId)
    if (mapped !== null) return mapped
    let assigned = 0
    this.deps.db.transaction(() => {
      assigned = maxAssignedCallIndex(this.deps.db, runId) + 1
      appendCallIndexMapping(this.deps.db, {
        runId,
        approvalId: approval.approvalId,
        toolName: approval.toolName,
        callIndex: assigned,
        planVersion: approval.planVersion,
        operationId: `${runId}:${approval.toolName}:${assigned}`
      })
    })
    return assigned
  }

  /**
   * OPS-02:调度器 approved 意图的驱动入口——执行一个已批准的提案。
   * 领取(tryResume:仅 awaiting_confirmation 且无其他 active)后经网关执行;
   * 每轮只处理一个审批,其余已批准项回到等待确认由调度器接力;
   * 已提交回执的派发只重试保存,不再次执行。
   */
  async executeApproved(runId: string, approvalId: string, signal?: AbortSignal): Promise<void> {
    const run = getRun(this.deps.db, runId)
    const approval = getApproval(this.deps.db, approvalId)
    if (!run || !approval) return
    if (run.status !== 'awaiting_confirmation') return // 已取消/已终态:禁止继续执行
    if (signal?.aborted) return

    // 稳定索引:映射缺失时分配并写映射事件(之后从映射读取)
    const callIndex = this.resolveApprovalCallIndex(runId, approval)
    const operationId = `${runId}:${approval.toolName}:${callIndex}`
    const receipt = getOperationReceipt(this.deps.db, operationId)
    if (receipt && receipt.requestHash === approval.argumentsHash) {
      // 已提交回执:只重试保存,不再次执行、不重写回执
      await this.retrySaveExecutedApproval(approval)
      return
    }

    // 领取执行权:无其他 active 才同步转 executing;被占则保持排队(调度器稍后重派)
    if (!this.deps.queue.tryResume(runId)) return

    // 领取后重读:取消或决定变化时让出执行权,不继续执行
    const current = getRun(this.deps.db, runId)
    const currentApproval = getApproval(this.deps.db, approvalId)
    if (!current || current.status !== 'executing' || signal?.aborted) return
    if (!currentApproval || currentApproval.decision !== 'approved') {
      transitionRun(this.deps.db, runId, 'awaiting_confirmation')
      return
    }

    let args: Record<string, unknown>
    try {
      args = parseFrozenArguments(currentApproval)
    } catch (err) {
      // 冻结参数无法解码:以 CONFLICT 失败并过期未执行提案
      const message = err instanceof Error ? err.message : String(err)
      this.failRun(runId, 'CONFLICT', message)
      expireUnexecutedApprovals(this.deps.db, runId)
      return
    }

    let failed = 0
    try {
      const result = await this.deps.gateway.execute({
        runId,
        tool: currentApproval.toolName,
        arguments: args,
        planVersion: currentApproval.planVersion,
        callIndex,
        approvalId
      })
      if (!result.ok) failed += 1
      // tool_call 轨迹由网关观察单一出口写入(OPS-03),编排器不再重复记录
    } catch (err) {
      // 网关级拒绝(目标变更/过期/保存失败):运行按实际错误码失败,保留已提交影响
      const code = err instanceof OperationError ? err.appError.code : 'CONFLICT'
      const message = err instanceof Error ? err.message : String(err)
      this.failRun(runId, code, message)
      expireUnexecutedApprovals(this.deps.db, runId)
      return
    }

    // 多提案:已批准未执行或仍有人工待批 → 回到等待确认,由调度器接力下一项
    expireStaleApprovals(this.deps.db, this.clock.now().toISOString())
    const remainingPending = this.pendingCount(runId)
    const remainingApproved = listApprovals(this.deps.db, runId).filter(
      (a) => a.decision === 'approved' && !isApprovalExecuted(this.deps.db, runId, a)
    ).length
    if (remainingPending > 0 || remainingApproved > 0) {
      transitionRun(this.deps.db, runId, 'awaiting_confirmation')
      return
    }
    // pendingCount=0 不足以收尾:上面已检查"已批准尚未执行"项后才收尾
    this.finishRun(runId, failed)
  }

  private pendingCount(runId: string): number {
    return (
      this.deps.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM approvals WHERE run_id = ? AND decision = 'pending'",
        [runId]
      )?.n ?? 0
    )
  }

  /** 请求取消:非终态可取消;既有写入保留,待批提案过期;调度器模式下发取消信号并唤醒后续 */
  cancel(runId: string): AgentRunRecord {
    const run = getRun(this.deps.db, runId)
    if (!run) throw new OperationError(appError('VALIDATION', `运行不存在:${runId}`, { retryable: false }))
    const updated = transitionRun(this.deps.db, runId, 'cancelled', { errorCode: 'CANCELLED' })
    expireStaleApprovals(this.deps.db, this.clock.now().toISOString())
    this.deps.db.run(
      "UPDATE approvals SET decision = 'expired' WHERE run_id = ? AND decision = 'pending'",
      [runId]
    )
    this.trace(runId, 'output', { cancelled: true })
    if (this.deps.scheduler) {
      // 取消顺序:先标 cancelled、过期待批审批,再 abort;旧驱动 await 后重读状态,
      // 不得继续提案或覆写终态;占用保留到旧驱动 settle,由 finally 唤醒下一个
      this.deps.scheduler.abort(runId)
      this.deps.scheduler.request()
    }
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
