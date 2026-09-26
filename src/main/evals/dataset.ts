// 评测数据集加载与校验(E-01)。
//
// 数据集目录形态(LLM Eval Lab 规格第 3 节):
//   evals/datasets/<dataset_version>/cases.jsonl  — 每行一条案例
//   evals/datasets/<dataset_version>/manifest.json — 数据 hash、类别统计
//
// 加载期四类检测:重复 case_id、泄漏(同输入跨 split)、缺 gold
// (写类案例必须有 tool_sequence)、split 构成与 manifest 不一致。
// 划分在调参前冻结:本模块只读取,不提供任何改写 split 的入口。

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEvalCase, type EvalCase, type EvalManifest } from './types'

export interface LoadedDataset {
  manifest: EvalManifest
  cases: EvalCase[]
  dev: EvalCase[]
  holdout: EvalCase[]
  /** cases 文件内容的 sha256(与 manifest.cases_sha256 比对) */
  casesSha256: string
}

/** 从 JSONL 文本加载并校验数据集(纯函数,便于测试注入) */
export function loadDatasetFromText(jsonl: string, manifest: unknown): LoadedDataset {
  const manifestParsed = parseManifest(manifest)
  const datasetVersion = manifestParsed.dataset_version

  const cases: EvalCase[] = []
  const errors: string[] = []
  const lines = jsonl.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  const seenIds = new Set<string>()
  // 泄漏检测:同一归一化输入不允许跨 split 出现(简单改写也会命中,近似检测)
  const inputToSplits = new Map<string, Set<string>>()

  for (let i = 0; i < lines.length; i += 1) {
    let raw: unknown
    try {
      raw = JSON.parse(lines[i]!)
    } catch {
      errors.push(`第 ${i + 1} 行不是合法 JSON`)
      continue
    }
    try {
      const parsed = parseEvalCase(raw, datasetVersion)
      if (seenIds.has(parsed.case_id)) errors.push(`重复 case_id:${parsed.case_id}`)
      seenIds.add(parsed.case_id)
      const normInput = parsed.input.replace(/\s+/g, '')
      const splits = inputToSplits.get(normInput) ?? new Set<string>()
      splits.add(parsed.split)
      inputToSplits.set(normInput, splits)
      cases.push(parsed)
    } catch (err) {
      errors.push(`第 ${i + 1} 行:${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 跨 split 泄漏
  for (const [norm, splits] of inputToSplits) {
    if (splits.size > 1) {
      errors.push(`输入跨 split 泄漏(${[...splits].join('/')}):${norm.slice(0, 40)}`)
    }
  }

  // 写类案例必须有 gold 工具序列(缺 gold 检测)
  for (const c of cases) {
    const isWriteCategory = c.category.includes('写') || c.expected.requires_confirmation === true
    if (isWriteCategory && !c.expected.tool_sequence) {
      errors.push(`案例 ${c.case_id}(类别 ${c.category})缺 gold tool_sequence`)
    }
  }

  // split 构成与 manifest 一致
  const categoryStats: Record<string, { total: number; dev: number; holdout: number }> = {}
  for (const c of cases) {
    const stat = categoryStats[c.category] ?? { total: 0, dev: 0, holdout: 0 }
    stat.total += 1
    if (c.split === 'dev') stat.dev += 1
    else stat.holdout += 1
    categoryStats[c.category] = stat
  }
  for (const [category, stat] of Object.entries(categoryStats)) {
    const declared = manifestParsed.categories[category]
    if (!declared) errors.push(`manifest 缺少类别声明:${category}`)
    else if (declared.total !== stat.total) {
      errors.push(`类别 ${category} 数量与 manifest 不一致:声明 ${declared.total},实际 ${stat.total}`)
    }
  }
  if (manifestParsed.total !== cases.length) {
    errors.push(`manifest.total(${manifestParsed.total})与实际案例数(${cases.length})不一致`)
  }

  if (errors.length > 0) {
    throw new Error(`评测数据集校验失败:\n- ${errors.join('\n- ')}`)
  }

  const casesSha256 = sha256OfText(jsonl)
  if (manifestParsed.cases_sha256 !== casesSha256) {
    throw new Error('评测数据集:cases 内容 hash 与 manifest 不一致,数据可能被改动')
  }

  return {
    manifest: manifestParsed,
    cases,
    dev: cases.filter((c) => c.split === 'dev'),
    holdout: cases.filter((c) => c.split === 'holdout'),
    casesSha256
  }
}

function parseManifest(raw: unknown): EvalManifest {
  if (typeof raw !== 'object' || raw === null) throw new Error('manifest 必须是对象')
  const m = raw as Record<string, unknown>
  if (typeof m.dataset_version !== 'string' || m.dataset_version === '') {
    throw new Error('manifest 缺少 dataset_version')
  }
  if (typeof m.cases_sha256 !== 'string') throw new Error('manifest 缺少 cases_sha256')
  if (typeof m.total !== 'number') throw new Error('manifest 缺少 total')
  if (typeof m.provenance !== 'string') throw new Error('manifest 缺少 provenance(数据来源说明)')
  if (typeof m.categories !== 'object' || m.categories === null) throw new Error('manifest 缺少 categories')
  return {
    dataset_version: m.dataset_version,
    schema_version: typeof m.schema_version === 'number' ? m.schema_version : 1,
    cases_sha256: m.cases_sha256,
    categories: m.categories as EvalManifest['categories'],
    total: m.total,
    provenance: m.provenance
  }
}

/** 从数据集目录加载(readFileSync 供 CLI 与测试使用;IPC 侧由调用方读文本) */
export function loadDatasetFromDir(dir: string): LoadedDataset {
  const jsonl = readFileSync(join(dir, 'cases.jsonl'), 'utf-8')
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'))
  return loadDatasetFromText(jsonl, manifest)
}

export function sha256OfText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
