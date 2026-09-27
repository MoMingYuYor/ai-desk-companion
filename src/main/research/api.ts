// 研究 IPC API 层(R-06):API 语义经 IPC 通道实现(错误码代替 HTTP 状态码)。
//
// 边界:
// 1. 只做 IO 适配与错误码映射,不含业务规则;领域函数来自 repository/snapshots/reports
//    的既有导出;workflow 经 IpcResearchWorkflow 最小结构接口注入,不 import workflow.ts
//    的具体类(与并行代理 G 的实现解耦,实际接线由主代理在合并后完成);
// 2. 错误信封复用 shared/operations.ts 的 appError 体系(VALIDATION/CONFLICT/
//    TARGET_UNAVAILABLE),研究错误码以 message 前缀 `[CODE]` 透传(R-01 词表),
//    对应 §7 的 4xx/409/404 语义;
// 3. snapshot-get 按 document_id 查询授权快照,不暴露任意路径读取能力;
// 4. import-documents 接受渲染层经文件对话框选取的字节列表,单批上限由
//    snapshots.IMPORT_BATCH_LIMIT 与 MAX_DOCUMENT_BYTES 把守。

import type { SqliteDb } from '../db/connection'
import { appError } from '../../shared/operations'
import { OperationError } from '../db/operations'
import { createResearchRun, getEvidenceSpan, getReport, getResearchTaskByRun, latestReport } from './repository'
import {
  getResearchSourceRecord,
  importResearchSources,
  type ImportedResearchSource,
  type ResearchSourceInput
} from './snapshots'
import { assembleReportResponse, type ReportResponse } from './reports'
import type { ResearchSnapshotView } from '../../shared/api'
import type { ResearchReportResponse } from '../../shared/researchReport'

/**
 * R-04 工作流的最小结构接口(与 ResearchWorkflow 的公开方法对齐,由组合层适配注入):
 * startDriver 驱动已创建的运行(创建路径与澄清受理后共用);acceptAnswers 受理澄清答案;
 * cancel 请求协作取消。本层不 import workflow.ts 的具体类。
 */
export interface IpcResearchWorkflow {
  startDriver(runId: string): unknown
  acceptAnswers(runId: string, answers: unknown): unknown
  cancel(runId: string): unknown
}

/** research:run-create 的入参(渲染层载荷;operationId 为幂等键) */
export interface ResearchRunCreatePayload {
  question: string
  snapshotIds: string[]
  constraints?: Record<string, string | number | boolean>
  budget?: Record<string, number>
  operationId: string
}

/** 渲染层传入的导入文件:名称 + 字节(IPC 序列化为普通对象,需还原 Buffer) */
export interface ResearchImportFilePayload {
  name: string
  bytes: Uint8Array | Buffer | Array<number>
}

function validationError(message: string): OperationError {
  return new OperationError(appError('VALIDATION', message, { retryable: false }))
}

function researchFailure(appCode: 'CONFLICT' | 'TARGET_UNAVAILABLE' | 'VALIDATION', code: string, message: string): OperationError {
  return new OperationError(appError(appCode, `[${code}] ${message}`, { retryable: false }))
}

// ---------- 创建研究运行(幂等) ----------

export function handleResearchRunCreate(db: SqliteDb, workflow: IpcResearchWorkflow | undefined, payload: ResearchRunCreatePayload): {
  runId: string
  status: string
  replayed: boolean
  researchTaskId: string
  snapshotManifestId: string
} {
  if (!payload || typeof payload !== 'object') throw validationError('研究请求必须是对象')
  if (typeof payload.operationId !== 'string' || payload.operationId === '') {
    throw validationError('缺少幂等键 operationId')
  }
  // 请求载荷按 R-01 请求 schema 组装(未知字段与边界在 parseResearchRequest 拒绝);
  // 请求摘要只含规范化业务输入,幂等回执由 runOperation 按 operationId 兜底
  const request: Record<string, unknown> = {
    question: payload.question,
    snapshot_ids: payload.snapshotIds,
    snapshot_policy: 'fixed'
  }
  if (payload.constraints !== undefined) request.constraints = payload.constraints
  if (payload.budget !== undefined) request.budget = payload.budget

  const { value, replayed } = createResearchRun(
    db,
    { request, contextClock: new Date().toISOString() },
    payload.operationId
  )
  // 202 语义:创建/回放成功即返回 queued;执行由 R-04 工作流异步驱动
  if (workflow && !replayed) {
    try {
      workflow.startDriver(value.run.runId)
    } catch (err: unknown) {
      console.error('[research] 工作流启动异常:', err instanceof Error ? err.message : String(err))
    }
  }
  return {
    runId: value.run.runId,
    status: value.run.status,
    replayed,
    researchTaskId: value.task.researchTaskId,
    snapshotManifestId: value.manifest.manifestId
  }
}

// ---------- 报告读取(REPORT_NOT_READY / REPORT_VERSION_NOT_FOUND) ----------

/** ReportResponse(主进程形态)→ ResearchReportResponse(共享投影),并富化引用的抽屉定位字段 */
function toSharedReport(response: ReportResponse, db: SqliteDb): ResearchReportResponse {
  const shared = response as ResearchReportResponse
  // 引用补充 snapshot/offset(证据抽屉按码点高亮);span 缺失时字段缺省,抽屉退化为全文只读
  for (const citation of shared.citations) {
    const span = getEvidenceSpan(db, citation.evidence_id)
    if (span) {
      citation.snapshot_id = span.snapshotId
      citation.start_offset = span.startOffset
      citation.end_offset = span.endOffset
      citation.quote = span.quote
    }
  }
  return shared
}

export function handleResearchReportGet(db: SqliteDb, runId: string, version?: number): ResearchReportResponse {
  const task = getResearchTaskByRun(db, runId)
  if (!task) throw researchFailure('TARGET_UNAVAILABLE', 'SNAPSHOT_NOT_FOUND', `研究运行不存在:${runId}`)
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
    throw researchFailure('VALIDATION', 'REPORT_VERSION_NOT_FOUND', `报告版本非法:${String(version)}`)
  }
  const report = version === undefined ? latestReport(db, task.researchTaskId) : getReport(db, task.researchTaskId, version)
  if (!report) {
    // §7:没有任何报告版本 → 409 REPORT_NOT_READY;指定版本不存在 → 404 REPORT_VERSION_NOT_FOUND
    if (version === undefined) {
      throw researchFailure('CONFLICT', 'REPORT_NOT_READY', `研究运行 ${runId} 还没有可用报告版本`)
    }
    const latest = latestReport(db, task.researchTaskId)
    throw researchFailure(
      'VALIDATION',
      'REPORT_VERSION_NOT_FOUND',
      `报告版本 v${version} 不存在${latest ? `(当前最大版本 v${latest.version})` : ''}`
    )
  }
  return toSharedReport(assembleReportResponse(db, runId, report, { runStatus: task.phase }), db)
}

// ---------- 证据抽屉快照读取 ----------

export function handleResearchSnapshotGet(db: SqliteDb, snapshotId: string): ResearchSnapshotView {
  if (typeof snapshotId !== 'string' || snapshotId === '') {
    throw validationError('缺少快照 ID')
  }
  const record = getResearchSourceRecord(db, snapshotId)
  if (!record) {
    throw researchFailure('TARGET_UNAVAILABLE', 'SNAPSHOT_NOT_FOUND', `快照不存在或不可见:${snapshotId}`)
  }
  return {
    snapshotId: record.documentId,
    sourceName: record.sourceName,
    sourceType: record.sourceType,
    sourceIdentity: record.sourceIdentity,
    provenanceGroupId: record.provenanceGroupId,
    textSha256: record.textSha256,
    normalizedText: record.normalizedText,
    codePointLength: record.codePointLength,
    collectedAt: record.collectedAt,
    collectionTimeBasis: record.collectionTimeBasis
  }
}

// ---------- 资料导入 ----------

export function handleResearchImportDocuments(db: SqliteDb, files: ResearchImportFilePayload[]): Array<{
  ok: boolean
  documentId?: string
  sourceName: string
  sourceType: string | null
  sourceLocator: string | null
  recordIndex: number | null
  sourceIdentity?: string
  provenanceGroupId?: string
  textSha256?: string
  codePointLength?: number
  chunkCount?: number
  deduped?: boolean
  error?: { code: string; message: string }
}> {
  if (!Array.isArray(files) || files.length === 0) throw validationError('导入清单为空:至少需要一个来源文件')
  const sources: ResearchSourceInput[] = files.map((f) => {
    if (!f || typeof f.name !== 'string') throw validationError('导入文件缺少名称')
    // IPC 传输后 Buffer 退化为普通对象/数组,统一还原为 Buffer(结构化克隆下 Uint8Array 原样保留)
    const bytes = Buffer.isBuffer(f.bytes)
      ? f.bytes
      : Buffer.from(f.bytes as Uint8Array)
    return { sourceName: f.name, bytes }
  })
  const outcomes = importResearchSources(db, { sources })
  return outcomes.map((o) => {
    if (o.ok) {
      const okOut = o as ImportedResearchSource
      return {
        ok: true,
        documentId: okOut.documentId,
        sourceName: okOut.sourceName,
        sourceType: okOut.sourceType,
        sourceLocator: okOut.sourceLocator,
        recordIndex: okOut.recordIndex,
        sourceIdentity: okOut.sourceIdentity,
        provenanceGroupId: okOut.provenanceGroupId,
        textSha256: okOut.textSha256,
        codePointLength: okOut.codePointLength,
        chunkCount: okOut.chunkCount,
        deduped: okOut.deduped
      }
    }
    return {
      ok: false,
      sourceName: o.sourceName,
      sourceType: o.sourceType,
      sourceLocator: o.sourceLocator,
      recordIndex: o.recordIndex,
      error: { code: o.error.code, message: o.error.message }
    }
  })
}

// ---------- 依赖装配(ipc.ts 调用) ----------

export interface ResearchApiDeps {
  db: SqliteDb
  /** R-04 工作流;缺省时创建仍落库,执行驱动报明确错误(兼容旧测试桩) */
  researchWorkflow?: IpcResearchWorkflow
}
