import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentEventStream } from '../../src/main/agent/eventStream'
import { Channels } from '../../src/shared/api'
import type { AgentRunView, TraceEvent } from '../../src/shared/agent'

// C-03:Agent 运行事件广播。核心契约:
// 1. updated 先于 finished;终态时两次都发,非终态只发 updated;
// 2. 发送失败只告警不上抛——运行状态已落库,UI 故障不能杀死运行。

function runView(status: AgentRunView['status']): AgentRunView {
  return {
    runId: 'run-1',
    mode: 'personal_ops',
    status,
    input: '整理任务',
    timezone: 'Asia/Shanghai',
    contextClock: '2026-09-28T01:00:00.000Z',
    configVersion: '',
    budgetJson: '{}',
    resultRef: null,
    errorCode: null,
    startedAt: '2026-09-28T01:00:00.000Z',
    finishedAt: null
  }
}

function traceEvent(seq: number): TraceEvent {
  return {
    runId: 'run-1',
    seq,
    eventType: 'plan',
    schemaVersion: 1,
    payload: {},
    durationMs: null,
    tokenUsage: null,
    createdAt: '2026-09-28T01:00:00.000Z'
  }
}

describe('AgentEventStream 事件顺序', () => {
  it('非终态只发 updated,载荷为 { run, event }', () => {
    const sent: Array<{ channel: string; payload: unknown }> = []
    const stream = new AgentEventStream({ send: (channel, payload) => sent.push({ channel, payload }) })
    const run = runView('executing')
    const event = traceEvent(1)

    stream.emit(event, run)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.channel).toBe(Channels.EventAgentRunUpdated)
    expect(sent[0]!.payload).toEqual({ run, event })
  })

  it('终态时先 updated 后 finished,finished 载荷为 { run }', () => {
    const sent: Array<{ channel: string; payload: unknown }> = []
    const stream = new AgentEventStream({ send: (channel, payload) => sent.push({ channel, payload }) })
    const run = runView('succeeded')
    const event = traceEvent(2)

    stream.emit(event, run)

    expect(sent.map((s) => s.channel)).toEqual([
      Channels.EventAgentRunUpdated,
      Channels.EventAgentRunFinished
    ])
    expect(sent[1]!.payload).toEqual({ run })
  })

  it('四种终态都发 finished', () => {
    for (const status of ['succeeded', 'partial', 'failed', 'cancelled'] as const) {
      const sent: string[] = []
      const stream = new AgentEventStream({ send: (channel) => sent.push(channel) })
      stream.emit(traceEvent(1), runView(status))
      expect(sent).toContain(Channels.EventAgentRunFinished)
    }
  })

  it('等待人工的状态不是终态,不发 finished', () => {
    for (const status of ['awaiting_input', 'awaiting_confirmation'] as const) {
      const sent: string[] = []
      const stream = new AgentEventStream({ send: (channel) => sent.push(channel) })
      stream.emit(traceEvent(1), runView(status))
      expect(sent).not.toContain(Channels.EventAgentRunFinished)
    }
  })
})

describe('AgentEventStream 容错', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sender 抛错被吞掉并告警,emit 不上抛', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stream = new AgentEventStream({
      send: () => {
        throw new Error('窗口已销毁')
      }
    })

    expect(() => stream.emit(traceEvent(1), runView('executing'))).not.toThrow()
    expect(warn).toHaveBeenCalled()
  })

  it('updated 成功而 finished 抛错时,错误同样被吞掉', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const stream = new AgentEventStream({
      send: () => {
        calls += 1
        if (calls === 2) throw new Error('second send failed')
      }
    })

    expect(() => stream.emit(traceEvent(1), runView('succeeded'))).not.toThrow()
    expect(warn).toHaveBeenCalled()
  })
})
