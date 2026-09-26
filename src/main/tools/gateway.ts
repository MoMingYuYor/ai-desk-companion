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

import { getWorkspaceEpoch, OperationError, runOperation, type PersistenceCoordinator } from '../db/operations'
import { appError } from '../../shared/operations'
import type { Clock } from '../../shared/clock'
import { DEFAULT_AGENT_TIMEOUTS } from '../agent/config'
import { createApproval, getApproval } from '../runs/repository'
import type { SqliteDb } from '../db/connection'
import { argumentsHash, validateToolInput } from './schema'
import type {
  ExecuteToolInput,
  ProposeToolInput,
  ToolDefinition,
  ToolProposal,
  ToolRegistryLike,
  ToolResult
} from './types'

export interface ToolGatewayDeps {
  db: SqliteDb
  registry: ToolRegistryLike
  /** 注入时钟:有效期判定与过期时间计算(C-02 契约:固定时钟只控领域时间) */
  clock: Clock
  /** 持久化协调器:存在时关键命令落盘成功才返回 */
  persistCoordinator?: PersistenceCoordinator
  /** 提案有效期(小时);默认取运行配置的 24 小时 */
  approvalTtlHours?: number
}

function forbidden(message: string): OperationError {
  return new OperationError(appError('FORBIDDEN', message, { retryable: false }))
}

function conflict(message: string): OperationError {
  return new OperationError(appError('CONFLICT', message, { retryable: false }))
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
   * 读工具直接可执行;写工具返回待批准提案。
   */
  propose(input: ProposeToolInput): ToolProposal {
    this.rejectClientApproval(input)
    const def = this.definition(input.tool)
    const args = validateToolInput(def.inputSchema, input.arguments)
    const hash = this.hashOf(input.tool, args)
    const targetVersion = input.targetVersion ?? null

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

    const ttlHours = this.deps.approvalTtlHours ?? DEFAULT_AGENT_TIMEOUTS.approvalTtlHours
    const expiresAt = new Date(this.deps.clock.now().getTime() + ttlHours * 3600_000).toISOString()
    const approval = createApproval(this.deps.db, {
      runId: input.runId,
      toolName: input.tool,
      argumentsHash: hash,
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
   * 失败语义:网关级拒绝(未批准/参数或版本变化/过期)与回执冲突抛错;
   * 工具业务级失败以 ToolFailure 返回并写入回执;工具意外异常由 runOperation
   * 回滚后向上传播,不写回执,同 callIndex 可重试。
   */
  async execute(input: ExecuteToolInput): Promise<ToolResult> {
    this.rejectClientApproval(input)
    const def = this.definition(input.tool)
    const args = validateToolInput(def.inputSchema, input.arguments)
    const hash = this.hashOf(input.tool, args)

    if (def.riskLevel !== 'read') {
      this.assertApproved(input, hash)
    }

    // 幂等键 = runId:tool:callIndex;同键同参命中回执返回首次结果,
    // 同键不同参由 runOperation 抛 CONFLICT 向上传播
    const operationId = `${input.runId}:${input.tool}:${input.callIndex}`
    const { value } = runOperation(
      this.deps.db,
      {
        operationId,
        command: `agent.tool.${input.tool}`,
        requestHash: hash,
        workspaceEpoch: getWorkspaceEpoch()
      },
      () => def.execute(args, { db: this.deps.db, clock: this.deps.clock })
    )

    if (this.deps.persistCoordinator) {
      // 关键命令落盘成功才返回成功;失败抛 PERSIST_FAILED(带 operationId,可重试)
      return await this.deps.persistCoordinator.commitCritical(operationId, value)
    }
    return value
  }

  /** 出现 approved 键(无论值)一律拒绝,含显式 false——契约不接受客户端声明批准 */
  private rejectClientApproval(input: ProposeToolInput): void {
    if ('approved' in input) {
      throw forbidden('不允许调用方声明批准状态;写操作必须经审批记录')
    }
  }

  /** 写工具的批准校验:存在性、决定、参数 hash、计划版本、目标版本、有效期 */
  private assertApproved(input: ExecuteToolInput, hash: string): void {
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
    if ((approval.targetVersion ?? null) !== (input.targetVersion ?? null)) {
      throw conflict('目标记录版本与批准时不一致,需重新生成提案')
    }
    if (this.deps.clock.now().getTime() >= new Date(approval.expiresAt).getTime()) {
      throw conflict('提案已过有效期,需重新生成')
    }
  }
}
