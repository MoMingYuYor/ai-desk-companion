// ToolGateway(C-04):工具执行的唯一入口。
//
// 三条硬约束(总体规格第 6、7 节):
// 1. 风险等级由注册表决定——本网关的输入结构里根本没有 risk 字段,
//    调用方或模型传来的任何风险声明只能作为"未知字段"被 schema 拒绝;
// 2. 写操作必须先有批准记录:propose 创建 pending 审批,execute 校验
//    批准状态 + 参数 hash + 计划版本 + 目标版本 + 有效期,任一不符拒绝;
// 3. 出现 approved 键(无论值)一律拒绝,不能凭客户端声明执行写操作。
//
// 执行统一走既有 runOperation:幂等键 = runId:tool:callIndex,
// 同键同参命中回执返回首次结果,不重复执行;关键命令经 commitCritical
// 落盘确认(协调器存在时)。

import { getWorkspaceEpoch, OperationError, runOperation, type OperationOutcome, type PersistenceCoordinator } from '../db/operations'
import { appError, type AppError } from '../../shared/operations'
import type { Clock } from '../../shared/clock'
import { DEFAULT_AGENT_TIMEOUTS } from '../agent/config'
import { createApproval, getApproval, maxObservationAttempt, type Approval } from '../runs/repository'
import type { SqliteDb } from '../db/connection'
import { argumentsHash, validateToolInput } from './schema'
import type {
  ExecuteToolInput,
  ProposeToolInput,
  ToolDefinition,
  ToolObservationV1,
  ToolProposal,
  ToolRegistryLike,
  ToolResult
} from './types'
import type { RiskLevel } from '../../shared/agent'

export interface ToolGatewayDeps {
  db: SqliteDb
  registry: ToolRegistryLike
  /** 注入时钟:有效期判定与过期时间计算(C-02 契约:固定时钟只控领域时间) */
  clock: Clock
  /** 持久化协调器:存在时关键命令落盘成功才返回 */
  persistCoordinator?: PersistenceCoordinator
  /** 提案有效期(小时);默认取运行配置的 24 小时 */
  approvalTtlHours?: number
  /**
   * 可选工作空间代数来源;缺省使用全局 getWorkspaceEpoch()(行为不变)。
   * EVAL-02 隔离评测环境用它注入局部 epoch,不影响全局生命周期元数据。
   */
  workspaceEpoch?: () => string
  /**
   * OPS-03:同步观测出口。网关单一出口在验证拒绝、审批拒绝、业务结果、抛错、
   * 落盘失败与回执重放处回调;注入方负责写 tool_call 轨迹——写库失败向上抛并
   * 停止后续动作;广播只能由注入方在事务提交后处理,广播失败仅告警。
   */
  onObservation?: (record: ToolObservationV1) => void
}

function forbidden(message: string): OperationError {
  return new OperationError(appError('FORBIDDEN', message, { retryable: false }))
}

function conflict(message: string): OperationError {
  return new OperationError(appError('CONFLICT', message, { retryable: false }))
}

/**
 * 非 OperationError 的意外异常映射。shared 的 ErrorCode 集合没有"网关内部错误"码,
 * 这里以 VALIDATION 承载原始消息;分类语义以观察记录的 outcome=gateway_error 为准。
 */
function asAppError(err: unknown): AppError {
  if (err instanceof OperationError) return err.appError
  return appError('VALIDATION', err instanceof Error ? err.message : String(err))
}

export class ToolGateway {
  constructor(private readonly deps: ToolGatewayDeps) {}

  private definition(tool: string): ToolDefinition {
    return this.deps.registry.get(tool)
  }

  private hashOf(tool: string, args: Record<string, unknown>): string {
    // hash 绑定工具名:同名同参在不同工具间不共享批准
    return argumentsHash({ tool, arguments: args })
  }

  /**
   * 生成工具调用提案:校验参数、计算 hash、按注册表风险等级决定是否创建审批。
   * 写工具先经 resolveTargetVersion 解析目标版本——引用不存在的记录在此拒绝;
   * 读工具直接可执行;写工具返回待批准提案。
   */
  propose(input: ProposeToolInput): ToolProposal {
    this.rejectClientApproval(input)
    const def = this.definition(input.tool)
    const args = validateToolInput(def.inputSchema, input.arguments)
    const hash = this.hashOf(input.tool, args)
    let targetVersion = input.targetVersion ?? null

    if (def.riskLevel === 'read') {
      return {
        tool: input.tool,
        riskLevel: def.riskLevel,
        requiresConfirmation: false,
        arguments: args,
        argumentsHash: hash,
        planVersion: input.planVersion,
        targetVersion,
        approvalId: null,
        expiresAt: null
      }
    }

    if (def.resolveTargetVersion) {
      const resolved = def.resolveTargetVersion(args, {
        db: this.deps.db,
        clock: this.deps.clock
      })
      if (resolved === null) {
        throw new OperationError(
          appError('VALIDATION', `目标记录不存在,拒绝虚构 ID 的修改提案(工具:${input.tool})`, { retryable: false })
        )
      }
      targetVersion = resolved
    }

    const ttlHours = this.deps.approvalTtlHours ?? DEFAULT_AGENT_TIMEOUTS.approvalTtlHours
    const expiresAt = new Date(this.deps.clock.now().getTime() + ttlHours * 3600_000).toISOString()
    const approval = createApproval(this.deps.db, {
      runId: input.runId,
      toolName: input.tool,
      argumentsHash: hash,
      argumentsJson: JSON.stringify(args),
      planVersion: input.planVersion,
      targetVersion,
      expiresAt
    })
    return {
      tool: input.tool,
      riskLevel: def.riskLevel,
      requiresConfirmation: true,
      arguments: args,
      argumentsHash: hash,
      planVersion: input.planVersion,
      targetVersion,
      approvalId: approval.approvalId,
      expiresAt
    }
  }

  /**
   * 执行工具调用。读工具直接执行;写工具必须先经 propose 并被批准。
   * 失败语义:网关级拒绝(未批准/参数变化/审批归属不符)与回执冲突抛错;
   * 工具业务级失败以 ToolFailure 返回并写入回执;工具意外异常由 runOperation
   * 回滚后向上传播,不写回执,同 callIndex 可重试。
   *
   * 校验分层(OPS-01):工具注册、审批存在/决定/冻结参数 hash/计划版本/审批归属
   * 对回执重放同样生效;目标版本与有效期校验放在 runOperation 的 apply 内,
   * 只对"新执行"生效——todo.update 首次执行后 revision 增长,保存重试走回执
   * 重放路径,不会被原目标版本拒绝。
   *
   * 观测(OPS-03):单一出口经 onObservation 输出 ToolObservationV1——
   * 验证拒绝/审批拒绝/业务结果/抛错/落盘失败/回执重放六类出口全部覆盖;
   * tool phase 在 apply 内与回执同事务记录(committed=false),apply 抛错时
   * 事务整体回滚、再在外层记录真实失败;persistence phase 在保存完成/失败处补记;
   * attempt 按"本 operationId 已保存观察最大值+1"分配,两 phase 共用,
   * 回执重放保持同 operationId 并单列新 attempt。
   */
  async execute(input: ExecuteToolInput): Promise<ToolResult> {
    const startedMs = this.deps.clock.monotonicMs()
    const operationId = `${input.runId}:${input.tool}:${input.callIndex}`
    const attempt = maxObservationAttempt(this.deps.db, input.runId, operationId) + 1

    let riskLevel: RiskLevel | null = null
    let args: Record<string, unknown> | null = null
    let approval: Approval | null = null
    let approvalValidated = false

    /** 观察记录的单次调用稳定字段 */
    const base = {
      observationVersion: 1 as const,
      runId: input.runId,
      tool: input.tool,
      callIndex: input.callIndex,
      operationId,
      attempt,
      planVersion: input.planVersion
    }
    /** 数据库/执行现场快照字段:审批字段一律来自数据库与服务端检查,不采信调用方声明 */
    const snapshot = () => ({
      riskLevel,
      attemptedArguments: input.arguments as unknown,
      arguments: args,
      approvalId: approval?.approvalId ?? null,
      approvalDecision: approval?.decision ?? null,
      approvalValidated,
      targetVersion: approval?.targetVersion ?? null
    })
    /** 单一出口:patch 中的显式字段(含 durationMs)优先于默认快照 */
    const emit = (
      phase: ToolObservationV1['phase'],
      patch: Partial<ToolObservationV1> & { outcome: ToolObservationV1['outcome'] }
    ): void => {
      const durationMs = patch.durationMs ?? Math.max(0, this.deps.clock.monotonicMs() - startedMs)
      const record: ToolObservationV1 = {
        ...base,
        phase,
        ...snapshot(),
        executed: false,
        replayed: false,
        committed: false,
        result: null,
        error: null,
        durationMs,
        ...patch
      }
      // 观察写库失败由注入方抛出并向上传播,停止后续动作
      try {
        this.deps.onObservation?.(record)
      } catch {
        throw new OperationError(appError('OBSERVATION_FAILED', '工具观察记录无法写入，运行已停止', { operationId }))
      }
    }

    // 信封契约:出现 approved 键(无论值)一律拒绝,拒绝本身也被观测
    try {
      this.rejectClientApproval(input)
    } catch (err) {
      emit('tool', { outcome: 'gateway_error', error: asAppError(err) })
      throw err
    }

    let def: ToolDefinition
    try {
      def = this.definition(input.tool)
    } catch (err) {
      emit('tool', { outcome: 'gateway_error', error: asAppError(err) })
      throw err
    }
    riskLevel = def.riskLevel

    try {
      args = validateToolInput(def.inputSchema, input.arguments)
    } catch (err) {
      // 验证失败:arguments=null,attemptedArguments 保留原始输入供 EVAL 比对
      emit('tool', { outcome: 'gateway_error', error: asAppError(err) })
      throw err
    }
    const hash = this.hashOf(input.tool, args)

    if (def.riskLevel !== 'read') {
      try {
        approval = this.assertApproved(def, input, hash)
        approvalValidated = true
      } catch (err) {
        // 审批拒绝:决定与目标版本取数据库快照,不采信调用方声明
        approval = input.approvalId ? getApproval(this.deps.db, input.approvalId) : null
        emit('tool', { outcome: 'gateway_error', error: asAppError(err) })
        throw err
      }
    }

    let outcome: OperationOutcome<ToolResult>
    const resolveEpoch = this.deps.workspaceEpoch ?? getWorkspaceEpoch
    try {
      outcome = runOperation(
        this.deps.db,
        {
          operationId,
          command: `agent.tool.${input.tool}`,
          requestHash: hash,
          workspaceEpoch: resolveEpoch()
        },
        () => {
          // 新执行才校验目标版本与有效期;回执命中时不进入本回调
          if (approval) this.assertTargetAndExpiry(def, approval)
          const result = def.execute(args!, {
            db: this.deps.db,
            clock: this.deps.clock,
            targetVersion: approval?.targetVersion ?? null
          })
          // tool phase 与回执同事务:先记录观察(committed=false),失败则整体回滚
          emit('tool', {
            outcome: result.ok ? 'success' : 'business_error',
            executed: true,
            result: result.ok ? result.data : null,
            error: result.ok ? null : result.error
          })
          return result
        }
      )
    } catch (err) {
      // apply 抛错:事务(含 apply 内观察)整体回滚,在外层记录真实失败
      if (err instanceof OperationError && err.appError.code === 'OBSERVATION_FAILED') throw err
      emit('tool', { outcome: 'gateway_error', error: asAppError(err) })
      throw err
    }

    if (outcome.replayed) {
      // 回执命中:executed=false、replayed=true;结果必然早已提交(committed=true)
      const value = outcome.value
      emit('tool', {
        outcome: value.ok ? 'success' : 'business_error',
        replayed: true,
        committed: true,
        result: value.ok ? value.data : null,
        error: value.ok ? null : value.error
      })
    }

    if (this.deps.persistCoordinator) {
      // 关键命令落盘成功才返回成功;失败抛 PERSIST_FAILED(带 operationId,可重试)
      const persistStartedMs = this.deps.clock.monotonicMs()
      try {
        const value = await this.deps.persistCoordinator.commitCritical(operationId, outcome.value)
        emit('persistence', {
          outcome: 'success',
          replayed: outcome.replayed,
          committed: true,
          durationMs: Math.max(0, this.deps.clock.monotonicMs() - persistStartedMs)
        })
        // 最终观察在首轮保存之后生成，必须再次保存才可返回；不重复运行业务。
        await this.deps.persistCoordinator.commitCritical(operationId, value)
        return value
      } catch (err) {
        if (err instanceof OperationError && err.appError.code === 'OBSERVATION_FAILED') throw err
        // PERSIST_FAILED 单列 outcome 且 committed=true:事务已提交,仅落盘未确认
        try { emit('persistence', {
          outcome: 'persist_error',
          replayed: outcome.replayed,
          committed: true,
          error: asAppError(err),
          durationMs: Math.max(0, this.deps.clock.monotonicMs() - persistStartedMs)
        }) } catch { console.error('[tool-gateway] 保存失败留痕未确认') }
        throw err
      }
    }
    return outcome.value
  }

  /** 出现 approved 键(无论值)一律拒绝,含显式 false——契约不接受客户端声明批准 */
  private rejectClientApproval(input: ProposeToolInput): void {
    if ('approved' in input) {
      throw forbidden('不允许调用方声明批准状态;写操作必须经审批记录')
    }
  }

  /**
   * 写工具的批准校验(回执重放同样生效):存在性、决定、参数 hash、计划版本、审批归属。
   * 目标版本与有效期的核对方式见 assertTargetAndExpiry——它们只对"新执行"生效,
   * 放在 runOperation 的 apply 内,避免保存重试被本次执行造成的 revision 增长拒绝。
   */
  private assertApproved(def: ToolDefinition, input: ExecuteToolInput, hash: string): Approval {
    if (!input.approvalId) {
      throw forbidden('写操作缺少审批记录;必须先经 propose 生成提案')
    }
    const approval = getApproval(this.deps.db, input.approvalId)
    if (!approval) throw forbidden('审批记录不存在')
    if (approval.decision === 'pending') throw forbidden('提案尚未批准')
    if (approval.decision === 'rejected') throw forbidden('提案已被拒绝')
    if (approval.decision === 'expired') throw conflict('提案已过期,需重新生成')
    if (approval.argumentsHash !== hash) {
      throw conflict('工具参数与批准时不一致,需重新生成提案')
    }
    if (approval.planVersion !== input.planVersion) {
      throw conflict('计划版本与批准时不一致,需重新生成提案')
    }
    // 审批归属:审批必须属于本次调用的运行,跨运行携带他运行的审批一律拒绝
    if (approval.runId !== input.runId) {
      throw forbidden('审批记录不属于本次运行')
    }
    return approval
  }

  /**
   * 新执行时的目标版本与有效期校验(在 runOperation 的 apply 内调用):
   * 用 resolveTargetVersion 重解析当前版本并与批准时绑定的版本比对——批准到执行
   * 之间目标被再修改或删除即 CONFLICT(OPS-06);过期提案同样在此拒绝。
   */
  private assertTargetAndExpiry(def: ToolDefinition, approval: Approval): void {
    if (approval.targetVersion !== null && def.resolveTargetVersion) {
      const parsedArgs = JSON.parse(approval.argumentsJson ?? '{}')
      const current = def.resolveTargetVersion(parsedArgs, {
        db: this.deps.db,
        clock: this.deps.clock
      })
      if (current !== approval.targetVersion) {
        throw conflict('目标记录版本与批准时不一致,需重新生成提案')
      }
    }
    if (this.deps.clock.now().getTime() >= new Date(approval.expiresAt).getTime()) {
      throw conflict('提案已过有效期,需重新生成')
    }
  }
}
