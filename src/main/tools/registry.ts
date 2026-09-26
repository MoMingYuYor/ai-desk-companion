// 工具注册表(C-04):所有工具必须经此注册才能被网关执行。
// 未注册工具不能执行(总体规格第 12 节);重复注册视为编程错误,直接抛错。

import { appError } from '../../shared/operations'
import { OperationError } from '../db/operations'
import type { ToolDefinition } from './types'

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  /** 注册工具;重名抛错。注册后定义被冻结,防止运行期改写风险等级 */
  register(definition: ToolDefinition): void {
    if (this.tools.has(definition.name)) {
      throw new OperationError(appError('VALIDATION', `工具重复注册:${definition.name}`, { retryable: false }))
    }
    if (definition.name.trim() === '') {
      throw new OperationError(appError('VALIDATION', '工具名不能为空', { retryable: false }))
    }
    this.tools.set(definition.name, Object.freeze({ ...definition }))
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** 未注册工具抛 VALIDATION;message 不区分"未注册"与其他查找失败以外的信息 */
  get(name: string): ToolDefinition {
    const def = this.tools.get(name)
    if (!def) {
      throw new OperationError(appError('VALIDATION', `未注册的工具:${name}`, { retryable: false }))
    }
    return def
  }

  /** 已注册工具名(按字典序,便于 MCP 工具清单等场景稳定输出) */
  list(): string[] {
    return [...this.tools.keys()].sort()
  }

  get size(): number {
    return this.tools.size
  }
}
