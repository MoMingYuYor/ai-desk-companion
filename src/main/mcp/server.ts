// personal-ops-mcp(A-07):stdio MCP 适配层。
//
// 边界(模块规格第 9 节):
// - 只暴露四个受控工具:list_todos / create_todo / list_calendar_events / create_calendar_event;
// - 一律转发 ToolGateway:读工具直接执行,写工具只创建待批准提案
//   (新运行为载体),返回 confirmation 供已认证应用界面批准;
// - 传入 approved 字段(无论值)被网关拒绝——模型不可能凭声明执行写操作;
// - MCP 不直接访问数据库,不绕过风险校验、确认与轨迹。
//
// 本模块提供纯函数 handleMcpMessage(可单测)与 startPersonalOpsMcpStdio
// (薄 IO 壳:按行读写 stdin/stdout,不做单元测试,仅冒烟)。

import type { SqliteDb } from '../db/connection'
import { createRun, getRun } from '../runs/repository'
import type { ToolGateway } from '../tools/gateway'
import type { ToolRegistry } from '../tools/registry'
import { validateToolInput } from '../tools/schema'
import { transitionRun } from '../runs/repository'
import type { ToolResult } from '../tools/types'
import { OperationError } from '../db/operations'
import { appError } from '../../shared/operations'

export const MCP_SERVER_INFO = { name: 'personal-ops-mcp', version: '0.1.0' } as const

/** MCP 暴露的工具 → 内部注册表工具的映射(白名单,不是全量注册表) */
const MCP_TOOL_MAP = {
  list_todos: 'todo.list',
  create_todo: 'todo.create',
  list_calendar_events: 'calendar.list',
  create_calendar_event: 'calendar.create_event'
} as const

export type McpToolName = keyof typeof MCP_TOOL_MAP

export interface McpDeps {
  db: SqliteDb
  registry: ToolRegistry
  gateway: ToolGateway
}

interface McpRequest {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

function jsonRpcResult(id: unknown, result: unknown): unknown {
  return { jsonrpc: '2.0', id, result }
}

function jsonRpcError(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/** MCP 工具清单:内部 schema 转换为 JSON Schema 形态 */
export function listMcpTools(registry: ToolRegistry): Array<Record<string, unknown>> {
  return (Object.keys(MCP_TOOL_MAP) as McpToolName[]).map((mcpName) => {
    const def = registry.get(MCP_TOOL_MAP[mcpName])
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const field of def.inputSchema.fields) {
      properties[field.name] =
        field.type === 'string[]'
          ? { type: 'array', items: { type: 'string' } }
          : { type: field.type, ...(field.enum ? { enum: [...field.enum] } : {}) }
      if (field.required) required.push(field.name)
    }
    return {
      name: mcpName,
      description: def.description,
      inputSchema: { type: 'object', properties, required }
    }
  })
}

/** 调用读工具:直接执行(无审批语义),返回工具结果 */
function callReadTool(deps: McpDeps, internalTool: string, args: Record<string, unknown>): ToolResult {
  const def = deps.registry.get(internalTool)
  // 严格 schema 校验:未知字段与类型不符同样拒绝(与网关同一规则)
  const normalized = validateToolInput(def.inputSchema, args)
  return def.execute(normalized, { db: deps.db, clock: { now: () => new Date(), monotonicMs: () => 0 } })
}

/**
 * 调用写工具:创建一个新的 personal_ops 运行作为提案载体,
 * 经 ToolGateway.propose 生成待批准提案,进入 awaiting_confirmation。
 * 返回 confirmation 信息;业务写入零发生。
 */
function proposeWriteTool(
  deps: McpDeps,
  internalTool: string,
  args: Record<string, unknown>
): { runId: string; toolCallId: string; confirmationId: string; status: string } {
  const run = createRun(deps.db, {
    mode: 'personal_ops',
    input: `(MCP 提案)${internalTool}`,
    contextClock: new Date().toISOString()
  })
  const proposal = deps.gateway.propose({
    runId: run.runId,
    tool: internalTool,
    arguments: args,
    planVersion: 1
  })
  // 提案已生成:queued → planning → awaiting_confirmation(与编排器产生的提案同一状态语义)
  transitionRun(deps.db, run.runId, 'planning')
  transitionRun(deps.db, run.runId, 'awaiting_confirmation')
  return {
    runId: run.runId,
    toolCallId: proposal.approvalId ?? '',
    confirmationId: proposal.approvalId ?? '',
    status: getRun(deps.db, run.runId)?.status ?? 'awaiting_confirmation'
  }
}

/**
 * 处理一条 MCP JSON-RPC 消息。通知(no id)返回 null(不发响应);
 * 未知方法返回 -32601;工具调用失败返回 tool 执行错误结果而非协议错误。
 */
export function handleMcpMessage(deps: McpDeps, raw: unknown): unknown | null {
  if (raw === null || typeof raw !== 'object') {
    return jsonRpcError(null, -32600, '无效请求')
  }
  const msg = raw as McpRequest
  const id = msg.id ?? null
  const method = typeof msg.method === 'string' ? msg.method : ''
  const isNotification = !('id' in msg) || msg.id === undefined

  if (method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO
    })
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null
  }
  if (method === 'tools/list') {
    return jsonRpcResult(id, { tools: listMcpTools(deps.registry) })
  }
  if (method === 'tools/call') {
    const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown }
    const mcpName = params.name
    const internalTool = typeof mcpName === 'string' ? MCP_TOOL_MAP[mcpName as McpToolName] : undefined
    if (!internalTool || (typeof mcpName === 'string' && !(mcpName in MCP_TOOL_MAP))) {
      return jsonRpcError(id, -32602, `未知工具:${String(mcpName)}`)
    }
    const rawArgs = (params.arguments ?? {}) as Record<string, unknown>
    if ('approved' in rawArgs) {
      // 双保险:网关同样拒绝;此处提前拦截让 MCP 错误信息更友好
      return jsonRpcResult(id, {
        content: [{ type: 'text', text: '不允许声明 approved;写操作必须经应用界面批准' }],
        isError: true
      })
    }
    try {
      const isWrite = internalTool === 'todo.create' || internalTool === 'calendar.create_event'
      if (isWrite) {
        const proposal = proposeWriteTool(deps, internalTool, rawArgs)
        return jsonRpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(proposal) }],
          isError: false
        })
      }
      const result = callReadTool(deps, internalTool, rawArgs)
      if (!result.ok) {
        return jsonRpcResult(id, {
          content: [{ type: 'text', text: result.error.message }],
          isError: true
        })
      }
      return jsonRpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result.data) }],
        isError: false
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return jsonRpcResult(id, { content: [{ type: 'text', text: message }], isError: true })
    }
  }
  if (isNotification) return null
  return jsonRpcError(id, -32601, `未知方法:${method}`)
}

// ---------- stdio IO 壳 ----------

/**
 * 启动 stdio MCP 服务:按行读取 stdin 的 JSON-RPC 请求,
 * 逐行写回 stdout;通知不响应。启动命令(拟定,实现后核对):
 * node out/main/mcp/server.js --stdio
 */
export function startPersonalOpsMcpStdio(deps: McpDeps, io: {
  readLine(): Promise<string | null>
  writeLine(line: string): void
}): void {
  void (async () => {
    for (;;) {
      const line = await io.readLine()
      if (line === null) break
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        io.writeLine(JSON.stringify(jsonRpcError(null, -32700, '解析错误')))
        continue
      }
      const response = handleMcpMessage(deps, parsed)
      if (response !== null) io.writeLine(JSON.stringify(response))
    }
  })().catch((err: unknown) => {
    console.error('[mcp] stdio 服务异常:', err instanceof Error ? err.message : String(err))
  })
}
