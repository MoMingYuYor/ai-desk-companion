// R-07 集成测试:research_v1 数据集接入 Eval 隔离执行体系,证明用例可运行。
//
// 范围声明(与交付一致):全量 40 条真实模型执行属 E-08/M6 范围,本集成只证明通路——
// (a) loadDatasetFromDir 装载 40 条(六组、split 24+16 由 gold_integrity 覆盖,此处复核);
// (b) 3 条代表性 case 端到端:locate 组 1 条(dev)完整研究链、insufficient 组 1 条
//     空候选诚实不足、injection 组 1 条 forbidden_tools 断言;
// (c) 结果记录含 run_id(traceRunId),失败案例可经其回放研究轨迹。
// 其余 37 条以 loader 校验(parse + fixture 语料存在 + gold 结构)覆盖可运行性声明。
import { describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDatasetFromDir } from '../../src/main/evals/dataset'
import { EvalRunner } from '../../src/main/evals/runner'
import type { EvalCase } from '../../src/main/evals/types'
import { registerResearchFixtures, RESEARCH_FIXTURE_ROOT } from '../../src/main/evals/researchAdapter'

const ROOT = process.cwd()
const DATA_DIR = join(ROOT, 'evals', 'datasets', 'research_v1')

function runnerFor(
  dataset: ReturnType<typeof loadDatasetFromDir>,
  splits: Array<'dev' | 'holdout'>,
  caseIds: string[]
): { runner: EvalRunner; artifactRoot: string } {
  const cases = dataset.cases.filter((c) => caseIds.includes(c.case_id))
  const artifactRoot = mkdtempSync(join(tmpdir(), 'eval-research-'))
  const runner = new EvalRunner(
    {
      artifactRoot,
      sqlJsDistDir: join(process.cwd(), 'node_modules', 'sql.js', 'dist'),
      dataset: { ...dataset, cases } as typeof dataset
    },
    {
      evalRunId: `eval-research-${Math.random().toString(36).slice(2, 8)}`,
      datasetVersion: dataset.manifest.dataset_version,
      casesSha256: dataset.casesSha256,
      splits,
      configIds: ['fake_research'],
      executionKind: 'fake',
      repeats: 1,
      maxCases: caseIds.length,
      status: 'running',
      startedAt: '2026-09-28T01:00:00.000Z',
      finishedAt: null,
      results: []
    }
  )
  return { runner, artifactRoot }
}

describe('R-07 集成:research_v1 数据集装载与 fixture 材料', () => {
  const dataset = loadDatasetFromDir(DATA_DIR)

  it('(a) 40 条装载,六组构成与 split 冻结(gold_integrity 复核)', () => {
    expect(dataset.cases).toHaveLength(40)
    expect(dataset.dev).toHaveLength(24)
    expect(dataset.holdout).toHaveLength(16)
    expect(Object.keys(dataset.manifest.categories)).toHaveLength(6)
    expect(dataset.cases.every((c) => c.mode === 'research')).toBe(true)
  })

  it('37 条非代表性 case 的可运行性:fixture 语料目录存在且每条 gold 结构完整', () => {
    const representative = new Set(['research-locate-001', 'research-insufficient-001', 'research-injection-001'])
    const rest = dataset.cases.filter((c) => !representative.has(c.case_id))
    expect(rest).toHaveLength(37)
    for (const c of rest as EvalCase[]) {
      // fixture 语料目录存在(端到端 seed 的前提)
      expect(existsSync(join(RESEARCH_FIXTURE_ROOT, c.fixture_id)), `缺少语料:${c.fixture_id}`).toBe(true)
      // gold 标注结构完整(case_id 对应、 adjudicated、证据集合形状)
      const goldPath = join(DATA_DIR, 'annotations', `${c.case_id}.json`)
      expect(existsSync(goldPath), `缺少 gold:${c.case_id}`).toBe(true)
      const gold = JSON.parse(readFileSync(goldPath, 'utf-8')) as {
        case_id: string
        annotation: { status: string }
        gold_claims: Array<{ gold_claim_id: string; acceptable_evidence_sets: unknown[][] }>
        forbidden_actions: string[]
      }
      expect(gold.case_id).toBe(c.case_id)
      expect(gold.annotation.status).toBe('adjudicated')
      // 证据不足组 gold_claims 为空 + missing 语义;其余组至少一个证据集合
      if (c.category === '证据不足') {
        expect(gold.gold_claims).toHaveLength(0)
        expect(c.tags.some((t) => t.startsWith('missing:'))).toBe(true)
      } else {
        for (const claim of gold.gold_claims) {
          expect(claim.acceptable_evidence_sets.length).toBeGreaterThan(0)
        }
      }
      // 注入组 forbidden 断言形状(EvalCase 侧)
      if (c.category === '提示注入') {
        for (const act of ['todo.create', 'http.fetch', 'shell.exec']) {
          expect(c.expected.forbidden_tools).toContain(act)
        }
      }
      // 终态与预算形状(端到端判定的前提)
      expect(['succeeded', 'partial']).toContain(c.expected.terminal_status)
      expect(c.budgets.max_model_calls).toBeLessThanOrEqual(6)
    }
  })

  it('全部 40 个 fixture_id 注册后可播种(注册表幂等)', () => {
    expect(() => registerResearchFixtures(dataset.cases.map((c) => c.fixture_id))).not.toThrow()
    // 幂等:重复注册不再抛错
    expect(() => registerResearchFixtures(dataset.cases.map((c) => c.fixture_id))).not.toThrow()
  })
})

describe('R-07 集成:3 条代表性 case 端到端(fake 隔离执行)', () => {
  const dataset = loadDatasetFromDir(DATA_DIR)
  registerResearchFixtures(dataset.cases.map((c) => c.fixture_id))

  it('单文档定位(dev):完整研究链 succeeded,报告落库,run_id 存在', async () => {
    const { runner } = runnerFor(dataset, ['dev'], ['research-locate-001'])
    const state = await runner.run()
    expect(state.status).toBe('completed')
    const r = state.results.find((x) => x.caseId === 'research-locate-001')!
    expect(r.status).toBe('passed')
    expect(r.terminalStatus).toBe('succeeded')
    expect(r.runId).toBeTruthy()
    expect(r.traceRunId).toBe(r.runId)
    expect(r.failureReasons).toEqual([])
  })

  it('证据不足(dev):空候选诚实不足,succeeded 与 gold_claims 为空兼容', async () => {
    const { runner } = runnerFor(dataset, ['dev'], ['research-insufficient-001'])
    const state = await runner.run()
    const r = state.results.find((x) => x.caseId === 'research-insufficient-001')!
    expect(r.status).toBe('passed')
    expect(r.terminalStatus).toBe('succeeded')
    expect(r.runId).toBeTruthy()
  })

  it('提示注入(dev):forbidden_tools 全程未被调用,trace 无工具调用', async () => {
    const { runner } = runnerFor(dataset, ['dev'], ['research-injection-001'])
    const state = await runner.run()
    const r = state.results.find((x) => x.caseId === 'research-injection-001')!
    expect(r.status).toBe('passed')
    expect(r.terminalStatus).toBe('succeeded')
    expect(r.executedTools).toEqual([]) // 研究链不产生 tool_call 轨迹
    expect(r.runId).toBeTruthy()
  })

  it('结果记录携带 traceRunId 并持久化到 state.json(E-08 可回放)', async () => {
    const { runner, artifactRoot } = runnerFor(dataset, ['dev'], ['research-locate-001', 'research-insufficient-001'])
    const state = await runner.run()
    expect(state.results).toHaveLength(2)
    for (const r of state.results) {
      expect(r.traceRunId).toBe(r.runId)
      expect(typeof r.traceRunId).toBe('string')
    }
    // 持久化形态包含 traceRunId 字段,与内存结果一致(最小扩展不破坏既有 state.json 契约)
    const persisted = JSON.parse(readFileSync(join(artifactRoot, state.evalRunId, 'state.json'), 'utf-8')) as {
      evalRunId: string
      results: Array<{ caseId: string; runId: string | null; traceRunId?: string | null }>
    }
    expect(persisted.evalRunId).toBe(state.evalRunId)
    for (const r of state.results) {
      const row = persisted.results.find((x) => x.caseId === r.caseId)!
      expect(row.traceRunId).toBe(r.traceRunId)
      expect(row.runId).toBe(r.runId)
    }
  })
})
