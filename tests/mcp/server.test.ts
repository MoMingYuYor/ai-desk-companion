import { describe, expect, it } from 'vitest'
import { makeTestDb } from '../helpers'
import { initWorkspaceEpoch } from '../../src/main/db/operations'
import { ToolGateway } from '../../src/main/tools/gateway'
import { ToolRegistry } from '../../src/main/tools/registry'
import { registerOpsTools } from '../../src/main/tools/definitions'
import { handleMcpMessage, listMcpTools, MCP_SERVER_INFO } from '../../src/main/mcp/server'
import type { McpDeps } from '../../src/main/mcp/server'
import type { SqliteDb } from '../../src/main/db/connection'

// A-07:MCP 适配层。核心边界:只暴露四个受控工具;写工具只产生提案
// (业务写入零发生);approved 声明被拒绝;不绕过网关与轨迹。

const NOW = '2026-09-28T01:00:00.000Z'

async function makeMcp(): Promise<{ db: SqliteDb; deps: McpDeps }> {
  const db = await makeTestDb()
  initWorkspaceEpoch()
  const registry = new ToolRegistry()
  registerOpsTools(registry)
  const gateway = new ToolGateway({ db, registry, clock: { now: () => new Date(NOW), monotonicMs: () => 0 } })
  return { db, deps: { db, registry, gateway } }
}

function call(deps: McpDeps, method: string, params?: unknown, id: unknown = 1): unknown {
  return handleMcpMessage(deps, { jsonrpc: '2.0', id, method, params })
}

describe('MCP 协议', () => {
  it('initialize 返回协议版本与服务器信息', async () => {
    const { deps } = await makeMcp()
    const res = call(deps, 'initialize') as { result: { protocolVersion: string; serverInfo: typeof MCP_SERVER_INFO } }
    expect(res.result.protocolVersion).toBe('2024-11-05')
    expect(res.result.serverInfo.name).toBe('personal-ops-mcp')
  })

  it('通知(no id)返回 null 不响应', async () => {
    const { deps } = await makeMcp()
    expect(handleMcpMessage(deps, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
  })

  it('tools/list 只暴露四个受控工具', async () => {
    const { deps } = await makeMcp()
    const res = call(deps, 'tools/list') as { result: { tools: Array<{ name: string }> } }
    expect(res.result.tools.map((t) => t.name)).toEqual([
      'list_todos',
      'create_todo',
      'list_calendar_events',
      'create_calendar_event'
    ])
  })

  it('未知方法返回 -32601;未知工具返回 -32602', async () => {
    const { deps } = await makeMcp()
    const badMethod = call(deps, 'resources/list') as { error: { code: number } }
    expect(badMethod.error.code).toBe(-32601)
    const badTool = call(deps, 'tools/call', { name: 'shell.exec', arguments: {} }) as { error: { code: number } }
    expect(badTool.error.code).toBe(-32602)
  })
})

describe('MCP 读工具', () => {
  it('list_todos 返回本地数据', async () => {
    const { deps } = await makeMcp()
    deps.db.run(
      "INSERT INTO todos (id, title, priority, completed_at, source, revision, created_at, updated_at) VALUES ('t1', '写周报', 'normal', NULL, 'manual', 1, '2026-09-28T00:00', '2026-09-28T00:00')"
    )
    const res = call(deps, 'tools/call', { name: 'list_todos', arguments: {} }) as {
      result: { content: Array<{ text: string }>; isError: boolean }
    }
    expect(res.result.isError).toBe(false)
    const data = JSON.parse(res.result.content[0]!.text) as { todos: Array<{ title: string }> }
    expect(data.todos.some((t) => t.title === '写周报')).toBe(true)
  })

  it('list_calendar_events 可按日期范围查询', async () => {
    const { deps } = await makeMcp()
    deps.db.run(
      "INSERT INTO events (id, title, start_at, end_at, all_day, status, revision, created_at, updated_at) VALUES ('e1', '周会', '2026-09-29T10:00', '2026-09-29T11:00', 0, 'active', 1, '2026-09-28T00:00', '2026-09-28T00:00')"
    )
    const res = call(deps, 'tools/call', {
      name: 'list_calendar_events',
      arguments: { from: '2026-09-29', to: '2026-09-30' }
    }) as { result: { content: Array<{ text: string }> } }
    const data = JSON.parse(res.result.content[0]!.text) as { events: Array<{ title: string }> }
    expect(data.events.some((e) => e.title === '周会')).toBe(true)
  })

  it('参数不满足 schema 返回工具错误结果', async () => {
    const { deps } = await makeMcp()
    const res = call(deps, 'tools/call', { name: 'list_todos', arguments: { limit: 5 } }) as {
      result: { isError: boolean }
    }
    expect(res.result.isError).toBe(true)
  })
})

describe('MCP 写工具:只产生提案(OPS-09 边界)', () => {
  it('create_todo 返回确认信息,业务写入零发生', async () => {
    const { deps } = await makeMcp()
    const res = call(deps, 'tools/call', {
      name: 'create_todo',
      arguments: { title: '经 MCP 请求创建' }
    }) as { result: { content: Array<{ text: string }>; isError: boolean } }
    expect(res.result.isError).toBe(false)
    const proposal = JSON.parse(res.result.content[0]!.text) as {
      runId: string
      confirmationId: string
      status: string
    }
    expect(proposal.status).toBe('awaiting_confirmation')
    expect(proposal.confirmationId).toBeTruthy()
    // 业务写入零发生
    expect(deps.db.all("SELECT * FROM todos WHERE title = '经 MCP 请求创建'")).toHaveLength(0)
    // 但提案与轨迹已建立(可审计)
    expect(deps.db.all('SELECT * FROM approvals WHERE approval_id = ?', [proposal.confirmationId])).toHaveLength(1)
  })

  it('arguments 带 approved=true:被拒绝(OPS-09)', async () => {
    const { deps } = await makeMcp()
    const res = call(deps, 'tools/call', {
      name: 'create_todo',
      arguments: { title: '越权创建', approved: true }
    }) as { result: { content: Array<{ text: string }>; isError: boolean } }
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0]!.text).toContain('approved')
    expect(deps.db.all("SELECT * FROM todos WHERE title = '越权创建'")).toHaveLength(0)
  })

  it('create_calendar_event 同样只产生提案', async () => {
    const { deps } = await makeMcp()
    const res = call(deps, 'tools/call', {
      name: 'create_calendar_event',
      arguments: { title: 'MCP 日程', startAt: '2026-09-30T09:00', endAt: '2026-09-30T10:00' }
    }) as { result: { isError: boolean } }
    expect(res.result.isError).toBe(false)
    expect(deps.db.all("SELECT * FROM events WHERE title = 'MCP 日程'")).toHaveLength(0)
  })
})
