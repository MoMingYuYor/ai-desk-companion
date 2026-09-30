// R-07 集成测试:research_v1 数据集接入 Eval 隔离执行体系,证明用例可运行。
//
// 范围声明(与交付一致):全量 40 条真实模型执行属 E-08/M6 范围,本集成只证明通路——
// (a) loadDatasetFromDir 装载 40 条(六组、split 24+16 由 gold_integrity 覆盖,此处复核);
// (b) 3 条代表性 case 端到端:locate 组 1 条(dev)完整研究链、insufficient 组 1 条
//     空候选诚实不足、injection 组 1 条 forbidden_tools 断言;
// (c) 结果记录含 run_id(traceRunId),失败案例可经其回放研究轨迹。
// 其余 37 条以 loader 校验(parse + fixture 语料存在 + gold 结构)覆盖可运行性声明。
//
// EVAL-03 扩展:3 条代表 case 的可回放产物(8 文件 + manifest hash)、删除临时库后
// 仅用产物重建时间线/报告/证据/原文定位、hash 篡改拒绝评分、gold 判分产出
// (recall/覆盖率数字如实记录——fake 脚本的抽取是为通过构造的,属流程验证
// 而非语义成绩;正式 holdout 支持度由 EVAL-04 人工审阅产生)。
import { describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDatasetFromDir } from '../../src/main/evals/dataset'
import { EvalRunner } from '../../src/main/evals/runner'
import type { EvalCase } from '../../src/main/evals/types'
import { registerResearchFixtures, RESEARCH_FIXTURE_ROOT } from '../../src/main/evals/researchAdapter'
import { CASE_ARTIFACT_FILES, caseArtifactDir, loadCaseArtifacts, verifyCaseArtifacts } from '../../src/main/evals/artifacts'
import type { ResearchScoreResult } from '../../src/main/evals/researchRules'

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
      dataset: { ...dataset, cases } as typeof dataset,
      // EVAL-03:gold 标注从数据集目录的 annotations/ 读取(评测判分专用)
      datasetRoot: DATA_DIR
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

// ---------- EVAL-03:可回放产物与 gold 判分 ----------

const REPRESENTATIVE = ['research-locate-001', 'research-insufficient-001', 'research-injection-001']

describe('EVAL-03:3 条代表 case 产物齐全且 manifest 完整(fake 隔离执行)', () => {
  const dataset = loadDatasetFromDir(DATA_DIR)
  registerResearchFixtures(dataset.cases.map((c) => c.fixture_id))

  it('每条 case 在 <evalRunId>/<configId>/<caseId>/<repeatIndex>/ 下产出 8 个文件', async () => {
    const { runner, artifactRoot } = runnerFor(dataset, ['dev'], REPRESENTATIVE)
    const state = await runner.run()
    expect(state.status).toBe('completed')
    for (const r of state.results) {
      expect(r.artifactStatus).toBe('ok')
      expect(r.artifactDir).toBe([state.evalRunId, r.configId, r.caseId, String(r.repeatIndex)].join('/'))
      const dir = caseArtifactDir(artifactRoot, state.evalRunId, r.configId, r.caseId, r.repeatIndex)
      for (const name of [...CASE_ARTIFACT_FILES, 'manifest.json']) {
        expect(existsSync(join(dir, name)), `${r.caseId} 缺少 ${name}`).toBe(true)
      }
      const verified = verifyCaseArtifacts(dir)
      expect(verified.ok, JSON.stringify(verified)).toBe(true)
      expect(verified.manifest?.runId).toBe(r.runId)
      expect(verified.manifest?.complete).toBe(true)
      // 临时库移入批次 temporary/ 下(隔离目录随 dispose 清理,父目录保留)
      expect(existsSync(join(artifactRoot, state.evalRunId, 'temporary'))).toBe(true)
    }
  }, 60_000)

  it('删除临时库后仅用产物文件重建时间线、报告、证据与原文定位', async () => {
    const { runner, artifactRoot } = runnerFor(dataset, ['dev'], ['research-locate-001'])
    const state = await runner.run()
    const r = state.results.find((x) => x.caseId === 'research-locate-001')!
    expect(r.artifactStatus).toBe('ok')
    const dir = caseArtifactDir(artifactRoot, state.evalRunId, r.configId, r.caseId, r.repeatIndex)

    // 关闭后删除临时库(整批 temporary/ 一并删除,模拟批次收尾清理)
    rmSync(join(artifactRoot, state.evalRunId, 'temporary'), { recursive: true, force: true })

    // 仅用产物文件回放:hash 校验通过后逐文件读取
    const loaded = loadCaseArtifacts(dir) // 篡改或缺失会抛 ArtifactIntegrityError
    // 时间线:trace.jsonl 覆盖研究链各阶段(input/plan/retrieval/model/output…)
    const eventTypes = new Set(loaded.traceEvents.map((e) => e.eventType as string))
    expect(eventTypes.has('input')).toBe(true)
    expect(eventTypes.has('retrieval')).toBe(true)
    expect(eventTypes.has('output')).toBe(true)
    // 报告:最新版本 + 结构化字段完整
    const report = loaded.report as { report_applicable: boolean; report: { markdown: string; claims: unknown[]; citations: unknown[]; sections: unknown[] } | null }
    expect(report.report_applicable).toBe(true)
    expect(report.report).not.toBeNull()
    expect(report.report!.markdown).toContain('## ')
    expect(report.report!.claims.length).toBeGreaterThan(0)
    // 证据:claim_type 为抽取期保存的分类(不事后改标签)
    const evidence = loaded.evidence as { applicable: boolean; claims: Array<{ claim_type: string }>; spans: Array<{ evidence_id: string; snapshot_id: string; start_offset: number; end_offset: number; quote: string }> }
    expect(evidence.applicable).toBe(true)
    expect(evidence.claims[0]!.claim_type).toBe('fact')
    // 原文定位:用产物内的规范全文按 span offset 重切片,必须与 quote 逐字一致
    const snapshots = loaded.snapshots as { applicable: boolean; snapshots: Array<{ snapshot_id: string; normalized_text: string; text_sha256: string }> }
    expect(snapshots.applicable).toBe(true)
    const textById = new Map(snapshots.snapshots.map((s) => [s.snapshot_id, s.normalized_text]))
    expect(evidence.spans.length).toBeGreaterThan(0)
    for (const span of evidence.spans) {
      const resliced = Array.from(textById.get(span.snapshot_id) ?? '').slice(span.start_offset, span.end_offset).join('')
      expect(resliced).toBe(span.quote)
    }
  }, 60_000)

  it('篡改一个产物文件:hash 校验失败且拒绝继续评分', async () => {
    const { runner, artifactRoot } = runnerFor(dataset, ['dev'], ['research-locate-001'])
    const state = await runner.run()
    const r = state.results.find((x) => x.caseId === 'research-locate-001')!
    const dir = caseArtifactDir(artifactRoot, state.evalRunId, r.configId, r.caseId, r.repeatIndex)
    writeFileSync(join(dir, 'evidence.json'), '{"applicable": true, "tampered": true}', 'utf-8')
    const verified = verifyCaseArtifacts(dir)
    expect(verified.ok).toBe(false)
    expect(verified.mismatched).toEqual(['evidence.json'])
    expect(() => loadCaseArtifacts(dir)).toThrow(/完整性校验失败/)
  }, 60_000)

  it('gold 判分产出:结构/语义分列,locate 记录真实数字,insufficient 覆盖 N/A + 不足识别正确', async () => {
    const { runner, artifactRoot } = runnerFor(dataset, ['dev'], REPRESENTATIVE)
    const state = await runner.run()
    const scoringOf = (caseId: string): ResearchScoreResult => {
      const r = state.results.find((x) => x.caseId === caseId)!
      expect(r.researchScoring, `${caseId} 缺少 gold 判分`).toBeTruthy()
      return r.researchScoring as ResearchScoreResult
    }

    // gold 不得进入运行输入:run.json 的输入只有 question/snapshot_ids
    const locate = state.results.find((x) => x.caseId === 'research-locate-001')!
    const dirLocate = caseArtifactDir(artifactRoot, state.evalRunId, locate.configId, locate.caseId, locate.repeatIndex)
    const runJson = JSON.stringify(loadCaseArtifacts(dirLocate).run)
    expect(runJson).not.toContain('gold_claim')
    expect(runJson).not.toContain('acceptable_evidence_sets')

    // 单文档定位:gold 2 条 claim 全部唯一定位;引用结构 100%(冻结引用均过结构终检);
    // recall 数字如实记录(fake 抽取按构造命中与否不构成语义成绩)
    const locateScore = scoringOf('research-locate-001')
    expect(locateScore.applicable).toBe(true)
    expect(locateScore.questions).toHaveLength(2)
    for (const q of locateScore.questions) {
      expect(q.resolutionError).toBeNull()
      expect(q.resolvedSnapshotIds.length).toBeGreaterThan(0)
      expect(q.goldChunkIds.length).toBeGreaterThan(0)
    }
    expect(locateScore.citationStructure.total).toBeGreaterThan(0)
    expect(locateScore.citationStructure.precision).toBe(1)
    expect(locateScore.factCoverage.total).toBeGreaterThan(0)
    expect(locateScore.factCoverage.value).toBe(1)
    expect(locateScore.insufficiency).toEqual({ expected: false, recognized: false, pass: null })
    expect(locateScore.semanticSupport).toBe('pending_human_review')
    // 流程验证数字(非语义成绩):recall ∈ [0,1] 或 null(gold 定位失败单列)
    if (locateScore.recallMacro !== null) {
      expect(locateScore.recallMacro).toBeGreaterThanOrEqual(0)
      expect(locateScore.recallMacro).toBeLessThanOrEqual(1)
    }
    // 实测记录(repeat 1,流程验证而非语义成绩):recallMacro = 1
    // (gc-locate-001-1/-2 的 gold span 均唯一解析到同一真实快照,交付 chunk 与
    // 两个 gold span 相交,交付集合命中全部 gold chunk);citationStructure
    // 2/2(precision 1);factCoverage 2/2 = 1(两条 fact claim 各有 1 条有效
    // supports 引用)。fake 脚本的抽取按交付 chunk 构造,以上数字只证明判分
    // 通路,不代表模型检索/命题支持能力。

    // 证据不足:gold_claims 为空 → recall N/A;零事实 claim → 覆盖 N/A;不足识别正确
    const insuffScore = scoringOf('research-insufficient-001')
    expect(insuffScore.applicable).toBe(true)
    expect(insuffScore.recallMacro).toBeNull()
    expect(insuffScore.factCoverage).toEqual({ covered: 0, total: 0, value: null })
    expect(insuffScore.insufficiency).toEqual({ expected: true, recognized: true, pass: true })

    // 提示注入:gold 判分同样产出(终态与 forbidden 断言之外的结构/语义单列)
    const injectionScore = scoringOf('research-injection-001')
    expect(injectionScore.applicable).toBe(true)
    expect(injectionScore.semanticSupport).toBe('pending_human_review')
  }, 90_000)
})
