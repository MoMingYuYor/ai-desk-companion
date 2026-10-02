// MCP-01 进程级测试:真实构建产物 out/main/index.js 以 --mcp 模式启动,
// 对合成库(随机临时 userData)走完整协议与审批边界。
//
// 前置:npm run build(本测试不自行构建,缺产物时明确失败)。
// 覆盖:initialize / tools/list / 读工具(经网关落 trace)/ 非法 JSON(-32700)/
// 未批准写提案(approvalId + 库中 pending 行)/ 伪造 approved(任意值)拒绝 /
// EOF 干净退出(退出码 0)/ 退出重开(同一 userData 重启,提案仍在)。
//
// stdout 仅允许有对应请求的 JSON-RPC 响应，任何日志或重复响应均为协议污染。

import { describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { openDatabase, type SqliteDb } from '../../src/main/db/connection'

const require = createRequire(import.meta.url)
// electron 包在 Node 环境导出其二进制可执行文件路径(已在本机实测)
const electronBinary = require('electron') as string
const outMain = resolve(dirname(fileURLToPath(import.meta.url)), '../../out/main/index.js')
// MCP 模式必须以 app 目录方式启动(electron . ):直接指定 out/main/index.js 会使
// app.getAppPath() 解析到 out/main,sql.js WASM 资源路径错误(实测复现,见交付差距报告)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

interface JsonRpcResponse {
  jsonrpc: string
  id: unknown
  result?: unknown
  error?: { code: number; message: string }
}

function toolText(res: JsonRpcResponse): { content: Array<{ text: string }>; isError?: boolean } {
  return res.result as { content: Array<{ text: string }>; isError?: boolean }
}

/** stdio JSON-RPC 客户端:按行解析子进程 stdout,stderr 只收集不断言内容 */
class StdioMcp {
  private nextId = 1
  private readonly waiters: Array<{
    /** null 表示不按 id 关联(非法 JSON 的解析错误响应) */
    id: number | null
    resolve: (r: JsonRpcResponse) => void
    reject: (e: Error) => void
    timer: NodeJS.Timeout
  }> = []
  /** stdout 上出现的非 JSON-RPC 响应行(协议污染证据) */
  readonly stdoutNoise: string[] = []
  readonly stderrLines: string[] = []
  private readonly exited: Promise<number | null>

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => this.onLine(line.trim()))
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() !== '') this.stderrLines.push(line.trim())
      }
    })
    this.exited = new Promise((resolveExit) => {
      child.on('exit', (code) => resolveExit(code))
    })
  }

  private onLine(line: string): void {
    if (line === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.stdoutNoise.push(line)
      return
    }
    const msg = parsed as JsonRpcResponse
    const isResponse =
      msg !== null && typeof msg === 'object' && msg.jsonrpc === '2.0' &&
      (('result' in msg) !== ('error' in msg)) && 'id' in msg
    if (!isResponse) {
      this.stdoutNoise.push(line)
      return
    }
    const i = this.waiters.findIndex((w) => w.id === null || w.id === msg.id)
    if (i >= 0) {
      const w = this.waiters.splice(i, 1)[0]!
      clearTimeout(w.timer)
      w.resolve(msg)
    }
    else this.stdoutNoise.push(line)
  }

  request(method: string, params?: unknown, timeoutMs = 20000): Promise<JsonRpcResponse> {
    const id = this.nextId++
    const promise = this.waitNext(id, timeoutMs)
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return promise
  }

  /** 通知(无 id):不等待响应 */
  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  /** 发送任意原始行(非法 JSON 场景)并等待下一条响应 */
  sendAndExpect(line: string, timeoutMs = 20000): Promise<JsonRpcResponse> {
    const promise = this.waitNext(null, timeoutMs)
    this.child.stdin.write(`${line}\n`)
    return promise
  }

  private waitNext(id: number | null, timeoutMs: number): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.id === id)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(new Error(`等待 MCP 响应超时(${timeoutMs}ms,id=${id})`))
      }, timeoutMs)
      this.waiters.push({ id, resolve, reject, timer })
    })
  }

  /** 关闭 stdin 并等待进程以干净退出码结束 */
  async closeStdinAndExit(timeoutMs = 15000): Promise<number | null> {
    this.child.stdin.end()
    return this.waitExit(timeoutMs)
  }

  waitExit(timeoutMs = 5000): Promise<number | null> {
    return Promise.race([
      this.exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('进程未在时限内退出')), timeoutMs)
      )
    ])
  }

  kill(): void {
    this.child.kill()
  }
}

async function spawnMcp(userDataDir: string, registry: StdioMcp[]): Promise<StdioMcp> {
  if (!existsSync(outMain)) {
    throw new Error(`缺少构建产物 ${outMain};进程级测试前先运行 npm run build`)
  }
  // Windows 新安装的 exe 可能短暂被扫描占用；只重试尚未启动的 EBUSY。
  for (let attempt = 0; ; attempt++) {
    try {
      const child = spawn(electronBinary, ['.', '--mcp', '--user-data', userDataDir], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: projectRoot
      }) as ChildProcessWithoutNullStreams
      const client = new StdioMcp(child)
      registry.push(client)
      return client
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || attempt >= 3) throw error
      console.warn(`[mcp-test] Electron 尚未启动，EBUSY 等待 ${250 * (attempt + 1)}ms`)
      await sleep(250 * (attempt + 1))
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 清理临时目录:Windows 下 crashpad 等子进程可能短暂持有目录句柄,
 * 重试删除;最终仍失败仅告警不抛错——清理失败不能掩盖测试断言结果,
 * 残留目录位于 OS 临时目录,不影响后续运行(每次随机新建)。
 */
async function cleanupDir(dir: string): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await sleep(300 * attempt)
    }
  }
  console.warn(`[mcp-test] 临时目录清理失败,已保留:${dir}`)
}

/** 终止所有会话并清理目录:统一收尾,保证异常路径也不泄漏子进程 */
async function shutdown(clients: StdioMcp[], dir: string): Promise<void> {
  for (const c of clients) c.kill()
  for (const c of clients) await c.waitExit().catch(() => undefined)
  await cleanupDir(dir)
}

function makeUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-startup-'))
}

/** 直接打开 MCP 进程落盘的 SQLite 文件(只查询,不写) */
async function openUserDataDb(dir: string): Promise<SqliteDb> {
  const { db } = await openDatabase(join(dir, 'data.sqlite'), join(process.cwd(), 'node_modules', 'sql.js', 'dist'))
  return db
}

describe('MCP-01 进程级:--mcp 模式与相同审批边界', () => {
  it(
    'initialize→list→读工具;非法 JSON;未批准写提案与伪造批准;EOF 干净退出;磁盘校验',
    async () => {
      const dir = makeUserDataDir()
      const clients: StdioMcp[] = []
      const mcp = await spawnMcp(dir, clients)
      try {
        // 协议握手
        const initRes = await mcp.request('initialize')
        expect(initRes.error).toBeUndefined()
        expect(initRes.result).toMatchObject({
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'personal-ops-mcp' }
        })
        mcp.notify('notifications/initialized')

        // tools/list:只暴露四个受控工具
        const listRes = await mcp.request('tools/list')
        const tools = (listRes.result as { tools: Array<{ name: string }> }).tools
        expect(tools.map((t) => t.name)).toEqual([
          'list_todos',
          'create_todo',
          'list_calendar_events',
          'create_calendar_event'
        ])

        // 读工具经网关执行:合法 JSON-RPC 结果
        const readRes = await mcp.request('tools/call', { name: 'list_todos', arguments: {} })
        expect(readRes.error).toBeUndefined()
        expect(toolText(readRes).isError).toBe(false)
        const readData = JSON.parse(toolText(readRes).content[0]!.text) as { todos: unknown[] }
        expect(Array.isArray(readData.todos)).toBe(true)

        // 重复请求:同一只读工具再次调用,仍返回合法结果
        const readRes2 = await mcp.request('tools/call', { name: 'list_todos', arguments: {} })
        expect(readRes2.error).toBeUndefined()
        expect(toolText(readRes2).isError).toBe(false)

        // 非法 JSON 行:-32700 解析错误,id=null
        const parseErr = await mcp.sendAndExpect('{这条不是 JSON')
        expect(parseErr.error?.code).toBe(-32700)
        expect(parseErr.id).toBeNull()

        // 未批准写提案:返回 approvalId,业务写入零发生
        const propRes = await mcp.request('tools/call', { name: 'create_todo', arguments: { title: 'MCP 启动测试待办' } })
        expect(toolText(propRes).isError).toBe(false)
        const proposal = JSON.parse(toolText(propRes).content[0]!.text) as {
          runId: string
          approvalId: string
          confirmationId: string
          status: string
        }
        expect(proposal.status).toBe('awaiting_confirmation')
        expect(proposal.approvalId).toBeTruthy()
        expect(proposal.confirmationId).toBe(proposal.approvalId)

        // 伪造批准:approved 任意值都拒绝(true / false)
        const forgeTrue = await mcp.request('tools/call', {
          name: 'create_todo',
          arguments: { title: '越权创建A', approved: true }
        })
        expect(toolForgeRejected(forgeTrue))
        const forgeFalse = await mcp.request('tools/call', {
          name: 'create_todo',
          arguments: { title: '越权创建B', approved: false }
        })
        expect(toolForgeRejected(forgeFalse))

        // EOF:关闭 stdin 后进程以退出码 0 干净退出
        const exitCode = await mcp.closeStdinAndExit()
        expect(exitCode).toBe(0)

        expect(mcp.stdoutNoise).toEqual([])
        // stderr 只允许日志,不允许任何 JSON-RPC 响应
        for (const line of mcp.stderrLines) {
          let parsed: unknown = null
          try {
            parsed = JSON.parse(line)
          } catch {
            // 日志行,忽略
          }
          const isResponse =
            parsed !== null &&
            typeof parsed === 'object' &&
            (parsed as JsonRpcResponse).jsonrpc === '2.0' &&
            ('result' in (parsed as object) || 'error' in (parsed as object))
          expect(isResponse).toBe(false)
        }

        // 磁盘校验:approvals 恰一条 pending;伪造调用未建审批;业务写入零发生
        const db = await openUserDataDb(dir)
        try {
          const approvals = db.all<{ approval_id: string; decision: string }>(
            'SELECT approval_id, decision FROM approvals ORDER BY approval_id'
          )
          expect(approvals).toHaveLength(1)
          expect(approvals[0]).toMatchObject({ approval_id: proposal.approvalId, decision: 'pending' })

          const forged = db.all<Pick<TodoRow, 'id'>>("SELECT id FROM todos WHERE title LIKE '越权创建%'")
          expect(forged).toHaveLength(0)
          const proposed = db.all<Pick<TodoRow, 'id'>>("SELECT id FROM todos WHERE title = 'MCP 启动测试待办'")
          expect(proposed).toHaveLength(0)

          // 提案运行停在 awaiting_confirmation;读调用运行 succeeded(与桌面端同一状态语义)
          const propRun = db.get<{ status: string }>('SELECT status FROM agent_runs WHERE run_id = ?', [proposal.runId])
          expect(propRun?.status).toBe('awaiting_confirmation')
          const readRuns = db.all<{ status: string }>("SELECT status FROM agent_runs WHERE input LIKE '(MCP 读取)%'")
          expect(readRuns.length).toBeGreaterThanOrEqual(1)
          expect(readRuns.every((r) => r.status === 'succeeded')).toBe(true)

          // 读工具观测轨迹经网关落库(tool_call,内部工具名)
          const trace = db.all<{ event_type: string; payload: string }>(
            "SELECT event_type, payload FROM trace_events WHERE event_type = 'tool_call'"
          )
          expect(trace.length).toBeGreaterThanOrEqual(1)
          expect(trace.some((t) => t.payload.includes('todo.list'))).toBe(true)
        } finally {
          db.close()
        }
      } finally {
        await shutdown(clients, dir)
      }
    },
    180000
  )

  it(
    '退出重开:同一 userData 重启后提案仍在、服务继续可用',
    async () => {
      const dir = makeUserDataDir()
      const clients: StdioMcp[] = []
      try {
        // 第一会话:创建提案后 EOF 退出
        let approvalId = ''
        {
          const mcp = await spawnMcp(dir, clients)
          const propRes = await mcp.request('tools/call', {
            name: 'create_todo',
            arguments: { title: '重启存活提案' }
          })
          approvalId = (JSON.parse(toolText(propRes).content[0]!.text) as { approvalId: string }).approvalId
          expect(approvalId).toBeTruthy()
          expect(await mcp.closeStdinAndExit()).toBe(0)
        }
        // 磁盘确认:提案 pending
        {
          const db = await openUserDataDb(dir)
          try {
            const row = db.get<{ decision: string }>('SELECT decision FROM approvals WHERE approval_id = ?', [approvalId])
            expect(row?.decision).toBe('pending')
          } finally {
            db.close()
          }
        }
        // 第二会话:重启同一 userData,服务可用,数据未丢
        {
          const mcp = await spawnMcp(dir, clients)
          const initRes = await mcp.request('initialize')
          expect(initRes.result).toMatchObject({ protocolVersion: '2024-11-05' })
          const readRes = await mcp.request('tools/call', { name: 'list_todos', arguments: {} })
          expect(toolText(readRes).isError).toBe(false)
          expect(await mcp.closeStdinAndExit()).toBe(0)
          const db = await openUserDataDb(dir)
          try {
            const row = db.get<{ decision: string }>('SELECT decision FROM approvals WHERE approval_id = ?', [approvalId])
            expect(row?.decision).toBe('pending')
            // 桌面端批准入口按同一 approvalId 决定;MCP 侧不提供批准通道
            const decisions = db.all<{ decision: string }>('SELECT decision FROM approvals')
            expect(decisions.every((d) => d.decision === 'pending')).toBe(true)
          } finally {
            db.close()
          }
        }
      } finally {
        await shutdown(clients, dir)
      }
    },
    180000
  )
})

/** 伪造批准响应的断言:工具级错误结果,不含提案信息 */
function toolForgeRejected(res: JsonRpcResponse): boolean {
  const body = toolText(res)
  return body.isError === true && body.content[0]!.text.includes('approved')
}

interface TodoRow {
  id: string
}
