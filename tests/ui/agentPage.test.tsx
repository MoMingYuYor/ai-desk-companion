// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { AgentPage } from '../../src/renderer/workbench/pages/AgentPage'
import type { AgentApprovalView, AgentRunView, TraceEvent } from '../../src/shared/api'
import type { RunStatus } from '../../src/shared/agent'

// A-06:AgentPage 组件测试。
// 页面挂载即自动打开最近一条运行;事件按 runId 过滤、按 seq 去重合并;
// partial 不伪装成功;过期提案禁止批准;空输入禁止提交。
// OPS-04:真实澄清输入(label+textarea+提交回答)与八种刷新竞态场景回归。

afterEach(cleanup)

const RUN_BASE = {
  mode: 'personal_ops' as const,
  input: '整理任务',
  timezone: 'Asia/Shanghai',
  contextClock: '2026-09-28T01:00:00.000Z',
  configVersion: '',
  budgetJson: '{}',
  resultRef: null
}

function runView(over: Partial<AgentRunView> = {}): AgentRunView {
  return {
    runId: 'run-1',
    status: 'executing',
    errorCode: null,
    startedAt: '2026-09-28T01:00:00.000Z',
    finishedAt: null,
    ...RUN_BASE,
    ...over
  }
}

function traceEvent(
  seq: number,
  eventType: TraceEvent['eventType'],
  payload: Record<string, unknown> = {},
  runId = 'run-1'
): TraceEvent {
  return {
    runId,
    seq,
    eventType,
    schemaVersion: 1,
    payload,
    durationMs: null,
    tokenUsage: null,
    createdAt: '2026-09-28T01:00:00.000Z'
  }
}

function approval(over: Partial<AgentApprovalView> = {}): AgentApprovalView {
  return {
    approvalId: 'ap-1',
    runId: 'run-1',
    toolName: 'todo.create',
    argumentsHash: 'h',
    arguments: { title: '新任务' },
    planVersion: 1,
    targetVersion: null,
    expiresAt: '2999-01-01T00:00:00.000Z',
    decision: 'pending',
    decidedAt: null,
    ...over
  }
}

/** 显式控制 IPC 返回顺序，避免用真实网络或 sleep 制造竞态。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type Listener = (...args: unknown[]) => void

interface Harness {
  decide: ReturnType<typeof vi.fn>
  create: (input: unknown) => Promise<unknown>
  listeners: Map<string, Listener[]>
  emit: (channel: string, ...args: unknown[]) => void
}

function installApi(
  over: {
    run?: AgentRunView
    approvals?: AgentApprovalView[]
    events?: TraceEvent[]
    create?: (input: unknown) => Promise<unknown>
  } = {}
): Harness {
  const run = over.run ?? runView()
  const listeners = new Map<string, Listener[]>()
  const decide = vi.fn(async () => ({ already: false }))
  const create = over.create ?? vi.fn(async () => ({ runId: run.runId, status: 'queued' }))
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    createAgentRun: create,
    getAgentRun: vi.fn(async () => run),
    listAgentRuns: vi.fn(async () => [
      {
        runId: run.runId,
        mode: run.mode,
        status: run.status,
        input: run.input,
        errorCode: null,
        startedAt: run.startedAt,
        finishedAt: null
      }
    ]),
    getAgentRunEvents: vi.fn(async () => ({ run, events: over.events ?? [] })),
    getAgentRunApprovals: vi.fn(async () => over.approvals ?? []),
    submitAgentAnswers: vi.fn(async () => ({ runId: run.runId, status: 'queued' })),
    cancelAgentRun: vi.fn(async () => run),
    decideAgentApproval: decide,
    on: vi.fn((channel: string, listener: Listener) => {
      const list = listeners.get(channel) ?? []
      list.push(listener)
      listeners.set(channel, list)
      return () => {
        listeners.set(channel, (listeners.get(channel) ?? []).filter((l) => l !== listener))
      }
    })
  }
  return {
    decide,
    create,
    listeners,
    emit: (channel, ...args) => {
      for (const l of listeners.get(channel) ?? []) l(...args)
    }
  }
}

describe('AgentPage 输入区', () => {
  it('空输入禁止提交;纯空白同样禁止', async () => {
    installApi({ run: runView(), events: [] })
    render(<AgentPage refreshKey={0} />)
    await screen.findByTestId('agent-run')
    // 挂载自动打开历史运行后,输入框仍为空:禁止提交
    const submit = screen.getByTestId('agent-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('agent-input'), { target: { value: '   ' } })
    expect(submit.disabled).toBe(true)
  })

  it('提交中防重:进行中的提交不产生第二次创建', async () => {
    let resolveCreate: (v: unknown) => void = () => {}
    const create = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        })
    )
    installApi({ create, run: runView({ runId: 'run-2' }) })
    vi.mocked(window.api.listAgentRuns).mockResolvedValue([])
    render(<AgentPage refreshKey={0} />)
    // 历史为空:无自动打开,手动输入并提交
    fireEvent.change(screen.getByTestId('agent-input'), { target: { value: '整理任务' } })
    fireEvent.click(screen.getByTestId('agent-submit'))
    // 提交进行中再点击:不重复创建
    fireEvent.click(screen.getByTestId('agent-submit'))
    expect(create).toHaveBeenCalledTimes(1)
    resolveCreate({ runId: 'run-2', status: 'queued' })
    await waitFor(() => expect(screen.getByTestId('agent-run')).toBeTruthy())
    // 完成后输入已清空:按钮回到空输入禁用态
    expect((screen.getByTestId('agent-submit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('agent-input'), { target: { value: '新任务' } })
    expect((screen.getByTestId('agent-submit') as HTMLButtonElement).disabled).toBe(false)
  })

  it('提交失败展示错误', async () => {
    installApi({ create: vi.fn(async () => { throw new Error('模型未配置') }) })
    render(<AgentPage refreshKey={0} />)
    // 等自动打开最近运行完成,避免与挂载链竞态清空错误态
    await screen.findByTestId('agent-run')
    fireEvent.change(screen.getByTestId('agent-input'), { target: { value: '整理任务' } })
    fireEvent.click(screen.getByTestId('agent-submit'))
    await waitFor(() => expect(screen.getByTestId('agent-error').textContent).toContain('模型未配置'))
  })
})

describe('AgentPage 确认流程', () => {
  it('awaiting_confirmation 且有待批提案:渲染确认卡并可批准', async () => {
    const h = installApi({
      run: runView({ status: 'awaiting_confirmation' }),
      approvals: [approval()]
    })
    render(<AgentPage refreshKey={0} />)
    const card = await screen.findByTestId('agent-confirm-card')
    expect(card.textContent).toContain('todo.create')
    expect(card.textContent).toContain('新任务')

    fireEvent.click(screen.getByText('批准执行'))
    await waitFor(() => expect(h.decide).toHaveBeenCalledWith('ap-1', 'approved'))
  })

  it('过期提案禁止批准', async () => {
    installApi({
      run: runView({ status: 'awaiting_confirmation' }),
      approvals: [approval({ expiresAt: '2000-01-01T00:00:00.000Z' })]
    })
    render(<AgentPage refreshKey={0} />)
    const card = await screen.findByTestId('agent-confirm-card')
    expect(card.textContent).toContain('已过期')
    expect((screen.getByText('批准执行') as HTMLButtonElement).disabled).toBe(true)
  })

  it('拒绝调用 decide rejected', async () => {
    const h = installApi({
      run: runView({ status: 'awaiting_confirmation' }),
      approvals: [approval()]
    })
    render(<AgentPage refreshKey={0} />)
    await screen.findByTestId('agent-confirm-card')
    fireEvent.click(screen.getByText('拒绝'))
    await waitFor(() => expect(h.decide).toHaveBeenCalledWith('ap-1', 'rejected'))
  })
})

describe('AgentPage 事件流', () => {
  it('updated 事件按 runId 过滤并按 seq 去重合并', async () => {
    const h = installApi({ run: runView(), events: [] })
    render(<AgentPage refreshKey={0} />)
    // 等自动打开完成(runIdRef 已设置),再发事件
    await screen.findByTestId('agent-run')
    await waitFor(() => expect(h.listeners.has('evt:agent-run-updated')).toBe(true))

    await act(async () => {
      h.emit('evt:agent-run-updated', { run: runView(), event: traceEvent(1, 'plan', { goal: '目标G' }) })
      h.emit('evt:agent-run-updated', { run: runView(), event: traceEvent(2, 'tool_call', { tool: 'todo.list', ok: true }) })
      // 重复 seq:去重
      h.emit('evt:agent-run-updated', { run: runView(), event: traceEvent(2, 'tool_call', { tool: 'todo.list', ok: true }) })
      // 其他运行:忽略
      h.emit('evt:agent-run-updated', { run: { ...runView(), runId: 'other' }, event: traceEvent(9, 'plan', {}) })
    })

    const timeline = await screen.findByTestId('agent-timeline')
    await waitFor(() => expect(timeline.textContent).toContain('#2'))
    expect(timeline.textContent).toContain('目标G')
    expect(timeline.textContent).not.toContain('#9')
  })

  it('补发请求携带最后 seq(断线重连不重复)', async () => {
    installApi({
      run: runView(),
      events: [traceEvent(1, 'plan', { goal: 'g' }), traceEvent(2, 'tool_call', { tool: 't', ok: true })]
    })
    render(<AgentPage refreshKey={0} />)
    await waitFor(() => expect(screen.getByTestId('agent-timeline').textContent).toContain('#2'))
    // 首次补发从 0 开始取全部
    expect(window.api.getAgentRunEvents).toHaveBeenCalledWith('run-1', 0)
  })

  it('finished 事件刷新运行终态', async () => {
    // getAgentRun 与事件载荷一致:finished 后刷新取回的是终态
    const h = installApi({ run: runView({ status: 'succeeded' }), events: [] })
    render(<AgentPage refreshKey={0} />)
    await screen.findByTestId('agent-run')
    await waitFor(() => expect(h.listeners.has('evt:agent-run-finished')).toBe(true))
    await act(async () => h.emit('evt:agent-run-finished', { run: runView({ status: 'succeeded' }) }))
    await waitFor(() => expect(screen.getByTestId('agent-run-status').textContent).toBe('已完成'))
  })
})

describe('AgentPage 结果与澄清', () => {
  it('partial 展示部分完成提示,不伪装成功', async () => {
    installApi({
      run: runView({ status: 'partial' }),
      events: [traceEvent(1, 'tool_call', { tool: 'todo.create', ok: true })]
    })
    render(<AgentPage refreshKey={0} />)
    const banner = await screen.findByTestId('agent-result-failure')
    expect(banner.textContent).toContain('部分步骤失败')
  })

  it('failed 展示错误码', async () => {
    installApi({
      run: runView({ status: 'failed', errorCode: 'MODEL_OUTPUT_INVALID' }),
      events: [traceEvent(1, 'error', { code: 'MODEL_OUTPUT_INVALID', message: '计划不可解析' })]
    })
    render(<AgentPage refreshKey={0} />)
    const banner = await screen.findByTestId('agent-result-failure')
    expect(banner.textContent).toContain('MODEL_OUTPUT_INVALID')
  })

  it('awaiting_input 展示澄清问题:旧固定回答按钮已由受控输入取代', async () => {
    installApi({
      run: runView({ status: 'awaiting_input' }),
      events: [traceEvent(1, 'input', { questions: [{ questionId: 'q-when', question: '安排到哪天?' }] })]
    })
    render(<AgentPage refreshKey={0} />)
    await screen.findByText('安排到哪天?')
    // 固定文本按钮已删除,不再出现
    expect(screen.queryByText('按建议继续')).toBeNull()
  })
})

describe('AgentPage 真实澄清输入(OPS-04)', () => {
  const questionEvent = traceEvent(1, 'input', {
    questions: [{ questionId: 'q-when', question: '安排到哪天?' }]
  })

  function installAwaitingInput(events: TraceEvent[]): void {
    installApi({ run: runView({ status: 'awaiting_input' }), events })
  }

  it('label+textarea 输入真实文本,提交回答携带原文', async () => {
    installAwaitingInput([questionEvent])
    render(<AgentPage refreshKey={0} />)
    fireEvent.change(await screen.findByLabelText('安排到哪天?'), { target: { value: '2026-10-02 09:30' } })
    fireEvent.click(screen.getByText('提交回答'))
    await waitFor(() =>
      expect(window.api.submitAgentAnswers).toHaveBeenCalledWith('run-1', [
        { questionId: 'q-when', answer: '2026-10-02 09:30' }
      ])
    )
  })

  it('多问题一并提交:一次点击携带全部当前问题的回答', async () => {
    installAwaitingInput([
      traceEvent(1, 'input', {
        questions: [
          { questionId: 'q-when', question: '安排到哪天?' },
          { questionId: 'q-title', question: '标题叫什么?' }
        ]
      })
    ])
    render(<AgentPage refreshKey={0} />)
    fireEvent.change(await screen.findByLabelText('安排到哪天?'), { target: { value: '10月2日' } })
    fireEvent.change(screen.getByLabelText('标题叫什么?'), { target: { value: '项目整理' } })
    fireEvent.click(screen.getByText('提交回答'))
    await waitFor(() =>
      expect(window.api.submitAgentAnswers).toHaveBeenCalledWith('run-1', [
        { questionId: 'q-when', answer: '10月2日' },
        { questionId: 'q-title', answer: '项目整理' }
      ])
    )
    expect(window.api.submitAgentAnswers).toHaveBeenCalledTimes(1)
  })

  it('纯空白回答禁用提交,填入有效文本后恢复', async () => {
    installAwaitingInput([questionEvent])
    render(<AgentPage refreshKey={0} />)
    await screen.findByLabelText('安排到哪天?')
    const submit = screen.getByText('提交回答') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('安排到哪天?'), { target: { value: '   ' } })
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('安排到哪天?'), { target: { value: '10月2日' } })
    expect(submit.disabled).toBe(false)
  })

  it('提交中防重:进行中的提交不产生第二次提交', async () => {
    installAwaitingInput([questionEvent])
    let resolveSubmit: (v: unknown) => void = () => {}
    ;(window.api.submitAgentAnswers as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve
        })
    )
    render(<AgentPage refreshKey={0} />)
    fireEvent.change(await screen.findByLabelText('安排到哪天?'), { target: { value: '10月2日' } })
    const submitBtn = () => screen.getByTestId('agent-answers-submit') as HTMLButtonElement
    fireEvent.click(submitBtn())
    // 提交中:按钮进入提交中态且防重,不产生第二次提交
    expect(submitBtn().textContent).toBe('提交中…')
    expect(submitBtn().disabled).toBe(true)
    fireEvent.click(submitBtn())
    expect(window.api.submitAgentAnswers).toHaveBeenCalledTimes(1)
    resolveSubmit({ runId: 'run-1', status: 'queued' })
    await waitFor(() => expect(submitBtn().textContent).toBe('提交回答'))
  })

  it('提交失败保留输入并展示错误', async () => {
    installAwaitingInput([questionEvent])
    ;(window.api.submitAgentAnswers as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('缺少必答问题:q-when')
    )
    render(<AgentPage refreshKey={0} />)
    fireEvent.change(await screen.findByLabelText('安排到哪天?'), { target: { value: '10月2日' } })
    fireEvent.click(screen.getByText('提交回答'))
    await waitFor(() => expect(screen.getByTestId('agent-error').textContent).toContain('缺少必答问题'))
    // 失败保留输入,便于修正后重试
    expect((screen.getByLabelText('安排到哪天?') as HTMLTextAreaElement).value).toBe('10月2日')
  })

  it('提交成功清空输入', async () => {
    installAwaitingInput([questionEvent])
    render(<AgentPage refreshKey={0} />)
    fireEvent.change(await screen.findByLabelText('安排到哪天?'), { target: { value: '10月2日' } })
    fireEvent.click(screen.getByText('提交回答'))
    await waitFor(() =>
      expect((screen.getByLabelText('安排到哪天?') as HTMLTextAreaElement).value).toBe('')
    )
  })

  it('运行切换重置回答表单,答案不泄漏到另一个 run', async () => {
    installApi({
      run: runView({ status: 'awaiting_input' }),
      events: [questionEvent],
      approvals: []
    })
    ;(window.api.listAgentRuns as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        runId: 'run-1',
        mode: 'personal_ops',
        status: 'awaiting_input',
        input: '第一个运行',
        errorCode: null,
        startedAt: '2026-09-28T01:00:00.000Z',
        finishedAt: null
      },
      {
        runId: 'run-2',
        mode: 'personal_ops',
        status: 'awaiting_input',
        input: '第二个运行',
        errorCode: null,
        startedAt: '2026-09-28T01:00:00.000Z',
        finishedAt: null
      }
    ])
    ;(window.api.getAgentRun as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) =>
      id === 'run-2'
        ? runView({ runId: 'run-2', input: '第二个运行', status: 'awaiting_input' })
        : runView({ status: 'awaiting_input' })
    )
    ;(window.api.getAgentRunEvents as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => ({
      run: null,
      events:
        id === 'run-2'
          ? [traceEvent(1, 'input', { questions: [{ questionId: 'q-other', question: '另一个问题?' }] }, 'run-2')]
          : [questionEvent]
    }))
    render(<AgentPage refreshKey={0} />)
    fireEvent.change(await screen.findByLabelText('安排到哪天?'), { target: { value: '属于 run-1 的答案' } })
    fireEvent.click(screen.getAllByTestId('agent-history-item')[1]!)
    // 切换运行后:run-2 的问题为空输入,run-1 的答案与问题卡不泄漏
    const other = await screen.findByLabelText('另一个问题?')
    expect((other as HTMLTextAreaElement).value).toBe('')
    expect(screen.queryByLabelText('安排到哪天?')).toBeNull()
  })

  it('回答输入上限 1000 码点:超出被截断,emoji 代理对按 1 码点计', async () => {
    installAwaitingInput([questionEvent])
    render(<AgentPage refreshKey={0} />)
    const field = (await screen.findByLabelText('安排到哪天?')) as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: '好'.repeat(1001) } })
    expect(field.value.length).toBe(1000)
    // 600 个 emoji = 600 码点(1200 UTF-16 单元):未超码点上限,不截断
    fireEvent.change(field, { target: { value: '😀'.repeat(600) } })
    expect(Array.from(field.value).length).toBe(600)
    expect(field.value.length).toBe(1200)
  })
})

describe('AgentPage 刷新竞态(OPS-04)', () => {
  it('创建回执前先到的快事件:由 openRun 全量补发恢复', async () => {
    let resolveCreate: (v: unknown) => void = () => {}
    const create = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        })
    )
    const h = installApi({
      create,
      run: runView({ runId: 'run-2', status: 'awaiting_input' }),
      events: [traceEvent(1, 'input', { questions: [{ questionId: 'q-when', question: '何时执行?' }] }, 'run-2')]
    })
    ;(window.api.listAgentRuns as ReturnType<typeof vi.fn>).mockResolvedValue([])
    render(<AgentPage refreshKey={0} />)
    await waitFor(() => expect(h.listeners.has('evt:agent-run-updated')).toBe(true))
    // 提交创建:Promise 挂起(回执未返回)
    fireEvent.change(screen.getByTestId('agent-input'), { target: { value: '整理任务' } })
    fireEvent.click(screen.getByTestId('agent-submit'))
    // 创建 Promise 未返回,新运行的事件先到:尚未打开该 run,不渲染
    act(() => {
      h.emit('evt:agent-run-updated', {
        run: runView({ runId: 'run-2', status: 'awaiting_input' }),
        event: traceEvent(1, 'input', { questions: [{ questionId: 'q-when', question: '何时执行?' }] }, 'run-2')
      })
    })
    expect(screen.queryByText('何时执行?')).toBeNull()
    resolveCreate({ runId: 'run-2', status: 'queued' })
    // 回执到达后 openRun 全量补发:问题卡恢复显示
    await screen.findByText('何时执行?')
  })

  it('创建回执返回后立即发事件:连续 seq 直接合并不重拉', async () => {
    const h = installApi({ run: runView(), events: [] })
    ;(window.api.listAgentRuns as ReturnType<typeof vi.fn>).mockResolvedValue([])
    render(<AgentPage refreshKey={0} />)
    fireEvent.change(screen.getByTestId('agent-input'), { target: { value: '整理任务' } })
    fireEvent.click(screen.getByTestId('agent-submit'))
    await screen.findByTestId('agent-run')
    await waitFor(() => expect(h.listeners.has('evt:agent-run-updated')).toBe(true))
    const callsBefore = (window.api.getAgentRunEvents as ReturnType<typeof vi.fn>).mock.calls.length
    act(() => {
      h.emit('evt:agent-run-updated', { run: runView(), event: traceEvent(1, 'plan', { goal: '目标G' }) })
    })
    await waitFor(() => expect(screen.getByTestId('agent-timeline').textContent).toContain('目标G'))
    expect((window.api.getAgentRunEvents as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore)
  })

  it('慢模型:等待期间展示真实状态,事件到达后无需切页即时刷新', async () => {
    const h = installApi({ run: runView({ status: 'planning' }), events: [], approvals: [approval()] })
    // 首次刷新(挂载)返回规划中;confirmation 后的合并刷新返回等待确认(服务端真实状态)
    const getRunMock = window.api.getAgentRun as ReturnType<typeof vi.fn>
    getRunMock.mockImplementation(async () =>
      getRunMock.mock.calls.length > 1 ? runView({ status: 'awaiting_confirmation' }) : runView({ status: 'planning' })
    )
    render(<AgentPage refreshKey={0} />)
    await screen.findByTestId('agent-run')
    expect(screen.getByTestId('agent-run-status').textContent).toBe('规划中')
    act(() => {
      h.emit('evt:agent-run-updated', {
        run: runView({ status: 'awaiting_confirmation' }),
        event: traceEvent(1, 'confirmation', { approvalId: 'ap-1' })
      })
    })
    // 等待卡无需切页即显示:confirmation 事件触发合并刷新拉取审批与最新状态
    await screen.findByTestId('agent-confirm-card')
    expect(screen.getByTestId('agent-run-status').textContent).toBe('等待确认')
  })

  it('刷新 A 晚于刷新 B 返回:过期响应不覆盖较新状态', async () => {
    let resolveFirst!: (v: AgentRunView) => void
    const h = installApi({ run: runView({ status: 'awaiting_confirmation' }), approvals: [approval()] })
    const getRunMock = vi.fn((id: string) => {
      if (getRunMock.mock.calls.length === 1) {
        return new Promise<AgentRunView>((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve(runView({ status: 'awaiting_confirmation' }))
    })
    ;(window.api.getAgentRun as ReturnType<typeof vi.fn>).mockImplementation(getRunMock)
    render(<AgentPage refreshKey={0} />)
    await waitFor(() => expect(h.listeners.has('evt:agent-run-updated')).toBe(true))
    // 第一次刷新(挂载)挂起期间,confirmation 事件触发第二次刷新:立即返回等待确认
    act(() => {
      h.emit('evt:agent-run-updated', {
        run: runView({ status: 'awaiting_confirmation' }),
        event: traceEvent(3, 'confirmation', { approvalId: 'ap-1' })
      })
    })
    await screen.findByTestId('agent-confirm-card')
    expect(screen.getByTestId('agent-run-status').textContent).toBe('等待确认')
    // 第一次刷新迟到的过期响应(规划中):不得覆盖
    act(() => {
      resolveFirst(runView({ status: 'planning' }))
    })
    await waitFor(() => expect(screen.getByTestId('agent-run-status').textContent).toBe('等待确认'))
    expect(screen.getByTestId('agent-confirm-card')).toBeTruthy()
  })

  it('切换 run-2 后 run-1 审批响应到达:不覆盖当前运行', async () => {
    let resolveRun1!: (v: AgentRunView) => void
    installApi({ run: runView({ runId: 'run-1', input: '第一个运行' }), approvals: [] })
    ;(window.api.listAgentRuns as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        runId: 'run-1',
        mode: 'personal_ops',
        status: 'awaiting_confirmation',
        input: '第一个运行',
        errorCode: null,
        startedAt: '2026-09-28T01:00:00.000Z',
        finishedAt: null
      },
      {
        runId: 'run-2',
        mode: 'personal_ops',
        status: 'executing',
        input: '第二个运行',
        errorCode: null,
        startedAt: '2026-09-28T01:00:00.000Z',
        finishedAt: null
      }
    ])
    ;(window.api.getAgentRun as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
      if (id === 'run-1') {
        return new Promise<AgentRunView>((resolve) => {
          resolveRun1 = resolve
        })
      }
      return runView({ runId: 'run-2', input: '第二个运行' })
    })
    render(<AgentPage refreshKey={0} />)
    await waitFor(() => expect(screen.getAllByTestId('agent-history-item')).toHaveLength(2))
    fireEvent.click(screen.getAllByTestId('agent-history-item')[1]!)
    await waitFor(() => expect(screen.getByTestId('agent-run').textContent).toContain('第二个运行'))
    // run-1 的迟到响应到达:不得覆盖 run-2 的视图
    act(() => {
      resolveRun1(runView({ runId: 'run-1', input: '第一个运行' }))
    })
    await waitFor(() => expect(screen.getByTestId('agent-run').textContent).toContain('第二个运行'))
    expect(screen.getByTestId('agent-run').textContent).not.toContain('第一个运行')
  })

  it('seq 缺口:收到 seq=3 而 seq=2 未接收时按 lastSeq 补拉,不跳过遗漏', async () => {
    const allEvents = [
      traceEvent(1, 'plan', { goal: 'g1' }),
      traceEvent(2, 'tool_call', { tool: 'todo.list', ok: true }),
      traceEvent(3, 'plan', { goal: 'g2' })
    ]
    const h = installApi({ run: runView(), events: [allEvents[0]!] })
    let openCall = 0
    ;(window.api.getAgentRunEvents as ReturnType<typeof vi.fn>).mockImplementation(
      async (id: string, afterSeq: number) => {
        openCall += 1
        // 首次(挂载打开)只拿到 #1:#2 在传输中丢失,模拟缺口场景
        if (openCall === 1) return { run: runView(), events: [allEvents[0]!] }
        return { run: runView(), events: allEvents.filter((e) => e.runId === id && e.seq > afterSeq) }
      }
    )
    render(<AgentPage refreshKey={0} />)
    await screen.findByTestId('agent-run')
    await waitFor(() => expect(window.api.getAgentRunEvents).toHaveBeenCalledWith('run-1', 0))
    act(() => {
      h.emit('evt:agent-run-updated', { run: runView(), event: allEvents[2]! })
    })
    const timeline = await screen.findByTestId('agent-timeline')
    await waitFor(() => expect(timeline.textContent).toContain('g2'))
    // 缺口事件 #2 已补齐,补拉从 lastSeq=1 开始
    expect(timeline.textContent).toContain('#2')
    expect(window.api.getAgentRunEvents).toHaveBeenCalledWith('run-1', 1)
  })

  it('同 seq 重复广播:去重不重复渲染', async () => {
    const h = installApi({ run: runView(), events: [] })
    render(<AgentPage refreshKey={0} />)
    await screen.findByTestId('agent-run')
    await waitFor(() => expect(h.listeners.has('evt:agent-run-updated')).toBe(true))
    const payload = { run: runView(), event: traceEvent(1, 'plan', { goal: '只出现一次' }) }
    act(() => {
      h.emit('evt:agent-run-updated', payload)
      h.emit('evt:agent-run-updated', payload)
    })
    await waitFor(() => expect(screen.getByTestId('agent-timeline').textContent).toContain('只出现一次'))
    expect(screen.getByTestId('agent-timeline').textContent.match(/只出现一次/g)).toHaveLength(1)
  })

  it('审批拉取拒绝:展示可识别错误,下次事件重试后渲染确认卡', async () => {
    const h = installApi({ run: runView({ status: 'awaiting_confirmation' }), approvals: [approval()] })
    let rejected = false
    ;(window.api.getAgentRunApprovals as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (!rejected) {
        rejected = true
        throw new Error('审批拉取失败')
      }
      return [approval()]
    })
    render(<AgentPage refreshKey={0} />)
    await waitFor(() => expect(screen.getByTestId('agent-error').textContent).toContain('审批拉取失败'))
    // 下次有效事件触发重试:成功后确认卡渲染
    act(() => {
      h.emit('evt:agent-run-updated', {
        run: runView({ status: 'awaiting_confirmation' }),
        event: traceEvent(1, 'confirmation', { approvalId: 'ap-1' })
      })
    })
    await screen.findByTestId('agent-confirm-card')
  })

  it('批准受理后展示真实状态,不预先标成功', async () => {
    const h = installApi({ run: runView({ status: 'awaiting_confirmation' }), approvals: [approval()] })
    render(<AgentPage refreshKey={0} />)
    await screen.findByTestId('agent-confirm-card')
    fireEvent.click(screen.getByText('批准执行'))
    await waitFor(() => expect(h.decide).toHaveBeenCalledWith('ap-1', 'approved'))
    // 受理后未收到执行事件前:保持真实等待状态,不预标成功
    expect(screen.getByTestId('agent-run-status').textContent).toBe('等待确认')
    act(() => {
      h.emit('evt:agent-run-updated', {
        run: runView({ status: 'executing' }),
        event: traceEvent(2, 'tool_call', { tool: 'todo.create', ok: true })
      })
    })
    await waitFor(() => expect(screen.getByTestId('agent-run-status').textContent).toBe('执行中'))
  })

  it('卸载清理订阅:卸载后监听器已移除', async () => {
    const h = installApi({ run: runView(), events: [] })
    const { unmount } = render(<AgentPage refreshKey={0} />)
    await screen.findByTestId('agent-run')
    expect((h.listeners.get('evt:agent-run-updated') ?? []).length).toBeGreaterThan(0)
    unmount()
    expect(h.listeners.get('evt:agent-run-updated')).toHaveLength(0)
    expect(h.listeners.get('evt:agent-run-finished')).toHaveLength(0)
    expect(h.listeners.get('evt:workspace-epoch-changed') ?? []).toHaveLength(0)
  })
})

describe('AgentPage T05 事件与刷新版本', () => {
  const question = traceEvent(1, 'input', {
    questions: [{ questionId: 'q-old', question: '旧运行的问题?' }]
  })

  it.each(['awaiting_confirmation', 'awaiting_input'] as const)(
    'seq=3 终态后 seq=2 的 %s 只补时间线，不恢复人工操作卡',
    async (oldStatus) => {
      const h = installApi({ run: runView({ status: oldStatus }), events: [question], approvals: [approval()] })
      render(<AgentPage refreshKey={0} />)
      await screen.findByTestId('agent-run')
      await act(async () => {
        h.emit('evt:agent-run-updated', { run: runView({ status: 'succeeded' }), event: traceEvent(3, 'output') })
      })
      await act(async () => {
        h.emit('evt:agent-run-updated', {
          run: runView({ status: oldStatus }), event: traceEvent(2, 'confirmation', { approvalId: 'ap-1' })
        })
      })
      expect(screen.getByTestId('agent-run-status').textContent).toBe('已完成')
      expect(screen.queryByTestId('agent-confirm-card')).toBeNull()
      expect(screen.queryByLabelText('旧运行的问题?')).toBeNull()
      const seqs = Array.from(screen.getByTestId('agent-timeline').querySelectorAll('span'))
        .map((node) => node.textContent).filter((text) => /^#\d+$/.test(text ?? ''))
      expect(seqs).toEqual(['#1', '#2', '#3'])
    }
  )

  it('重复 seq 的不同快照不能覆盖已接纳状态，也不再次刷新', async () => {
    const h = installApi({ events: [traceEvent(1, 'plan')] })
    render(<AgentPage refreshKey={0} />)
    await screen.findByTestId('agent-run')
    await act(async () => {
      h.emit('evt:agent-run-updated', { run: runView({ status: 'succeeded' }), event: traceEvent(2, 'output') })
    })
    const calls = vi.mocked(window.api.getAgentRun).mock.calls.length
    await act(async () => {
      h.emit('evt:agent-run-updated', {
        run: runView({ status: 'awaiting_confirmation' }), event: traceEvent(2, 'confirmation')
      })
    })
    expect(screen.getByTestId('agent-run-status').textContent).toBe('已完成')
    expect(vi.mocked(window.api.getAgentRun).mock.calls).toHaveLength(calls)
    expect(screen.getByTestId('agent-timeline').textContent?.match(/#2/g)).toHaveLength(1)
  })

  it('迟到的 refresh 与审批不能覆盖新终态，并合并补拉一次', async () => {
    const staleRun = deferred<AgentRunView>()
    const staleApprovals = deferred<AgentApprovalView[]>()
    const h = installApi({ run: runView({ status: 'succeeded' }), events: [question] })
    vi.mocked(window.api.getAgentRun).mockImplementationOnce(() => staleRun.promise)
    vi.mocked(window.api.getAgentRunApprovals).mockImplementationOnce(() => staleApprovals.promise)
    render(<AgentPage refreshKey={0} />)
    await waitFor(() => expect(window.api.getAgentRunEvents).toHaveBeenCalledWith('run-1', 0))
    await act(async () => {
      h.emit('evt:agent-run-updated', { run: runView({ status: 'succeeded' }), event: traceEvent(2, 'output') })
      staleRun.resolve(runView({ status: 'awaiting_input' }))
      staleApprovals.resolve([approval()])
    })
    expect(screen.getByTestId('agent-run-status').textContent).toBe('已完成')
    expect(screen.queryByTestId('agent-confirm-card')).toBeNull()
    expect(screen.queryByLabelText('旧运行的问题?')).toBeNull()
    expect(window.api.getAgentRun).toHaveBeenCalledTimes(2)
    expect(window.api.getAgentRunApprovals).toHaveBeenCalledTimes(2)
  })

  it('迟到的 refresh 错误不污染新事件，并补拉最新状态', async () => {
    const stale = deferred<AgentRunView>()
    const h = installApi({ run: runView({ status: 'succeeded' }), events: [question] })
    vi.mocked(window.api.getAgentRun).mockImplementationOnce(() => stale.promise)
    render(<AgentPage refreshKey={0} />)
    await waitFor(() => expect(window.api.getAgentRunEvents).toHaveBeenCalledWith('run-1', 0))
    await act(async () => {
      h.emit('evt:agent-run-updated', { run: runView({ status: 'succeeded' }), event: traceEvent(2, 'output') })
      stale.reject(new Error('旧请求失败'))
    })
    expect(screen.queryByTestId('agent-error')).toBeNull()
    expect(screen.getByTestId('agent-run-status').textContent).toBe('已完成')
    expect(window.api.getAgentRun).toHaveBeenCalledTimes(2)
  })

  it('较新 refresh 已完成后，旧请求错误不覆盖当前错误区', async () => {
    const stale = deferred<AgentRunView>()
    const h = installApi({ run: runView({ status: 'awaiting_confirmation' }), approvals: [approval()] })
    render(<AgentPage refreshKey={0} />)
    await screen.findByTestId('agent-confirm-card')
    vi.mocked(window.api.getAgentRun).mockImplementationOnce(() => stale.promise)
    await act(async () => {
      h.emit('evt:agent-run-updated', { run: runView({ status: 'awaiting_confirmation' }), event: traceEvent(1, 'confirmation') })
    })
    await act(async () => {
      h.emit('evt:agent-run-updated', { run: runView({ status: 'awaiting_confirmation' }), event: traceEvent(2, 'confirmation') })
    })
    await act(async () => stale.reject(new Error('已被替代的请求失败')))
    expect(screen.queryByTestId('agent-error')).toBeNull()
    expect(screen.getByTestId('agent-confirm-card')).toBeTruthy()
  })

  it('新事件淘汰审批 refresh 后仍能拉到最新审批，两条同批事件只合并刷新一次', async () => {
    const stale = deferred<AgentApprovalView[]>()
    const h = installApi({ run: runView({ status: 'awaiting_confirmation' }), approvals: [approval({ approvalId: 'ap-new' })] })
    vi.mocked(window.api.getAgentRunApprovals).mockImplementationOnce(() => stale.promise)
    render(<AgentPage refreshKey={0} />)
    await waitFor(() => expect(window.api.getAgentRunApprovals).toHaveBeenCalledTimes(1))
    await act(async () => {
      h.emit('evt:agent-run-updated', { run: runView({ status: 'awaiting_confirmation' }), event: traceEvent(1, 'model') })
      h.emit('evt:agent-run-updated', { run: runView({ status: 'awaiting_confirmation' }), event: traceEvent(2, 'confirmation') })
      stale.resolve([])
    })
    expect(screen.getByTestId('agent-confirm-card')).toBeTruthy()
    expect(window.api.getAgentRun).toHaveBeenCalledTimes(2)
    expect(window.api.getAgentRunApprovals).toHaveBeenCalledTimes(2)
  })

  it('补拉仍缺 seq=2 时游标停在 1，后续补齐 2/3/4 且各展示一次', async () => {
    const events = [traceEvent(1, 'plan'), traceEvent(2, 'tool_call'), traceEvent(3, 'plan'), traceEvent(4, 'input')]
    const h = installApi({ events: [events[0]!] })
    vi.mocked(window.api.getAgentRunEvents)
      .mockResolvedValueOnce({ run: runView(), events: [events[0]!] })
      .mockResolvedValueOnce({ run: runView(), events: [events[2]!] })
      .mockImplementation(async (_id, afterSeq) => ({ run: runView(), events: events.filter((e) => e.seq > (afterSeq ?? 0)) }))
    render(<AgentPage refreshKey={0} />)
    await screen.findByTestId('agent-run')
    await act(async () => {
      h.emit('evt:agent-run-updated', { run: runView(), event: events[2]! })
    })
    await act(async () => {
      h.emit('evt:agent-run-updated', { run: runView(), event: events[3]! })
    })
    expect(vi.mocked(window.api.getAgentRunEvents).mock.calls.slice(1).map((call) => call[1])).toEqual([1, 1])
    const seqs = Array.from(screen.getByTestId('agent-timeline').querySelectorAll('span'))
      .map((node) => node.textContent).filter((text) => /^#\d+$/.test(text ?? ''))
    expect(seqs).toEqual(['#1', '#2', '#3', '#4'])
  })

  it('当前缺口补拉失败显示错误、保留新快照且不自动重试', async () => {
    const h = installApi({ events: [traceEvent(1, 'plan')] })
    render(<AgentPage refreshKey={0} />)
    await screen.findByTestId('agent-run')
    vi.mocked(window.api.getAgentRunEvents).mockRejectedValueOnce(new Error('轨迹补拉失败'))
    await act(async () => {
      h.emit('evt:agent-run-updated', { run: runView({ status: 'succeeded' }), event: traceEvent(3, 'output') })
    })
    expect(screen.getByTestId('agent-error').textContent).toContain('轨迹补拉失败')
    expect(screen.getByTestId('agent-run-status').textContent).toBe('已完成')
    expect(screen.getByTestId('agent-timeline').textContent).toContain('#3')
    expect(window.api.getAgentRunEvents).toHaveBeenCalledTimes(2)
  })

  it('旧补拉错误晚于新事件到达时不污染当前视图', async () => {
    const stale = deferred<{ run: AgentRunView; events: TraceEvent[] }>()
    const h = installApi({ events: [traceEvent(1, 'plan')] })
    render(<AgentPage refreshKey={0} />)
    await screen.findByTestId('agent-run')
    vi.mocked(window.api.getAgentRunEvents).mockImplementationOnce(() => stale.promise)
    await act(async () => {
      h.emit('evt:agent-run-updated', { run: runView(), event: traceEvent(3, 'plan') })
      h.emit('evt:agent-run-updated', { run: runView({ status: 'succeeded' }), event: traceEvent(2, 'output') })
      h.emit('evt:agent-run-updated', { run: runView({ status: 'succeeded' }), event: traceEvent(4, 'output') })
      stale.reject(new Error('旧轨迹查询失败'))
    })
    expect(screen.queryByTestId('agent-error')).toBeNull()
    expect(screen.getByTestId('agent-run-status').textContent).toBe('已完成')
  })

  it('finished 无 seq 时保持当前快照，重复通知只合并一次权威刷新', async () => {
    const authoritative = deferred<AgentRunView>()
    const h = installApi()
    render(<AgentPage refreshKey={0} />)
    await screen.findByTestId('agent-run')
    vi.mocked(window.api.getAgentRun).mockImplementationOnce(() => authoritative.promise)
    await act(async () => {
      h.emit('evt:agent-run-finished', { run: runView({ status: 'succeeded' }) })
      h.emit('evt:agent-run-finished', { run: runView({ status: 'succeeded' }) })
    })
    expect(screen.getByTestId('agent-run-status').textContent).toBe('执行中')
    expect(window.api.getAgentRun).toHaveBeenCalledTimes(2)
    await act(async () => authoritative.resolve(runView({ status: 'partial' })))
    expect(screen.getByTestId('agent-run-status').textContent).toBe('部分完成')
  })

  it('finished 权威刷新失败保留现状、显示错误且不自动重试', async () => {
    const h = installApi()
    render(<AgentPage refreshKey={0} />)
    await screen.findByTestId('agent-run')
    vi.mocked(window.api.getAgentRun).mockRejectedValueOnce(new Error('终态查询失败'))
    await act(async () => {
      h.emit('evt:agent-run-finished', { run: runView({ status: 'succeeded' }) })
    })
    expect(screen.getByTestId('agent-run-status').textContent).toBe('执行中')
    expect(screen.getByTestId('agent-error').textContent).toContain('终态查询失败')
    expect(window.api.getAgentRun).toHaveBeenCalledTimes(2)
  })

  it.each(['succeeded', 'partial', 'failed', 'cancelled'] as const)(
    '%s 的有效刷新也拒绝人工等待态回退', async (status) => {
      const h = installApi({ run: runView({ status }), events: [question] })
      render(<AgentPage refreshKey={0} />)
      await screen.findByTestId('agent-run')
      vi.mocked(window.api.getAgentRun).mockResolvedValue(runView({ status: 'awaiting_input' }))
      vi.mocked(window.api.getAgentRunApprovals).mockResolvedValue([approval()])
      await act(async () => {
        h.emit('evt:agent-run-finished', { run: runView({ status: 'awaiting_confirmation' }) })
      })
      expect(screen.getByTestId('agent-run-status').textContent).toBe(
        { succeeded: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消' }[status]
      )
      expect(screen.queryByTestId('agent-confirm-card')).toBeNull()
      expect(screen.queryByLabelText('旧运行的问题?')).toBeNull()
    }
  )

  it.each(['resolve', 'reject'] as const)(
    '跨运行的旧 refresh %s 后保留 run-2 回答文本和错误区', async (outcome) => {
      const staleRun = deferred<AgentRunView>()
      const staleApprovals = deferred<AgentApprovalView[]>()
      installApi()
      vi.mocked(window.api.listAgentRuns).mockResolvedValue([
        runView({ input: '第一个运行' }), runView({ runId: 'run-2', input: '第二个运行', status: 'awaiting_input' })
      ])
      vi.mocked(window.api.getAgentRun).mockImplementation(async (id) =>
        id === 'run-1' ? staleRun.promise : runView({ runId: 'run-2', input: '第二个运行', status: 'awaiting_input' })
      )
      vi.mocked(window.api.getAgentRunApprovals).mockImplementation(async (id) => id === 'run-1' ? staleApprovals.promise : [])
      vi.mocked(window.api.getAgentRunEvents).mockImplementation(async (id) => ({
        run: null, events: [traceEvent(1, 'input', { questions: [{ questionId: 'q-new', question: '新运行的问题?' }] }, id)]
      }))
      render(<AgentPage refreshKey={0} />)
      await waitFor(() => expect(window.api.getAgentRun).toHaveBeenCalledWith('run-1'))
      fireEvent.click(screen.getAllByTestId('agent-history-item')[1]!)
      fireEvent.change(await screen.findByLabelText('新运行的问题?'), { target: { value: 'run-2 的回答' } })
      await act(async () => {
        staleApprovals.resolve([approval()])
        if (outcome === 'resolve') staleRun.resolve(runView({ status: 'awaiting_confirmation' }))
        else staleRun.reject(new Error('run-1 的旧错误'))
      })
      expect((screen.getByLabelText('新运行的问题?') as HTMLTextAreaElement).value).toBe('run-2 的回答')
      expect(screen.queryByTestId('agent-error')).toBeNull()
      expect(screen.queryByTestId('agent-confirm-card')).toBeNull()
    }
  )

  it('epoch 变化重开同 runId，重置终态和 seq 并隔离旧 refresh/审批/补发', async () => {
    const staleRun = deferred<AgentRunView>()
    const staleApprovals = deferred<AgentApprovalView[]>()
    const staleEvents = deferred<{ run: AgentRunView; events: TraceEvent[] }>()
    const h = installApi({ run: runView({ status: 'succeeded' }), events: [traceEvent(1, 'plan')] })
    render(<AgentPage refreshKey={0} />)
    await screen.findByTestId('agent-run')
    vi.mocked(window.api.getAgentRun).mockImplementationOnce(() => staleRun.promise)
    vi.mocked(window.api.getAgentRunApprovals).mockImplementationOnce(() => staleApprovals.promise)
    vi.mocked(window.api.getAgentRunEvents).mockImplementationOnce(() => staleEvents.promise)
    await act(async () => {
      h.emit('evt:agent-run-updated', { run: runView({ status: 'succeeded' }), event: traceEvent(5, 'output') })
      h.emit('evt:agent-run-finished', { run: runView({ status: 'succeeded' }) })
    })
    vi.mocked(window.api.getAgentRun).mockResolvedValue(runView({ status: 'awaiting_input', input: '恢复后的运行' }))
    vi.mocked(window.api.getAgentRunEvents).mockResolvedValue({
      run: runView({ status: 'awaiting_input' }),
      events: [traceEvent(1, 'input', { questions: [{ questionId: 'q-restored', question: '恢复后的问题?' }] })]
    })
    await act(async () => h.emit('evt:workspace-epoch-changed', { epoch: 'new-epoch' }))
    fireEvent.change(await screen.findByLabelText('恢复后的问题?'), { target: { value: '新库的回答' } })
    await act(async () => {
      staleRun.resolve(runView({ status: 'awaiting_confirmation' }))
      staleApprovals.resolve([approval()])
      staleEvents.resolve({ run: runView({ status: 'succeeded' }), events: [traceEvent(5, 'output')] })
    })
    expect(screen.getByTestId('agent-run').textContent).toContain('恢复后的运行')
    expect((screen.getByLabelText('恢复后的问题?') as HTMLTextAreaElement).value).toBe('新库的回答')
    expect(screen.queryByTestId('agent-confirm-card')).toBeNull()
    expect(screen.queryByTestId('agent-error')).toBeNull()
    expect(screen.getByTestId('agent-timeline').textContent).not.toContain('#5')
    expect(vi.mocked(window.api.getAgentRunEvents).mock.calls.at(-1)).toEqual(['run-1', 0])
    await act(async () => h.emit('evt:agent-run-updated', { run: runView(), event: traceEvent(2, 'plan') }))
    expect(screen.getByTestId('agent-run-status').textContent).toBe('执行中')
  })
})
