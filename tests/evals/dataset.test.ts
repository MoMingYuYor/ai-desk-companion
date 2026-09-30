import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadDatasetFromDir, loadDatasetFromText } from '../../src/main/evals/dataset'
import { parseEvalCase } from '../../src/main/evals/types'
import { normalizePlainText, projectJsonSource, textSha256 } from '../../src/main/retrieval/normalize'

// E-01:数据集契约。四类检测:重复 ID、跨 split 泄漏、缺 gold、split/manifest 不一致;
// hash 防改动。

const MANIFEST = {
  dataset_version: 'personal_ops_v1',
  schema_version: 1,
  cases_sha256: '',
  categories: { 只读: { total: 2, dev: 1, holdout: 1 }, 可撤销写: { total: 1, dev: 1, holdout: 0 } },
  total: 3,
  provenance: '人工构造样例,标注者:seed'
}

function caseJson(over: Record<string, unknown>): string {
  return JSON.stringify({
    schema_version: 1,
    dataset_version: 'personal_ops_v1',
    mode: 'personal_ops',
    category: '只读',
    split: 'dev',
    input: '列出未完成任务',
    fixture_id: 'ops-empty',
    clock: '2026-09-28T01:00:00.000Z',
    timezone: 'Asia/Shanghai',
    expected: { terminal_status: 'succeeded' },
    interaction_script: [],
    budgets: {},
    tags: [],
    ...over
  })
}

function manifestFor(lines: string[]): Record<string, unknown> {
  // 类别统计从实际行推导,保证 manifest 与内容一致(hash 用例单独改 hash)
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
    ...MANIFEST,
    cases_sha256: sha(lines.join('\n')),
    categories,
    total: lines.length
  }
}

function sha(text: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('node:crypto').createHash('sha256').update(text).digest('hex')
}

describe('loadDatasetFromText', () => {
  it('合法数据集通过,split 正确分组', () => {
    const lines = [
      caseJson({ case_id: 'c1' }),
      caseJson({ case_id: 'c2', split: 'holdout', category: '只读', input: '列出已完成任务' }),
      caseJson({ case_id: 'c3', category: '可撤销写', tool_sequence_note: undefined, expected: { terminal_status: 'succeeded', tool_sequence: ['todo.create'], requires_confirmation: true } })
    ]
    const jsonl = lines.join('\n')
    const dataset = loadDatasetFromText(jsonl, manifestFor(lines))
    expect(dataset.cases).toHaveLength(3)
    expect(dataset.dev).toHaveLength(2)
    expect(dataset.holdout).toHaveLength(1)
    expect(dataset.cases[0]!.mode).toBe('personal_ops')
  })

  it('重复 case_id 检出', () => {
    const lines = [caseJson({ case_id: 'dup' }), caseJson({ case_id: 'dup', split: 'holdout' })]
    expect(() => loadDatasetFromText(lines.join('\n'), manifestFor(lines))).toThrow(/重复 case_id:dup/)
  })

  it('同输入跨 split 泄漏检出', () => {
    const lines = [
      caseJson({ case_id: 'a', input: '整理本周任务并安排' }),
      caseJson({ case_id: 'b', input: '整理本周任务并安排 ', split: 'holdout' })
    ]
    expect(() => loadDatasetFromText(lines.join('\n'), manifestFor(lines))).toThrow(/泄漏/)
  })

  it('写类案例缺 gold tool_sequence 检出', () => {
    const lines = [caseJson({ case_id: 'w', category: '可撤销写', expected: { terminal_status: 'succeeded', requires_confirmation: true } })]
    expect(() => loadDatasetFromText(lines.join('\n'), manifestFor(lines))).toThrow(/缺 gold tool_sequence/)
  })

  it('split 构成与 manifest 不一致检出', () => {
    const lines = [caseJson({ case_id: 'c1' })]
    const bad = { ...MANIFEST, cases_sha256: sha(lines.join('\n')), categories: { 只读: { total: 2, dev: 2, holdout: 0 } }, total: 1 }
    expect(() => loadDatasetFromText(lines.join('\n'), bad)).toThrow(/数量与 manifest 不一致/)
  })

  it('total 一致但 dev/holdout 拆分与 manifest 不一致检出(DATA-01)', () => {
    const lines = [caseJson({ case_id: 'c1' })]
    // total=1 正确,dev/holdout 声明漂移为 0/1(实际 1/0)
    const bad = { ...MANIFEST, cases_sha256: sha(lines.join('\n')), categories: { 只读: { total: 1, dev: 0, holdout: 1 } }, total: 1 }
    expect(() => loadDatasetFromText(lines.join('\n'), bad)).toThrow(/dev\/holdout 与 manifest 不一致:声明 0\/1,实际 1\/0/)
  })

  it('manifest 声明实际不存在的额外类别检出(DATA-01)', () => {
    const lines = [caseJson({ case_id: 'c1' })]
    const bad = {
      ...MANIFEST,
      cases_sha256: sha(lines.join('\n')),
      categories: { 只读: { total: 1, dev: 1, holdout: 0 }, 幻影类别: { total: 0, dev: 0, holdout: 0 } },
      total: 1
    }
    expect(() => loadDatasetFromText(lines.join('\n'), bad)).toThrow(/manifest 声明了实际不存在的类别:幻影类别/)
  })

  it('cases 内容 hash 与 manifest 不一致时拒绝(防改动)', () => {
    const lines = [caseJson({ case_id: 'c1' })]
    const right = loadDatasetFromText(lines.join('\n'), manifestFor(lines))
    expect(right.cases).toHaveLength(1)
    const wrongHash = {
      ...manifestFor(lines),
      cases_sha256: sha('tampered'),
      // 其余字段保持与实际内容一致,只改 hash:验证 hash 校验独立生效
      categories: { 只读: { total: 1, dev: 1, holdout: 0 } },
      total: 1
    }
    expect(() => loadDatasetFromText(lines.join('\n'), wrongHash)).toThrow(/hash 与 manifest 不一致/)
  })
})

describe('parseEvalCase 严格性', () => {
  it('未知字段拒绝', () => {
    expect(() => parseEvalCase({ ...JSON.parse(caseJson({ case_id: 'x' })), auto_approve: true }, 'personal_ops_v1')).toThrow(
      /未知字段:auto_approve/
    )
  })

  it('terminal_status 非法拒绝', () => {
    expect(() =>
      parseEvalCase({ ...JSON.parse(caseJson({ case_id: 'x' })), expected: { terminal_status: 'running' } }, 'personal_ops_v1')
    ).toThrow(/terminal_status 非法/)
  })
})

// DATA-01:数据冻结的交叉核对。check-eval-data.mjs 以只读复刻的规范化 v1 重放坐标与
// hash(脚本侧无法 import TS),本用例用 TS 真实现与其产物(dataset-review.json)闭环,
// 防止脚本复刻实现与 src/main/retrieval/normalize.ts 漂移。
describe('DATA-01 冻结交叉核对(check-eval-data 脚本产物)', () => {
  const ROOT = process.cwd()
  const reviewPath = join(ROOT, 'artifacts', 'data-review', 'dataset-review.json')
  const reviewAvailable = existsSync(reviewPath)

  it('脚本复刻的规范化 v1 与 TS 实现一致:语料 text hash 三方闭环', () => {
    // 快照 manifest 的 hash 生成于 TS 导入器(snapshots.ts),此处用 normalize.ts 原实现重算,
    // review.json 中脚本重放的 byte_identical 检查应同时为 pass。
    const fixRoot = join(ROOT, 'fixtures', 'research')
    const samples: Array<{ fixture: string; file: string; json?: boolean }> = [
      { fixture: 'locate-003', file: 'jd.txt' }, // emoji 语料
      { fixture: 'locate-007', file: 'jd.txt' }, // BOM 语料
      { fixture: 'locate-005', file: 'jd.json', json: true } // JSON 投影语料
    ]
    for (const s of samples) {
      const manifest = JSON.parse(readFileSync(join(ROOT, 'evals', 'datasets', 'research_v1', 'snapshots', s.fixture, 'manifest.json'), 'utf-8')) as {
        entries: Array<{ file: string; text_sha256: string }>
      }
      const bytes = readFileSync(join(fixRoot, s.fixture, s.file))
      const canon = s.json ? normalizePlainText(projectJsonSource(bytes.toString('utf8'))) : normalizePlainText(bytes.toString('utf8'))
      expect(manifest.entries.find((e) => e.file === s.file)!.text_sha256).toBe(textSha256(canon))
    }
    if (reviewAvailable) {
      const review = JSON.parse(readFileSync(reviewPath, 'utf-8')) as {
        datasets: Record<string, { corpus?: { files_checked: number }; cross_split: Record<string, { findings: unknown[] }> }>
      }
      expect(review.datasets.research_v1.cross_split['res.text_sha256'].findings).toHaveLength(0)
    }
  })

  it.runIf(reviewAvailable)('dataset-review.json 为冻结通过状态且与 loader 一致', () => {
    const review = JSON.parse(readFileSync(reviewPath, 'utf-8')) as {
      status: string
      summary: { failed: string[] }
      datasets: Record<string, { hashes: Record<string, string>; counts: Record<string, unknown> }>
      near_duplicates: { conclusion_coverage: { candidates: number; concluded: number; leak_pairs: string[] } }
    }
    expect(review.status).toBe('pass')
    expect(review.summary.failed).toHaveLength(0)
    // hash 与 loader 实算一致
    const ops = loadDatasetFromDir(join(ROOT, 'evals', 'datasets', 'personal_ops_v1'))
    const res = loadDatasetFromDir(join(ROOT, 'evals', 'datasets', 'research_v1'))
    expect(review.datasets.personal_ops_v1.hashes.cases_jsonl_sha256).toBe(ops.casesSha256)
    expect(review.datasets.research_v1.hashes.cases_jsonl_sha256).toBe(res.casesSha256)
    expect(review.datasets.personal_ops_v1.counts.total).toBe(50)
    expect(review.datasets.research_v1.counts.total).toBe(40)
    // 近重复候选逐对人工结论齐备,且无泄漏判定
    expect(review.near_duplicates.conclusion_coverage.concluded).toBe(review.near_duplicates.conclusion_coverage.candidates)
    expect(review.near_duplicates.conclusion_coverage.leak_pairs).toHaveLength(0)
  })
})
