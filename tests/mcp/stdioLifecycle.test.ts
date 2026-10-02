import { expect, it, vi } from 'vitest'
import { makeTestDb } from '../helpers'
import { startPersonalOpsMcpStdio } from '../../src/main/mcp/server'
import { ToolRegistry } from '../../src/main/tools/registry'
import { ToolGateway } from '../../src/main/tools/gateway'
import { fixedClock } from '../../src/shared/clock'

it.each(['normal', 'save', 'read', 'drain'] as const)('stdio %s 收尾恰好一次，失败退出 1', async fault => {
  const db = await makeTestDb()
  const registry = new ToolRegistry()
  const gateway = new ToolGateway({ db, registry, clock: fixedClock('2026-09-30T01:00:00Z') })
  if (fault === 'save') vi.spyOn(db, 'flush').mockImplementation(() => { throw new Error('flush fault') })
  const readLine = vi.fn(async () => { if (fault === 'read') throw new Error('input fault'); return null })
  const fallbackReadLine = vi.fn(async () => null)
  const drain = vi.fn(async () => { if (fault === 'drain') throw new Error('drain fault') })
  const onClose = vi.fn()
  startPersonalOpsMcpStdio({ db, registry, gateway }, { readLine, fallbackReadLine, writeLine: vi.fn(), drain, onClose })
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(fault === 'normal' ? 0 : 1))
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(readLine).toHaveBeenCalledTimes(1)
})

it('正常会话 EOF 不重新打开 fd0，解析错误返回严格 JSON-RPC', async () => {
  const db = await makeTestDb()
  const registry = new ToolRegistry()
  const gateway = new ToolGateway({ db, registry, clock: fixedClock('2026-09-30T01:00:00Z') })
  const lines: Array<string | null> = ['{invalid', '{"jsonrpc":"2.0","id":2,"method":"unknown"}', null]
  const fallbackReadLine = vi.fn(async () => null)
  const writeLine = vi.fn()
  const onClose = vi.fn()
  startPersonalOpsMcpStdio({ db, registry, gateway }, { readLine: async () => lines.shift()!, fallbackReadLine, writeLine, drain: async () => {}, onClose })
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(0))
  expect(fallbackReadLine).not.toHaveBeenCalled()
  expect(writeLine.mock.calls.map(args => JSON.parse(args[0]))).toEqual([
    { jsonrpc: '2.0', id: null, error: { code: -32700, message: '解析错误' } },
    { jsonrpc: '2.0', id: 2, error: { code: -32601, message: '未知方法:unknown' } }
  ])
})
