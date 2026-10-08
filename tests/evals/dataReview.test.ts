// T12 数据审查只读校验：CLI 使用临时合成材料，不修改冻结数据或调用网络。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const CLI = join(ROOT, 'scripts/check-eval-data.mjs')
const hash = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
const textScans = [
  'docs/demos/deep-research-agent.md', 'tests/research/demoRun.test.ts',
  'tests/evals/researchIntegration.test.ts', 'tests/research/gold_integrity.test.ts',
  'src/main/evals/researchAdapter.ts'
]

function save(root: string, file: string, value: unknown): void {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}

function treeHash(root: string): string {
  const entries: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.isDirectory()) walk(join(dir, item.name), `${prefix}${item.name}/`)
      else entries.push(`${prefix}${item.name}:${hash(readFileSync(join(dir, item.name)))}`)
    }
  }
  walk(root, '')
  return hash(entries.join('\n'))
}

function fixture(kind: 'pair' | 'cross-record' | 'wrong-hash' = 'pair'): string {
  const root = mkdtempSync(join(tmpdir(), 't12-data-review-'))
  for (const file of textScans) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    copyFileSync(join(ROOT, file), join(root, file))
  }
  for (const version of ['personal_ops_v1', 'personal_ops_v2']) {
    const cases = [{ case_id: 'synthetic-ops', mode: 'personal_ops', dataset_version: version, category: '只读',
      split: 'dev', fixture_id: 'ops-empty', input: '合成读取任务', budgets: { max_model_calls: 4, max_active_seconds: 60 },
      expected: { terminal_status: 'succeeded', tool_sequence: ['todo.list'] } }]
    const lines = cases.map((c) => JSON.stringify(c)).join('\n') + '\n'
    save(root, `evals/datasets/${version}/cases.jsonl`, lines)
    save(root, `evals/datasets/${version}/manifest.json`, { schema_version: 1, dataset_version: version, total: 1,
      cases_sha256: hash(lines), categories: { 只读: { total: 1, dev: 1, holdout: 0 } } })
  }
  const caseId = 'synthetic-research'
  const fixtureId = 'synthetic'
  const category = '单文档定位'
  const input = '合成岗位的要求是什么'
  const file = kind === 'cross-record' ? 'jd.json' : 'a.md'
  const normalized = kind === 'cross-record' ? '甲🧪\n乙' : '同一合成岗位内容：要求 Python。'
  const source = kind === 'cross-record' ? JSON.stringify([{ description: '甲🧪' }, { description: '乙' }]) : normalized
  const sources = kind === 'pair' ? [file, 'b.md'] : [file]
  const entries = sources.map((name) => {
    save(root, `fixtures/research/${fixtureId}/${name}`, source)
    save(root, `evals/datasets/research_v1/snapshots/${fixtureId}/${name}`, source)
    return { file: name, raw_sha256: hash(source), text_sha256: hash(normalized) }
  })
  save(root, `evals/datasets/research_v1/snapshots/${fixtureId}/manifest.json`, {
    fixture_id: fixtureId, case_id: caseId, normalization_version: 1, entries
  })
  const caseValue = { case_id: caseId, category, input, split: 'dev', mode: 'research', fixture_id: fixtureId,
    dataset_version: 'research_v1', expected: { terminal_status: 'succeeded' } }
  const lines = JSON.stringify(caseValue) + '\n'
  save(root, 'evals/datasets/research_v1/cases.jsonl', lines)
  save(root, 'evals/datasets/research_v1/manifest.json', { schema_version: 1, dataset_version: 'research_v1', total: 1,
    cases_sha256: hash(lines), categories: { [category]: { total: 1, dev: 1, holdout: 0 } } })
  save(root, `evals/datasets/research_v1/annotations/${caseId}.json`, {
    case_id: caseId, group: category, input, split: 'dev', annotation: { status: 'adjudicated', guideline_version: 'research-gold.v1' },
    gold_claims: [{ gold_claim_id: 'synthetic-claim', acceptable_evidence_sets: [[{
      snapshot_id: `${fixtureId}/${file}`, text_sha256: kind === 'wrong-hash' ? '0'.repeat(64) : hash(normalized),
      start_offset: 0, end_offset: Array.from(normalized).length, quote: normalized,
      relation: 'supports', provenance_group_id: 'synthetic-pg'
    }]] }]
  })
  return root
}

type Member = { id: string; sha256: string; split: string }
type Candidate = { pair_key: string; dataset: string; a: Member; b: Member }
interface Review {
  status: string
  datasets: Record<string, unknown>
  summary: { failed: string[] }
  near_duplicates: { candidates: Candidate[]; conclusion_coverage: { concluded: number; invalid?: string[]; stale?: string[] } }
}

function run(root: string, conclusions?: unknown): { exitCode: number; review: Review } {
  const output = join(root, 'review.json')
  const args = [CLI, '--output', output]
  if (conclusions !== undefined) {
    save(root, 'conclusions.json', { conclusions })
    args.push('--conclusions', join(root, 'conclusions.json'))
  }
  let exitCode = 0
  try { execFileSync(process.execPath, args, { cwd: root, encoding: 'utf-8', timeout: 10000 }) }
  catch (error) { exitCode = (error as { status: number }).status }
  return { exitCode, review: JSON.parse(readFileSync(output, 'utf-8')) as Review }
}

function bound(root: string, candidate: Candidate): Record<string, unknown> {
  return { schemaVersion: 1, datasetSha256: treeHash(join(root, 'evals/datasets', candidate.dataset)),
    members: [candidate.a, candidate.b].map(({ id, sha256, split }) => ({ id, sha256, split })).sort((a, b) => a.id.localeCompare(b.id)),
    relation: 'duplicate-repost', verdict: 'no-leak', reason: '合成同 split 副本用于测试',
    reviewer: 'synthetic-test-reviewer (agent)', reviewedAt: '2026-10-02T08:00:00Z' }
}

describe('T12 CLI gold 与结论绑定反例', () => {
  it.each(['cross-record', 'wrong-hash'] as const)('T12 %s gold 必须拒绝且退出 1', (kind) => {
    const result = run(fixture(kind), {})
    expect(result.exitCode).toBe(1)
    expect(result.review.summary.failed).toContain('research.gold_record_ownership')
  })

  const invalid = [
    'empty', 'unknown-verdict', 'unknown-relation', 'blank-reason', 'missing-reviewer', 'invalid-time',
    'dataset-hash', 'member-hash', 'member-split', 'member-order'
  ] as const
  it.each(invalid)('T12 %s 结论不得计作覆盖', (kind) => {
    const root = fixture()
    const candidate = run(root).review.near_duplicates.candidates[0]!
    expect(candidate).toBeDefined()
    let value = bound(root, candidate)
    if (kind === 'empty') value = {}
    if (kind === 'unknown-verdict') value.verdict = 'maybe'
    if (kind === 'unknown-relation') value.relation = 'similar'
    if (kind === 'blank-reason') value.reason = '  '
    if (kind === 'missing-reviewer') delete value.reviewer
    if (kind === 'invalid-time') value.reviewedAt = 'not-a-date'
    if (kind === 'dataset-hash') value.datasetSha256 = '0'.repeat(64)
    const members = value.members as Member[] | undefined
    if (kind === 'member-hash') members![0]!.sha256 = '0'.repeat(64)
    if (kind === 'member-split') members![0]!.split = 'holdout'
    if (kind === 'member-order') members!.reverse()
    const result = run(root, { [candidate.pair_key]: value })
    expect(result.exitCode).toBe(1)
    expect(result.review.near_duplicates.conclusion_coverage.concluded).toBe(0)
    expect(result.review.near_duplicates.conclusion_coverage.invalid).toEqual([candidate.pair_key])
  })

  it('T12 有效绑定通过机器检查,陈旧额外键单列且不增加覆盖', () => {
    const root = fixture()
    const candidate = run(root).review.near_duplicates.candidates[0]!
    const result = run(root, { [candidate.pair_key]: bound(root, candidate), 'obsolete-pair': {} })
    expect(result.exitCode).toBe(0)
    expect(result.review.near_duplicates.conclusion_coverage.concluded).toBe(1)
    expect(result.review.near_duplicates.conclusion_coverage.stale).toEqual(['obsolete-pair'])
  })

  it('T12 leak 结论结构有效但机器检查拒绝冻结', () => {
    const root = fixture()
    const candidate = run(root).review.near_duplicates.candidates[0]!
    const result = run(root, { [candidate.pair_key]: { ...bound(root, candidate), verdict: 'leak' } })
    expect(result.exitCode).toBe(1)
    expect(result.review.summary.failed).toContain('near_duplicate.no_leak')
  })

  it('T12 默认消费正式 personal_ops_v2,不固定 v1', () => {
    const result = run(fixture('wrong-hash'), {})
    expect(result.review.datasets).toHaveProperty('personal_ops_v2')
    expect(result.review.datasets).not.toHaveProperty('personal_ops_v1')
  })
})

// EVAL-01 数据人审与签发:机器口径保持 freeze_eligible=false,省略 --conclusions 时输出
// blocked_input=BLOCKED_INPUT 标记并退出 0;真人裁决与签发不属机器检查范围。
interface Eval01Review extends Review {
  conclusions_mode: string
  blocked_input: { status: string; reasons: string[] } | null
  freeze_eligible: boolean
  near_duplicates: {
    candidates: Candidate[]
    conclusion_coverage: { mode: string; candidates: number; concluded: number; missing: string[]; invalid?: string[]; stale?: string[] }
  }
  datasets: Record<string, {
    counts: { total: number; dev: number; holdout: number; categories: Record<string, { total: number; dev: number; holdout: number }> }
  }>
}

describe('EVAL-01 机器口径与 BLOCKED_INPUT 标记', () => {
  it('EVAL-01 --ops-dir personal_ops_v3 逐组计数校验通过,退出 0 且含 blocked_input 标记', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'eval01-v3-'))
    const output = join(outDir, 'machine-review.json')
    execFileSync(process.execPath, [CLI, '--ops-dir', 'evals/datasets/personal_ops_v3', '--output', output],
      { cwd: ROOT, encoding: 'utf-8', timeout: 10000 })
    const review = JSON.parse(readFileSync(output, 'utf-8')) as Eval01Review
    expect(review.status).toBe('blocked-input')
    expect(review.conclusions_mode).toBe('not-provided')
    expect(review.blocked_input?.status).toBe('BLOCKED_INPUT')
    expect(review.blocked_input?.reasons.length).toBeGreaterThan(0)
    expect(review.freeze_eligible).toBe(false)
    expect(review.summary.failed).toEqual([])
    const v3 = review.datasets.personal_ops_v3
    expect(v3.counts.total).toBe(51)
    expect(v3.counts.dev).toBe(31)
    expect(v3.counts.holdout).toBe(20)
    expect(v3.counts.categories).toEqual({
      只读: { total: 20, dev: 12, holdout: 8 },
      可撤销写: { total: 16, dev: 10, holdout: 6 },
      歧义澄清: { total: 10, dev: 6, holdout: 4 },
      注入越权: { total: 5, dev: 3, holdout: 2 }
    })
    expect(review.near_duplicates.conclusion_coverage.mode).toBe('not-provided')
    expect(review.near_duplicates.conclusion_coverage.concluded).toBe(0)
    expect(review.near_duplicates.conclusion_coverage.missing).toHaveLength(3)
  })

  it('EVAL-01 合成数据集省略 --conclusions 时 blocked_input 存在且退出 0', () => {
    const result = run(fixture('pair'))
    expect(result.exitCode).toBe(0)
    const review = result.review as Eval01Review
    expect(review.status).toBe('blocked-input')
    expect(review.blocked_input?.status).toBe('BLOCKED_INPUT')
    expect(review.near_duplicates.conclusion_coverage.concluded).toBe(0)
    expect(review.near_duplicates.conclusion_coverage.missing).toEqual([review.near_duplicates.candidates[0]!.pair_key])
  })

  it('EVAL-01 --conclusions 覆盖不足时报错退出 1,陈旧键不计入覆盖', () => {
    const root = fixture('pair')
    const candidate = run(root).review.near_duplicates.candidates[0]!
    const result = run(root, { 'stale-key': { schemaVersion: 1 } })
    expect(result.exitCode).toBe(1)
    const coverage = (result.review as Eval01Review).near_duplicates.conclusion_coverage
    expect(coverage.concluded).toBe(0)
    expect(coverage.missing).toEqual([candidate.pair_key])
    expect(coverage.stale).toEqual(['stale-key'])
    expect(result.review.summary.failed).toContain('near_duplicate.manual_conclusions')
  })

  it('EVAL-01 --conclusions 指向不存在文件时报错退出 1', () => {
    const root = fixture('pair')
    const output = join(root, 'review.json')
    let exitCode = 0
    try {
      execFileSync(process.execPath, [CLI, '--output', output, '--conclusions', join(root, 'absent-conclusions.json')],
        { cwd: root, encoding: 'utf-8', timeout: 10000 })
    } catch (error) { exitCode = (error as { status: number }).status }
    expect(exitCode).toBe(1)
    const review = JSON.parse(readFileSync(output, 'utf-8')) as Eval01Review
    expect(review.conclusions_mode).toBe('file-missing')
    expect(review.summary.failed).toContain('near_duplicate.manual_conclusions')
  })
})
