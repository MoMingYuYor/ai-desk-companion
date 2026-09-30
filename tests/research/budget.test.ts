// R-04 预算账本测试:六次调用用尽、受控重试、审核预留先于抽取、活动时间窗与
// 暂停/恢复、时限置位、收尾段单独计时、finalize 判定、审核打包与序列化恢复。
// 覆盖执行清单步骤 16 的预算相关验收项。
import { describe, expect, it } from 'vitest'
import { systemClock } from '../../src/shared/clock'
import type { Clock } from '../../src/shared/clock'
import {
  FINALIZE_SEGMENT_LIMIT_MS,
  isBudgetExhaustedError,
  BudgetExhaustedError,
  createLedger,
  deserializeLedger,
  finalizeOutcome,
  packageReviewClaims,
  restoreLedger,
  type ReviewClaimCandidate
} from '../../src/main/research/budget'
import { resolveResearchBudget } from '../../src/main/research/schemas'
import { OperationError } from '../../src/main/db/operations'

// ---------- 可控单调时钟:测试内自建 fake Clock,monotonicMs 不冻结 ----------

/** 手动推进的单调时钟:now() 固定领域时间,monotonicMs 按推进量返回(始终前进) */
function makeManualClock(): Clock & { advance(ms: number): void } {
  let monotonic = 0
  return {
    now: () => new Date('2026-09-27T08:00:00.000Z'),
    monotonicMs: () => monotonic,
    advance: (ms: number) => {
      expect(ms).toBeGreaterThanOrEqual(0)
      monotonic += ms
    }
  }
}

/** 新建默认预算账本并完成领取后的计时开始 */
function freshLedger(budget?: unknown) {
  const clock = makeManualClock()
  const ledger = createLedger({ budget, clock })
  ledger.activity.start()
  return { clock, ledger }
}

/** 走完「规划 → 定稿 → 审核预留」前缀,进入可抽取状态 */
function planAndReserveReview(ledger: ReturnType<typeof createLedger>, subquestions = 3): void {
  ledger.reserve('planning')
  ledger.sealPlan(subquestions)
  ledger.reserve('review')
}

// ---------- 调用配额账本:六次调用用尽 ----------

describe('六次调用用尽', () => {
  it('规划1 + 抽取3 + 审核1 + 组织1 恰好用满,第 7 次 reserve 抛错', () => {
    const { ledger } = freshLedger()
    planAndReserveReview(ledger)
    for (let i = 0; i < 3; i += 1) ledger.reserve('extraction')
    ledger.markSynthesisReady()
    ledger.reserve('synthesis')
    expect(ledger.remainingModelCalls).toBe(0)
    // 第 7 次:组织槽位的重试——总额已尽,抛 BudgetExhaustedError
    expect(() => ledger.reserve('synthesis', { isRetry: true })).toThrow(BudgetExhaustedError)
  })

  it('抽取槽位第 4 次预留抛槽位容量耗尽', () => {
    const { ledger } = freshLedger()
    planAndReserveReview(ledger)
    for (let i = 0; i < 3; i += 1) ledger.reserve('extraction')
    expect(() => ledger.reserve('extraction')).toThrowError(/抽取槽位配额已用尽|extraction 槽位配额已用尽/)
  })

  it('规划槽位只允许消耗一次', () => {
    const { ledger } = freshLedger()
    ledger.reserve('planning')
    expect(() => ledger.reserve('planning')).toThrow(/规划槽位/)
  })

  it('max_subqueries 下调时抽取槽位随之收缩(子问题数校验在规划定稿时做)', () => {
    const { ledger } = freshLedger({ max_subqueries: 1, max_model_calls: 6 })
    planAndReserveReview(ledger, 1)
    ledger.reserve('extraction')
    expect(() => ledger.reserve('extraction')).toThrow(BudgetExhaustedError)
  })

  it('定稿子问题数超过下调后的 max_subqueries 抛 VALIDATION', () => {
    const { ledger } = freshLedger({ max_subqueries: 1 })
    ledger.reserve('planning')
    expect(() => ledger.sealPlan(2)).toThrowError(/max_subqueries/)
  })

  it('总额下调到 4 时:规划1+审核1+抽取2 用尽,第 3 次抽取抛总额耗尽', () => {
    const { ledger } = freshLedger({ max_model_calls: 4 })
    planAndReserveReview(ledger, 3)
    ledger.reserve('extraction')
    ledger.reserve('extraction')
    expect(ledger.remainingModelCalls).toBe(0)
    expect(() => ledger.reserve('extraction')).toThrow(BudgetExhaustedError)
  })
})

// ---------- 受控重试 ----------

describe('受控重试', () => {
  it('429/无效输出后的重试占预算且每槽位最多一次', () => {
    const { ledger } = freshLedger()
    planAndReserveReview(ledger)
    ledger.reserve('extraction')
    // 模型返回无效结构化输出 → 重试一次(以子问题为身份):成功
    ledger.reserve('extraction', { isRetry: true, retryKey: 'sub-1' })
    // 已用:规划1 + 审核1 + 抽取1 + 抽取重试1 = 4
    expect(ledger.remainingModelCalls).toBe(2)
    // 同一子问题第二次重试拒绝
    expect(() => ledger.reserve('extraction', { isRetry: true, retryKey: 'sub-1' })).toThrow(/受控重试/)
  })

  it('重试不占槽位容量但占总额;每槽位最多一次受控重试', () => {
    const { ledger } = freshLedger()
    planAndReserveReview(ledger)
    // 总额 6:规划1+审核1 已用 2。抽取 2 次基础 + 1 次重试 = 5,剩 1
    ledger.reserve('extraction')
    ledger.reserve('extraction', { isRetry: true, retryKey: 'sub-1' })
    ledger.reserve('extraction')
    expect(ledger.remainingModelCalls).toBe(1)
    // 第 3 次基础抽取用满总额,但抽取槽位基础用量 3/3 恰好也用满
    ledger.reserve('extraction')
    expect(ledger.remainingModelCalls).toBe(0)
    // 同一子问题已重试过一次:被「每子问题最多一次受控重试」守卫拒绝(先于总额判定)
    expect(() => ledger.reserve('extraction', { isRetry: true, retryKey: 'sub-1' })).toThrow(/受控重试/)
    // 另一账本:抽取容量 3 用尽后,基础预留抛槽位容量;重试不占容量,总额允许时放行
    const second = freshLedger()
    planAndReserveReview(second.ledger)
    for (let i = 0; i < 3; i += 1) second.ledger.reserve('extraction')
    expect(second.ledger.remainingModelCalls).toBe(1)
    second.ledger.reserve('extraction', { isRetry: true, retryKey: 'sub-3' })
    expect(second.ledger.remainingModelCalls).toBe(0)
  })

  it('剩余不足时受控重试被拒绝', () => {
    const { ledger } = freshLedger({ max_model_calls: 4 })
    planAndReserveReview(ledger, 3)
    ledger.reserve('extraction')
    // 总额 4:规划1+审核1+抽取1 = 3,剩 1 → 抽取重试用掉最后额度
    ledger.reserve('extraction', { isRetry: true, retryKey: 'sub-1' })
    expect(ledger.remainingModelCalls).toBe(0)
    // 审核槽位的基础调用已消耗、尚未重试,但剩余不足 → 受控重试被拒绝
    expect(() => ledger.reserve('review', { isRetry: true })).toThrow(BudgetExhaustedError)
  })

  it('无基础调用时重试拒绝', () => {
    const { ledger } = freshLedger()
    planAndReserveReview(ledger)
    expect(() => ledger.reserve('extraction', { isRetry: true })).toThrow(/重试无从谈起|尚无基础调用/)
  })

  it('组织槽位的重试同样占预算且最多一次', () => {
    const { ledger } = freshLedger()
    planAndReserveReview(ledger)
    for (let i = 0; i < 3; i += 1) ledger.reserve('extraction')
    ledger.markSynthesisReady()
    ledger.reserve('synthesis')
    // 总额 6:规划1+审核1+抽取3+组织1 = 6,重试没有剩余预算 → 拒绝
    expect(ledger.remainingModelCalls).toBe(0)
    expect(() => ledger.reserve('synthesis', { isRetry: true })).toThrow(BudgetExhaustedError)
  })
})

// ---------- 阶段顺序:审核预留先于抽取 ----------

describe('审核预留先于抽取', () => {
  it('未定稿不能抽取', () => {
    const { ledger } = freshLedger()
    ledger.reserve('planning')
    expect(() => ledger.reserve('extraction')).toThrow(OperationError)
  })

  it('定稿后、审核预留前抽取被拒绝(审核预留必须在开始抽取前完成)', () => {
    const { ledger } = freshLedger()
    ledger.reserve('planning')
    ledger.sealPlan(3)
    expect(() => ledger.reserve('extraction')).toThrow(/审核预留/)
  })

  it('审核预留后抽取放行;组织槽位在审核完成(markSynthesisReady)后才能预留', () => {
    const { ledger } = freshLedger()
    ledger.reserve('planning')
    ledger.sealPlan(3)
    ledger.reserve('review')
    expect(() => ledger.reserve('synthesis')).toThrow(/组织槽位/)
    ledger.reserve('extraction')
    ledger.markSynthesisReady()
    ledger.reserve('synthesis')
    expect(ledger.currentPhase).toBe('synthesis')
  })

  it('审核槽位重复预留拒绝', () => {
    const { ledger } = freshLedger()
    ledger.reserve('planning')
    ledger.sealPlan(3)
    ledger.reserve('review')
    // 阶段已推进,重复预留按「开始抽取前」窗口约束拒绝
    expect(() => ledger.reserve('review')).toThrow(/重复预留|开始抽取前/)
  })

  it('markSynthesisReady 要求审核槽位已预留;未预留时拒绝', () => {
    const { ledger } = freshLedger()
    ledger.reserve('planning')
    ledger.sealPlan(3)
    // 审核槽位未预留 → 阶段守卫先拒绝
    expect(() => ledger.markSynthesisReady()).toThrow(/审核尚未完成|尚未预留/)
    ledger.reserve('review')
    ledger.markSynthesisReady()
    expect(ledger.currentPhase).toBe('synthesis')
  })
})

// ---------- 活动时间窗 ----------

describe('活动时间窗', () => {
  it('领取后累计活动时间;pause 排除等待用户时间,resume 继续累计', () => {
    const { clock, ledger } = freshLedger()
    clock.advance(30_000)
    expect(ledger.activeMs).toBe(30_000)
    // 澄清等待:awaiting_input 窗口暂停,真实时间流逝不计入
    ledger.activity.pause()
    clock.advance(600_000)
    expect(ledger.activeMs).toBe(30_000)
    ledger.activity.resume()
    clock.advance(10_000)
    expect(ledger.activeMs).toBe(40_000)
  })

  it('剩余活动时间参与模型调用时限:取 min(请求时限, 剩余活动预算)', () => {
    const { clock, ledger } = freshLedger()
    expect(ledger.modelCallTimeoutMs(30_000)).toBe(30_000)
    clock.advance(100_000)
    // 剩余 20 秒 < 请求时限 30 秒 → 取 20 秒
    expect(ledger.modelCallTimeoutMs(30_000)).toBe(20_000)
    clock.advance(20_000)
    expect(ledger.remainingActiveMs).toBe(0)
  })

  it('pause/repeat、resume 未暂停、start 重复均抛错', () => {
    const { ledger } = freshLedger()
    // freshLedger 已 start,直接重复 start 应抛错
    expect(() => ledger.activity.start()).toThrow(/已开始/)
    ledger.activity.pause()
    expect(() => ledger.activity.pause()).toThrow(/未在运行/)
    ledger.activity.resume()
    expect(() => ledger.activity.resume()).toThrow(/未暂停/)
    expect(() => ledger.activity.start()).toThrow(/已开始/)
  })

  it('时限到达置位后拒绝一切模型请求;checkDeadline 主动检查', () => {
    const { clock, ledger } = freshLedger()
    clock.advance(119_999)
    expect(ledger.checkDeadline()).toBe(false)
    clock.advance(1)
    expect(ledger.checkDeadline()).toBe(true)
    expect(ledger.isDeadlineReached).toBe(true)
    expect(() => ledger.reserve('planning')).toThrow(BudgetExhaustedError)
    expect(ledger.modelCallTimeoutMs(30_000)).toBe(0)
  })

  it('恢复(resume)在时限已到达后被拒绝;显式 markDeadlineReached 折算在途段', () => {
    const { clock, ledger } = freshLedger()
    ledger.activity.pause()
    ledger.markDeadlineReached()
    clock.advance(5_000)
    expect(() => ledger.activity.resume()).toThrow(/时限已到达/)
    // 在途段在 markDeadlineReached 时已折算,后续时间不累计
    expect(ledger.activeMs).toBe(0)
  })
})

// ---------- 收尾段(最多 2 秒本地持久化,单独记录) ----------

describe('收尾段单独计时', () => {
  it('收尾段单独计时、单独可查,不计入活动时间', () => {
    const { clock, ledger } = freshLedger()
    clock.advance(120_000)
    ledger.checkDeadline()
    ledger.beginFinalizeSegment()
    clock.advance(800)
    expect(ledger.tickFinalizeSegment()).toBe(800)
    expect(ledger.finalizeMs).toBe(800)
    // 活动时间不因收尾段推进
    expect(ledger.activeMs).toBe(120_000)
    clock.advance(1200)
    expect(ledger.finalizeSegmentExceeded()).toBe(false)
    clock.advance(1)
    expect(ledger.finalizeSegmentExceeded()).toBe(true)
    ledger.endFinalizeSegment()
    expect(ledger.finalizeMs).toBe(2001)
    expect(FINALIZE_SEGMENT_LIMIT_MS).toBe(2000)
  })

  it('beginFinalizeSegment 隐含暂停活动计时;收尾段不可重复开始', () => {
    const { clock, ledger } = freshLedger()
    clock.advance(10_000)
    ledger.beginFinalizeSegment()
    clock.advance(500)
    expect(ledger.activeMs).toBe(10_000)
    expect(() => ledger.beginFinalizeSegment()).toThrow(/已开始/)
    ledger.endFinalizeSegment()
    expect(() => ledger.tickFinalizeSegment()).toThrow(/未开始/)
  })
})

// ---------- finalize 收尾判定 ----------

describe('finalizeOutcome 收尾判定', () => {
  it('预算耗尽且已有经检查结论 → partial + skipped 清单 + BUDGET_EXHAUSTED', () => {
    const outcome = finalizeOutcome({
      answeredSubquestionIds: ['sq-1'],
      insufficientSubquestionIds: [],
      skippedSubquestionIds: ['sq-2', 'sq-3'],
      exhaustedByDeadline: false
    })
    expect(outcome).toEqual({
      status: 'partial',
      skippedSubquestions: ['sq-2', 'sq-3'],
      reason: 'BUDGET_EXHAUSTED'
    })
  })

  it('已判定不足项也构成 partial 的可展示产物', () => {
    const outcome = finalizeOutcome({
      answeredSubquestionIds: [],
      insufficientSubquestionIds: ['sq-1'],
      skippedSubquestionIds: ['sq-2'],
      exhaustedByDeadline: true
    })
    expect(outcome.status).toBe('partial')
    expect(outcome.reason).toBe('DEADLINE_REACHED')
  })

  it('完全没有可展示研究产物 → failed', () => {
    const outcome = finalizeOutcome({
      answeredSubquestionIds: [],
      insufficientSubquestionIds: [],
      skippedSubquestionIds: ['sq-1', 'sq-2'],
      exhaustedByDeadline: false
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toBe('BUDGET_EXHAUSTED')
  })

  it('无产物且时限到达 → failed + DEADLINE_REACHED', () => {
    const outcome = finalizeOutcome({
      answeredSubquestionIds: [],
      insufficientSubquestionIds: [],
      skippedSubquestionIds: [],
      exhaustedByDeadline: true
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toBe('DEADLINE_REACHED')
  })
})

// ---------- 审核打包规则 ----------

function claim(claimId: string, priority: number, text = 'claim', spanIds: string[] = []): ReviewClaimCandidate {
  return { claimId, text, supportSpanIds: spanIds, priority }
}

describe('packageReviewClaims 打包规则', () => {
  const spans = [
    { spanId: 's1', text: '支持片段一' },
    { spanId: 's2', text: '支持片段二' }
  ]

  it('按完整 Claim 及其全部支持片段打包', () => {
    const pkg = packageReviewClaims([claim('c1', 1, '命题', ['s1', 's2'])], spans, 100)
    expect(pkg.included).toHaveLength(1)
    expect(pkg.included[0].supportSpanIds).toEqual(['s1', 's2'])
    expect(pkg.uncovered).toEqual([])
  })

  it('超上下文预算时整体移除低优先级候选并记录 uncovered', () => {
    // 成本:候选文本 1 码点 + 支持片段「片段片段片段片段片段」10 码点 = 11
    const longSpans = [{ spanId: 's1', text: '片段片段片段片段片段' }]
    const candidates = [
      claim('c1', 1, '命', ['s1']),
      claim('c2', 2, '题', ['s1']),
      claim('c3', 3, '词', ['s1'])
    ]
    // 预算 23 只够两个候选(22),c3 整体移除
    const pkg = packageReviewClaims(candidates, longSpans, 23)
    expect(pkg.included.map((c) => c.claimId)).toEqual(['c1', 'c2'])
    expect(pkg.uncovered).toEqual(['c3'])
  })

  it('禁止单片段截断:候选证据要么完整进入,要么整体 uncovered', () => {
    // 预算只够 c1 的完整证据,c2 完整放不下 → c2 整体 uncovered,不截断
    const bigSpans = [{ spanId: 'big', text: 'x'.repeat(60) }]
    const candidates = [claim('c1', 1, 'c', ['big']), claim('c2', 2, 'c', ['big'])]
    const pkg = packageReviewClaims(candidates, bigSpans, 65)
    expect(pkg.included.map((c) => c.claimId)).toEqual(['c1'])
    expect(pkg.uncovered).toEqual(['c2'])
  })

  it('不拆成额外调用:uncovered 的候选不产生部分打包形态', () => {
    // s1 长度 5:候选成本 = 文本 1 + 5 = 6
    const candidates = [claim('c1', 1, 't', ['s1']), claim('c2', 2, 't', ['s1'])]
    const pkg = packageReviewClaims(candidates, spans, 8)
    // c1 成本 6 进入后剩 2,c2 成本 6 放不下 → 整体移除
    expect(pkg.included.map((c) => c.claimId)).toEqual(['c1'])
    expect(pkg.uncovered).toEqual(['c2'])
    // included 候选携带完整证据,不存在部分打包形态
    expect(pkg.included[0].text).toBe('t')
    expect(pkg.included[0].supportSpanIds).toEqual(['s1'])
  })

  it('未知片段引用与非法预算抛 VALIDATION', () => {
    expect(() => packageReviewClaims([claim('c1', 1, 't', ['nope'])], spans, 100)).toThrow(OperationError)
    expect(() => packageReviewClaims([], [], 0)).toThrow(OperationError)
  })
})

// ---------- 序列化与重启恢复 ----------

describe('账本序列化与重启恢复', () => {
  it('序列化往返一致', () => {
    const { ledger } = freshLedger({ max_model_calls: 6, max_active_seconds: 60 })
    planAndReserveReview(ledger)
    ledger.reserve('extraction')
    ledger.recordSentAttempt('attempt-1')
    // RES-01:抽取受控重试以子问题 ID 为 retryKey(每子问题单独一次)
    ledger.reserve('extraction', { isRetry: true, retryKey: 'sub-1' })
    const serialized = ledger.serializeLedger()
    const parsed = JSON.parse(JSON.stringify(serialized))
    const restored = deserializeLedger(parsed)
    expect(restored).toEqual(serialized)
    expect(restored.slots.extraction).toEqual({ used: 1, retries: 1 })
    expect(restored.sentAttemptIds).toEqual(['attempt-1'])
    expect(restored.extractionRetryKeys).toEqual(['sub-1'])
    expect(restored.phase).toBe('review_reserved')
  })

  it('恢复后预算不复活:已预留未消费的槽位保持已扣状态', () => {
    const { ledger } = freshLedger()
    planAndReserveReview(ledger)
    for (let i = 0; i < 3; i += 1) ledger.reserve('extraction')
    const restored = restoreLedger({
      serialized: JSON.parse(JSON.stringify(ledger.serializeLedger())),
      clock: systemClock
    })
    // 全部槽位已扣:抽取容量用尽、剩余总额 1
    expect(restored.extractionCapacity).toBe(3)
    expect(restored.remainingModelCalls).toBe(1)
    expect(() => restored.reserve('extraction')).toThrow(BudgetExhaustedError)
    // 规划槽位同样不能重用(重跑规划不能逃过预算)
    expect(() => restored.reserve('planning')).toThrow(/planning 阶段/)
  })

  it('恢复后可继续受控重试且不可超过一次', () => {
    const first = freshLedger()
    first.ledger.reserve('planning')
    first.ledger.sealPlan(1)
    first.ledger.reserve('review')
    first.ledger.reserve('extraction')
    const serialized = JSON.parse(JSON.stringify(first.ledger.serializeLedger()))
    const restored = restoreLedger({ serialized, clock: systemClock })
    // RES-01:抽取重试携带子问题身份;同一子问题最多一次
    restored.reserve('extraction', { isRetry: true, retryKey: 'sub-1' })
    expect(() => restored.reserve('extraction', { isRetry: true, retryKey: 'sub-1' })).toThrow(/受控重试/)
  })

  it('RES-01 每个抽取子问题单独一次重试身份;不能共用标记', () => {
    const { ledger } = freshLedger({ max_model_calls: 6, max_active_seconds: 60 })
    planAndReserveReview(ledger)
    ledger.reserve('extraction')
    ledger.reserve('extraction')
    ledger.reserve('extraction', { isRetry: true, retryKey: 'sub-a' })
    // 不同子问题各自一次重试身份
    ledger.reserve('extraction', { isRetry: true, retryKey: 'sub-b' })
    // 同一子问题第二次重试拒绝;缺 retryKey 的抽取重试拒绝
    expect(() => ledger.reserve('extraction', { isRetry: true, retryKey: 'sub-a' })).toThrow(/受控重试/)
    expect(() => ledger.reserve('extraction', { isRetry: true })).toThrow(/retryKey/)
    // 重试计数与身份一致地进入 checkpoint v2
    const serialized = ledger.serializeLedger()
    expect(serialized.version).toBe(2)
    expect(serialized.extractionRetryKeys.sort()).toEqual(['sub-a', 'sub-b'])
    expect(serialized.slots.extraction).toEqual({ used: 2, retries: 2 })
  })

  it('RES-01 v1 checkpoint 恢复入口保留:恢复后按旧版本续跑由上层拒绝', () => {
    const { ledger } = freshLedger()
    ledger.reserve('planning')
    ledger.sealPlan(1)
    const serialized = ledger.serializeLedger()
    // 模拟历史 v1 checkpoint:剥离 v2 字段并降版本
    const v1 = { ...serialized, version: 1 }
    delete (v1 as Record<string, unknown>).sentAttemptIds
    delete (v1 as Record<string, unknown>).extractionRetryKeys
    const restored = deserializeLedger(v1)
    expect(restored.version).toBe(1)
    expect(restored.sentAttemptIds).toEqual([])
    expect(restored.extractionRetryKeys).toEqual([])
  })

  it('RES-01 规划在途形态(已准入未定稿)可序列化恢复', () => {
    const { ledger } = freshLedger()
    ledger.reserve('planning')
    ledger.recordSentAttempt('attempt-plan-1')
    const restored = restoreLedger({ serialized: JSON.parse(JSON.stringify(ledger.serializeLedger())), clock: systemClock })
    expect(restored.currentPhase).toBe('planning')
    expect(restored.checkpointVersion).toBe(2)
    expect(restored.sentAttemptIdList).toEqual(['attempt-plan-1'])
    // 恢复后规划槽位不可再次预扣(不重发历史请求)
    expect(() => restored.reserve('planning')).toThrow(/规划槽位已用尽/)
  })

  it('活动时间恢复:累计值保留,恢复后按剩余预算计算', () => {
    const first = freshLedger({ max_active_seconds: 60 })
    first.clock.advance(50_000)
    const serialized = JSON.parse(JSON.stringify(first.ledger.serializeLedger()))
    const restored = restoreLedger({ serialized, clock: systemClock })
    expect(restored.activeMs).toBe(50_000)
    expect(restored.remainingActiveMs).toBe(10_000)
    // 恢复后需 resume 重开在途段
    restored.activity.resume()
  })

  it('未知字段拒绝', () => {
    const { ledger } = freshLedger()
    const serialized = ledger.serializeLedger() as unknown as Record<string, unknown>
    serialized.hackerField = true
    expect(() => deserializeLedger(serialized)).toThrow(/未知字段/)
    const slotsBad = { ...ledger.serializeLedger() }
    slotsBad.slots = { ...slotsBad.slots, extra: { used: 0, retries: 0 } } as typeof slotsBad.slots
    expect(() => deserializeLedger(slotsBad)).toThrow(/四个槽位/)
  })

  it('非法状态拒绝:负数计数、超上限、状态机不合法', () => {
    const base = freshLedger()
    planAndReserveReview(base.ledger)
    const good = base.ledger.serializeLedger()

    const negative = JSON.parse(JSON.stringify(good))
    negative.slots.extraction.used = -1
    expect(() => deserializeLedger(negative)).toThrow(/非负整数/)

    const overCapacity = JSON.parse(JSON.stringify(good))
    overCapacity.slots.review.used = 5
    expect(() => deserializeLedger(overCapacity)).toThrow(/超过容量/)

    const overTotal = JSON.parse(JSON.stringify(good))
    overTotal.slots.extraction = { used: 3, retries: 1 }
    overTotal.slots.review = { used: 1, retries: 1 }
    expect(() => deserializeLedger(overTotal)).toThrow(/总额/)

    const badPhase = JSON.parse(JSON.stringify(good))
    badPhase.phase = 'planning'
    expect(() => deserializeLedger(badPhase)).toThrow(/planning 不允许/)

    const retryNoBase = JSON.parse(JSON.stringify(good))
    retryNoBase.slots.extraction = { used: 0, retries: 1 }
    expect(() => deserializeLedger(retryNoBase)).toThrow(/重试必须建立在基础调用之上/)

    const badBudget = JSON.parse(JSON.stringify(good))
    badBudget.budget = { ...good.budget, max_model_calls: 999 }
    expect(() => deserializeLedger(badBudget)).toThrow(OperationError)
  })

  it('预算覆盖值复用 resolveResearchBudget:上调与未知字段拒绝(不重写)', () => {
    expect(() => createLedger({ clock: systemClock, budget: { max_model_calls: 999 } })).toThrow(OperationError)
    expect(() => createLedger({ clock: systemClock, budget: { unknown_field: 1 } })).toThrow(/未知字段/)
    expect(createLedger({ clock: systemClock, budget: { max_model_calls: 3 } }).budgetSnapshot).toEqual(
      resolveResearchBudget({ max_model_calls: 3 })
    )
  })
})
