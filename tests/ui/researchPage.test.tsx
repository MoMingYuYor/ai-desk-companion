// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { ResearchPage, splitByCodePointOffsets } from '../../src/renderer/workbench/pages/ResearchPage'
import type { AgentRunView, ResearchReportResponse, ResearchSnapshotView, TraceEvent } from '../../src/shared/api'

// R-06:研究工作台组件测试。
// 覆盖:空资料提交禁用;导入后可勾选;运行创建调用与幂等键;时间线 seq 去重;
// 澄清提交;报告渲染含引用编号;证据抽屉码点高亮(emoji/组合字符);partial 不伪装成功;
// 「转为待办」只调 createAgentRun(mode=personal_ops)。

afterEach(cleanup)

const RUN_BASE = {
  mode: 'research' as const,
  input: '比较岗位要求',
  timezone: 'Asia/Shanghai',
  contextClock: '2026-09-28T01:00:00.000Z',
  configVersion: '',
  budgetJson: '{}',
  resultRef: null
}

function runView(over: Partial<AgentRunView> = {}): AgentRunView {
  return {
    runId: 'run-r1',
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
    runId: 'run-r1',
    seq,
    eventType,
    schemaVersion: 1,
    payload,
    durationMs: null,
    tokenUsage: null,
    createdAt: '2026-09-28T01:00:00.000Z'
  }
}

function reportView(over: Partial<ResearchReportResponse> = {}): ResearchReportResponse {
  return {
    run_id: 'run-r1',
    report_id: 'rep-1',
    version: 1,
    report_state: 'final',
    run_status: 'succeeded',
    manifest_sha256: 'a'.repeat(64),
    sections: [
      { section: 'core_findings', title: '核心结论', markdown: '## 核心结论\n\n1. 该岗位明确要求 Python。' },
      { section: 'conflicts_and_gaps', title: '冲突与不足', markdown: '## 冲突与不足\n\n未检测到冲突。' }
    ],
    claims: [
      { claim_id: 'c-1', text: '该岗位明确要求 Python。', claim_type: 'fact', support_status: 'supported', subquestion_id: 'sub-1' }
    ],
    citations: [
      {
        citation_id: 'cite-1',
        claim_id: 'c-1',
        evidence_id: 'ev-1',
        relation: 'supports',
        evidence_group_id: null,
        group_operator: null,
        snapshot_id: 'snap-1',
        start_offset: 0,
        end_offset: 10,
        quote: '要求：Python。'
      }
    ],
    sources: [
      { source_id: 'snap-1', source_name: 'jd.json', source_type: 'json', text_sha256: 'b'.repeat(64) }
    ],
    unanswered_subquestions: [],
    budget_usage: { max_subqueries: 3, max_chunks_per_subquery: 8, max_model_calls: 6, max_active_seconds: 120 },
    markdown: '## 核心结论\n\n1. 该岗位明确要求 Python。',
    ...over
  }
}

function snapshotView(over: Partial<ResearchSnapshotView> = {}): ResearchSnapshotView {
  return {
    snapshotId: 'snap-1',
    sourceName: 'jd.json',
    sourceType: 'json',
    sourceIdentity: '某公司·某岗位',
    provenanceGroupId: 'pg-1',
    textSha256: 'b'.repeat(64),
    normalizedText: '',
    codePointLength: 0,
    collectedAt: '2026-09-28T01:00:00.000Z',
    collectionTimeBasis: 'imported',
    ...over
  }
}

type Listener = (...args: unknown[]) => void

interface Harness {
  createResearch: ReturnType<typeof vi.fn>
  createAgent: ReturnType<typeof vi.fn>
  listeners: Map<string, Listener[]>
  emit: (channel: string, ...args: unknown[]) => void
}

function installApi(over: {
  run?: AgentRunView
  events?: TraceEvent[]
  historyRuns?: Array<{ runId: string; mode: string; status: string; input: string; errorCode: string | null; startedAt: string; finishedAt: string | null }>
  report?: ResearchReportResponse
  reportError?: Error
  snapshot?: ResearchSnapshotView
  importResult?: Array<Record<string, unknown>>
} = {}): Harness {
  const run = over.run ?? runView()
  const listeners = new Map<string, Listener[]>()
  const createResearch = vi.fn(async () => ({ runId: run.runId, status: 'queued', replayed: false, researchTaskId: 'task-1', snapshotManifestId: 'man-1' }))
  const createAgent = vi.fn(async () => ({ runId: 'run-p1', status: 'queued' }))
  const reportError = over.reportError
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    createResearchRun: createResearch,
    getResearchReport: vi.fn(async () => {
      if (reportError) throw reportError
      return over.report ?? reportView()
    }),
    getResearchSnapshot: vi.fn(async () => over.snapshot ?? snapshotView()),
    importResearchDocuments: vi.fn(async () => over.importResult ?? []),
    // 复用的 Agent 通道
    getAgentRun: vi.fn(async () => run),
    listAgentRuns: vi.fn(async () => over.historyRuns ?? []),
    getAgentRunEvents: vi.fn(async () => ({ run, events: over.events ?? [] })),
    submitAgentAnswers: vi.fn(async () => ({ runId: run.runId, status: 'queued' })),
    cancelAgentRun: vi.fn(async () => run),
    createAgentRun: createAgent,
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
    createResearch,
    createAgent,
    listeners,
    emit: (channel, ...args) => {
      for (const l of listeners.get(channel) ?? []) l(...args)
    }
  }
}

/** jsdom 无文件对话框:向页面注入的隐藏 input 塞入 File 并触发 change */
async function pickFiles(files: File[]): Promise<void> {
  const input = await waitFor(() => {
    const el = document.querySelector('input[data-testid="research-import-input"]') as HTMLInputElement
    expect(el).toBeTruthy()
    return el
  })
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  fireEvent.change(input)
}

// ---------- 输入与资料 ----------

describe('ResearchPage 输入与资料', () => {
  it('空资料或空问题时提交禁用;不发模型请求', () => {
    installApi()
    render(<ResearchPage refreshKey={0} />)
    const submit = screen.getByTestId('research-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    // 只有文字仍不够:必须勾选资料
    fireEvent.change(screen.getByTestId('research-question'), { target: { value: '比较岗位' } })
    expect(submit.disabled).toBe(true)
  })

  it('导入后资料入列并默认勾选,问题非空即可提交', async () => {
    const h = installApi({
      importResult: [{ ok: true, documentId: 'doc-1', sourceName: 'jd.json', sourceType: 'json', sourceLocator: null, recordIndex: null, deduped: false }]
    })
    render(<ResearchPage refreshKey={0} />)
    fireEvent.click(screen.getByTestId('research-import'))
    await pickFiles([new File([new Uint8Array([1, 2, 3])], 'jd.json')])
    await waitFor(() => expect(screen.getByTestId('research-import-result').textContent).toContain('jd.json'))
    // 默认勾选;取消勾选后提交再次禁用
    const checkbox = screen.getByTestId('research-source-doc-1') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    fireEvent.change(screen.getByTestId('research-question'), { target: { value: '比较岗位' } })
    const submit = screen.getByTestId('research-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(false)
    fireEvent.click(checkbox)
    expect((screen.getByTestId('research-submit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(checkbox)
    // 提交:创建调用带幂等键 operationId 与勾选的 snapshotIds
    fireEvent.click(submit)
    await waitFor(() => expect(h.createResearch).toHaveBeenCalledTimes(1))
    const arg = h.createResearch.mock.calls[0]![0] as Record<string, unknown>
    expect(arg.snapshotIds).toEqual(['doc-1'])
    expect(typeof arg.operationId).toBe('string')
    expect(String(arg.operationId).length).toBeGreaterThan(0)
  })

  it('导入失败逐文件展示错误,成功资料保留', async () => {
    installApi({
      importResult: [
        { ok: false, sourceName: 'bad.exe', sourceType: null, sourceLocator: null, recordIndex: null, error: { code: 'UNSUPPORTED_FORMAT', message: 'bad.exe:不支持的格式,仅支持 .md/.txt/.json/.csv' } },
        { ok: true, documentId: 'doc-2', sourceName: 'jd.csv', sourceType: 'csv', sourceLocator: 'row:1', recordIndex: 0, deduped: false }
      ]
    })
    render(<ResearchPage refreshKey={0} />)
    fireEvent.click(screen.getByTestId('research-import'))
    await pickFiles([new File([new Uint8Array([1])], 'bad.exe')])
    await waitFor(() => expect(screen.getByTestId('research-import-result').textContent).toContain('不支持的格式'))
    expect(screen.getByTestId('research-source-doc-2')).toBeTruthy()
  })
})

// ---------- 运行与事件 ----------

describe('ResearchPage 运行与事件流', () => {
  it('提交中防重:进行中的提交不产生第二次创建', async () => {
    let resolveCreate: (v: unknown) => void = () => {}
    const createResearch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        })
    )
    installApi({
      importResult: [{ ok: true, documentId: 'doc-1', sourceName: 'jd.json', sourceType: 'json', sourceLocator: null, recordIndex: null, deduped: false }]
    })
    ;(window as unknown as { api: Record<string, unknown> }).api.createResearchRun = createResearch
    render(<ResearchPage refreshKey={0} />)
    fireEvent.click(screen.getByTestId('research-import'))
    await pickFiles([new File([new Uint8Array([1, 2, 3])], 'jd.json')])
    await waitFor(() => expect(screen.getByTestId('research-source-doc-1')).toBeTruthy())
    fireEvent.change(screen.getByTestId('research-question'), { target: { value: '比较岗位' } })
    fireEvent.click(screen.getByTestId('research-submit'))
    // 提交进行中再点击:不重复创建(幂等键同值复用)
    fireEvent.click(screen.getByTestId('research-submit'))
    expect(createResearch).toHaveBeenCalledTimes(1)
    resolveCreate({ runId: 'run-r1', status: 'queued', replayed: false, researchTaskId: 'task-1', snapshotManifestId: 'man-1' })
    await screen.findByTestId('research-run')
  })

  it('创建后订阅事件并按 seq 去重渲染时间线', async () => {
    const h = installApi({
      run: runView(),
      importResult: [{ ok: true, documentId: 'doc-1', sourceName: 'jd.json', sourceType: 'json', sourceLocator: null, recordIndex: null, deduped: false }]
    })
    render(<ResearchPage refreshKey={0} />)
    fireEvent.click(screen.getByTestId('research-import'))
    await pickFiles([new File([new Uint8Array([1, 2, 3])], 'jd.json')])
    await waitFor(() => expect(screen.getByTestId('research-source-doc-1')).toBeTruthy())
    fireEvent.change(screen.getByTestId('research-question'), { target: { value: '比较岗位' } })
    fireEvent.click(screen.getByTestId('research-submit'))
    await screen.findByTestId('research-run')
    await waitFor(() => expect(h.listeners.has('evt:agent-run-updated')).toBe(true))

    h.emit('evt:agent-run-updated', { run: runView(), event: traceEvent(1, 'plan', { goal: '拆解子问题' }) })
    h.emit('evt:agent-run-updated', { run: runView(), event: traceEvent(2, 'retrieval', { chunkCount: 8 }) })
    // 重复 seq 2:去重不重复渲染
    h.emit('evt:agent-run-updated', { run: runView(), event: traceEvent(2, 'retrieval', { chunkCount: 8 }) })
    // 其他运行:忽略
    h.emit('evt:agent-run-updated', { run: { ...runView(), runId: 'other' }, event: traceEvent(9, 'plan', {}) })

    const timeline = await screen.findByTestId('research-timeline')
    await waitFor(() => expect(timeline.textContent).toContain('#2'))
    expect(timeline.textContent).toContain('拆解子问题')
    expect(timeline.textContent).not.toContain('#9')
  })
})

// ---------- 澄清 ----------

describe('ResearchPage 澄清', () => {
  it('awaiting_input 渲染澄清问题并可经 submitAgentAnswers 提交', async () => {
    installApi({
      run: runView({ status: 'awaiting_input' }),
      events: [traceEvent(1, 'input', { questions: [{ question_id: 'q-1', question: '比较哪些维度?' }] })],
      historyRuns: [
        { runId: 'run-r1', mode: 'research', status: 'awaiting_input', input: '比较岗位要求', errorCode: null, startedAt: '2026-09-28T01:00:00.000Z', finishedAt: null }
      ]
    })
    render(<ResearchPage refreshKey={0} />)
    await screen.findByTestId('research-questions')
    expect(screen.getByText('比较哪些维度?')).toBeTruthy()
    fireEvent.click(screen.getByText('按默认假设继续'))
    await waitFor(() => expect(window.api.submitAgentAnswers).toHaveBeenCalledWith('run-r1', [{ questionId: 'q-1', answer: '按默认假设继续' }]))
  })
})

// ---------- 报告 ----------

describe('ResearchPage 报告', () => {
  it('报告按结论—证据—限制渲染,含引用编号', async () => {
    installApi({
      run: runView({ status: 'succeeded' }),
      report: reportView(),
      historyRuns: [
        { runId: 'run-r1', mode: 'research', status: 'succeeded', input: '比较岗位要求', errorCode: null, startedAt: '2026-09-28T01:00:00.000Z', finishedAt: '2026-09-28T01:02:00.000Z' }
      ]
    })
    render(<ResearchPage refreshKey={0} />)
    const reportNode = await screen.findByTestId('research-report')
    // 阅读顺序:结论区在限制区之前
    const findings = screen.getByTestId('research-report-section-core_findings')
    const conflicts = screen.getByTestId('research-report-section-conflicts_and_gaps')
    expect(findings.compareDocumentPosition(conflicts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(reportNode.textContent).toContain('[1]')
    expect(reportNode.textContent).toContain('该岗位明确要求 Python')
  })

  it('partial 状态不伪装成功:显示终止提示与未完成子问题', async () => {
    installApi({
      run: runView({ status: 'partial', errorCode: 'BUDGET_EXHAUSTED' }),
      report: reportView({
        report_state: 'partial',
        run_status: 'partial',
        unanswered_subquestions: [{ subquestion_id: 'sub-2', question: '薪资水平?', insufficiency_reason: '资料未覆盖' }]
      }),
      historyRuns: [
        { runId: 'run-r1', mode: 'research', status: 'partial', input: '比较岗位要求', errorCode: 'BUDGET_EXHAUSTED', startedAt: '2026-09-28T01:00:00.000Z', finishedAt: '2026-09-28T01:02:00.000Z' }
      ]
    })
    render(<ResearchPage refreshKey={0} />)
    const banner = await screen.findByTestId('research-run-failure')
    expect(banner.textContent).toContain('部分完成')
    await waitFor(() => expect(screen.getByTestId('research-unanswered').textContent).toContain('薪资水平?'))
    expect(screen.getByTestId('research-unanswered').textContent).toContain('资料未覆盖')
  })

  it('无报告版本时如实展示 REPORT_NOT_READY,不显示报告区', async () => {
    installApi({
      run: runView({ status: 'succeeded' }),
      reportError: new Error('[REPORT_NOT_READY] 研究运行 run-r1 还没有可用报告版本'),
      historyRuns: [
        { runId: 'run-r1', mode: 'research', status: 'succeeded', input: '比较岗位要求', errorCode: null, startedAt: '2026-09-28T01:00:00.000Z', finishedAt: '2026-09-28T01:02:00.000Z' }
      ]
    })
    render(<ResearchPage refreshKey={0} />)
    await waitFor(() => expect(screen.getByTestId('research-report-error').textContent).toContain('REPORT_NOT_READY'))
    expect(screen.queryByTestId('research-report')).toBeNull()
  })
})

// ---------- 证据抽屉与码点高亮 ----------

describe('证据抽屉码点高亮', () => {
  it('emoji(代理对)offset 不错位', () => {
    // "👍要求" = 3 码点(👍 是 2 个 UTF-16 code unit);高亮 [0,2) 应为 "👍要"
    const parts = splitByCodePointOffsets('👍要求', { start: 0, end: 2 })
    expect(parts).toEqual([
      { text: '👍要', highlight: true },
      { text: '求', highlight: false }
    ])
  })

  it('组合字符按独立码点切片;中文与换行不参与错位', () => {
    // Array.from 视角下组合符 U+0301 是独立码点:[0,1) 就是 "e"(与 chunker 坐标系一致)
    const composed = 'e\u0301是中文'
    const parts = splitByCodePointOffsets(composed, { start: 0, end: 1 })
    expect(parts[0]).toEqual({ text: 'e', highlight: true })
    expect(parts[1]).toEqual({ text: '\u0301是中文', highlight: false })
    // 整段高亮:中文 + \n 换行(导入规范化后 CRLF→LF)按码点切分不受影响
    const multi = '要求：Python。\n地点：上海。'
    const whole = splitByCodePointOffsets(multi, { start: 0, end: Array.from(multi).length })
    expect(whole).toEqual([{ text: multi, highlight: true }])
  })

  it('打开引用按钮经 snapshot-get 读取全文并高亮精确区间', async () => {
    installApi({
      run: runView({ status: 'succeeded' }),
      report: reportView(),
      snapshot: snapshotView({ normalizedText: '要求：Python。\n地点：上海。', codePointLength: 18 }),
      historyRuns: [
        { runId: 'run-r1', mode: 'research', status: 'succeeded', input: '比较岗位要求', errorCode: null, startedAt: '2026-09-28T01:00:00.000Z', finishedAt: '2026-09-28T01:02:00.000Z' }
      ]
    })
    render(<ResearchPage refreshKey={0} />)
    await screen.findByTestId('research-report')
    fireEvent.click(screen.getByTestId('research-cite-ev-1'))
    const drawer = await screen.findByTestId('research-drawer')
    expect(window.api.getResearchSnapshot).toHaveBeenCalledWith('snap-1')
    const highlight = drawer.querySelector('mark[data-testid="research-drawer-highlight"]')
    expect(highlight?.textContent).toBe('要求：Python。')
  })
})

// ---------- 转为待办 ----------

describe('ResearchPage 转为待办', () => {
  it('只调 createAgentRun(mode=personal_ops),不产生其他业务写', async () => {
    const h = installApi({
      run: runView({ status: 'succeeded' }),
      report: reportView({
        claims: [
          { claim_id: 'c-1', text: '事实句', claim_type: 'fact', support_status: 'supported', subquestion_id: 'sub-1' },
          { claim_id: 'c-2', text: '建议优先补检索基础', claim_type: 'recommendation', support_status: 'supported', subquestion_id: 'sub-1' }
        ]
      }),
      historyRuns: [
        { runId: 'run-r1', mode: 'research', status: 'succeeded', input: '比较岗位要求', errorCode: null, startedAt: '2026-09-28T01:00:00.000Z', finishedAt: '2026-09-28T01:02:00.000Z' }
      ]
    })
    render(<ResearchPage refreshKey={0} />)
    await screen.findByTestId('research-report')
    fireEvent.click(screen.getByTestId('research-convert-todo'))
    await waitFor(() => expect(h.createAgent).toHaveBeenCalledTimes(1))
    const arg = h.createAgent.mock.calls[0]![0] as { input: string; mode?: string }
    expect(arg.mode).toBe('personal_ops')
    expect(arg.input).toContain('建议优先补检索基础')
    // 未审批不产生业务写:不触任何待办/日程创建通道
    expect((window.api as unknown as Record<string, ReturnType<typeof vi.fn>>).createTodo ?? null).toBeNull()
  })
})
