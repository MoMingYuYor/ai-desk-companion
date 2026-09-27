// 研究评测适配器(R-07 集成):把 research_v1 数据集接入 Eval 隔离执行体系。
//
// 职责:
// - registerResearchFixture(s):按需从 fixtures/research/<fixture_id>/ 读取原始字节,
//   经 importResearchSources 导入该 fixture 的全部语料文件(惰性注册表工厂,幂等;
//   重复导入由 importResearchSources 的 raw_sha256+locator 幂等语义兜底);
// - researchFakeScriptFor():为 fake 模式的 research case 生成 FakeProvider 脚本
//   (按 request.system 角色分支,与 tests/research/workflow.test.ts 的范例同构):
//   * 单文档定位等有产物组:规划 1~3 子问题 → 抽取真实 EvidenceSpan+Claim
//     (quote/offset 从交付 chunk 的真实内容取)→ 审核 supported → 组织章节枚举;
//   * 证据不足组:抽取输出空候选(不编造),子问题落 no_evidence → 诚实不足,
//     终态 succeeded 与 gold_claims 为空的标注语义兼容;
//   * 提示注入组:FakeProvider 本就不会调工具,脚本照常走正常链,
//     expected.forbidden_tools 由 runner 的 trace 检查承载断言。
//
// 边界:不解析 gold 标注文件、不改写 annotations;gold 的逻辑 snapshot_id 形态
// `<fixture_id>/<file>` 与导入后真实 documentId 的映射,经 seed 返回的
// ResearchSeedResult 保留(评测判定与 E-08 评分用)。
//
// 不为 40 条全部编写脚本:全量 40 条真实模型执行属 E-08/M6 范围,本集成只证明通路。

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SqliteDb } from '../db/connection'
import type { StructuredCompleteRequest } from '../agent/llm'
import { importResearchSources, type ImportedResearchSource } from '../research/snapshots'
import { normalizePlainText } from '../retrieval/normalize'
import { tokenizeForSearch } from '../retrieval/tokenize'
import { registerFixtureById, getFixtureById } from './isolation'
import type { EvalCase } from './types'

/** 仓库内语料根目录(fixtures 与 snapshots 副本逐字节一致,读 fixtures 侧) */
export const RESEARCH_FIXTURE_ROOT = join(process.cwd(), 'fixtures', 'research')

/** 一个研究 fixture 播种后的映射信息(逻辑 snapshot_id → 真实 documentId) */
export interface ResearchSeedResult {
  fixtureId: string
  /** 逻辑形态 `<fixture_id>/<file>` → 导入后的真实 snapshot_id(documentId);
   *  多记录文件的记录共享同一逻辑 id(同文件共享整文件规范全文),收敛为一条 */
  snapshotIdByLogical: Map<string, string>
  /** 逻辑 id → 整文件规范全文(quote/offset 计算的真实内容来源) */
  normalizedTextByLogical: Map<string, string>
  /** 全部成功导入的记录(documentId + sourceLocator + hash,评测导出可复核) */
  records: ImportedResearchSource[]
}

/**
 * fixture 播种:读语料目录全部文件并一批导入,返回逻辑/真实 snapshot_id 映射
 * 与规范全文缓存。任一记录导入失败直接抛错(fixture 损坏应让 case 失败,
 * 不能静默产空库)。
 */
export function seedResearchFixture(db: SqliteDb, fixtureId: string): ResearchSeedResult {
  const dir = join(RESEARCH_FIXTURE_ROOT, fixtureId)
  const files = readdirSync(dir).sort()
  if (files.length === 0) {
    throw new Error(`研究 fixture 语料目录为空:${fixtureId}`)
  }
  const outcomes = importResearchSources(db, {
    sources: files.map((file) => ({
      sourceName: file,
      bytes: readFileSync(join(dir, file))
    }))
  })
  const snapshotIdByLogical = new Map<string, string>()
  const normalizedTextByLogical = new Map<string, string>()
  const records: ImportedResearchSource[] = []
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      throw new Error(`研究 fixture 导入失败:${fixtureId} ${outcome.sourceName}:${outcome.error.message}`)
    }
    records.push(outcome)
    // 同一文件的多条记录共享整文件规范全文,收敛为一个逻辑 snapshot_id
    const logical = `${fixtureId}/${outcome.sourceName}`
    if (!snapshotIdByLogical.has(logical)) snapshotIdByLogical.set(logical, outcome.documentId)
  }
  for (const [logical, documentId] of snapshotIdByLogical) {
    const row = db.get<{ normalized_text: string }>(
      'SELECT normalized_text FROM retrieval_documents WHERE document_id = ?',
      [documentId]
    )
    normalizedTextByLogical.set(logical, row?.normalized_text ?? '')
  }
  return { fixtureId, snapshotIdByLogical, normalizedTextByLogical, records }
}

// ---------- 注册(isolation 注册表的最小适配) ----------

/** 研究侧注册的 EvalFixture.description 前缀(幂等注册的判据) */
const RESEARCH_FIXTURE_MARK = 'research_v1 fixture'

/** seed 结果暂存:db 实例 → 播种映射(WeakMap,库关闭后自动可回收) */
const seedByDb = new WeakMap<SqliteDb, ResearchSeedResult>()

let registeredFixtureIds: Set<string> | null = null

/**
 * 为数据集引用的 fixture_id 注册 seed(惰性注册表工厂,幂等):
 * 首次调用时向 isolation 注册表写入 seed 闭包;seed 把映射结果暂存进
 * seedByDb,供 runner/测试经 getResearchSeedResult 读取。
 */
export function registerResearchFixture(fixtureId: string): void {
  registeredFixtureIds ??= new Set()
  if (registeredFixtureIds.has(fixtureId) && getFixtureById(fixtureId)) return
  registerFixtureById(fixtureId, {
    description: `${RESEARCH_FIXTURE_MARK} ${fixtureId}:fixtures/research/${fixtureId} 全部语料`,
    seed: (db: SqliteDb) => {
      const result = seedResearchFixture(db, fixtureId)
      seedByDb.set(db, result)
      // 返回值进 IsolatedCaseEnv.seedResult(评测判定读取逻辑/真实 snapshot_id 映射)
      return result
    }
  })
  registeredFixtureIds.add(fixtureId)
}

/** 批量注册(数据集装载后按全部 fixture_id 调用) */
export function registerResearchFixtures(fixtureIds: readonly string[]): void {
  for (const fixtureId of fixtureIds) registerResearchFixture(fixtureId)
}

/** 读取某个库上的研究播种映射(非研究 fixture 或未播种返回 undefined) */
export function getResearchSeedResult(db: SqliteDb): ResearchSeedResult | undefined {
  return seedByDb.get(db)
}

// ---------- fake 模型脚本(≥3 条代表性 case 端到端;其余走 loader 校验) ----------

/**
 * research case 的 fake 脚本(按 request.system 角色分支,不按 callIndex——
 * 与 tests/research/workflow.test.ts 惯例一致,与调用次数解耦)。
 *
 * 语料感知方式:抽取阶段不预知检索交付哪些 chunk,因此脚本从抽取 prompt 中
 * 解析本次交付的 snapshot_id/chunk_id/原文行(与测试范例 supportedVerdictsFrom
 * 从审核 prompt 提取真实 Claim ID 同一思路),quote 取交付原文中唯一命中的整行,
 * 由服务端 resolveSpanOffsets 补全 offset——quote/offset 均来自语料真实内容。
 */
export function researchFakeScriptFor(
  caseDef: EvalCase,
  seed: ResearchSeedResult
): (callIndex: number, request: StructuredCompleteRequest) => unknown {
  const isInsufficient = caseDef.category.includes('证据不足')
  return (_callIndex: number, request: StructuredCompleteRequest) => {
    if (request.system.includes('研究规划器')) {
      // 规划:1~3 个子问题(主问题 + 语义核对题;不请求澄清——通路证明不走澄清轮)
      return {
        subquestions: [
          { question: caseDef.input, query: queryTokensOf(caseDef.input, seed) },
          { question: `${caseDef.input}(补充核对)`, query: queryTokensOf(caseDef.input, seed) }
        ],
        clarifications: []
      }
    }
    if (request.system.includes('证据抽取器')) {
      if (isInsufficient) {
        // 证据不足:输出空候选(不编造);子问题将落 no_evidence(诚实不足)
        return { evidence: [], claims: [] }
      }
      const delivered = parseDeliveredChunks(request.prompt)
      if (delivered.length === 0) return { evidence: [], claims: [] }
      const first = delivered[0]!
      const quote = uniqueLineOf(first.content) ?? first.content.slice(0, 30)
      return {
        evidence: [{ snapshot_id: first.snapshotId, chunk_id: first.chunkId, quote }],
        claims: [
          {
            text: `关于「${caseDef.input}」的结论,以引用原文为准。`,
            claim_type: 'fact',
            subject: { entity: caseDef.case_id },
            supports: [0]
          }
        ]
      }
    }
    if (request.system.includes('证据审核员')) {
      // 审核:从 prompt 提取真实 Claim ID 全判 supported(片段直接支持的通路证明)
      const ids = Array.from(request.prompt.matchAll(/Claim\(([0-9a-f-]+)\)/g)).map((m) => m[1]!)
      return {
        verdicts: ids.map((id) => ({
          claim_id: id,
          status: 'supported',
          reason: '片段直接支持命题(通路证明脚本)'
        }))
      }
    }
    // 组织员:章节枚举走白名单;claim_order 留空由服务端按落库序补齐
    return { sections: ['core_findings', 'evidence_by_subquestion', 'sources'], claim_order: [] }
  }
}

/** 从抽取 prompt 解析交付的候选块:`- snapshot_id=... chunk_id=...` + 缩进原文行 */
function parseDeliveredChunks(
  prompt: string
): Array<{ snapshotId: string; chunkId: string; content: string }> {
  const out: Array<{ snapshotId: string; chunkId: string; content: string }> = []
  const lines = prompt.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i]!.match(/- snapshot_id=(\S+) chunk_id=(\S+)/)
    if (!m) continue
    const contentLine = lines[i + 1] ?? ''
    out.push({
      snapshotId: m[1]!,
      chunkId: m[2]!,
      content: contentLine.replace(/^\s*原文:/, '')
    })
  }
  return out
}

/**
 * 交付块内取「唯一命中」的一行作为 quote(resolveSpanOffsets 要求 chunk 内唯一
 * 精确匹配;多行都唯一时取第一行)。找不到唯一行时回退前 30 个码点。
 */
function uniqueLineOf(content: string): string | null {
  const lines = content.split('\n').map((l) => l.trim()).filter((l) => l.length >= 4)
  for (const line of lines) {
    const cps = Array.from(content)
    const q = Array.from(line)
    let hits = 0
    for (let i = 0; i + q.length <= cps.length; i += 1) {
      let ok = true
      for (let j = 0; j < q.length; j += 1) {
        if (cps[i + j] !== q[j]) {
          ok = false
          break
        }
      }
      if (ok) hits += 1
    }
    if (hits === 1) return line
  }
  return null
}

/**
 * 从 case 输入与语料构造检索查询词:取输入与规范全文共现的 CJK 二元组,
 * 保证 FTS 检索在冻结清单内必有命中(通路证明的前提)。
 */
function queryTokensOf(input: string, seed: ResearchSeedResult): string {
  const inputTokens = tokenizeForSearch(input)
  const corpusTokens = new Set(
    [...seed.normalizedTextByLogical.values()].flatMap((text) => tokenizeForSearch(normalizePlainText(text)))
  )
  const shared = [...new Set(inputTokens)].filter((t) => corpusTokens.has(t))
  if (shared.length > 0) return shared.join(' ')
  // 输入与语料零共现(如问句全是抽象词):回退语料自身的 token,保证有命中
  return [...corpusTokens].slice(0, 8).join(' ')
}
