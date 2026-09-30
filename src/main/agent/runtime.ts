// 生产网关工厂(OPS-01):关键落盘依赖在此显式必填。
//
// 背景:生产入口此前直接 new ToolGateway 而漏传 persistCoordinator,
// 网关的"关键命令落盘成功才返回"分支永远走不到(F-01)。
// 本工厂把 persistCoordinator 变成必填并在缺失时显式拒绝,
// 生产接线(index.ts,由整合者完成)与集成测试共同经此构造;
// 单元替身测试仍可直接 new ToolGateway(依赖保持可选)。

import { appError } from '../../shared/operations'
import { OperationError, type PersistenceCoordinator } from '../db/operations'
import { ToolGateway, type ToolGatewayDeps } from '../tools/gateway'

/** 生产网关依赖:在 ToolGatewayDeps 之上把关键落盘协调器变为必填 */
export type AgentGatewayRuntimeDeps = ToolGatewayDeps & {
  persistCoordinator: PersistenceCoordinator
}

/**
 * 创建生产 ToolGateway:缺失任一关键依赖(db/registry/clock/persistCoordinator)
 * 显式拒绝,不允许静默降级为"不等待落盘"的执行语义。
 */
export function createAgentGateway(deps: AgentGatewayRuntimeDeps): ToolGateway {
  const missing: string[] = []
  if (!deps.db) missing.push('db')
  if (!deps.registry) missing.push('registry')
  if (!deps.clock) missing.push('clock')
  if (!deps.persistCoordinator) missing.push('persistCoordinator')
  if (missing.length > 0) {
    throw new OperationError(
      appError('VALIDATION', `createAgentGateway 缺少关键依赖:${missing.join(', ')}`, { retryable: false })
    )
  }
  return new ToolGateway(deps)
}
