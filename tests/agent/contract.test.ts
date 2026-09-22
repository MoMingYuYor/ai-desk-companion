import { describe, expect, it } from 'vitest'
import {
  APPROVAL_DECISIONS,
  RISK_LEVELS,
  RUN_MODES,
  RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  TOOL_CALL_STATUSES,
  TRACE_EVENT_TYPES,
  findSeqAnomaly,
  isRiskLevel,
  isRunMode,
  isRunStatus,
  isTerminalRunStatus,
  isWriteRisk,
  normalizePlanStep,
  type TraceEvent
} from '../../src/shared/agent'

// C-02:共享契约。两组断言最要紧:
// 1. 归一化必须丢掉模型自报的 riskLevel / needsConfirmation(总体规格第 6 节);
// 2. 状态集合与总体规格逐字一致,改动会在这里失败,强制同步文档。

describe('状态集合与总体规格一致', () => {
  it('九态状态集完整且顺序固定', () => {
    expect([...RUN_STATUSES]).toEqual([
      'queued',
      'planning',
      'awaiting_input',
      'awaiting_confirmation',
      'executing',
      'succeeded',
      'partial',
      'failed',
      'cancelled'
    ])
  })

  it('终态集合为 succeeded / partial / failed / cancelled', () => {
    expect([...TERMINAL_RUN_STATUSES]).toEqual(['succeeded', 'partial', 'failed', 'cancelled'])
  })

  it('运行模式只有 personal_ops 与 research', () => {
    expect([...RUN_MODES]).toEqual(['personal_ops', 'research'])
  })

  it('风险等级为 read / reversible_write / irreversible_write', () => {
    expect([...RISK_LEVELS]).toEqual(['read', 'reversible_write', 'irreversible_write'])
  })

  it('工具调用状态含 unknown(外部结果未知时禁止盲目重试)', () => {
    expect(TOOL_CALL_STATUSES).toContain('unknown')
  })

  it('轨迹事件类型八类齐全', () => {
    expect([...TRACE_EVENT_TYPES]).toEqual([
      'input',
      'retrieval',
      'plan',
      'tool_call',
      'confirmation',
      'model',
      'output',
      'error'
    ])
  })

  it('审批决策四态齐全', () => {
    expect([...APPROVAL_DECISIONS]).toEqual(['pending', 'approved', 'rejected', 'expired'])
  })
})

describe('类型守卫', () => {
  it('isRunMode 只接受两种模式', () => {
    expect(isRunMode('personal_ops')).toBe(true)
    expect(isRunMode('research')).toBe(true)
    expect(isRunMode('ops')).toBe(false)
    expect(isRunMode(undefined)).toBe(false)
  })

  it('isRunStatus 拒绝未知状态与非法类型', () => {
    expect(isRunStatus('awaiting_confirmation')).toBe(true)
    expect(isRunStatus('running')).toBe(false)
    expect(isRunStatus(1)).toBe(false)
  })

  it('isRiskLevel 拒绝模型可能编造的值', () => {
    expect(isRiskLevel('read')).toBe(true)
    expect(isRiskLevel('safe')).toBe(false)
    expect(isRiskLevel('READ')).toBe(false)
  })

  it('isTerminalRunStatus 只认四个终态', () => {
    expect(isTerminalRunStatus('succeeded')).toBe(true)
    expect(isTerminalRunStatus('cancelled')).toBe(true)
    expect(isTerminalRunStatus('executing')).toBe(false)
    expect(isTerminalRunStatus('awaiting_confirmation')).toBe(false)
  })

  it('isWriteRisk:只有 read 不是写入', () => {
    expect(isWriteRisk('read')).toBe(false)
    expect(isWriteRisk('reversible_write')).toBe(true)
    expect(isWriteRisk('irreversible_write')).toBe(true)
  })
})

describe('normalizePlanStep 丢弃模型自报的风险等级', () => {
  it('模型声明的 riskLevel 与 needsConfirmation 不出现在归一化结果里', () => {
    const got = normalizePlanStep({
      tool: 'calendar.create_event',
      arguments: { title: '项目整理' },
      // 模型试图把写入降级为只读
      riskLevel: 'read',
      needsConfirmation: false
    })
    expect(got).toEqual({ tool: 'calendar.create_event', arguments: { title: '项目整理' } })
    expect(got).not.toHaveProperty('riskLevel')
    expect(got).not.toHaveProperty('needsConfirmation')
  })

  it('空工具名或全空白被拒绝', () => {
    expect(normalizePlanStep({ tool: '', arguments: {} })).toBeNull()
    expect(normalizePlanStep({ tool: '   ', arguments: {} })).toBeNull()
  })

  it('非对象参数被拒绝(数组、null、字符串)', () => {
    expect(normalizePlanStep({ tool: 'todo.list', arguments: [] as unknown as Record<string, unknown> })).toBeNull()
    expect(normalizePlanStep({ tool: 'todo.list', arguments: null as unknown as Record<string, unknown> })).toBeNull()
    expect(normalizePlanStep({ tool: 'todo.list', arguments: 'x' as unknown as Record<string, unknown> })).toBeNull()
  })

  it('缺少工具名被拒绝', () => {
    expect(normalizePlanStep({ arguments: {} } as never)).toBeNull()
  })
})

describe('findSeqAnomaly 检查 seq 从 1 连续递增', () => {
  const ev = (seq: number): Pick<TraceEvent, 'seq'> => ({ seq })

  it('空数组无异常', () => {
    expect(findSeqAnomaly([])).toBeNull()
  })

  it('连续 1..n 无异常', () => {
    expect(findSeqAnomaly([ev(1), ev(2), ev(3)])).toBeNull()
  })

  it('缺号定位到第一个缺口', () => {
    expect(findSeqAnomaly([ev(1), ev(2), ev(4)])).toBe(2)
  })

  it('不从 1 开始即异常', () => {
    expect(findSeqAnomaly([ev(0), ev(1)])).toBe(0)
    expect(findSeqAnomaly([ev(2), ev(3)])).toBe(0)
  })

  it('重复序号定位到重复处', () => {
    expect(findSeqAnomaly([ev(1), ev(2), ev(2)])).toBe(2)
  })
})
