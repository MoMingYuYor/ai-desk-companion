// 版本化报告(R-05;reports.ts):研究模块规格第 4/6 节。
//
// 关键约束:
// 1. 报告组织模型只能引用已冻结(已审核)的 Claim ID 白名单;输出白名单外或不存在
//    的 claim 一律拒绝;模型只返回章节枚举与 Claim 顺序,不生成新的事实句;
// 2. 正文由服务端用 Claim 原文与确定性模板渲染——模型不可用时模板仍可输出
//    已验证内容与未完成清单;
// 3. 未经审核(candidate)的 Claim 不进事实区;引用闭包在进入版本前最终再校验一次;
// 4. 版本不可变:createReport 的 (research_task_id, version) 唯一约束兜底;
//    进入版本的 Claim/Citation/EvidenceSpan 以 structured.frozen 记录冻结,
//    repository 的状态写函数据此拒绝回写。
//
// report_state 判定:完整 final / 部分 partial / 草稿 draft——
// 全部子问题 answered/conflicted → final;有产物但存在 insufficient/skipped → partial;
// 只有检查过的事实而没有可用组织模型输出时仍按数据完整性判定(草稿指阶段中间产物)。

import type { SqliteDb } from '../db/connection'
import type { StructuredCompleter } from '../agent/llm'
import { appError } from '../../shared/operations'
import { OperationError } from '../db/operations'
import {
  createReport,
  getResearchTaskByRun,
  listClaims,
  listEvidenceSpansForRun,
  listFrozenClaimIds,
  listRunCitationsForClaim,
  listSubQuestions,
  getSnapshotManifest,
  verifySnapshotManifest,
  type RunCitationRow
} from './repository'
import type { Claim, Report, SubQuestion } from './schemas'

// ---------- 章节契约(固定八段;顺序即规格第 6 节) ----------

export const REPORT_SECTIONS = [
  'question',
  'scope',
  'core_findings',
  'evidence_by_subquestion',
  'conflicts_and_gaps',
  'recommendations',
  'method_and_budget',
  'sources'
] as const

export type ReportSection = (typeof REPORT_SECTIONS)[number]

/** 组织模型的输出 schema(章节枚举 + 白名单内 Claim 顺序 + 建议顺序) */
export interface SynthesisPlan {
  sections: ReportSection[]
  /** 事实区的 claim 排序;必须全部在白名单内 */
  claim_order: string[]
  /** 建议区引用的建议类 claim(recommendation)顺序;也须在白名单内 */
  recommendation_claim_ids?: string[]
}

// ---------- 报告响应结构(规格第 7 节;组装函数供 R-06 使用) ----------

export interface ReportSectionContent {
  section: ReportSection
  title: string
  markdown: string
}

export interface ReportClaimView {
  claim_id: string
  text: string
  claim_type: Claim['claimType']
  support_status: Claim['supportStatus']
  subquestion_id: string
}

export interface ReportCitationView {
  citation_id: string
  claim_id: string
  evidence_id: string
  relation: RunCitationRow['citation']['relation']
  evidence_group_id: string | null
  group_operator: string | null
}

export interface ReportSourceView {
  source_id: string
  source_name: string
  source_type: string
  text_sha256: string
  source_identity?: string
  provenance_group_id?: string
  collection_time_basis?: string
}

export interface ReportBudgetUsage {
  max_model_calls: number
  max_subqueries: number
  max_chunks_per_subquery: number
  max_active_seconds: number
}

/** 报告响应结构(规格第 7 节字段清单;由 assembleReportResponse 组装) */
export interface ReportResponse {
  run_id: string
  report_id: string
  version: number
  report_state: Report['reportState']
  run_status: string
  manifest_sha256: string
  sections: ReportSectionContent[]
  claims: ReportClaimView[]
  citations: ReportCitationView[]
  sources: ReportSourceView[]
  unanswered_subquestions: Array<{ subquestion_id: string; question: string; insufficiency_reason: string | null }>
  budget_usage: ReportBudgetUsage
  markdown: string
}

// ---------- 白名单与组织模型输出校验 ----------

const SECTION_TITLES: Record<ReportSection, string> = Object.freeze({
  question: '研究问题',
  scope: '资料范围与时间',
  core_findings: '核心结论',
  evidence_by_subquestion: '按子问题组织的证据',
  conflicts_and_gaps: '冲突与不足',
  recommendations: '带假设的建议',
  method_and_budget: '方法与预算',
  sources: '完整来源清单'
}) as Record<ReportSection, string>

/**
 * 组织模型输出校验:白名单外的 claim(幻觉、跨运行、未冻结)整体拒绝——
 * 宁可回退到模板输出,不接受编造的引用。
 */
export function parseSynthesisPlan(raw: unknown, allowedClaimIds: ReadonlySet<string>): SynthesisPlan | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const sectionsRaw = obj.sections
  if (!Array.isArray(sectionsRaw) || sectionsRaw.length === 0) return null
  const sections: ReportSection[] = []
  for (const s of sectionsRaw) {
    if (typeof s !== 'string' || !(REPORT_SECTIONS as readonly string[]).includes(s)) return null
    if (!sections.includes(s as ReportSection)) sections.push(s as ReportSection)
  }
  const claimOrderRaw = obj.claim_order
  if (!Array.isArray(claimOrderRaw)) return null
  for (const id of claimOrderRaw) {
    if (typeof id !== 'string' || !allowedClaimIds.has(id)) return null
  }
  const recRaw = obj.recommendation_claim_ids
  if (recRaw !== undefined) {
    if (!Array.isArray(recRaw)) return null
    for (const id of recRaw) {
      if (typeof id !== 'string' || !allowedClaimIds.has(id)) return null
    }
  }
  return {
    sections,
    claim_order: claimOrderRaw as string[],
    recommendation_claim_ids: recRaw === undefined ? undefined : (recRaw as string[])
  }
}

// ---------- 数据装配(读取 run 的报告输入) ----------

/** 事实区白名单:审核通过的 claim(supported)与冲突组并列 claim(uncertain 并列) */
export function reportEligibleClaims(claims: readonly Claim[]): Claim[] {
  return claims.filter((c) => c.supportStatus === 'supported' || (c.supportStatus === 'uncertain' && c.conflictGroup !== null))
}

/** 按 claim ID 联查引用(构造最小 Claim 骨架复用 repository 的 per-claim 联查) */
function citationsOfClaimId(db: SqliteDb, claimId: string): RunCitationRow[] {
  const row = db.get<{ claim_id: string; research_task_id: string; subquestion_id: string }>(
    'SELECT claim_id, research_task_id, subquestion_id FROM research_claims WHERE claim_id = ?',
    [claimId]
  )
  if (!row) return []
  return listRunCitationsForClaim(db, {
    claimId: row.claim_id,
    researchTaskId: row.research_task_id,
    subquestionId: row.subquestion_id,
    text: '',
    claimType: 'fact',
    subject: null,
    qualifier: null,
    supportStatus: 'candidate',
    conflictGroup: null,
    review: null
  })
}

// ---------- 确定性模板渲染 ----------

function renderScope(manifestEntries: ReadonlyArray<{ snapshot_id: string; source_name: string; source_type: string; text_sha256: string; collection_time_basis?: string }>): string {
  const lines = manifestEntries.map(
    (e) => `- ${e.source_name}(${e.source_type};采集时间依据:${e.collection_time_basis ?? 'unknown'})`
  )
  return lines.length > 0 ? lines.join('\n') : '- (空)'
}

function renderClaimLine(claim: Claim, citations: readonly RunCitationRow[], displayIndex: number): string {
  const citeIds = citations
    .filter((row) => row.claim.claimId === claim.claimId)
    .map((row) => `[${row.citation.citationId.slice(0, 8)}]`)
  const citeSuffix = citeIds.length > 0 ? `(${citeIds.join(' ')})` : ''
  const conflictNote =
    claim.conflictGroup !== null && (claim.supportStatus === 'uncertain' || claim.supportStatus === 'candidate')
      ? '(与另一来源并列,待确认)'
      : ''
  return `${displayIndex}. ${claim.text}${conflictNote} ${citeSuffix}`.trimEnd()
}

/** 确定性模板:全部章节由服务端渲染,不采用模型生成的事实句 */
function renderMarkdown(input: {
  question: string
  manifestEntries: ReadonlyArray<{ snapshot_id: string; source_name: string; source_type: string; text_sha256: string; collection_time_basis?: string }>
  sections: readonly ReportSection[]
  claims: readonly Claim[]
  citations: readonly RunCitationRow[]
  subquestions: readonly SubQuestion[]
  conflictGroups: number
  planUsedModel: boolean
}): string {
  const { question, manifestEntries, sections, claims, citations, subquestions, conflictGroups, planUsedModel } = input
  const parts: string[] = []
  const sectionOf = (section: ReportSection): string => {
    switch (section) {
      case 'question':
        return `## ${SECTION_TITLES.question}\n\n${question}`
      case 'scope':
        return `## ${SECTION_TITLES.scope}\n\n${renderScope(manifestEntries)}`
      case 'core_findings': {
        if (claims.length === 0) {
          return `## ${SECTION_TITLES['core_findings']}\n\n没有证据:未形成可核对的结论。`
        }
        return `## ${SECTION_TITLES['core_findings']}\n\n${claims.map((c, i) => renderClaimLine(c, citations, i + 1)).join('\n')}`
      }
      case 'evidence_by_subquestion': {
        const blocks = subquestions.map((sub) => {
          const subClaims = claims.filter((c) => c.subquestionId === sub.subquestionId)
          const head = `### ${sub.question}`
          if (sub.status === 'insufficient') {
            return `${head}\n\n${sub.insufficiencyReason ?? '没有证据:未检索到相关材料(不能推导为不需要)。'}`
          }
          if (sub.status === 'conflicted') {
            return `${head}\n\n资料存在冲突:${sub.insufficiencyReason ?? '矛盾证据并列展示,不投票裁决。'}`
          }
          if (subClaims.length === 0) {
            return `${head}\n\n(本子问题没有进入事实区的结论)`
          }
          const items = subClaims.map((c, i) => renderClaimLine(c, citations, i + 1)).join('\n')
          return `${head}\n\n${items}`
        })
        return `## ${SECTION_TITLES['evidence_by_subquestion']}\n\n${blocks.join('\n\n')}`
      }
      case 'conflicts_and_gaps': {
        const conflictPart =
          conflictGroups > 0
            ? `存在 ${conflictGroups} 组冲突,矛盾证据并列展示、标 unresolved,不按多数副本投票。`
            : '未检测到需要并列展示的冲突。'
        const gapParts = subquestions
          .filter((s) => s.status === 'insufficient' || s.status === 'skipped')
          .map((s) => `- ${s.question}:${s.insufficiencyReason ?? '未完成'}`)
        const gapPart = gapParts.length > 0 ? `\n\n不足项:\n${gapParts.join('\n')}` : ''
        return `## ${SECTION_TITLES['conflicts_and_gaps']}\n\n${conflictPart}${gapPart}`
      }
      case 'recommendations': {
        const recs = claims.filter((c) => c.claimType === 'recommendation')
        if (recs.length === 0) {
          return `## ${SECTION_TITLES.recommendations}\n\n(本次运行没有已审核的建议项;建议与事实分区,自述能力未核验)`
        }
        return `## ${SECTION_TITLES.recommendations}\n\n${recs.map((c, i) => renderClaimLine(c, citations, i + 1)).join('\n')}`
      }
      case 'method_and_budget': {
        return (
          `## ${SECTION_TITLES['method_and_budget']}\n\n` +
          `- 流程:冻结快照 → 有界检索 → 证据抽取 → 引用闭包检查 → 语义审核 → 版本化报告\n` +
          `- 组织方式:${planUsedModel ? '模型返回 Claim 顺序,服务端确定性模板渲染' : '模板直接输出(模型不可用或计划无效)'}\n` +
          `- 引用规则:仅校验 URL 可打开、域名可信或引用编号存在,不构成合格引用;以快照原文与 offset 对齐为准`
        )
      }
      case 'sources': {
        // 来源清单:快照 ID + 冻结清单中的名称与 hash(没有 URL 的本地文件同样完整可引)
        const seen = new Map<string, { name: string; sha: string }>()
        for (const row of citations) {
          if (seen.has(row.span.snapshotId)) continue
          const entry = manifestEntries.find((e) => e.snapshot_id === row.span.snapshotId)
          seen.set(row.span.snapshotId, {
            name: entry?.source_name ?? `快照 ${row.span.snapshotId.slice(0, 8)}`,
            sha: entry?.text_sha256 ?? ''
          })
        }
        const lines = [...seen].map(
          ([snapshotId, meta]) => `- ${meta.name}(snapshot_id=${snapshotId};text_sha256=${meta.sha.slice(0, 12)}…)`
        )
        if (lines.length === 0) lines.push('- (无引用来源)')
        return `## ${SECTION_TITLES.sources}\n\n${lines.join('\n')}`
      }
    }
  }
  for (const section of sections) {
    parts.push(sectionOf(section))
  }
  return parts.join('\n\n')
}

// ---------- 报告构建主入口 ----------

export interface BuildReportOptions {
  version: number
  /** 组织模型;null 或输出无效时回退确定性模板(仍输出已验证内容与未完成清单) */
  completer?: StructuredCompleter | null
  /** 显式提供组织计划(测试与模板路径);缺省调用 completer */
  plan?: SynthesisPlan | null
  reportState?: Report['reportState']
}

export interface BuildReportResult {
  report: Report
  response: ReportResponse
}

/**
 * buildReport:组织 → 终检 → 冻结 → 落版本。
 * 1) 白名单 = 已审核(supported)或冲突并列(uncertain+conflict_group)的 claim;
 *    candidate 不进事实区;
 * 2) 组织模型返回白名单外的 claim 即拒绝并回退模板;
 * 3) 引用闭包最终再校验一次(逐引用重放 checkCitationStructure),任一失败不进入版本;
 * 4) createReport 唯一约束兜底版本不可变;structured.frozen 记录冻结集合。
 */
export async function buildReport(db: SqliteDb, runId: string, options: BuildReportOptions): Promise<BuildReportResult> {
  const task = getResearchTaskByRun(db, runId)
  if (!task) throw new OperationError(appError('TARGET_UNAVAILABLE', `运行缺少研究任务:${runId}`, { retryable: false }))
  const manifest = verifySnapshotManifest(db, task.snapshotManifestId)
  const manifestFull = getSnapshotManifest(db, task.snapshotManifestId)
  const claims = listClaims(db, task.researchTaskId)
  const subquestions = listSubQuestions(db, task.researchTaskId)
  const frozenAlready = listFrozenClaimIds(db, task.researchTaskId)

  const eligible = reportEligibleClaims(claims).filter((c) => !frozenAlready.has(c.claimId))
  const allowed = new Set(eligible.map((c) => c.claimId))

  // 组织:优先显式 plan;否则调 completer;白名单外/无效一律回退模板。
  // 白名单统一为 eligible:parseSynthesisPlan 只认本版本白名单(历史冻结 claim
  // 已随其版本定格,不重复进入新版本,补正走新 ID 新版本)。
  let plan: SynthesisPlan | null = options.plan ?? null
  let planUsedModel = false
  if (plan === null && options.completer) {
    try {
      const result = await options.completer.completeJson({
        system:
          '你是报告组织员。只能引用给定 Claim ID,返回章节枚举(sections)、Claim 顺序(claim_order);' +
          '不生成新的事实句。可选输出 recommendation_claim_ids(建议类 Claim 顺序)。',
        prompt:
          `可用 Claim ID(白名单):\n${[...allowed].map((id) => `- ${id}`).join('\n') || '(空)'}\n` +
          `章节枚举:${REPORT_SECTIONS.join(', ')}`
      })
      plan = parseSynthesisPlan(result.data, allowed)
    } catch {
      plan = null
    }
    planUsedModel = plan !== null
  }

  // 事实区 claim 顺序:计划顺序在前(过滤白名单),其余按落库序追加
  const orderedClaims: Claim[] = []
  if (plan) {
    for (const id of plan.claim_order) {
      const claim = eligible.find((c) => c.claimId === id)
      if (claim && !orderedClaims.includes(claim)) orderedClaims.push(claim)
    }
  }
  for (const claim of eligible) {
    if (!orderedClaims.includes(claim)) orderedClaims.push(claim)
  }

  // 引用闭包最终校验:进入版本前逐引用重放结构检查(快照 hash、offset、quote、chunk 覆盖)
  const citationsOf = (claim: Claim): RunCitationRow[] => {
    const rows = listRunCitationsForClaim(db, claim)
    return rows
  }
  const citationRows: RunCitationRow[] = []
  for (const claim of orderedClaims) {
    citationRows.push(...citationsOf(claim))
  }
  finalCheck(db, citationRows, manifest)

  // 报告状态:显式指定优先;否则按数据完整性判定(完整 final / 部分 partial)
  const unfinished = subquestions.filter((s) => s.status === 'insufficient' || s.status === 'skipped' || s.status === 'pending' || s.status === 'running')
  const reportState: Report['reportState'] =
    options.reportState ?? (unfinished.length === 0 && subquestions.length > 0 ? 'final' : 'partial')

  const conflictGroups = new Set(
    claims.filter((c) => c.conflictGroup !== null).map((c) => c.conflictGroup as string)
  ).size

  const sections: ReportSection[] = plan?.sections ?? [...REPORT_SECTIONS]
  const markdown = renderMarkdown({
    question: task.question,
    manifestEntries: manifestFull?.entries ?? [],
    sections,
    claims: orderedClaims,
    citations: citationRows,
    subquestions,
    conflictGroups,
    planUsedModel
  })

  // 冻结记录:进入版本的 claim/citation/evidence 的 ID 与状态快照
  const frozen = {
    frozen_claim_ids: orderedClaims.map((c) => c.claimId),
    frozen_citation_ids: citationRows.map((r) => r.citation.citationId),
    frozen_evidence_ids: [...new Set(citationRows.map((r) => r.span.evidenceId))],
    frozen_support_status: Object.fromEntries(orderedClaims.map((c) => [c.claimId, c.supportStatus])),
    frozen_validation_status: Object.fromEntries(
      [...new Set(citationRows.map((r) => r.span.evidenceId))].map((id) => {
        const row = citationRows.find((r) => r.span.evidenceId === id)
        return [id, row!.span.validationStatus]
      })
    )
  }
  const structured = {
    sections,
    claim_order: orderedClaims.map((c) => c.claimId),
    plan_used_model: planUsedModel,
    frozen
  }

  const report = createReport(db, runId, {
    version: options.version,
    reportState,
    structured,
    markdown
  })

  return {
    report,
    response: assembleReportResponse(db, runId, report, { runStatus: task.phase })
  }
}

/** 终检:任一引用结构失败即拒绝进入版本(CITATION_INVALID) */
function finalCheck(db: SqliteDb, rows: readonly RunCitationRow[], manifest: ReturnType<typeof verifySnapshotManifest>): void {
  void db
  for (const row of rows) {
    const snapshotRow = db.get<{ text_sha256: string }>(
      'SELECT text_sha256 FROM retrieval_documents WHERE document_id = ?',
      [row.span.snapshotId]
    )
    if (!snapshotRow || snapshotRow.text_sha256 !== manifest.entries.find((e) => e.snapshot_id === row.span.snapshotId)?.text_sha256) {
      throw new OperationError(appError('CONFLICT', '[CITATION_INVALID] 快照 hash 与冻结清单不一致,拒绝生成报告版本', { retryable: false }))
    }
    const resliced = Array.from(
      db.get<{ normalized_text: string }>('SELECT normalized_text FROM retrieval_documents WHERE document_id = ?', [row.span.snapshotId])!
        .normalized_text
    )
      .slice(row.span.startOffset, row.span.endOffset)
      .join('')
    if (resliced !== row.span.quote) {
      throw new OperationError(
        appError('CONFLICT', `[CITATION_INVALID] 引用 ${row.citation.citationId} 的 quote 与快照切片不匹配,拒绝生成报告版本`, { retryable: false })
      )
    }
    const chunk = db.get<{ start_offset: number; end_offset: number; document_id: string }>(
      'SELECT start_offset, end_offset, document_id FROM retrieval_chunks WHERE chunk_id = ?',
      [row.span.chunkId]
    )
    if (
      !chunk ||
      chunk.document_id !== row.span.snapshotId ||
      chunk.start_offset > row.span.startOffset ||
      chunk.end_offset < row.span.endOffset
    ) {
      throw new OperationError(
        appError('CONFLICT', `[CITATION_INVALID] chunk 未覆盖片段 ${row.span.evidenceId},拒绝生成报告版本`, { retryable: false })
      )
    }
  }
}

// ---------- 响应组装(供 R-06 API/页面使用) ----------

export function assembleReportResponse(
  db: SqliteDb,
  runId: string,
  report: Report,
  context: { runStatus: string }
): ReportResponse {
  const task = getResearchTaskByRun(db, runId)
  if (!task) throw new OperationError(appError('TARGET_UNAVAILABLE', `运行缺少研究任务:${runId}`, { retryable: false }))
  const manifest = getSnapshotManifest(db, task.snapshotManifestId)
  const subquestions = listSubQuestions(db, task.researchTaskId)
  const claims = listClaims(db, task.researchTaskId)
  const spans = listEvidenceSpansForRun(db, runId)

  const structuredSections = (report.structured?.sections as ReportSection[] | undefined) ?? [...REPORT_SECTIONS]
  const sections: ReportSectionContent[] = structuredSections.map((section) => ({
    section,
    title: SECTION_TITLES[section],
    markdown: extractSection(report.markdown, `## ${SECTION_TITLES[section]}`)
  }))

  const frozenIds = new Set((report.structured?.frozen as ReportFrozenShape | undefined)?.frozen_claim_ids ?? [])
  const claimViews: ReportClaimView[] = claims
    .filter((c) => frozenIds.has(c.claimId))
    .map((c) => ({
      claim_id: c.claimId,
      text: c.text,
      claim_type: c.claimType,
      support_status: c.supportStatus,
      subquestion_id: c.subquestionId
    }))

  const citationRows = claimViews.flatMap((view) => listRunCitationsForClaim(db, { ...claims.find((c) => c.claimId === view.claim_id)! }))
  const citationViews: ReportCitationView[] = citationRows.map((row) => ({
    citation_id: row.citation.citationId,
    claim_id: row.claim.claimId,
    evidence_id: row.citation.evidenceId,
    relation: row.citation.relation,
    evidence_group_id: row.citation.evidenceGroupId,
    group_operator: row.citation.groupOperator
  }))

  const sourceIds = [...new Set(spans.filter((s) => citationRows.some((r) => r.span.evidenceId === s.evidenceId)).map((s) => s.snapshotId))]
  const sources: ReportSourceView[] = (manifest?.entries ?? [])
    .filter((e) => sourceIds.includes(e.snapshot_id))
    .map((e) => ({
      source_id: e.snapshot_id,
      source_name: e.source_name,
      source_type: e.source_type,
      text_sha256: e.text_sha256,
      ...(e.source_identity === undefined ? {} : { source_identity: e.source_identity }),
      ...(e.provenance_group_id === undefined ? {} : { provenance_group_id: e.provenance_group_id }),
      ...(e.collection_time_basis === undefined ? {} : { collection_time_basis: e.collection_time_basis })
    }))

  return {
    run_id: runId,
    report_id: report.reportId,
    version: report.version,
    report_state: report.reportState,
    run_status: context.runStatus,
    manifest_sha256: report.manifestSha256,
    sections,
    claims: claimViews,
    citations: citationViews,
    sources,
    unanswered_subquestions: subquestions
      .filter((s) => s.status === 'insufficient' || s.status === 'skipped' || s.status === 'pending')
      .map((s) => ({ subquestion_id: s.subquestionId, question: s.question, insufficiency_reason: s.insufficiencyReason })),
    budget_usage: { ...task.budget },
    markdown: report.markdown
  }
}

interface ReportFrozenShape {
  frozen_claim_ids?: string[]
}

function extractSection(markdown: string, heading: string): string {
  const index = markdown.indexOf(heading)
  if (index < 0) return ''
  const rest = markdown.slice(index + heading.length)
  const next = rest.indexOf('\n## ')
  return (next < 0 ? rest : rest.slice(0, next)).trim()
}
