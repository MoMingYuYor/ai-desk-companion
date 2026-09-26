// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { AgentPage } from '../../src/renderer/workbench/pages/AgentPage'
import type { AgentApprovalView, AgentRunView, TraceEvent } from '../../src/shared/api'
import type { RunStatus } from '../../src/shared/agent'

// A-06:AgentPage 组件测试。
// 页面挂载即自动打开最近一条运行;事件按 runId 过滤、按 seq 去重合并;
// partial 不伪装成功;过期提案禁止批准;空输入禁止提交。

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

function traceEvent(seq: number, eventType: TraceEvent['eventType'], payload: Record<string, unknown> = {}): TraceEvent {
  return {
    runId: 'run-1',
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
  it('空输入禁止提交;纯空白同样禁止', () => {
    installApi({ run: runView(), events: [] })
    render(<AgentPage refreshKey={0} />)
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
    installApi({ create })
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

    h.emit('evt:agent-run-updated', { run: runView(), event: traceEvent(1, 'plan', { goal: '目标G' }) })
    h.emit('evt:agent-run-updated', { run: runView(), event: traceEvent(2, 'tool_call', { tool: 'todo.list', ok: true }) })
    // 重复 seq:去重
    h.emit('evt:agent-run-updated', { run: runView(), event: traceEvent(2, 'tool_call', { tool: 'todo.list', ok: true }) })
    // 其他运行:忽略
    h.emit('evt:agent-run-updated', { run: { ...runView(), runId: 'other' }, event: traceEvent(9, 'plan', {}) })

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
    h.emit('evt:agent-run-finished', { run: runView({ status: 'succeeded' }) })
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

  it('awaiting_input 展示澄清问题并可回答', async () => {
    installApi({
      run: runView({ status: 'awaiting_input' }),
      events: [traceEvent(1, 'input', { questions: [{ questionId: 'q-when', question: '安排到哪天?' }] })]
    })
    render(<AgentPage refreshKey={0} />)
    await screen.findByText('安排到哪天?')
    fireEvent.click(screen.getByText('按建议继续'))
    await waitFor(() => expect(window.api.submitAgentAnswers).toHaveBeenCalled())
  })
})
