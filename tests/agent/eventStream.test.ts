import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentEventStream } from '../../src/main/agent/eventStream'
import { Channels } from '../../src/shared/api'
import type { AgentRunView, TraceEvent } from '../../src/shared/agent'

// C-03:Agent 运行事件广播。核心契约:
// 1. updated 先于 finished;终态时两次都发,非终态只发 updated;
// 2. 发送失败只告警不上抛——运行状态已落库,UI 故障不能杀死运行。
// OPS-04:状态转移先于广播(事件快照是转移后的状态)与 acceptAnswers 服务端校验,
// 用真实 AgentEventStream + 编排器驱动,断言广播时刻的运行快照与库内状态一致。

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

// ---------- OPS-04:状态转移先于广播 + acceptAnswers 服务端校验 ----------

import { appendTraceEvent, createRun, getRun, listTraceEvents } from '../../src/main/runs/repository'
import { RunOrchestrator } from '../../src/main/agent/orchestrator'
import { FakeProvider } from '../../src/main/providers/fake'
import { ToolGateway } from '../../src/main/tools/gateway'
import { ToolRegistry } from '../../src/main/tools/registry'
import { registerOpsTools } from '../../src/main/tools/definitions'
import { systemClock } from '../../src/shared/clock'
import { RunQueue } from '../../src/main/agent/runQueue'
import { createPersistenceCoordinator, initWorkspaceEpoch } from '../../src/main/db/operations'
import { makeTestDb } from '../helpers'
import type { StructuredCompleteRequest } from '../../src/main/agent/llm'
import type { SqliteDb } from '../../src/main/db/connection'

const NOW = '2026-09-28T01:00:00.000Z'

interface OpsHarness {
  db: SqliteDb
  orchestrator: RunOrchestrator
  /** 真实 AgentEventStream 广播序列 */
  sent: Array<{ channel: string; payload: unknown }>
}

/** 带真实事件广播的编排器测试台:断言广播时刻的运行快照 */
async function makeOpsHarness(
  script: (callIndex: number, request: StructuredCompleteRequest) => unknown
): Promise<OpsHarness> {
  const db = await makeTestDb()
  initWorkspaceEpoch()
  const registry = new ToolRegistry()
  registerOpsTools(registry)
  const gateway = new ToolGateway({
    db,
    registry,
    clock: systemClock,
    persistCoordinator: createPersistenceCoordinator(db),
    // 与 orchestrator.test.ts 的生产组合同构:观察先落库(此处测试不广播工具观察)
    onObservation: (r) =>
      appendTraceEvent(db, { runId: r.runId, eventType: 'tool_call', payload: { ...r }, durationMs: r.durationMs })
  })
  const queue = new RunQueue(db)
  const sent: Array<{ channel: string; payload: unknown }> = []
  const events = new AgentEventStream({ send: (channel, payload) => sent.push({ channel, payload }) })
  const provider = new FakeProvider({ script })
  const orchestrator = new RunOrchestrator({ db, registry, gateway, queue, completer: provider, events })
  return { db, orchestrator, sent }
}

function planOf(steps: unknown[], over: Record<string, unknown> = {}): unknown {
  return { goal: '测试目标', steps, assumptions: [], ...over }
}

function updatedPayload(payload: unknown): { run: AgentRunView; event: TraceEvent } {
  return payload as { run: AgentRunView; event: TraceEvent }
}

/** 驱动一个进入 awaiting_input 的澄清运行 */
async function makeClarificationRun(h: OpsHarness, input = '安排任务'): Promise<string> {
  const run = createRun(h.db, { mode: 'personal_ops', input, contextClock: NOW })
  await h.orchestrator.drivePlanning(run.runId)
  expect(getRun(h.db, run.runId)?.status).toBe('awaiting_input')
  return run.runId
}

describe('OPS-04 状态转移先于广播', () => {
  it('awaiting_input:input 问题事件广播时,快照已是转移后的状态', async () => {
    const h = await makeOpsHarness(() =>
      planOf([], { clarifications: [{ question_id: 'q-when', question: '哪天?' }] })
    )
    const runId = await makeClarificationRun(h)
    const inputBroadcast = h.sent
      .filter((s) => s.channel === Channels.EventAgentRunUpdated)
      .map((s) => updatedPayload(s.payload))
      .filter((p) => p.event.eventType === 'input')
    expect(inputBroadcast).toHaveLength(1)
    expect(inputBroadcast[0]!.event.payload).toHaveProperty('questions')
    expect(inputBroadcast[0]!.run.status).toBe('awaiting_input')
  })

  it('awaiting_confirmation:确认卡事件广播时全部审批行已写入且状态已转移', async () => {
    const h = await makeOpsHarness((callIndex) => {
      if (callIndex === 0) {
        return planOf([{ tool: 'todo.list', arguments: {} }], { continue_after_read: true })
      }
      return planOf([
        { tool: 'todo.create', arguments: { title: '提案A' } },
        { tool: 'todo.create', arguments: { title: '提案B' } }
      ])
    })
    const run = createRun(h.db, { mode: 'personal_ops', input: '两条提案', contextClock: NOW })
    await h.orchestrator.drivePlanning(run.runId)
    expect(getRun(h.db, run.runId)?.status).toBe('awaiting_confirmation')
    expect(h.db.all('SELECT * FROM approvals')).toHaveLength(2)

    const confirmationBroadcasts = h.sent
      .filter((s) => s.channel === Channels.EventAgentRunUpdated)
      .map((s) => updatedPayload(s.payload))
      .filter((p) => p.event.eventType === 'confirmation')
    expect(confirmationBroadcasts).toHaveLength(2)
    for (const broadcast of confirmationBroadcasts) {
      // 禁止先广播 planning 状态的确认卡事件:快照必须是转移后的 awaiting_confirmation
      expect(broadcast.run.status).toBe('awaiting_confirmation')
    }
  })

  it('acceptAnswers:答案事件广播时运行已是 queued(轨迹先落库,转移后广播)', async () => {
    const h = await makeOpsHarness((callIndex) =>
      callIndex === 0
        ? planOf([], { clarifications: [{ question_id: 'q-when', question: '哪天?' }] })
        : planOf([{ tool: 'todo.list', arguments: {} }])
    )
    const runId = await makeClarificationRun(h)
    h.orchestrator.acceptAnswers(runId, [{ questionId: 'q-when', answer: '9月30日上午9点' }])
    // 接受即 queued(同步),答案事件快照是转移后的状态
    expect(getRun(h.db, runId)?.status).toBe('queued')
    const answerBroadcast = h.sent
      .filter((s) => s.channel === Channels.EventAgentRunUpdated)
      .map((s) => updatedPayload(s.payload))
      .filter((p) => p.event.eventType === 'input' && (p.event.payload as { answers?: unknown }).answers)
    expect(answerBroadcast).toHaveLength(1)
    expect(answerBroadcast[0]!.run.status).toBe('queued')
    expect(answerBroadcast[0]!.event.payload).toMatchObject({
      answers: [{ questionId: 'q-when', answer: '9月30日上午9点' }]
    })
  })
})

describe('OPS-04 acceptAnswers 服务端校验', () => {
  async function seedRun(): Promise<{ h: OpsHarness; runId: string }> {
    const h = await makeOpsHarness(() =>
      planOf([], { clarifications: [{ question_id: 'q-when', question: '哪天?' }] })
    )
    const runId = await makeClarificationRun(h)
    return { h, runId }
  }

  /** 拒绝后零写入:无答案轨迹、状态保持等待输入 */
  function expectRejected(
    h: OpsHarness,
    runId: string,
    fn: () => unknown,
    message: RegExp
  ): void {
    expect(fn).toThrow(message)
    expect(getRun(h.db, runId)?.status).toBe('awaiting_input')
    const answerEvents = listTraceEvents(h.db, runId).filter(
      (e) => e.eventType === 'input' && (e.payload as { answers?: unknown }).answers
    )
    expect(answerEvents).toHaveLength(0)
  }

  it('未知 questionId 拒绝', async () => {
    const { h, runId } = await seedRun()
    expectRejected(
      h,
      runId,
      () => h.orchestrator.acceptAnswers(runId, [{ questionId: 'q-unknown', answer: '答案' }]),
      /未知的问题 ID/
    )
  })

  it('重复 questionId 拒绝', async () => {
    const { h, runId } = await seedRun()
    expectRejected(
      h,
      runId,
      () =>
        h.orchestrator.acceptAnswers(runId, [
          { questionId: 'q-when', answer: 'a' },
          { questionId: 'q-when', answer: 'b' }
        ]),
      /重复的问题 ID/
    )
  })

  it('缺少必答问题拒绝:两个必答只答一个被拒,全部回答通过', async () => {
    const h = await makeOpsHarness((callIndex) =>
      callIndex === 0
        ? planOf([], {
            clarifications: [
              { question_id: 'q-when', question: '哪天?' },
              { question_id: 'q-title', question: '标题?' }
            ]
          })
        : planOf([{ tool: 'todo.list', arguments: {} }])
    )
    const runId = await makeClarificationRun(h)
    expectRejected(
      h,
      runId,
      () => h.orchestrator.acceptAnswers(runId, [{ questionId: 'q-when', answer: '周五' }]),
      /缺少必答问题/
    )
    h.orchestrator.acceptAnswers(runId, [
      { questionId: 'q-when', answer: '周五' },
      { questionId: 'q-title', answer: '整理' }
    ])
    expect(getRun(h.db, runId)?.status).toBe('queued')
  })

  it('纯空白回答拒绝', async () => {
    const { h, runId } = await seedRun()
    expectRejected(
      h,
      runId,
      () => h.orchestrator.acceptAnswers(runId, [{ questionId: 'q-when', answer: '   ' }]),
      /不能为空白/
    )
  })

  it('超过 1000 码点拒绝;恰好 1000 码点接受', async () => {
    const { h, runId } = await seedRun()
    expectRejected(
      h,
      runId,
      () => h.orchestrator.acceptAnswers(runId, [{ questionId: 'q-when', answer: '好'.repeat(1001) }]),
      /1000/
    )
    h.orchestrator.acceptAnswers(runId, [{ questionId: 'q-when', answer: '好'.repeat(1000) }])
    expect(getRun(h.db, runId)?.status).toBe('queued')
  })
})
