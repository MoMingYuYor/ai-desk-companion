// personal-ops-mcp(A-07/MCP-01):stdio MCP 适配层。
//
// 边界(模块规格第 9 节):
// - 只暴露四个受控工具:list_todos / create_todo / list_calendar_events / create_calendar_event;
// - 读工具与写工具一律经同一 ToolGateway:读工具以一次 personal_ops 运行为载体
//   执行(schema 校验、幂等回执、观测轨迹全量生效,经注入方落 trace);
//   写工具只创建待批准提案,返回 approvalId,业务写入零发生;
// - 传入 approved 字段(无论值)被拒绝——模型不可能凭声明执行写操作;
// - MCP 不直接访问数据库,不绕过风险校验、确认与轨迹。
//
// 协议形态(MCP-01):所有协议输出只写 stdout,日志只写 stderr;
// EOF(stdin 关闭)后落盘本服务写入的数据并干净退出。
//
// Windows 限制与自愈:Electron 主进程(Windows)的 process.stdin 不可用——
// 一旦被读取就立即合成 end,管道/文件内容永不交付(Electron 已知限制,
// 实测 Electron 44 复现)。宿主若基于 process.stdin 注入 readLine,首读即 null;
// 此时本模块用独立打开的 fd 0 流(createReadStream)兜底读行,实测可正常收行;
// fd 0 流同样立即 EOF 才判定为真实 EOF(客户端关闭 stdin)。正常宿主不受影响。
//
// 本模块提供纯函数 handleMcpMessage(可单测)与 startPersonalOpsMcpStdio
// (薄 IO 壳:按行读写由宿主注入的 stdin/stdout,进程级行为由 tests/mcp/startup.test.ts 冒烟)。

import { createReadStream } from 'node:fs'
import type { SqliteDb } from '../db/connection'
import { createRun, getRun } from '../runs/repository'
import type { ToolGateway } from '../tools/gateway'
import type { ToolRegistry } from '../tools/registry'
import { transitionRun } from '../runs/repository'
import type { ToolResult } from '../tools/types'
import { OperationError } from '../db/operations'

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

/**
 * 调用读工具:创建一次 personal_ops 运行作为载体,经 ToolGateway.execute 执行——
 * 与写路径同一网关入口:注册表 schema 校验、幂等回执与观测单一出口全量生效,
 * 观测由注入方(主进程工厂)落 tool_call 轨迹。失败语义:业务失败返回 ToolFailure,
 * 网关级拒绝(schema 不符等)抛错由 handleMcpMessage 转为工具错误结果。
 */
async function callReadTool(deps: McpDeps, internalTool: string, args: Record<string, unknown>): Promise<ToolResult> {
  const run = createRun(deps.db, {
    mode: 'personal_ops',
    input: `(MCP 读取)${internalTool}`,
    contextClock: new Date().toISOString()
  })
  // queued → planning → executing 同步完成,不给调度器留拾取窗口
  transitionRun(deps.db, run.runId, 'planning')
  transitionRun(deps.db, run.runId, 'executing')
  try {
    const result = await deps.gateway.execute({
      runId: run.runId,
      tool: internalTool,
      callIndex: 1,
      arguments: args,
      planVersion: 1
    })
    transitionRun(deps.db, run.runId, result.ok ? 'succeeded' : 'failed', result.ok ? {} : { errorCode: result.error.code })
    return result
  } catch (err) {
    transitionRun(deps.db, run.runId, 'failed', {
      errorCode: err instanceof OperationError ? err.appError.code : null
    })
    throw err
  }
}

/**
 * 调用写工具:创建一个新的 personal_ops 运行作为提案载体,
 * 经 ToolGateway.propose 生成待批准提案,进入 awaiting_confirmation。
 * 返回审批信息(approvalId 与 confirmationId 同值,前者为内部审批记录 ID,
 * 桌面端审批入口按它决定);业务写入零发生。
 */
function proposeWriteTool(
  deps: McpDeps,
  internalTool: string,
  args: Record<string, unknown>
): { runId: string; approvalId: string; confirmationId: string; status: string } {
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
    approvalId: proposal.approvalId ?? '',
    confirmationId: proposal.approvalId ?? '',
    status: getRun(deps.db, run.runId)?.status ?? 'awaiting_confirmation'
  }
}

/**
 * 处理一条 MCP JSON-RPC 消息。通知(no id)返回 null(不发响应);
 * 未知方法返回 -32601;工具调用失败返回 tool 执行错误结果而非协议错误。
 * 读路径经网关异步执行,整体返回 Promise。
 */
export async function handleMcpMessage(deps: McpDeps, raw: unknown): Promise<unknown | null> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
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
    if (
      params.arguments !== undefined &&
      (typeof params.arguments !== 'object' || params.arguments === null || Array.isArray(params.arguments))
    ) {
      return jsonRpcError(id, -32602, '无效参数:arguments 必须是对象')
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
      const result = await callReadTool(deps, internalTool, rawArgs)
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
 * 等待 stdout 缓冲排空:管道写入是异步的,EOF 退出前不等待可能截断最后一行响应。
 * 上限 2 秒,防止管道阻塞导致进程无法退出。
 */
function stdoutDrained(): Promise<void> {
  return new Promise((resolve) => {
    const stream = process.stdout
    const deadline = Date.now() + 2000
    const tick = (): void => {
      if (!stream || stream.writableLength === 0 || Date.now() >= deadline) {
        resolve()
        return
      }
      setTimeout(tick, 10)
    }
    tick()
  })
}

/**
 * 独立打开 fd 0 的行读取器(Windows/Electron 主进程 stdin 自愈兜底):
 * process.stdin 在 Electron 主进程(Windows)被读取即合成 end 且内容永不交付,
 * 而 fd 0 本身可用——独立 createReadStream 实测能正常收行(含先写入管道缓冲的数据)。
 * 行语义与 readline 对齐:按 \n 切分、容忍结尾无换行的最后一行、剥离 \r。
 */
function createFd0LineReader(): { readLine(): Promise<string | null> } {
  // fd 已提供时 Node 忽略 path(不执行 open);@types/node v24 重载不再接受 null,传空串
  const stream = createReadStream('', { fd: 0 })
  let buffer = ''
  const queue: string[] = []
  let done = false
  let notify: (() => void) | null = null
  const wake = (): void => {
    const n = notify
    notify = null
    n?.()
  }
  stream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let i: number
    while ((i = buffer.indexOf('\n')) >= 0) {
      queue.push(buffer.slice(0, i).replace(/\r$/, ''))
      buffer = buffer.slice(i + 1)
    }
    if (queue.length > 0) wake()
  })
  stream.on('end', () => {
    if (buffer.trim() !== '') queue.push(buffer.replace(/\r$/, ''))
    buffer = ''
    done = true
    wake()
  })
  stream.on('error', (err: Error) => {
    console.error('[mcp] fd 0 读取失败,按 EOF 处理:', err.message)
    done = true
    wake()
  })
  return {
    readLine(): Promise<string | null> {
      if (queue.length > 0) return Promise.resolve(queue.shift()!)
      if (done) return Promise.resolve(null)
      // MCP 循环严格串行:同一时刻至多一个未决 readLine,单槽唤醒即可
      return new Promise<string | null>((resolve) => {
        notify = () => resolve(queue.length > 0 ? queue.shift()! : null)
      })
    }
  }
}

/**
 * 启动 stdio MCP 服务:按行读取注入的 stdin JSON-RPC 请求,逐行写回 stdout;
 * 通知不响应;非法 JSON 行回 -32700 解析错误(id=null)。
 * 启动命令(MCP-01 实测):electron . --mcp --user-data <绝对目录>
 * (必须在项目根用 app 目录方式启动——直接指定 out/main/index.js 会使
 * app.getAppPath() 解析到 out/main,sql.js WASM 资源路径错误)。
 *
 * 注入通道首读即 EOF 时按「Electron Windows 主进程 stdin 不可用」处理,
 * 自动切换 fd 0 兜底行读取器(见模块头注释);fd 0 也立即 EOF 才真实退出。
 *
 * EOF(stdin 关闭):落盘本服务写入的数据(提案/运行/轨迹),排空 stdout 后
 * 交还宿主(onClose)或以退出码 0 结束进程——宿主未注入钩子时(生产 --mcp 模式)
 * 由服务自行退出,避免僵尸进程。循环异常:记 stderr 后以退出码 1 结束。
 */
export function startPersonalOpsMcpStdio(deps: McpDeps, io: {
  readLine(): Promise<string | null>
  writeLine(line: string): void
  /** EOF 收尾钩子:提供时由宿主负责进程退出(测试注入);未提供时服务以退出码 0 自行结束 */
  onClose?: () => void
}): void {
  void (async () => {
    let reader = io.readLine
    let fallbackUsed = false
    for (;;) {
      let line = await reader()
      if (line === null && !fallbackUsed) {
        // 注入通道首读即 EOF:Electron Windows 主进程 stdin 的已知失效形态。
        // fd 0 兜底读取器探测:同样立即 EOF 才是真 EOF(客户端关闭 stdin)。
        const fallback = createFd0LineReader()
        const probed = await fallback.readLine()
        if (probed === null) break
        fallbackUsed = true
        reader = fallback.readLine
        line = probed
      }
      if (line === null) break
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        io.writeLine(JSON.stringify(jsonRpcError(null, -32700, '解析错误')))
        continue
      }
      const response = await handleMcpMessage(deps, parsed)
      if (response !== null) io.writeLine(JSON.stringify(response))
    }
    // EOF:先落盘,再排空协议输出,最后干净退出
    try {
      deps.db.flush()
    } catch (err) {
      console.error('[mcp] 退出前落盘失败:', err instanceof Error ? err.message : String(err))
    }
    await stdoutDrained()
    if (io.onClose) {
      io.onClose()
    } else {
      process.exit(0)
    }
  })().catch((err: unknown) => {
    console.error('[mcp] stdio 服务异常:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
