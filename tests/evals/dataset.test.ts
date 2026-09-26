import { describe, expect, it } from 'vitest'
import { loadDatasetFromText } from '../../src/main/evals/dataset'
import { parseEvalCase } from '../../src/main/evals/types'

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
