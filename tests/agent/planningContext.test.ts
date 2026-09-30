import { describe, expect, it } from 'vitest'
import { makeTestDb } from '../helpers'
import { initWorkspaceEpoch } from '../../src/main/db/operations'
import { createRun, getRun } from '../../src/main/runs/repository'
import { buildPlanningPrompt, parseModelPlan, PLAN_SYSTEM_PROMPT, type ToolCatalogEntry } from '../../src/main/agent/planner'
import { RunOrchestrator } from '../../src/main/agent/orchestrator'
import { FakeProvider } from '../../src/main/providers/fake'
import { ToolGateway } from '../../src/main/tools/gateway'
import { ToolRegistry } from '../../src/main/tools/registry'
import { registerOpsTools } from '../../src/main/tools/definitions'
import { systemClock } from '../../src/shared/clock'
import { RunQueue } from '../../src/main/agent/runQueue'
import { RunMode } from '../../src/shared/agent'

// OPS-03:规划上下文契约——冻结 contextClock 与用户时区进入提示词(UTC instant 与
// IANA 时区并列,不用执行机器的当前时间);非法时区/非法时间在入队前拒绝;
// DST 歧义不猜测。校验一律用 Intl.DateTimeFormat 独立计算当地日期与偏移。

const CATALOG: ToolCatalogEntry[] = []

/** 用 Intl 独立计算 instant 在指定时区的当地日期/时间/偏移(测试基准,与实现分开写) */
function intlLocal(instant: string, timeZone: string): { date: string; time: string; offset: string } {
  const at = new Date(instant)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(at)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  const offsetRaw =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value ?? ''
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
    offset: offsetRaw.replace('GMT', 'UTC')
  }
}

describe('提示词中的冻结时钟与用户时区', () => {
  it('上海跨日:UTC 2026-09-30T17:00Z 当地已是 10 月 1 日,偏移 UTC+08:00', () => {
    const instant = '2026-09-30T17:00:00.000Z'
    const prompt = buildPlanningPrompt({
      task: '整理项目',
      catalog: CATALOG,
      contextClock: instant,
      timezone: 'Asia/Shanghai',
      readResults: []
    })
    const local = intlLocal(instant, 'Asia/Shanghai')
    expect(local.date).toBe('2026-10-01')
    expect(local.offset).toBe('UTC+08:00')
    // UTC instant 与 IANA 时区并列,当地日期与偏移来自 Intl 校验
    expect(prompt).toContain(instant)
    expect(prompt).toContain('Asia/Shanghai')
    expect(prompt).toContain(local.date)
    expect(prompt).toContain(local.offset)
  })

  it('纽约 DST:同一渲染规则下夏季偏移 UTC-04:00、冬季 UTC-05:00;与上海同一 instant 当地墙钟不同', () => {
    const summerInstant = '2026-07-01T16:00:00.000Z'
    const winterInstant = '2026-01-15T17:00:00.000Z'
    const summer = buildPlanningPrompt({ task: 't', catalog: CATALOG, contextClock: summerInstant, timezone: 'America/New_York', readResults: [] })
    const winter = buildPlanningPrompt({ task: 't', catalog: CATALOG, contextClock: winterInstant, timezone: 'America/New_York', readResults: [] })

    const summerLocal = intlLocal(summerInstant, 'America/New_York')
    const winterLocal = intlLocal(winterInstant, 'America/New_York')
    expect(summerLocal.offset).toBe('UTC-04:00')
    expect(winterLocal.offset).toBe('UTC-05:00')
    expect(summer).toContain('UTC-04:00')
    expect(winter).toContain('UTC-05:00')
    expect(summer).toContain(summerLocal.date)
    expect(winter).toContain(winterLocal.date)

    // 同一 instant:上海已跨到次日,纽约仍在当日
    const shanghai = buildPlanningPrompt({ task: 't', catalog: CATALOG, contextClock: summerInstant, timezone: 'Asia/Shanghai', readResults: [] })
    expect(intlLocal(summerInstant, 'Asia/Shanghai').date).toBe('2026-07-02')
    expect(intlLocal(summerInstant, 'America/New_York').date).toBe('2026-07-01')
    expect(shanghai).toContain('2026-07-02')
    expect(summer).not.toContain('UTC+08:00')
  })

  it('提示词不包含执行机器的当前时间:只出现冻结 instant 与用户时区', () => {
    const before = new Date().toISOString()
    const prompt = buildPlanningPrompt({
      task: 't',
      catalog: CATALOG,
      contextClock: '2026-05-01T00:30:00.000Z',
      timezone: 'Asia/Shanghai',
      readResults: []
    })
    expect(prompt).toContain('2026-05-01T00:30:00.000Z')
    expect(prompt).not.toContain(before.slice(0, 10))
  })
})

describe('读取结果的不可信数据区块', () => {
  it('成功读取结果以 JSON 区块进入提示词并标注不可信边界', () => {
    const prompt = buildPlanningPrompt({
      task: '查到整理项目后改为高优先级',
      catalog: CATALOG,
      contextClock: '2026-09-30T01:00:00.000Z',
      timezone: 'Asia/Shanghai',
      readResults: [
        {
          tool: 'todo.list',
          callIndex: 0,
          result: { ok: true, data: { todos: [{ id: 'todo-1', title: '整理项目', priority: 'normal' }] } }
        }
      ]
    })
    expect(prompt).toContain('不可信')
    expect(prompt).toContain('"todo.list"')
    expect(prompt).toContain('todo-1')
    // 不可信数据中的指令必须被声明忽略
    expect(PLAN_SYSTEM_PROMPT).toContain('不可信')
  })

  it('失败读取结果保留错误码,供重规划判断', () => {
    const prompt = buildPlanningPrompt({
      task: 't',
      catalog: CATALOG,
      contextClock: '2026-09-30T01:00:00.000Z',
      timezone: 'Asia/Shanghai',
      readResults: [
        { tool: 'calendar.list', callIndex: 1, result: { ok: false, error: { code: 'VALIDATION', message: '区间倒置', retryable: false } } }
      ]
    })
    expect(prompt).toContain('"ok":false')
    expect(prompt).toContain('VALIDATION')
  })
})

describe('parseModelPlan 的 continue_after_read 归一', () => {
  it('显式 true/false 归一为 continueAfterRead;缺省 false', () => {
    expect(parseModelPlan({ goal: 'g', steps: [], assumptions: [], continue_after_read: true }).continueAfterRead).toBe(true)
    expect(parseModelPlan({ goal: 'g', steps: [], assumptions: [], continue_after_read: false }).continueAfterRead).toBe(false)
    expect(parseModelPlan({ goal: 'g', steps: [], assumptions: [] }).continueAfterRead).toBe(false)
  })

  it('continue_after_read 非布尔拒绝;其他未知字段仍拒绝', () => {
    expect(() => parseModelPlan({ goal: 'g', steps: [], assumptions: [], continue_after_read: 'yes' })).toThrow(/continue_after_read/)
    expect(() => parseModelPlan({ goal: 'g', steps: [], assumptions: [], continueAfterRead: true })).toThrow(/未知字段/)
  })

  it('系统提示声明 continue_after_read 语义与 DST 歧义处理', () => {
    expect(PLAN_SYSTEM_PROMPT).toContain('continue_after_read')
    expect(PLAN_SYSTEM_PROMPT).toContain('歧义')
    expect(PLAN_SYSTEM_PROMPT).toContain('澄清')
  })
})

describe('入队前的时区与时钟校验', () => {
  it('非法时区在 createRun 入队前拒绝,不落运行记录', async () => {
    const db = await makeTestDb()
    initWorkspaceEpoch()
    expect(() =>
      createRun(db, { mode: 'personal_ops' as RunMode, input: 'x', contextClock: '2026-09-30T01:00:00.000Z', timezone: 'Mars/Olympus' })
    ).toThrow(/时区/)
    expect(db.all('SELECT * FROM agent_runs')).toHaveLength(0)
  })

  it('非法 contextClock 在入队前拒绝,不落运行记录', async () => {
    const db = await makeTestDb()
    initWorkspaceEpoch()
    expect(() => createRun(db, { mode: 'personal_ops' as RunMode, input: 'x', contextClock: 'not-a-date' })).toThrow(/时间/)
    expect(db.all('SELECT * FROM agent_runs')).toHaveLength(0)
  })

  it('编排器 startRun 同样拒绝非法时区', async () => {
    const db = await makeTestDb()
    initWorkspaceEpoch()
    const registry = new ToolRegistry()
    registerOpsTools(registry)
    const orchestrator = new RunOrchestrator({
      db,
      registry,
      gateway: new ToolGateway({ db, registry, clock: systemClock }),
      queue: new RunQueue(db)
    })
    expect(() => orchestrator.startRun({ mode: 'personal_ops' as RunMode, input: '任务', timezone: 'Nope/Nope' })).toThrow(/时区/)
    expect(db.all('SELECT * FROM agent_runs')).toHaveLength(0)
  })

  it('合法时区与时钟正常入队', async () => {
    const db = await makeTestDb()
    initWorkspaceEpoch()
    const run = createRun(db, {
      mode: 'personal_ops' as RunMode,
      input: 'x',
      contextClock: '2026-09-30T01:00:00.000Z',
      timezone: 'America/New_York'
    })
    expect(run.timezone).toBe('America/New_York')
    expect(run.contextClock).toBe('2026-09-30T01:00:00.000Z')
  })
})

describe('延迟澄清后仍用原 contextClock', () => {
  it('回答触发的重新规划仍携带创建时冻结的时钟与时区', async () => {
    const db = await makeTestDb()
    initWorkspaceEpoch()
    const registry = new ToolRegistry()
    registerOpsTools(registry)
    const prompts: string[] = []
    const provider = new FakeProvider({
      script: (_callIndex, request) => {
        prompts.push(request.prompt)
        return { goal: 'g', steps: [], assumptions: [], clarifications: [{ question_id: 'q', question: '补充?' }] }
      }
    })
    const orchestrator = new RunOrchestrator({
      db,
      registry,
      gateway: new ToolGateway({ db, registry, clock: systemClock }),
      queue: new RunQueue(db),
      completer: provider
    })
    const run = createRun(db, {
      mode: 'personal_ops' as RunMode,
      input: '任务',
      contextClock: '2026-09-20T01:00:00.000Z',
      timezone: 'Asia/Shanghai'
    })
    await orchestrator.drivePlanning(run.runId)
    expect(getRun(db, run.runId)?.status).toBe('awaiting_input')
    expect(prompts[0]).toContain('2026-09-20T01:00:00.000Z')

    // 澄清重入(时间已流逝):重新规划仍用原 contextClock,而非当前系统时间
    await orchestrator.submitAnswers(run.runId, [{ questionId: 'q', answer: '答案' }])
    expect(prompts.length).toBe(2)
    expect(prompts[1]).toContain('2026-09-20T01:00:00.000Z')
    expect(prompts[1]).toContain('Asia/Shanghai')
    expect(prompts[1]).toContain('答案')
    // 二轮仍要求澄清:INPUT_INSUFFICIENT 显式失败
    expect(getRun(db, run.runId)?.status).toBe('failed')
    expect(getRun(db, run.runId)?.errorCode).toBe('INPUT_INSUFFICIENT')
  })
})
