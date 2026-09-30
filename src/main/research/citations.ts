// 引用闭包检查(R-05;citations.ts):沿 Claim → Citation → EvidenceSpan →
// SourceSnapshot → Source 遍历的结构层校验(研究模块规格第 4 节、执行清单步骤 17)。
//
// 边界与关键取舍:
// 1. 本模块只做确定性结构检查:引用属于本次运行、来源在冻结清单内、快照 hash 一致、
//    offset 合法、`Array.from(normalized_text).slice(start,end).join('') === quote`、
//    chunk 覆盖该 span。**仅校验 URL 可打开、域名可信或引用编号存在,不构成合格引用**
//    (P0 无网络;来源与快照的可信性来自导入时的双 hash 与冻结清单,不是 URL 可达性)。
// 2. 语义层(片段是否真支持命题)不在本模块:validateCitations 把结构通过且存在
//    supports 引用的 claim 留在 candidate,交给 evidence.ts 的 reviewClaims 审核;
//    结构失败(引用错配、快照定位错误)直接落 unsupported——确定性规则拦截可判定错误。
// 3. 落库一律经 repository 的状态写函数(自带冻结守卫),本模块不写裸 UPDATE。
// 4. all_of 证据组:同一 (claim, evidence_group_id) 且 group_operator='all_of' 的
//    supports 引用必须全部有效才算支持,缺一则整组不成立,不能以任一片段替代全部条件。

import { createHash } from 'node:crypto'
import type { SqliteDb } from '../db/connection'
import {
  getSnapshotText,
  getChunkBoundary,
  listClaims,
  listCitationsForRun,
  listEvidenceSpansForRun,
  listRunCitationsForClaim,
  listFrozenClaimIds,
  listFrozenEvidenceIds,
  loadAllOfRequirements,
  updateEvidenceSpanStatus,
  updateClaimReview,
  getResearchTaskByRun,
  verifySnapshotManifest,
  type ChunkBoundaryRecord,
  type RunCitationRow,
  type SnapshotTextRecord
} from './repository'
import type { Claim, EvidenceSpan, SnapshotManifest } from './schemas'

// ---------- 结果类型 ----------

/** 单条引用的结构检查结果 */
export interface CitationCheckResult {
  citationId: string
  claimId: string
  evidenceId: string
  ok: boolean
  /** 失败原因(确定性规则的可判定描述);通过时为 null */
  reason: string | null
}

/** validateCitations 的整体结果:供工作流与报告判断可进入事实区的集合 */
export interface CitationValidationReport {
  /** 本次检查的引用总数 */
  totalCitations: number
  /** 结构失败的引用清单 */
  failed: CitationCheckResult[]
  /** 结构失败的 claim ID(已落 unsupported) */
  unsupportedClaimIds: string[]
  /** 结构通过且存在支持引用、等待语义审核的 claim ID(保持 candidate) */
  pendingClaimIds: string[]
  /** 结构通过且无 supports 引用的 claim ID(无支持引用即不支持,不升级) */
  noSupportClaimIds: string[]
  /** 结构通过但有 contradicts 引用、等待冲突判定的 claim ID */
  contradictedClaimIds: string[]
}

// ---------- 工具 ----------

function codePoints(text: string): string[] {
  return Array.from(text)
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// ---------- 逐项结构检查(纯函数,不触库) ----------

/**
 * 单条引用的结构闭包检查。检查序即失败原因的判定序:
 * 引用归属 → 清单成员 → 快照存在与 hash → offset 边界 → 文本精确匹配 → chunk 覆盖。
 */
export function checkCitationStructure(input: {
  citation: RunCitationRow['citation']
  span: EvidenceSpan
  snapshot: SnapshotTextRecord | null
  manifest: SnapshotManifest
  chunk: ChunkBoundaryRecord | null
}): CitationCheckResult {
  const { citation, span, snapshot, manifest, chunk } = input
  const fail = (reason: string): CitationCheckResult => ({
    citationId: citation.citationId,
    claimId: citation.claimId,
    evidenceId: citation.evidenceId,
    ok: false,
    reason
  })
  const pass = (): CitationCheckResult => ({
    citationId: citation.citationId,
    claimId: citation.claimId,
    evidenceId: citation.evidenceId,
    ok: true,
    reason: null
  })

  // 1) 来源在冻结清单内:span 的 snapshot 必须出现在本 run 的清单条目中
  const entry = manifest.entries.find((e) => e.snapshot_id === span.snapshotId)
  if (!entry) {
    return fail(`快照 ${span.snapshotId} 不在本运行的冻结清单内,拒绝清单外来源`)
  }

  // 1.5) RES-02:span 必须落在冻结记录范围内——清单外伪造 span(同一文件其他
  // 记录的内容、或范围被改写后的位置)一律拒绝
  if (entry.record_scope !== undefined) {
    const scope = entry.record_scope
    if (span.startOffset < scope.startOffset || span.endOffset > scope.endOffset) {
      return fail(
        `span [${span.startOffset},${span.endOffset}) 超出冻结记录范围 [${scope.startOffset},${scope.endOffset}),拒绝清单外伪造证据`
      )
    }
  }

  // 2) 快照存在且 hash 一致(当前行 text_sha256 == span 落库时清单冻结的 hash)
  if (!snapshot) {
    return fail(`快照不存在:${span.snapshotId}`)
  }
  if (snapshot.textSha256 !== entry.text_sha256) {
    return fail(`快照 hash 与冻结清单不一致:${span.snapshotId}`)
  }

  // 3) offset 合法:0 ≤ start < end ≤ 码点长度
  const cps = codePoints(snapshot.normalizedText)
  if (span.startOffset < 0 || span.endOffset > cps.length || span.startOffset >= span.endOffset) {
    return fail(
      `offset 非法:[${span.startOffset},${span.endOffset}) 超出快照码点范围 [0,${cps.length}) 或顺序颠倒`
    )
  }

  // 4) 文本精确匹配:Array.from(normalized_text).slice(start,end).join('') === quote
  const resliced = cps.slice(span.startOffset, span.endOffset).join('')
  if (resliced !== span.quote) {
    return fail(
      `quote 与快照切片不匹配:offset [${span.startOffset},${span.endOffset}) 处的原文是「${resliced.slice(0, 50)}」,quote 是「${span.quote.slice(0, 50)}」`
    )
  }
  // span_sha256 是 quote 的落库指纹:篡改检测(hash 与清单复核互补)
  if (span.spanSha256 !== sha256Hex(span.quote)) {
    return fail(`span_sha256 与 quote 不一致,片段可能被篡改:${span.evidenceId}`)
  }

  // 5) chunk 覆盖该 span:chunk 界包含 span 界(同快照),且 chunk 内容自身对齐
  if (!chunk) {
    return fail(`chunk 不存在:${span.chunkId}`)
  }
  if (chunk.snapshotId !== span.snapshotId) {
    return fail(`chunk ${chunk.chunkId} 属于快照 ${chunk.snapshotId},与片段快照 ${span.snapshotId} 不一致`)
  }
  if (chunk.startOffset > span.startOffset || chunk.endOffset < span.endOffset) {
    return fail(
      `chunk [${chunk.startOffset},${chunk.endOffset}) 未覆盖 span [${span.startOffset},${span.endOffset})`
    )
  }

  return pass()
}

// ---------- offset 补全 ----------

export interface OffsetResolution {
  ok: boolean
  startOffset: number
  endOffset: number
  /** 失败原因:无命中或多处命中(必须显式定位,不猜) */
  reason: string | null
}

/**
 * 模型只给 quote 时的 offset 补全:仅在限定 chunk 范围内存在**唯一**精确匹配才补;
 * 多处命中必须显式定位(要求提供 offset)或拒绝该证据——不猜(规格第 4 节)。
 * 匹配按码点坐标进行;返回的 offset 是规范化全文的绝对码点坐标。
 */
export function resolveSpanOffsets(input: {
  quote: string
  snapshotText: string
  chunk: Pick<ChunkBoundaryRecord, 'startOffset' | 'endOffset'>
}): OffsetResolution {
  const { quote, snapshotText, chunk } = input
  const cps = codePoints(snapshotText)
  const quoteCps = codePoints(quote)
  const hits: Array<{ start: number; end: number }> = []
  for (let i = chunk.startOffset; i + quoteCps.length <= chunk.endOffset && i + quoteCps.length <= cps.length; i += 1) {
    let matched = true
    for (let j = 0; j < quoteCps.length; j += 1) {
      if (cps[i + j] !== quoteCps[j]) {
        matched = false
        break
      }
    }
    if (matched) hits.push({ start: i, end: i + quoteCps.length })
  }
  if (hits.length === 0) {
    return { ok: false, startOffset: -1, endOffset: -1, reason: `quote 在限定 chunk [${chunk.startOffset},${chunk.endOffset}) 内无精确匹配` }
  }
  if (hits.length > 1) {
    const positions = hits.map((h) => `[${h.start},${h.end})`).join(', ')
    return {
      ok: false,
      startOffset: -1,
      endOffset: -1,
      reason: `quote 在限定 chunk 内命中 ${hits.length} 处(${positions}),必须显式提供 offset,不猜测定位`
    }
  }
  return { ok: true, startOffset: hits[0]!.start, endOffset: hits[0]!.end, reason: null }
}

// ---------- all_of 证据组判定 ----------

/** 同一 claim 下某 all_of 组的成员结构结果 */
export interface EvidenceGroupCheck {
  groupId: string
  /** 组内全部成员结构有效才算支持 */
  satisfied: boolean
  /** 未通过结构的成员引用 ID(缺一则整组不成立) */
  failedCitationIds: string[]
}

/**
 * all_of 组判定:把 (claim, evidence_group_id) 相同、group_operator='all_of' 的
 * supports 引用视为一组,组内全部结构有效才 satisfied;缺一则整组不成立。
 * relation='context' 的引用不参与支持判定(见 supportsOf)。
 */
export function evaluateAllOfGroups(
  rows: readonly RunCitationRow[],
  structure: ReadonlyMap<string, CitationCheckResult>
): EvidenceGroupCheck[] {
  const groups = new Map<string, RunCitationRow[]>()
  for (const row of rows) {
    if (row.citation.relation !== 'supports') continue
    if (row.citation.evidenceGroupId === null || row.citation.groupOperator !== 'all_of') continue
    const key = `${row.citation.claimId}::${row.citation.evidenceGroupId}`
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  }
  const checks: EvidenceGroupCheck[] = []
  for (const [key, members] of groups) {
    const failedCitationIds = members
      .map((m) => structure.get(m.citation.citationId))
      .filter((r): r is CitationCheckResult => r !== undefined && !r.ok)
      .map((r) => r.citationId)
    checks.push({
      groupId: key.split('::')[1] ?? key,
      satisfied: failedCitationIds.length === 0,
      failedCitationIds
    })
  }
  return checks
}

/** claim 的非组支持引用:存在任一结构有效的 supports(非 context)即视为有支持面 */
export function hasUngroupedSupport(rows: readonly RunCitationRow[], structure: ReadonlyMap<string, CitationCheckResult>): boolean {
  return rows.some((row) => {
    if (row.citation.relation !== 'supports') return false
    if (row.citation.evidenceGroupId !== null && row.citation.groupOperator === 'all_of') return false
    const result = structure.get(row.citation.citationId)
    return result !== undefined && result.ok
  })
}

/** claim 的 contradicts 引用(结构有效的)ID 清单;供冲突检测使用 */
export function validContradictsEvidenceIds(rows: readonly RunCitationRow[], structure: ReadonlyMap<string, CitationCheckResult>): string[] {
  return rows
    .filter((row) => row.citation.relation === 'contradicts')
    .filter((row) => {
      const result = structure.get(row.citation.citationId)
      return result !== undefined && result.ok
    })
    .map((row) => row.citation.evidenceId)
}

// ---------- all_of 联合证据完整性(RES-03) ----------

/**
 * all_of 预期成员清单:抽取期与 Claim、引用同事务持久化于 Claim.review
 * 的 evidence_requirements 段;被拒成员保存 null ID 与拒绝原因,
 * 禁止只留下有效成员。
 */
export interface AllOfRequirement {
  version: 1
  groupId: string
  expectedIndices: number[]
  members: Array<{
    index: number
    evidenceId: string | null
    citationId: string | null
    rejectionReason: string | null
  }>
}

/** 完整性判定结果:missingIndices 是缺失的预期成员下标 */
export interface AllOfCompleteness {
  satisfied: boolean
  missingIndices: number[]
}

/**
 * all_of 完整性判定:expectedIndices 非空、无重复,members 与之精确一一对应,
 * 所有成员 evidenceId/citationId 非 null、无 rejectionReason 且 citation 在
 * 结构通过集合内;未知结果(结构结果缺失)按缺失处理。
 */
export function checkAllOfCompleteness(
  requirement: AllOfRequirement,
  validCitationIds: ReadonlySet<string>
): AllOfCompleteness {
  const expected = Array.isArray(requirement.expectedIndices) ? requirement.expectedIndices : []
  const members = Array.isArray(requirement.members) ? requirement.members : []
  if (expected.length === 0 || new Set(expected).size !== expected.length) {
    // 预期清单非法(空组/重复成员):整组不成立,不能用剩余引用数推测原始成员数
    return { satisfied: false, missingIndices: [...expected].sort((a, b) => a - b) }
  }
  const missing: number[] = []
  for (const index of expected) {
    const member = members.find((m) => m.index === index)
    if (
      member === undefined ||
      member.rejectionReason !== null ||
      member.evidenceId === null ||
      member.citationId === null ||
      !validCitationIds.has(member.citationId)
    ) {
      missing.push(index)
    }
  }
  return { satisfied: missing.length === 0, missingIndices: missing.sort((a, b) => a - b) }
}

/**
 * 汇总缺员(或缺预期清单)的 all_of 命题 ID:供 reviewClaims 送审入口与
 * buildReport 事实区过滤使用。判定口径:citation 的 span 结构结果为 valid
 * (validateCitations 之后)才计入通过集合;未经结构检查的按缺失处理。
 */
export function allOfIncompleteClaimIds(db: SqliteDb, claims: readonly Claim[]): Set<string> {
  const blocked = new Set<string>()
  for (const claim of claims) {
    const requirements = loadAllOfRequirements(db, claim.claimId)
    if (requirements.length === 0) continue
    const rows = listRunCitationsForClaim(db, claim)
    const validIds = new Set(
      rows
        .filter((row) => row.citation.relation === 'supports' && row.span.validationStatus === 'valid')
        .map((row) => row.citation.citationId)
    )
    const groupIds = new Set(
      rows
        .filter((row) => row.citation.evidenceGroupId !== null && row.citation.groupOperator === 'all_of')
        .map((row) => row.citation.evidenceGroupId as string)
    )
    for (const groupId of groupIds) {
      const requirement = requirements.find((r) => r.groupId === groupId)
      if (!requirement || !checkAllOfCompleteness(requirement, validIds).satisfied) {
        blocked.add(claim.claimId)
        break
      }
    }
  }
  return blocked
}

// ---------- 主入口 ----------

/**
 * 引用闭包检查(结构层):
 * 1) 沿 Claim → Citation → EvidenceSpan → SourceSnapshot → Source 逐项校验,
 *    失败引用落 span invalid + claim unsupported;
 * 2) 无 supports 引用或 all_of 组缺员的 claim 落 unsupported(不升级为支持);
 * 3) 结构通过且存在有效 supports 面的 claim 保持 candidate,等待语义审核;
 * 4) 已被报告版本冻结的实体跳过回写(版本不可变)。
 * manifest 先经 verifySnapshotManifest 复核,快照被替换即整体失败(SNAPSHOT_HASH_MISMATCH)。
 */
export function validateCitations(db: SqliteDb, runId: string): CitationValidationReport {
  const task = getResearchTaskByRun(db, runId)
  if (!task) throw new Error(`运行缺少研究任务:${runId}`)
  const manifest = verifySnapshotManifest(db, task.snapshotManifestId)

  const spans = listEvidenceSpansForRun(db, runId)
  const snapshotCache = new Map<string, SnapshotTextRecord | null>()
  const chunkCache = new Map<string, ChunkBoundaryRecord | null>()
  for (const span of spans) {
    if (!snapshotCache.has(span.snapshotId)) {
      snapshotCache.set(span.snapshotId, getSnapshotText(db, span.snapshotId))
    }
    if (!chunkCache.has(span.chunkId)) {
      chunkCache.set(span.chunkId, getChunkBoundary(db, span.chunkId))
    }
  }

  const rows = listCitationsForRun(db, runId)
  const structure = new Map<string, CitationCheckResult>()
  const failed: CitationCheckResult[] = []
  for (const row of rows) {
    const result = checkCitationStructure({
      citation: row.citation,
      span: row.span,
      snapshot: snapshotCache.get(row.span.snapshotId) ?? null,
      manifest,
      chunk: chunkCache.get(row.span.chunkId) ?? null
    })
    structure.set(row.citation.citationId, result)
    if (!result.ok) failed.push(result)
  }

  const frozenClaims = listFrozenClaimIds(db, task.researchTaskId)
  const frozenSpans = listFrozenEvidenceIds(db, task.researchTaskId)

  // span 状态:被任一失败引用指向的片段 invalid;仅被有效引用指向的片段 valid;
  // 无引用的候选片段保持 candidate(抽取阶段落库,未经引用不定性)。
  const spanVerdict = new Map<string, boolean>()
  for (const row of rows) {
    const result = structure.get(row.citation.citationId)
    if (result === undefined) continue
    const prev = spanVerdict.get(row.span.evidenceId)
    spanVerdict.set(row.span.evidenceId, prev === undefined ? result.ok : prev && result.ok)
  }
  for (const [evidenceId, ok] of spanVerdict) {
    if (frozenSpans.has(evidenceId)) continue
    updateEvidenceSpanStatus(db, evidenceId, ok ? 'valid' : 'invalid')
  }

  const report: CitationValidationReport = {
    totalCitations: rows.length,
    failed,
    unsupportedClaimIds: [],
    pendingClaimIds: [],
    noSupportClaimIds: [],
    contradictedClaimIds: []
  }

  const claims = listClaims(db, task.researchTaskId)
  for (const claim of claims) {
    const claimRows = listRunCitationsForClaim(db, claim)
    const claimStructure = new Map<string, CitationCheckResult>()
    for (const row of claimRows) {
      const result = structure.get(row.citation.citationId)
      if (result !== undefined) claimStructure.set(row.citation.citationId, result)
    }
    // 结构失败:引用错配是可判定错误,claim 直接落 unsupported
    const anyFailed = claimRows.some((row) => {
      const result = claimStructure.get(row.citation.citationId)
      return result !== undefined && !result.ok
    })
    // RES-03:all_of 组先按结构结果,再按持久化预期清单判定完整性——
    // 缺任一预期成员、缺清单([ALL_OF_EXPECTATION_MISSING])整组不成立
    const requirements = loadAllOfRequirements(db, claim.claimId)
    const groupComplete = (group: EvidenceGroupCheck): boolean => {
      if (!group.satisfied) return false
      const requirement = requirements.find((r) => r.groupId === group.groupId)
      if (!requirement) return false // [ALL_OF_EXPECTATION_MISSING]
      const validIds = new Set(
        claimRows
          .filter((row) => row.citation.relation === 'supports' && row.citation.evidenceGroupId === group.groupId)
          .filter((row) => claimStructure.get(row.citation.citationId)?.ok === true)
          .map((row) => row.citation.citationId)
      )
      return checkAllOfCompleteness(requirement, validIds).satisfied
    }
    const allOfGroups = evaluateAllOfGroups(claimRows, claimStructure)
    const missingGroup = allOfGroups.find((g) => !groupComplete(g))
    const groupMissing = missingGroup !== undefined
    const hasSupport = hasUngroupedSupport(claimRows, claimStructure)
    const contradicted = validContradictsEvidenceIds(claimRows, claimStructure).length > 0

    // 无任何引用(或只有 context 引用)同样不构成支持:无支持引用即不支持,不升级
    const hasAnySupportCitation = claimRows.some((row) => row.citation.relation === 'supports')
    if (!hasAnySupportCitation) report.noSupportClaimIds.push(claim.claimId)

    if (groupMissing || anyFailed || (!hasSupport && !hasAnySupportCitation)) {
      report.unsupportedClaimIds.push(claim.claimId)
      if (!frozenClaims.has(claim.claimId)) {
        // 原因判定:all_of 缺员/缺清单优先于单项失败(整组不成立是更准确的语义结论;
        // 无组且无支持引用次之;单项引用失败兜底)
        let reason: string
        if (missingGroup !== undefined) {
          const requirement = requirements.find((r) => r.groupId === missingGroup.groupId)
          reason = requirement
            ? `all_of 证据组 ${missingGroup.groupId} 缺少有效成员(缺员下标 ${checkAllOfCompleteness(requirement, validIdsOfGroup(claimRows, claimStructure, missingGroup.groupId)).missingIndices.join(', ')}),整组不成立`
            : `all_of 证据组 ${missingGroup.groupId} 缺少预期成员清单 [ALL_OF_EXPECTATION_MISSING],整组不成立`
        } else if (anyFailed) {
          reason = failed.find((f) => f.claimId === claim.claimId)?.reason ?? '引用结构检查失败'
        } else {
          reason = 'claim 没有任何 supports 引用,不构成支持'
        }
        updateClaimReview(db, claim.claimId, 'unsupported', {
          stage: 'structure_check',
          reason
        })
      }
      continue
    }
    if (contradicted) report.contradictedClaimIds.push(claim.claimId)
    report.pendingClaimIds.push(claim.claimId)
  }

  return report
}

/** 组内结构通过的引用 ID 集合(缺员原因展示用) */
function validIdsOfGroup(
  rows: readonly RunCitationRow[],
  structure: ReadonlyMap<string, CitationCheckResult>,
  groupId: string
): Set<string> {
  return new Set(
    rows
      .filter((row) => row.citation.relation === 'supports' && row.citation.evidenceGroupId === groupId)
      .filter((row) => structure.get(row.citation.citationId)?.ok === true)
      .map((row) => row.citation.citationId)
  )
}
