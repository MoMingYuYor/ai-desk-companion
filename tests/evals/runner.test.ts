import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDatasetFromText } from '../../src/main/evals/dataset'
import { EvalRunner } from '../../src/main/evals/runner'
import type { EvalCase } from '../../src/main/evals/types'

// E-03:Runner。覆盖:EVAL-03 变体(失败保留在分母)、EVAL-07 预算停止
// not_run 单列、EVAL-10 重启续跑不覆盖、工具序列与终态判定。

const NOW = '2026-09-28T01:00:00.000Z'

function caseLine(id: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    case_id: id,
    dataset_version: 'personal_ops_v1',
    mode: 'personal_ops',
    category: '可撤销写',
    split: 'dev',
    input: `任务 ${id}`,
    fixture_id: 'ops-empty',
    clock: NOW,
    timezone: 'Asia/Shanghai',
    expected: {
      terminal_status: 'succeeded',
      tool_sequence: ['todo.create'],
      required_arguments: { 'todo.create': { title: `任务 ${id}` } },
      requires_confirmation: true
    },
    interaction_script: [{ on: 'confirmation', decision: 'approved' }],
    budgets: {},
    tags: [],
    ...over
  })
}

function makeDataset(lines: string[]) {
  return loadDatasetFromText(lines.join('\n'), manifestFor(lines))
}

function manifestFor(lines: string[]): Record<string, unknown> {
  const categories: Record<string, { total: number; dev: number; holdout: number }> = {}
  for (const line of lines) {
    const parsed = JSON.parse(line) as { category: string; split: string }
    const stat = categories[parsed.category] ?? { total: 0, dev: 0, holdout: 0 }
    stat.total += 1
    if (parsed.split === 'dev') stat.dev += 1
    else stat.holdout += 1
    categories[parsed.category] = stat
  }
  return {
    dataset_version: 'personal_ops_v1',
    schema_version: 1,
    cases_sha256: sha(lines.join('\n')),
    categories,
    total: lines.length,
    provenance: '测试'
  }
}

function sha(text: string): string {
  return require('node:crypto').createHash('sha256').update(text).digest('hex')
}

function runnerFor(
  lines: string[],
  over: { repeats?: number; maxCases?: number; splits?: ('dev' | 'holdout')[] } = {}
): { runner: EvalRunner; artifactRoot: string } {
  const dataset = makeDataset(lines)
  const artifactRoot = mkdtempSync(join(tmpdir(), 'eval-run-'))
  const runner = new EvalRunner(
    {
      artifactRoot,
      sqlJsDistDir: join(process.cwd(), 'node_modules', 'sql.js', 'dist'),
      dataset
    },
    {
      evalRunId: `eval-${Math.random().toString(36).slice(2, 8)}`,
      datasetVersion: dataset.manifest.dataset_version,
      casesSha256: dataset.casesSha256,
      splits: over.splits ?? ['dev'],
      configIds: ['fake_flow'],
      executionKind: 'fake',
      repeats: over.repeats ?? 1,
      maxCases: over.maxCases ?? 100,
      status: 'running',
      startedAt: NOW,
      finishedAt: null,
      results: []
    }
  )
  return { runner, artifactRoot }
}

describe('EvalRunner 基本执行', () => {
  it('写案例经批准后通过;轨迹与审批可追溯', async () => {
    const { runner } = runnerFor([caseLine('w1')])
    const state = await runner.run()
    expect(state.status).toBe('completed')
    expect(state.results).toHaveLength(1)
    const r = state.results[0]!
    expect(r.status).toBe('passed')
    expect(r.terminalStatus).toBe('succeeded')
    expect(r.executedTools).toEqual(['todo.create'])
    expect(r.runId).toBeTruthy()
  })

  it('终态不符与工具序列不符:failed 并给出原因', async () => {
    const lines = [
      // 期望 partial 但实际成功:终态不符
      caseLine('w-status', { expected: { terminal_status: 'partial', tool_sequence: ['todo.create'], requires_confirmation: true } }),
      // 期望错误工具序列
      caseLine('w-seq', { expected: { terminal_status: 'succeeded', tool_sequence: ['todo.update'], requires_confirmation: true } })
    ]
    const { runner } = runnerFor(lines)
    const state = await runner.run()
    expect(state.results[0]!.status).toBe('failed')
    expect(state.results[0]!.failureReasons.some((x) => x.includes('终态'))).toBe(true)
    expect(state.results[1]!.status).toBe('failed')
    expect(state.results[1]!.failureReasons.some((x) => x.includes('工具序列'))).toBe(true)
  })

  it('重复执行 repeats=2:每个 repeat 独立隔离环境,都通过', async () => {
    const { runner } = runnerFor([caseLine('w-rep')], { repeats: 2 })
    const state = await runner.run()
    expect(state.results).toHaveLength(2)
    expect(state.results.every((r) => r.status === 'passed')).toBe(true)
    expect(state.results[0]!.runId).not.toBe(state.results[1]!.runId)
  })
})

describe('EVAL-07 预算停止:not_run 单列', () => {
  it('maxCases=1 时第二个案例标 not_run,批次 cancelled', async () => {
    const { runner } = runnerFor([caseLine('w1'), caseLine('w2')], { maxCases: 1 })
    const state = await runner.run()
    expect(state.results.filter((r) => r.status === 'passed')).toHaveLength(1)
    const notRun = state.results.filter((r) => r.status === 'not_run')
    expect(notRun).toHaveLength(1)
    expect(state.status).toBe('cancelled')
  })
})

describe('EVAL-10 重启续跑', () => {
  it('同 evalRunId 重建 runner:跳过已完成组合,不覆盖', async () => {
    const lines = [caseLine('w1'), caseLine('w2')]
    const dataset = makeDataset(lines)
    const artifactRoot = mkdtempSync(join(tmpdir(), 'eval-resume-'))
    const evalRunId = 'eval-resume-test'
    const common = {
      evalRunId,
      datasetVersion: dataset.manifest.dataset_version,
      casesSha256: dataset.casesSha256,
      splits: ['dev' as const],
      configIds: ['fake_flow'],
      executionKind: 'fake' as const,
      repeats: 1,
      maxCases: 100,
      startedAt: NOW,
      finishedAt: null
    }

    const first = new EvalRunner(
      { artifactRoot, sqlJsDistDir: join(process.cwd(), 'node_modules', 'sql.js', 'dist'), dataset },
      { ...common, status: 'running', results: [] }
    )
    await first.run()
    const afterFirst = first.snapshot
    expect(afterFirst.results).toHaveLength(2)

    // 重启:同状态目录重建,所有组合已有结果 → 不重跑
    const second = new EvalRunner(
      { artifactRoot, sqlJsDistDir: join(process.cwd(), 'node_modules', 'sql.js', 'dist'), dataset },
      { ...common, status: 'running', results: [] }
    )
    const state = await second.run()
    expect(state.results).toEqual(afterFirst.results)
  })
})

describe('歧义类案例:澄清轮', () => {
  it('fake 脚本先澄清,脚本回答后继续执行', async () => {
    const lines = [
      caseLine('amb-1', {
        category: '歧义澄清',
        input: '安排项目整理',
        interaction_script: [
          { on: 'clarification', answer: '下周一上午' },
          { on: 'confirmation', decision: 'approved' }
        ],
        expected: {
          terminal_status: 'succeeded',
          tool_sequence: ['todo.create'],
          required_arguments: { 'todo.create': { title: '安排项目整理' } },
          requires_confirmation: true
        }
      })
    ]
    const { runner } = runnerFor(lines)
    const state = await runner.run()
    expect(state.results[0]!.status).toBe('passed')
  })
})
