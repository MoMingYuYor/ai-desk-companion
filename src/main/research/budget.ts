// 研究预算账本(R-04 预算子模块;规格第 8 节 + 执行清单步骤 16)。
//
// 职责:模型调用配额的原子预扣、活动时间窗、审核预留与收尾语义。纯逻辑模块,
// 不直接访问数据库——账本状态经 serializeLedger/deserializeLedger 交给调用方落库,
// 持久化接线由 workflow.ts(R-04 下一波)完成。预算数值与下调语义复用 R-01 的
// resolveResearchBudget(schemas.ts 为权威),本模块不重写。
//
// 账本不变量(核心约束:重试不能逃过预算):
// 1. 每次实际发送模型请求前必须原子 reserve;结构化输出无效、429、超时后的重试
//    也占预算(重试 = 对同槽位再次 reserve 且 isRetry: true),每槽位最多一次受控重试;
// 2. 全部槽位用量(基础 + 重试)恒 ≤ max_model_calls;槽位容量恒可满足;
//    预留冲突与超卖抛 BudgetExhaustedError / OperationError(CONFLICT),不静默;
// 3. 阶段顺序由状态机强制:规划槽位用尽才允许定稿;审核槽位必须在开始抽取前预留
//    (调度器在开始抽取前预留一次语义审核和确定性收尾窗口);组织槽位在审核后预留;
// 4. 抽取槽位容量 = 规划定稿的子问题数(受 max_subqueries 收缩),校验在 sealPlan 一次完成。
//
// 活动时间语义:按「领取后的累计活动时间」计算,用注入 Clock 的 monotonicMs() 累计;
// 排队与等待用户(awaiting_input 窗口)不计入——activity.pause()/resume() 关闭/重开在途段。
// 时限到达置位 deadlineReached,终止继续检索与模型请求;之后允许最多 2 秒本地持久化
// 收尾(finalize segment),收尾段单独计时、单独可查,不计入 active_seconds 判定。
//
// 错误形态:配额/时限耗尽抛 BudgetExhaustedError(workflow 据此走收尾路径);
// 顺序与形状违规抛 OperationError(appError 的 VALIDATION/CONFLICT 信封)。
// ResearchErrorCode(BUDGET_EXHAUSTED 等)只作语义词表写入 message,不另造错误码体系。

import { appError } from '../../shared/operations'
import { OperationError } from '../db/operations'
import type { Clock } from '../../shared/clock'
import { codePointLength, resolveResearchBudget, type ResearchBudget } from './schemas'

// ---------- 领域错误 ----------

function budgetError(code: 'VALIDATION' | 'CONFLICT', message: string): OperationError {
  return new OperationError(appError(code, message, { retryable: false }))
}

/** 配额耗尽的细分原因;全部映射到研究错误码 BUDGET_EXHAUSTED 的语义 */
export type BudgetExhaustionKind = 'MODEL_CALLS' | 'SLOT_CAPACITY' | 'DEADLINE'

/**
 * 配额/时限耗尽:workflow 捕获后走 finalizeOutcome 收尾,属于正常控制流信号。
 * 顺序违规(如未定稿就抽取)不用本类,应视为编程错误直接暴露。
 */
export class BudgetExhaustedError extends OperationError {
  readonly exhaustion: BudgetExhaustionKind

  constructor(message: string, exhaustion: BudgetExhaustionKind) {
    super(appError('CONFLICT', message, { retryable: false }))
    this.name = 'BudgetExhaustedError'
    this.exhaustion = exhaustion
  }
}

/** 是否为配额/时限耗尽类错误(供 workflow 判定收尾路径) */
export function isBudgetExhaustedError(err: unknown): err is BudgetExhaustedError {
  return err instanceof BudgetExhaustedError
}

// ---------- 槽位与阶段模型 ----------

/** 模型调用槽位;容量与顺序由规格第 8 节预算表冻结:规划 1 + 抽取 ≤3 + 审核 1 + 组织 1 */
export type SlotKind = 'planning' | 'extraction' | 'review' | 'synthesis'

export const SLOT_KINDS: readonly SlotKind[] = ['planning', 'extraction', 'review', 'synthesis']

/** 固定容量槽位;extraction 的容量 = 规划定稿的子问题数,不在本表 */
const BASE_SLOT_CAPACITY: Readonly<Record<Exclude<SlotKind, 'extraction'>, number>> = Object.freeze({
  planning: 1,
  review: 1,
  synthesis: 1
})

export interface SlotState {
  /** 已消耗的基础调用次数(每次非重试 reserve 成功 +1) */
  used: number
  /** 本槽位已执行的受控重试次数(0 或 1);计入总调用额但不占槽位容量 */
  retries: number
}

/**
 * 账本阶段(单向状态机,防顺序绕过):
 * planning →(规划槽位消耗 + sealPlan)→ plan_sealed →(审核预留)→ review_reserved
 * →(抽取在 review_reserved 内进行,审核调用完成后)→ synthesis。
 * 「审核预留先于抽取」由抽取 reserve 强制要求 review_reserved 阶段实现。
 */
export type LedgerPhase = 'planning' | 'plan_sealed' | 'review_reserved' | 'synthesis'

export const LEDGER_PHASES: readonly LedgerPhase[] = ['planning', 'plan_sealed', 'review_reserved', 'synthesis']

// ---------- 收尾判定(纯函数) ----------

/** 收尾原因词表;DEADLINE_REACHED 映射到 error_code 时归并为 BUDGET_EXHAUSTED(词表对齐 R-01) */
export type FinalizeReason = 'BUDGET_EXHAUSTED' | 'DEADLINE_REACHED'

/** finalizeOutcome 的输入:workflow 从领域状态挑出的可展示产物清单 */
export interface FinalizeInput {
  /** 已有经检查结论的子问题 ID(answered 且通过审核/引用检查) */
  answeredSubquestionIds: readonly string[]
  /** 已判定不足(insufficient/conflicted)的子问题 ID */
  insufficientSubquestionIds: readonly string[]
  /** 预算耗尽时未完成、被跳过的子问题 ID(pending/running) */
  skippedSubquestionIds: readonly string[]
  /** 活动时限是否为耗尽的触发原因 */
  exhaustedByDeadline: boolean
}

export interface FinalizeOutcome {
  status: 'partial' | 'failed'
  skippedSubquestions: string[]
  reason: FinalizeReason
}

/**
 * 收尾语义(纯函数):预算耗尽且已有经检查结论或已判定不足项 → partial +
 * skipped 子问题清单与 BUDGET_EXHAUSTED;完全没有可展示研究产物 → failed。
 * 用户取消始终 cancelled——由 workflow 负责,budget 不产生 cancelled 判定。
 */
export function finalizeOutcome(input: FinalizeInput): FinalizeOutcome {
  const skipped = [...input.skippedSubquestionIds]
  const hasShowable = input.answeredSubquestionIds.length > 0 || input.insufficientSubquestionIds.length > 0
  const reason: FinalizeReason = input.exhaustedByDeadline ? 'DEADLINE_REACHED' : 'BUDGET_EXHAUSTED'
  if (hasShowable) {
    return { status: 'partial', skippedSubquestions: skipped, reason }
  }
  return { status: 'failed', skippedSubquestions: skipped, reason }
}

// ---------- 审核打包(纯函数) ----------

/** 审核打包的片段形态:完整片段原文,禁止截断 */
export interface ReviewSpanInput {
  spanId: string
  text: string
}

/** 审核打包的候选形态:完整 Claim 及其全部支持片段的引用 */
export interface ReviewClaimCandidate {
  claimId: string
  /** 完整 Claim 原文 */
  text: string
  /** 全部支持片段 ID;打包时按完整片段计入,禁止拆分 */
  supportSpanIds: readonly string[]
  /** 数值越小优先级越高;超上下文预算时低优先级候选整体移除 */
  priority: number
}

export interface ReviewPackage {
  /** 进入本次审核请求的候选(按优先级稳定排序,含完整证据) */
  included: ReviewClaimCandidate[]
  /** 因超上下文预算被整体移除的候选 ID(uncovered 清单) */
  uncovered: string[]
}

/**
 * 审核打包:按完整 Claim 及其全部支持片段打包;超上下文预算时整体移除低优先级候选
 * 并返回 uncovered 清单。输出结构里没有「部分打包」形态——候选要么整体 included,
 * 要么整体 uncovered,禁止截断候选证据或拆成额外调用。
 * 成本按 Unicode 码点计(与 schemas 的长度口径一致);同优先级按 claimId 稳定排序。
 * 放不下低优先级候选后继续扫描更小的候选(尽量提高覆盖率)。
 */
export function packageReviewClaims(
  claims: readonly ReviewClaimCandidate[],
  spans: readonly ReviewSpanInput[],
  contextBudget: number
): ReviewPackage {
  if (!Number.isInteger(contextBudget) || contextBudget <= 0) {
    throw budgetError('VALIDATION', `contextBudget 必须是正整数,收到 ${String(contextBudget)}`)
  }
  const spanTexts = new Map<string, string>()
  for (const span of spans) {
    if (spanTexts.has(span.spanId)) throw budgetError('VALIDATION', `片段 ID 重复:${span.spanId}`)
    spanTexts.set(span.spanId, span.text)
  }
  const costOf = (candidate: ReviewClaimCandidate): number => {
    let cost = codePointLength(candidate.text)
    for (const spanId of candidate.supportSpanIds) {
      const text = spanTexts.get(spanId)
      if (text === undefined) {
        throw budgetError('VALIDATION', `候选 ${candidate.claimId} 引用了未知片段:${spanId}`)
      }
      cost += codePointLength(text)
    }
    return cost
  }
  const ordered = [...claims].sort((a, b) => a.priority - b.priority || (a.claimId < b.claimId ? -1 : 1))
  const included: ReviewClaimCandidate[] = []
  const uncovered: string[] = []
  let used = 0
  for (const candidate of ordered) {
    const cost = costOf(candidate)
    if (used + cost <= contextBudget) {
      included.push(candidate)
      used += cost
    } else {
      uncovered.push(candidate.claimId)
    }
  }
  return { included, uncovered }
}

// ---------- 账本序列化形态 ----------

/** 活动计时持久化形态:只有累计值与状态,不含 monotonic 基准(跨进程无意义) */
export interface SerializedActivity {
  /** 已落账的累计活动毫秒(含序列化时在途段折算) */
  accumulatedMs: number
  /** 在途段起点;本模块序列化时恒为 null(折算落账),仅容忍恢复历史形态 */
  segmentStartedAtMs: number | null
  /** 是否处于收尾段 */
  finalizing: boolean
  /** 收尾段已计毫秒(单独记录,不计入 active_seconds 判定) */
  finalizeMs: number
}

/** 账本持久化形态:全量状态;反序列化后预算不复活 */
export interface SerializedLedger {
  version: 1
  budget: ResearchBudget
  phase: LedgerPhase
  slots: Record<SlotKind, SlotState>
  activity: SerializedActivity
  deadlineReached: boolean
  /** 规划定稿时锁定的子问题数(= 抽取槽位容量) */
  sealedSubquestions: number
}

/** 本地持久化收尾段上限(规格:最多 2 秒;目标值,超限由 finalizeSegmentExceeded 上报) */
export const FINALIZE_SEGMENT_LIMIT_MS = 2000

// ---------- 活动时间控制器 ----------

export interface ActivityController {
  /** worker 领取任务后开始计时(领取后的累计活动时间) */
  start(): void
  /** 进入 awaiting_input(等待用户)前暂停;等待时间不计入 active_seconds */
  pause(): void
  /** 恢复执行时重开在途段;时限已到达或已进入收尾段时拒绝 */
  resume(): void
}

// ---------- 账本主体 ----------

/**
 * 研究预算账本。构造即完成预算校验;所有写操作同步完成、校验全部通过才落账
 * (单线程主进程内即原子预扣:不通过则状态零变更)。
 */
export class ResearchBudgetLedger {
  private readonly budget: ResearchBudget
  private phase: LedgerPhase
  private readonly slots: Record<SlotKind, SlotState>
  private readonly time: {
    accumulatedMs: number
    segmentStartedAtMs: number | null
    finalizing: boolean
    finalizeMs: number
  }
  private finalizeSegmentStartedMs: number | null
  private deadlineReachedFlag: boolean
  private sealedSubquestions: number
  private readonly clock: Clock

  /** 活动时间窗控制:pause/resume 排除排队与等待用户的时间 */
  readonly activity: ActivityController

  constructor(options: { budget?: unknown; clock: Clock; serialized?: unknown }) {
    this.clock = options.clock
    this.time = { accumulatedMs: 0, segmentStartedAtMs: null, finalizing: false, finalizeMs: 0 }
    this.finalizeSegmentStartedMs = null
    this.deadlineReachedFlag = false
    this.sealedSubquestions = 0
    this.activity = {
      start: () => {
        if (this.time.segmentStartedAtMs !== null) throw budgetError('CONFLICT', '活动计时已开始')
        if (this.time.finalizing) throw budgetError('CONFLICT', '收尾段已开始,活动计时不可再开始')
        this.time.segmentStartedAtMs = this.clock.monotonicMs()
      },
      pause: () => {
        if (this.time.segmentStartedAtMs === null) throw budgetError('CONFLICT', '活动计时未在运行')
        this.foldActiveSegment()
        this.maybeDeadline()
      },
      resume: () => {
        if (this.time.segmentStartedAtMs !== null) throw budgetError('CONFLICT', '活动计时未暂停')
        if (this.time.finalizing || this.deadlineReachedFlag) {
          throw budgetError('CONFLICT', '收尾段已开始或时限已到达,活动计时不可恢复')
        }
        this.time.segmentStartedAtMs = this.clock.monotonicMs()
      }
    }

    if (options.serialized !== undefined) {
      const restored = deserializeLedger(options.serialized)
      this.budget = restored.budget
      this.phase = restored.phase
      this.slots = {
        planning: { ...restored.slots.planning },
        extraction: { ...restored.slots.extraction },
        review: { ...restored.slots.review },
        synthesis: { ...restored.slots.synthesis }
      }
      this.time.accumulatedMs = restored.activity.accumulatedMs
      this.time.segmentStartedAtMs = restored.activity.segmentStartedAtMs
      this.time.finalizing = restored.activity.finalizing
      this.time.finalizeMs = restored.activity.finalizeMs
      this.deadlineReachedFlag = restored.deadlineReached
      this.sealedSubquestions = restored.sealedSubquestions
      return
    }

    // 新账本:预算经 resolveResearchBudget 归一(未知字段/上调/低于下限在此拒绝)
    this.budget = resolveResearchBudget(options.budget ?? {})
    this.phase = 'planning'
    this.slots = {
      planning: { used: 0, retries: 0 },
      extraction: { used: 0, retries: 0 },
      review: { used: 0, retries: 0 },
      synthesis: { used: 0, retries: 0 }
    }
  }

  // ---------- 只读视图 ----------

  get budgetSnapshot(): ResearchBudget {
    return { ...this.budget }
  }

  get currentPhase(): LedgerPhase {
    return this.phase
  }

  get isDeadlineReached(): boolean {
    return this.deadlineReachedFlag
  }

  /** 抽取槽位容量 = 规划定稿的子问题数(未定稿为 0) */
  get extractionCapacity(): number {
    return this.sealedSubquestions
  }

  /** 剩余模型调用次数(全部槽位基础 + 重试的总口径) */
  get remainingModelCalls(): number {
    return this.budget.max_model_calls - this.totalUsedCalls()
  }

  /** 单调累计活动毫秒(在途段实时折算;不含收尾段) */
  get activeMs(): number {
    let ms = this.time.accumulatedMs
    if (this.time.segmentStartedAtMs !== null) {
      ms += Math.max(0, this.clock.monotonicMs() - this.time.segmentStartedAtMs)
    }
    return ms
  }

  /** 剩余活动毫秒;上限只可下调,下限 10 秒由 resolveResearchBudget 保证 */
  get remainingActiveMs(): number {
    return Math.max(0, this.budget.max_active_seconds * 1000 - this.activeMs)
  }

  /** 收尾段已计毫秒(单独可查) */
  get finalizeMs(): number {
    return this.time.finalizeMs
  }

  /** 模型调用时限:取 min(请求时限, 剩余活动预算);时限已到达返回 0 */
  modelCallTimeoutMs(requestLimitMs: number): number {
    if (!Number.isFinite(requestLimitMs) || requestLimitMs <= 0) {
      throw budgetError('VALIDATION', `requestLimitMs 必须是正数,收到 ${String(requestLimitMs)}`)
    }
    if (this.deadlineReachedFlag) return 0
    return Math.min(requestLimitMs, this.remainingActiveMs)
  }

  // ---------- 私有工具 ----------

  private totalUsedCalls(): number {
    return SLOT_KINDS.reduce((sum, kind) => sum + this.slots[kind].used + this.slots[kind].retries, 0)
  }

  private slotCapacity(kind: SlotKind): number {
    if (kind === 'extraction') return this.sealedSubquestions
    return BASE_SLOT_CAPACITY[kind]
  }

  /** 在途活动段折算落账并关闭;单调基准不跨段保留 */
  private foldActiveSegment(): void {
    if (this.time.segmentStartedAtMs !== null) {
      this.time.accumulatedMs += Math.max(0, this.clock.monotonicMs() - this.time.segmentStartedAtMs)
      this.time.segmentStartedAtMs = null
    }
  }

  /** 剩余活动预算归零即置位;pause/serialize/显式置位时检查,不依赖轮询 */
  private maybeDeadline(): void {
    if (!this.deadlineReachedFlag && this.remainingActiveMs <= 0) {
      this.deadlineReachedFlag = true
    }
  }

  // ---------- 规划定稿 ----------

  /**
   * 规划定稿:锁定子问题数(= 抽取槽位容量)并推进阶段。
   * max_subqueries 下调时抽取槽位随之收缩——预留校验在此一次完成:
   * 子问题数超过收缩后的 max_subqueries 抛 VALIDATION,不静默。
   */
  sealPlan(subquestionCount: number): void {
    if (this.phase !== 'planning') {
      throw budgetError('CONFLICT', `规划只能定稿一次,当前阶段 ${this.phase}`)
    }
    if (this.slots.planning.used < 1) {
      throw budgetError('CONFLICT', '规划槽位尚未消耗,不能定稿')
    }
    if (!Number.isInteger(subquestionCount) || subquestionCount < 1) {
      throw budgetError('VALIDATION', `子问题数必须是不小于 1 的整数,收到 ${String(subquestionCount)}`)
    }
    if (subquestionCount > this.budget.max_subqueries) {
      throw budgetError('VALIDATION', `子问题数 ${subquestionCount} 超过 max_subqueries ${this.budget.max_subqueries}`)
    }
    this.sealedSubquestions = subquestionCount
    this.phase = 'plan_sealed'
  }

  // ---------- 调用预留(原子预扣) ----------

  /**
   * 每次实际发送模型请求前原子预扣一个槽位调用。
   * 重试 = 对同槽位再次 reserve 且 isRetry: true:计入总调用额、不占槽位容量,
   * 每槽位最多一次受控重试,且只有剩余预算允许才执行——重试不能逃过预算。
   */
  reserve(kind: SlotKind, opts: { isRetry?: boolean } = {}): void {
    if (this.deadlineReachedFlag) {
      throw new BudgetExhaustedError(`活动时限已到达,拒绝 ${kind} 模型调用(BUDGET_EXHAUSTED)`, 'DEADLINE')
    }
    const slot = this.slots[kind]
    const retrying = opts.isRetry === true

    if (retrying) {
      if (slot.used < 1) {
        throw budgetError('CONFLICT', `${kind} 槽位尚无基础调用,重试无从谈起`)
      }
      if (slot.retries >= 1) {
        throw budgetError('CONFLICT', `${kind} 槽位已执行过一次受控重试,不允许再次重试`)
      }
    }

    this.assertPhaseAllows(kind, retrying)

    if (!retrying) {
      const capacity = this.slotCapacity(kind)
      if (slot.used + 1 > capacity) {
        throw new BudgetExhaustedError(
          `${kind} 槽位配额已用尽(容量 ${capacity},已用 ${slot.used})(BUDGET_EXHAUSTED)`,
          'SLOT_CAPACITY'
        )
      }
    }

    // 总额约束:基础 + 重试恒 ≤ max_model_calls;剩余不足时受控重试同样被拒绝
    if (this.totalUsedCalls() + 1 > this.budget.max_model_calls) {
      throw new BudgetExhaustedError(
        `模型调用总额已用尽(${this.budget.max_model_calls})(BUDGET_EXHAUSTED)`,
        'MODEL_CALLS'
      )
    }

    // 校验全部通过后才落账——原子预扣:不通过则状态零变更
    if (retrying) {
      slot.retries += 1
    } else {
      slot.used += 1
      // 审核预留成功即推进阶段:此后(抽取阶段)review_reserved 窗口内才允许抽取
      if (kind === 'review') {
        this.phase = 'review_reserved'
      }
    }
  }

  private assertPhaseAllows(kind: SlotKind, retrying: boolean): void {
    switch (kind) {
      case 'planning':
        if (this.phase !== 'planning') {
          throw budgetError('CONFLICT', `规划槽位仅限 planning 阶段,当前阶段 ${this.phase}`)
        }
        if (this.slots.planning.used >= 1) {
          throw budgetError('CONFLICT', '规划槽位已用尽,不允许再次规划')
        }
        return
      case 'extraction':
        // 规划槽位用尽(经 sealPlan)且审核预留已完成,才允许抽取
        if (this.phase !== 'review_reserved') {
          throw budgetError(
            'CONFLICT',
            `抽取必须在审核预留后进行(审核预留先于抽取),当前阶段 ${this.phase}`
          )
        }
        return
      case 'review':
        if (!retrying && this.slots.review.used >= 1) {
          throw budgetError('CONFLICT', '审核槽位已预留,不允许重复预留')
        }
        if (retrying) {
          // 审核调用发生在抽取之后的 review_reserved 窗口内
          if (this.phase !== 'review_reserved') {
            throw budgetError('CONFLICT', `审核重试仅限 review_reserved 阶段,当前阶段 ${this.phase}`)
          }
          return
        }
        // 审核预留必须在开始抽取前完成(此时抽取用量必为 0)
        if (this.phase !== 'plan_sealed') {
          throw budgetError('CONFLICT', `审核预留必须在规划定稿后、开始抽取前完成,当前阶段 ${this.phase}`)
        }
        return
      case 'synthesis':
        // 组织槽位在审核后预留
        if (this.phase !== 'synthesis') {
          throw budgetError('CONFLICT', `组织槽位必须在审核完成后预留,当前阶段 ${this.phase}`)
        }
        return
    }
  }

  // ---------- 阶段推进 ----------

  /** 审核调用完成(结果落定),解锁组织槽位;组织槽位在审核后预留 */
  markSynthesisReady(): void {
    if (this.phase !== 'review_reserved') {
      throw budgetError('CONFLICT', `审核尚未完成,不能进入组织阶段,当前阶段 ${this.phase}`)
    }
    if (this.slots.review.used < 1) {
      throw budgetError('CONFLICT', '审核槽位尚未预留,不能进入组织阶段')
    }
    this.phase = 'synthesis'
  }

  // ---------- 活动时限 ----------

  /** 检查活动预算并在耗尽时置位;workflow 可在每步后主动调用 */
  checkDeadline(): boolean {
    this.maybeDeadline()
    return this.deadlineReachedFlag
  }

  /** 显式置位时限(如单次调用超时后由 workflow 调用);置位后终止继续检索与模型请求 */
  markDeadlineReached(): void {
    this.foldActiveSegment()
    this.deadlineReachedFlag = true
  }

  // ---------- 收尾段(最多 2 秒本地持久化,独立计时) ----------

  /**
   * 开始本地持久化收尾段:隐含暂停活动计时,收尾段单独计时、单独可查,
   * 不计入 active_seconds 判定,只计入日志/轨迹字段。全程最多允许一次。
   */
  beginFinalizeSegment(): void {
    if (this.time.finalizing) throw budgetError('CONFLICT', '收尾段已开始')
    this.foldActiveSegment()
    this.time.finalizing = true
    this.finalizeSegmentStartedMs = this.clock.monotonicMs()
    this.time.finalizeMs = 0
  }

  /** 刷新收尾段已计毫秒并返回;workflow 在每次持久化动作后调用 */
  tickFinalizeSegment(): number {
    if (!this.time.finalizing || this.finalizeSegmentStartedMs === null) {
      throw budgetError('CONFLICT', '收尾段未开始')
    }
    this.time.finalizeMs = Math.max(0, this.clock.monotonicMs() - this.finalizeSegmentStartedMs)
    return this.time.finalizeMs
  }

  /** 收尾段是否已超过 2 秒目标;workflow 据此放弃后续持久化动作 */
  finalizeSegmentExceeded(): boolean {
    if (!this.time.finalizing) return false
    return this.tickFinalizeSegment() > FINALIZE_SEGMENT_LIMIT_MS
  }

  /** 结束收尾段,落定 finalizeMs(单独记录,供日志/轨迹字段读取) */
  endFinalizeSegment(): void {
    if (!this.time.finalizing) throw budgetError('CONFLICT', '收尾段未开始')
    this.tickFinalizeSegment()
    this.time.finalizing = false
    this.finalizeSegmentStartedMs = null
  }

  // ---------- 序列化 ----------

  /**
   * 全量序列化(供 workflow 落库与重启恢复)。
   * 在途活动段折算落账并关闭(等价于暂停)——monotonic 基准跨进程无意义;
   * 序列化后若继续执行,需调用 activity.resume() 重开在途段。
   */
  serializeLedger(): SerializedLedger {
    this.foldActiveSegment()
    this.maybeDeadline()
    return {
      version: 1,
      budget: { ...this.budget },
      phase: this.phase,
      slots: {
        planning: { ...this.slots.planning },
        extraction: { ...this.slots.extraction },
        review: { ...this.slots.review },
        synthesis: { ...this.slots.synthesis }
      },
      activity: {
        accumulatedMs: this.time.accumulatedMs,
        segmentStartedAtMs: null,
        finalizing: this.time.finalizing,
        finalizeMs: this.time.finalizeMs
      },
      deadlineReached: this.deadlineReachedFlag,
      sealedSubquestions: this.sealedSubquestions
    }
  }
}

// ---------- 反序列化(独立函数;构造器恢复路径复用) ----------

/**
 * 反序列化账本:拒绝未知字段与非法状态(负数计数、超上限、槽位状态机不合法)。
 * 重启恢复语义:已预留未消费的槽位恢复后保持已扣状态——预算不复活,
 * 重试不能逃过预算。
 */
export function deserializeLedger(raw: unknown): SerializedLedger {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw budgetError('VALIDATION', '账本必须是对象')
  }
  const allowed = new Set(['version', 'budget', 'phase', 'slots', 'activity', 'deadlineReached', 'sealedSubquestions'])
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (!allowed.has(key)) throw budgetError('VALIDATION', `账本含未知字段:${key}`)
  }
  const obj = raw as Record<string, unknown>

  if (obj.version !== 1) throw budgetError('VALIDATION', `账本版本不支持:${String(obj.version)}`)

  // 预算重走 resolveResearchBudget 校验(未知字段/上调/低于下限),不重写规则
  const budget = resolveResearchBudget(obj.budget)

  if (typeof obj.phase !== 'string' || !(LEDGER_PHASES as readonly string[]).includes(obj.phase)) {
    throw budgetError('VALIDATION', `账本阶段非法:${String(obj.phase)}`)
  }
  const phase = obj.phase as LedgerPhase

  if (typeof obj.sealedSubquestions !== 'number' || !Number.isInteger(obj.sealedSubquestions) || obj.sealedSubquestions < 0) {
    throw budgetError('VALIDATION', 'sealedSubquestions 必须是非负整数')
  }
  if (obj.sealedSubquestions > budget.max_subqueries) {
    throw budgetError('VALIDATION', `sealedSubquestions ${obj.sealedSubquestions} 超过 max_subqueries ${budget.max_subqueries}`)
  }

  // 槽位形态
  const slotsRaw = obj.slots
  if (typeof slotsRaw !== 'object' || slotsRaw === null || Array.isArray(slotsRaw)) {
    throw budgetError('VALIDATION', 'slots 必须是对象')
  }
  const slotsKeys = Object.keys(slotsRaw as Record<string, unknown>)
  if (slotsKeys.length !== SLOT_KINDS.length || !SLOT_KINDS.every((k) => slotsKeys.includes(k))) {
    throw budgetError('VALIDATION', 'slots 必须恰好包含四个槽位')
  }
  const slots = {} as Record<SlotKind, SlotState>
  for (const kind of SLOT_KINDS) {
    const s = (slotsRaw as Record<string, unknown>)[kind]
    if (typeof s !== 'object' || s === null || Array.isArray(s)) {
      throw budgetError('VALIDATION', `槽位 ${kind} 必须是对象`)
    }
    const sObj = s as Record<string, unknown>
    const sKeys = Object.keys(sObj)
    if (sKeys.length !== 2 || !('used' in sObj) || !('retries' in sObj)) {
      throw budgetError('VALIDATION', `槽位 ${kind} 含未知字段或缺少计数`)
    }
    const used = sObj.used
    const retries = sObj.retries
    if (typeof used !== 'number' || !Number.isInteger(used) || used < 0) {
      throw budgetError('VALIDATION', `槽位 ${kind}.used 必须是非负整数,收到 ${String(used)}`)
    }
    if (typeof retries !== 'number' || !Number.isInteger(retries) || retries < 0) {
      throw budgetError('VALIDATION', `槽位 ${kind}.retries 必须是非负整数,收到 ${String(retries)}`)
    }
    if (retries > 1) throw budgetError('VALIDATION', `槽位 ${kind}.retries 最多为 1,收到 ${retries}`)
    if (retries === 1 && used < 1) {
      throw budgetError('VALIDATION', `槽位 ${kind} 状态机不合法:重试必须建立在基础调用之上`)
    }
    slots[kind] = { used, retries }
  }

  // 容量与总额不变量:恢复后的账本同样不得超卖
  const sealed = obj.sealedSubquestions
  const capacityOf = (kind: SlotKind): number =>
    kind === 'extraction' ? sealed : BASE_SLOT_CAPACITY[kind]
  for (const kind of SLOT_KINDS) {
    if (slots[kind].used > capacityOf(kind)) {
      throw budgetError('VALIDATION', `槽位 ${kind}.used ${slots[kind].used} 超过容量 ${capacityOf(kind)}`)
    }
  }
  const total = SLOT_KINDS.reduce((sum, k) => sum + slots[k].used + slots[k].retries, 0)
  if (total > budget.max_model_calls) {
    throw budgetError('VALIDATION', `账本总额 ${total} 超过 max_model_calls ${budget.max_model_calls}`)
  }

  // 阶段与槽位状态机一致性
  if (phase === 'planning') {
    if (total > 0) throw budgetError('VALIDATION', '阶段 planning 不允许存在任何已消耗调用')
    if (obj.sealedSubquestions !== 0) throw budgetError('VALIDATION', '阶段 planning 不允许已定稿子问题')
  } else {
    if (slots.planning.used < 1) throw budgetError('VALIDATION', `阶段 ${phase} 要求规划槽位已消耗`)
    if (obj.sealedSubquestions < 1) throw budgetError('VALIDATION', `阶段 ${phase} 要求已定稿子问题数不小于 1`)
    if (slots.synthesis.used + slots.synthesis.retries > 0 && phase !== 'synthesis') {
      throw budgetError('VALIDATION', '组织槽位不得早于 synthesis 阶段消耗')
    }
    if (phase === 'plan_sealed' && slots.review.used + slots.review.retries > 0) {
      throw budgetError('VALIDATION', '阶段 plan_sealed 不允许审核槽位已预留')
    }
    if (phase === 'review_reserved' && slots.review.used + slots.review.retries < 1) {
      throw budgetError('VALIDATION', '阶段 review_reserved 要求审核槽位已预留')
    }
  }

  // 活动计时形态
  const act = obj.activity
  if (typeof act !== 'object' || act === null || Array.isArray(act)) {
    throw budgetError('VALIDATION', 'activity 必须是对象')
  }
  const actAllowed = new Set(['accumulatedMs', 'segmentStartedAtMs', 'finalizing', 'finalizeMs'])
  for (const key of Object.keys(act as Record<string, unknown>)) {
    if (!actAllowed.has(key)) throw budgetError('VALIDATION', `activity 含未知字段:${key}`)
  }
  const a = act as Record<string, unknown>
  if (typeof a.accumulatedMs !== 'number' || !Number.isInteger(a.accumulatedMs) || a.accumulatedMs < 0) {
    throw budgetError('VALIDATION', 'accumulatedMs 必须是非负整数')
  }
  if (a.segmentStartedAtMs !== null && (typeof a.segmentStartedAtMs !== 'number' || !Number.isInteger(a.segmentStartedAtMs) || a.segmentStartedAtMs < 0)) {
    throw budgetError('VALIDATION', 'segmentStartedAtMs 必须是 null 或非负整数')
  }
  if (typeof a.finalizing !== 'boolean') throw budgetError('VALIDATION', 'finalizing 必须是布尔值')
  if (typeof a.finalizeMs !== 'number' || !Number.isInteger(a.finalizeMs) || a.finalizeMs < 0) {
    throw budgetError('VALIDATION', 'finalizeMs 必须是非负整数')
  }
  if (a.finalizing && a.finalizeMs === 0 && a.segmentStartedAtMs !== null) {
    throw budgetError('VALIDATION', '收尾段与活动在途段不可同时存在')
  }
  if (a.accumulatedMs >= budget.max_active_seconds * 1000 && obj.deadlineReached !== true) {
    throw budgetError('VALIDATION', '活动累计已达上限但 deadlineReached 未置位,状态不合法')
  }
  if (obj.deadlineReached !== undefined && typeof obj.deadlineReached !== 'boolean') {
    throw budgetError('VALIDATION', 'deadlineReached 必须是布尔值')
  }

  return {
    version: 1,
    budget,
    phase,
    slots,
    activity: {
      accumulatedMs: a.accumulatedMs,
      segmentStartedAtMs: a.segmentStartedAtMs as number | null,
      finalizing: a.finalizing,
      finalizeMs: a.finalizeMs
    },
    deadlineReached: obj.deadlineReached === true,
    sealedSubquestions: obj.sealedSubquestions
  }
}

// ---------- 便捷工厂 ----------

/** 新建账本:budget 覆盖值经 resolveResearchBudget 校验(只允许下调) */
export function createLedger(options: { budget?: unknown; clock: Clock }): ResearchBudgetLedger {
  return new ResearchBudgetLedger(options)
}

/** 从序列化形态恢复账本;恢复后已扣状态保持,预算不复活 */
export function restoreLedger(options: { serialized: unknown; clock: Clock }): ResearchBudgetLedger {
  return new ResearchBudgetLedger({ clock: options.clock, serialized: options.serialized })
}
