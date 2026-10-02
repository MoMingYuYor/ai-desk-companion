// 评测 Runner(E-03):按"案例 × 配置 × 重复"执行,隔离环境,结果持久化可续跑。
//
// 关键规则(LLM Eval Lab 规格第 6 节 + EVAL-02 修正 F-10/F-12):
// - fake/real 分离:fake 结果标 execution_kind='fake',不得当真实模型能力;
// - 已启动后失败或超时的案例保留在分母;未启动案例标 not_run 并记录终止原因
//   (user_cancelled / budget_exhausted / interrupted);
// - 取消:领取每个组合前检查 cancelRequested;正在执行的案例经 AbortSignal
//   广播协作停止(RES-01 signal 协议接线点);整批收尾不能把取消覆盖成 completed,
//   已完成结果原样保留;
// - 重启续跑:按 (eval_run_id, config_id, case_id, repeat_index) 唯一组合
//   跳过有完整产物的结果,不覆盖原记录;已领取未收尾的组合记 interrupted
//   并保留分母;预算按已启动唯一组合计算,重启不重置;
// - 状态文件:临时文件写入后原子替换;续跑前校验 schema/数据 hash/配置/split/
//   重复次数/唯一键;损坏文件抛可诊断错误并保留原文件,禁止静默重置为新实验;
// - 全局 epoch 不再由评测初始化(F-12 修正):案例用局部 epoch(isolation 提供),
//   生产 epoch 在评测前后保持不变;
// - interaction_script 经 runner 驱动真实入口(decide/acceptAnswers),
//   不存在"评测模式自动批准"开关;
// - 每个案例的临时环境用后即弃;
// - EVAL-03(F-11):隔离案例关闭前导出可回放产物到
//   <artifactRoot>/<evalRunId>/<configId>/<caseId>/<repeatIndex>/,
//   临时库移入该批次的 temporary/;导出失败保留临时库并标 artifact_failed,
//   不把案例标成可回放;research case 另做 gold 判分(gold 只进入评分模块,
//   评测输入只有 question/snapshot_ids);
// - EVAL-04(F-13):`realCompleter?: unknown` 换成类型明确的 completerFactory
//   (按 configId 与案例上下文创建实例;real 上下文类型上不含 gold);每个案例
//   的补全实例包一层路由记录,结果透传 actualProvider/modelAttempts——实际
//   发生备用切换时报告可单列路由,不与冻结配置的 model 混算。

import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { Clock } from '../../shared/clock'
import type { LoadedDataset } from './dataset'
import type { EvalCase, EvalSplit } from './types'
import { createIsolatedCaseEnv, type IsolatedCaseEnv } from './isolation'
import type { ScoringToolObservation } from './observations'
import { mergeObservations } from './observations'
import type { RuleCheck } from './rules'
import { evaluateParameterRules } from './rules'
import type { ToolObservationV1 } from '../tools/types'
import { RunOrchestrator } from '../agent/orchestrator'
import { RunQueue } from '../agent/runQueue'
import { ToolGateway } from '../tools/gateway'
import { ToolRegistry } from '../tools/registry'
import { registerOpsTools } from '../tools/definitions'
import { FakeProvider } from '../providers/fake'
import { getRun, listTraceEvents, listApprovals, appendTraceEvent } from '../runs/repository'
import { ResearchWorkflow } from '../research/workflow'
import {
  getResearchTaskByRun,
  getSnapshotManifest,
  latestReport,
  listClaims,
  listCitationsForRun,
  listEvidenceSpansForRun,
  listSubQuestions
} from '../research/repository'
import { assembleReportResponse } from '../research/reports'
import {
  registerResearchFixture,
  researchFakeScriptFor,
  type ResearchSeedResult
} from './researchAdapter'
import {
  defaultCodeVersion,
  exportCaseArtifacts,
  finalizeCaseArtifactOutcome,
  temporaryRoot,
  type CaseArtifactPayload
} from './artifacts'
import {
  loadResearchGold,
  scoreResearchCase,
  type ResearchScoreResult,
  type ResearchScoringInput
} from './researchRules'
import type { ActualProvider, ModelAttemptRecord } from '../services/modelRequest'
import type {
  StructuredCompleteRequest,
  StructuredCompleteResult,
  StructuredCompleter
} from '../agent/llm'
import { opsFakeScriptFor, type EvalCompleterContext, type EvalCompleterFactory } from './completerFactory'
import { selectExplicitSmokeCases } from './experiment'

export type ExecutionKind = 'fake' | 'real'

/** 批次终止原因:整批收尾按取消/预算/中断归类,不得伪装成正常完成 */
export type EvalStopReason = 'user_cancelled' | 'budget_exhausted' | 'interrupted' | null

export interface EvalExperimentConfig {
  /** 冻结配置标识(如 fts_single_pass / bounded_research) */
  config_id: string
  description: string
  execution_kind: ExecutionKind
  /** 冻结说明:代码版本、提示词 hash、工具版本等 */
  freeze_note: string
}

export type CaseOutcomeStatus = 'passed' | 'failed' | 'not_run'

export interface EvalCaseOutcome {
  configId: string
  caseId: string
  repeatIndex: number
  status: CaseOutcomeStatus
  /** 关联的 AgentRun(未启动为空) */
  runId: string | null
  terminalStatus: string | null
  failureReasons: string[]
  executedTools: string[]
  confirmedBypass: boolean
  /** 合并后的工具观测(EVAL-01;网关接线前缺省=未测,不伪造) */
  toolObservations?: ScoringToolObservation[]
  /** 逐条参数规则判分(EVAL-01;同上) */
  ruleChecks?: RuleCheck[]
  /** 案例真实耗时(单调钟,毫秒);null/缺省 = 未测 */
  durationMs?: number | null
  /** research case 的完整轨迹可经该 run_id 在评测产物内回放(R-07 最小扩展) */
  traceRunId?: string | null
  /**
   * EVAL-03:产物导出状态。ok = manifest 完整可回放;artifact_failed =
   * 导出失败,临时库保留待人工复核,该案例绝不标记为可回放。
   */
  artifactStatus?: 'ok' | 'artifact_failed'
  /** 产物目录(相对 artifactRoot 的批次内路径);导出失败为空 */
  artifactDir?: string | null
  /** EVAL-03:research gold 判分结果(仅 research case;gold 缺失时 applicable=false) */
  researchScoring?: ResearchScoreResult | null
  /**
   * EVAL-04:实际派发路由(来自补全结果;fake 无网络为 null)。与冻结配置的
   * model 不同即发生了备用切换,报告单列路由,不混算同模型提升。
   */
  actualProvider?: ActualProvider | null
  /** EVAL-04:逐次发送尝试结算记录(备用切换/失败尝试可见;fake 为空数组) */
  modelAttempts?: ModelAttemptRecord[]
}

/** 领取日志:组合一旦启动即落盘,是中断检测与预算计数的依据 */
export interface EvalClaimRecord {
  configId: string
  caseId: string
  repeatIndex: number
  startedAt: string
}

/** 重启检测到的中断:上次批次存在已领取但无完整收尾的组合 */
export interface EvalInterruption {
  detectedAt: string
  combos: string[]
}

export interface EvalRunState {
  evalRunId: string
  datasetVersion: string
  casesSha256: string
  splits: EvalSplit[]
  configIds: string[]
  executionKind: ExecutionKind
  repeats: number
  maxCases: number
  caseIds?: string[]
  status: 'running' | 'completed' | 'cancelled'
  startedAt: string
  finishedAt: string | null
  results: EvalCaseOutcome[]
  /** 状态文件 schema 版本(续跑校验必需) */
  schemaVersion?: 1
  /** 本批次终止原因 */
  stopReason?: EvalStopReason
  /** 领取日志(已启动唯一组合) */
  claims?: EvalClaimRecord[]
  /** 显式重新试验的来源运行 ID(不覆盖原失败) */
  originEvalRunId?: string | null
  /** 重启检测到的中断信息 */
  lastInterruption?: EvalInterruption | null
}

/** 领取前的控制点钩子(测试注入取消时机;亦为限流/收口预留) */
export type BeforeClaimHook = (combo: {
  configId: string
  caseId: string
  repeatIndex: number
}) => void | Promise<void>

export interface RunnerDeps {
  /** 评测根目录(artifacts 之下),状态与临时目录都在其中 */
  artifactRoot: string
  sqlJsDistDir: string
  /** 已加载并校验的数据集 */
  dataset: LoadedDataset
  /**
   * EVAL-04:类型明确的补全工厂(按 configId 与案例上下文创建实例)。
   * fake 执行未提供工厂时走既有内置 FakeProvider 通路;real 执行必须提供。
   */
  completerFactory?: EvalCompleterFactory
  /** 每个组合领取前调用(可 await);测试用其注入确定性取消时机 */
  beforeClaim?: BeforeClaimHook
  /**
   * EVAL-03:数据集根目录(research gold 标注从 <datasetRoot>/annotations 读取)。
   * 缺省回退 process.cwd()/evals/datasets/<datasetVersion>(EvalResourcePaths
   * 接管前的过渡形态,与 RESEARCH_FIXTURE_ROOT 同一约定)。
   */
  datasetRoot?: string
}

/** 状态文件损坏或不兼容:抛出可诊断错误,原文件保留,绝不静默重置 */
export class EvalStateError extends Error {
  constructor(message: string, readonly stateFile: string) {
    super(message)
    this.name = 'EvalStateError'
  }
}

/** EVAL-04:捕获补全结果的实际路由与逐尝试记录(透传到结果,备用切换可见) */
class RecordingCompleter implements StructuredCompleter {
  private readonly routed: ActualProvider[] = []
  private readonly attemptRecords: ModelAttemptRecord[] = []

  constructor(private readonly inner: StructuredCompleter) {}

  async completeJson<T>(request: StructuredCompleteRequest): Promise<StructuredCompleteResult<T>> {
    const result = await this.inner.completeJson<T>(request)
    if (result.actualProvider) this.routed.push(result.actualProvider)
    if (result.attempts.length > 0) this.attemptRecords.push(...result.attempts)
    return result
  }

  /** 最近一次实际派发路由(无网络 fake 为 null) */
  get lastProvider(): ActualProvider | null {
    return this.routed.length > 0 ? this.routed[this.routed.length - 1]! : null
  }

  /** 全部发送尝试结算记录(只读快照) */
  get attemptsSnapshot(): ModelAttemptRecord[] {
    return [...this.attemptRecords]
  }
}

function outcomeKey(configId: string, caseId: string, repeat: number): string {
  return `${configId}::${caseId}::${repeat}`
}

function nowIso(): string {
  return new Date().toISOString()
}

function stableJson(value: unknown): string {
  return JSON.stringify(value)
}

/** 轮询等待条件成立(研究链为 startRun 异步驱动;timeout 内不成立返回 false) */
async function waitUntilTerminal(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

/** trace 事件按交付序收集 retrieval 的 hitChunkIds(Recall@k 的 retrieved 集合来源) */
function retrievedChunkIdsOf(trace: ReturnType<typeof listTraceEvents>): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const event of trace) {
    if (event.eventType !== 'retrieval') continue
    const hits = (event.payload as { hitChunkIds?: unknown } | undefined)?.hitChunkIds
    if (!Array.isArray(hits)) continue
    for (const id of hits) {
      if (typeof id === 'string' && !seen.has(id)) {
        seen.add(id)
        ordered.push(id)
      }
    }
  }
  return ordered
}

type ResearchDb = import('../db/connection').SqliteDb

/** 研究运行数据的一次性收集(gold 判分与产物导出共用;临时库关闭前调用) */
interface ResearchRunData {
  task: ReturnType<typeof getResearchTaskByRun>
  claims: ReturnType<typeof listClaims>
  citations: ReturnType<typeof listCitationsForRun>
  spans: ReturnType<typeof listEvidenceSpansForRun>
  subquestions: ReturnType<typeof listSubQuestions>
  retrievedChunkIds: string[]
  chunksBySnapshot: Map<string, Array<{ chunkId: string; startOffset: number; endOffset: number }>>
  manifest: ReturnType<typeof getSnapshotManifest>
}

function collectResearchRunData(db: ResearchDb, runId: string): ResearchRunData {
  const task = getResearchTaskByRun(db, runId)
  if (!task) {
    return {
      task: null,
      claims: [],
      citations: [],
      spans: [],
      subquestions: [],
      retrievedChunkIds: [],
      chunksBySnapshot: new Map(),
      manifest: null
    }
  }
  const claims = listClaims(db, task.researchTaskId)
  const citations = listCitationsForRun(db, runId)
  const spans = listEvidenceSpansForRun(db, runId)
  const subquestions = listSubQuestions(db, task.researchTaskId)
  const manifest = getSnapshotManifest(db, task.snapshotManifestId)
  // 冻结快照的块索引(gold span → 相交 chunk 的映射基础;RES-02 范围内分块)
  const chunksBySnapshot = new Map<string, Array<{ chunkId: string; startOffset: number; endOffset: number }>>()
  if (manifest) {
    for (const entry of manifest.entries) {
      const rows = db.all<{ chunk_id: string; start_offset: number; end_offset: number }>(
        'SELECT chunk_id, start_offset, end_offset FROM retrieval_chunks WHERE document_id = ? ORDER BY start_offset ASC',
        [entry.snapshot_id]
      )
      chunksBySnapshot.set(
        entry.snapshot_id,
        rows.map((r) => ({ chunkId: r.chunk_id, startOffset: r.start_offset, endOffset: r.end_offset }))
      )
    }
  }
  return {
    task,
    claims,
    citations,
    spans,
    subquestions,
    retrievedChunkIds: retrievedChunkIdsOf(listTraceEvents(db, runId)),
    chunksBySnapshot,
    manifest
  }
}

/**
 * research case 的 report/evidence/snapshots 产物段:内容来自研究链真实产物;
 * 运行未创建或任务缺失时如实记录原因,不伪造研究成果。
 */
function researchArtifactSections(
  env: IsolatedCaseEnv,
  caseDef: EvalCase,
  base: EvalCaseOutcome
): Pick<CaseArtifactPayload, 'report' | 'evidence' | 'snapshots'> {
  const db = env.db
  const runId = base.runId
  const data = runId ? collectResearchRunData(db, runId) : null
  if (!runId || !data || !data.task) {
    return {
      report: { report_applicable: true, report: null, reason: '研究任务或运行未创建,无报告版本' },
      evidence: { applicable: true, run_id: runId, question: caseDef.input, claims: [], citations: [], spans: [], subquestions: [] },
      snapshots: { applicable: true, manifest_id: null, manifest_sha256: null, snapshots: [] }
    }
  }
  const evidence = {
    applicable: true,
    run_id: runId,
    question: caseDef.input,
    claims: data.claims.map((c) => ({
      claim_id: c.claimId,
      text: c.text,
      claim_type: c.claimType,
      support_status: c.supportStatus,
      subquestion_id: c.subquestionId,
      conflict_group: c.conflictGroup
    })),
    citations: data.citations.map((r) => ({
      citation_id: r.citation.citationId,
      claim_id: r.claim.claimId,
      evidence_id: r.citation.evidenceId,
      relation: r.citation.relation
    })),
    spans: data.spans.map((s) => ({
      evidence_id: s.evidenceId,
      snapshot_id: s.snapshotId,
      chunk_id: s.chunkId,
      start_offset: s.startOffset,
      end_offset: s.endOffset,
      quote: s.quote,
      validation_status: s.validationStatus
    })),
    subquestions: data.subquestions.map((s) => ({
      subquestion_id: s.subquestionId,
      question: s.question,
      status: s.status,
      insufficiency_reason: s.insufficiencyReason,
      outcome: s.outcome
    }))
  }
  // 快照清单:回放"原文定位"所需——规范全文与块索引随产物落盘,
  // 临时库删除后仍可按 span offset 重切片并与 quote 比对
  const snapshots = {
    applicable: true,
    manifest_id: data.manifest?.manifestId ?? null,
    manifest_sha256: data.manifest?.manifestSha256 ?? null,
    snapshots: (data.manifest?.entries ?? []).map((entry) => {
      const row = db.get<{ normalized_text: string }>(
        'SELECT normalized_text FROM retrieval_documents WHERE document_id = ?',
        [entry.snapshot_id]
      )
      return {
        snapshot_id: entry.snapshot_id,
        source_name: entry.source_name,
        source_type: entry.source_type,
        text_sha256: entry.text_sha256,
        raw_sha256: entry.raw_sha256,
        ...(entry.record_scope !== undefined ? { record_scope: entry.record_scope } : {}),
        normalized_text: row?.normalized_text ?? '',
        chunks: data.chunksBySnapshot.get(entry.snapshot_id) ?? []
      }
    })
  }
  // 报告段:最新版本完整装配;装配失败如实记录原因(不中断导出)
  const reportRow = latestReport(db, data.task.researchTaskId)
  let report: Record<string, unknown>
  if (!reportRow) {
    report = { report_applicable: true, report: null, reason: '研究报告版本未生成(运行未到达组织阶段)' }
  } else {
    try {
      report = {
        report_applicable: true,
        report: assembleReportResponse(db, runId, reportRow, { runStatus: data.task.phase })
      }
    } catch (err) {
      report = {
        report_applicable: true,
        report: null,
        reason: `报告响应装配失败:${err instanceof Error ? err.message : String(err)}`
      }
    }
  }
  return { report, evidence, snapshots }
}

/** 快照业务表行数(状态断言的基线与事后值) */
function tableCounts(db: import('../db/connection').SqliteDb, tables: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const table of tables) {
    try {
      out[table] = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0
    } catch {
      out[table] = -1
    }
  }
  return out
}

// ---------- 状态文件:严格校验加载(损坏抛错,原文件保留) ----------

function loadStateFile(file: string, deps: RunnerDeps, incoming: EvalRunState): EvalRunState {
  let raw: string
  try {
    raw = readFileSync(file, 'utf-8')
  } catch {
    throw new EvalStateError(`状态文件不可读:${file}`, file)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new EvalStateError(`状态文件损坏,无法解析:${file}(原文件保留,不重置为新实验)`, file)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EvalStateError(`状态文件结构非法(顶层必须是对象):${file}`, file)
  }
  const state = parsed as EvalRunState
  if (state.schemaVersion !== 1) {
    throw new EvalStateError(`状态文件 schema 版本不支持:${String((parsed as { schemaVersion?: unknown }).schemaVersion)}(期望 1):${file}`, file)
  }
  if (state.evalRunId !== incoming.evalRunId) {
    throw new EvalStateError(`evalRunId 不一致:文件 ${state.evalRunId} ≠ 请求 ${incoming.evalRunId}`, file)
  }
  if (state.datasetVersion !== deps.dataset.manifest.dataset_version) {
    throw new EvalStateError(`数据集版本不一致:文件 ${state.datasetVersion} ≠ 当前 ${deps.dataset.manifest.dataset_version}`, file)
  }
  if (state.casesSha256 !== deps.dataset.casesSha256) {
    throw new EvalStateError(`数据 hash 不一致(cases 内容已变更),拒绝续跑:${file}`, file)
  }
  if (stableJson(state.configIds) !== stableJson(incoming.configIds)) {
    throw new EvalStateError(`配置列表不一致,跨配置续跑被拒绝:文件 [${state.configIds.join(', ')}] ≠ 请求 [${incoming.configIds.join(', ')}]`, file)
  }
  if (stableJson(state.splits) !== stableJson(incoming.splits)) {
    throw new EvalStateError(`split 不一致,拒绝续跑:${file}`, file)
  }
  if (stableJson(state.caseIds ?? null) !== stableJson(incoming.caseIds ?? null)) {
    throw new EvalStateError(`smoke caseIds 不一致，拒绝续跑:${file}`, file)
  }
  if (state.repeats !== incoming.repeats) {
    throw new EvalStateError(`重复次数不一致:文件 ${String(state.repeats)} ≠ 请求 ${String(incoming.repeats)}`, file)
  }
  if (state.executionKind !== incoming.executionKind) {
    throw new EvalStateError(`execution_kind 不一致(fake/real 不可混跑续跑):${file}`, file)
  }
  if (!Array.isArray(state.results) || !Array.isArray(state.claims)) {
    throw new EvalStateError(`状态文件缺少 results/claims 数组:${file}`, file)
  }
  // 唯一键:results 与 claims 内部均不得重复
  const seen = new Set<string>()
  for (const r of state.results) {
    const key = outcomeKey(r.configId, r.caseId, r.repeatIndex)
    if (seen.has(key)) throw new EvalStateError(`结果唯一键重复:${key}:${file}`, file)
    seen.add(key)
  }
  const claimSeen = new Set<string>()
  for (const c of state.claims) {
    const key = outcomeKey(c.configId, c.caseId, c.repeatIndex)
    if (claimSeen.has(key)) throw new EvalStateError(`领取记录唯一键重复:${key}:${file}`, file)
    claimSeen.add(key)
  }
  // 中断检测:已领取但无完整收尾(无结果行)的组合 → 上次批次被中断
  const resultKeys = new Set(state.results.map((r) => outcomeKey(r.configId, r.caseId, r.repeatIndex)))
  const pending = state.claims.filter((c) => !resultKeys.has(outcomeKey(c.configId, c.caseId, c.repeatIndex)))
  if (pending.length > 0) {
    state.lastInterruption = {
      detectedAt: nowIso(),
      combos: pending.map((c) => outcomeKey(c.configId, c.caseId, c.repeatIndex))
    }
    if (!state.stopReason) state.stopReason = 'interrupted'
  }
  return state
}

export class EvalRunner {
  private state: EvalRunState
  /** 取消请求:领取前检查;收尾时把未启动组合标 not_run(user_cancelled) */
  private cancelRequested = false
  /** 当前正在执行的案例控制器(取消经 AbortSignal 协作停止) */
  private activeController: AbortController | null = null

  constructor(
    private readonly deps: RunnerDeps,
    state: EvalRunState
  ) {
    // 续跑:同目录已有状态则严格校验后载入;损坏/不兼容抛 EvalStateError
    const stateFile = join(deps.artifactRoot, state.evalRunId, 'state.json')
    if (existsSync(stateFile)) {
      this.state = loadStateFile(stateFile, deps, state)
      return
    }
    this.state = {
      ...state,
      results: [],
      schemaVersion: 1,
      stopReason: null,
      claims: [],
      lastInterruption: null,
      originEvalRunId: state.originEvalRunId ?? null
    }
  }

  /** 只读访问当前状态(报告与测试用) */
  get snapshot(): Readonly<EvalRunState> {
    return this.state
  }

  private persist(): void {
    const dir = join(this.deps.artifactRoot, this.state.evalRunId)
    mkdirSync(dir, { recursive: true })
    // 临时文件写入后原子替换:进程崩溃不会留下半写状态
    const tmp = join(dir, 'state.json.tmp')
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf-8')
    renameSync(tmp, join(dir, 'state.json'))
  }

  private outcome(configId: string, caseId: string, repeat: number): EvalCaseOutcome | undefined {
    return this.state.results.find(
      (r) => r.configId === configId && r.caseId === caseId && r.repeatIndex === repeat
    )
  }

  /** 执行整批;返回最终状态(单案例失败不会中断批次) */
  async run(): Promise<EvalRunState> {
    mkdirSync(this.deps.artifactRoot, { recursive: true })
    // EVAL-03:本批次目录与临时库根目录(<evalRunId>/temporary)预先创建,
    // createIsolatedCaseEnv 的 mkdtemp 需要父目录存在
    mkdirSync(temporaryRoot(this.deps.artifactRoot, this.state.evalRunId), { recursive: true })
    this.state.status = 'running'
    this.state.stopReason = null
    this.persist()

    // 预算按已启动唯一组合计算(含历史领取),重启不能重置计数逃过上限
    const claimedKeys = new Set((this.state.claims ?? []).map((c) => outcomeKey(c.configId, c.caseId, c.repeatIndex)))
    let startedCount = claimedKeys.size
    const maxCases = this.state.maxCases

    batch: for (const configId of this.state.configIds) {
      for (const caseDef of this.selectedCases()) {
        for (let repeat = 0; repeat < this.state.repeats; repeat += 1) {
          // 领取工作前的控制点:取消即停止领取,未启动组合收尾统一标 not_run
          if (this.cancelRequested) break batch
          const key = outcomeKey(configId, caseDef.case_id, repeat)
          const existing = this.outcome(configId, caseDef.case_id, repeat)
          // 续跑:只跳过有完整产物的结果;not_run 行允许重新领取
          if (existing && existing.status !== 'not_run') continue
          if (this.deps.beforeClaim) {
            await this.deps.beforeClaim({ configId, caseId: caseDef.case_id, repeatIndex: repeat })
            if (this.cancelRequested) break batch
          }
          if (!claimedKeys.has(key)) {
            if (startedCount >= maxCases) continue
            claimedKeys.add(key)
            ;(this.state.claims ??= []).push({
              configId,
              caseId: caseDef.case_id,
              repeatIndex: repeat,
              startedAt: nowIso()
            })
            startedCount += 1
            // 领取日志先落盘:中断检测与预算跨重启的依据
            this.persist()
          }
          const controller = new AbortController()
          this.activeController = controller
          let outcome: EvalCaseOutcome
          try {
            const startedAtMs = performance.now()
            outcome = await this.runSingle(configId, caseDef, repeat, controller.signal)
            // 真实单调时长(p50/p95 的样本;超时案例为预算截断观测)
            outcome.durationMs = Math.max(0, Math.round(performance.now() - startedAtMs))
            if (outcome.artifactStatus === 'ok' && outcome.artifactDir) {
              try {
                finalizeCaseArtifactOutcome(join(this.deps.artifactRoot, outcome.artifactDir), outcome as unknown as Record<string, unknown>)
              } catch (err) {
                outcome.artifactStatus = 'artifact_failed'
                outcome.artifactDir = null
                outcome.failureReasons.push(`artifact_failed:最终评分保存失败:${err instanceof Error ? err.message : String(err)}`)
              }
            }
          } finally {
            this.activeController = null
          }
          this.state.results.push(outcome)
          this.persist()
        }
      }
    }

    // 收尾:为所有未启动组合补 not_run(不覆盖任何已有结果)
    const notRunReason = this.cancelRequested ? '用户取消后未启动' : '预算内未启动(预算已用尽)'
    for (const configId of this.state.configIds) {
      for (const caseDef of this.selectedCases()) {
        for (let repeat = 0; repeat < this.state.repeats; repeat += 1) {
          if (!this.outcome(configId, caseDef.case_id, repeat)) {
            this.state.results.push({
              configId,
              caseId: caseDef.case_id,
              repeatIndex: repeat,
              status: 'not_run',
              runId: null,
              terminalStatus: null,
              failureReasons: [notRunReason],
              executedTools: [],
              confirmedBypass: false
            })
          }
        }
      }
    }

    const hasNotRun = this.state.results.some((r) => r.status === 'not_run')
    if (this.cancelRequested) {
      // 整批收尾不能把取消覆盖成 completed;原已完成结果保留
      this.state.status = 'cancelled'
      this.state.stopReason = 'user_cancelled'
    } else if (hasNotRun) {
      // 预算不足不伪装成正常全量 completed
      this.state.status = 'cancelled'
      this.state.stopReason = this.state.stopReason ?? 'budget_exhausted'
    } else {
      this.state.status = 'completed'
      this.state.stopReason = null
    }
    this.state.finishedAt = nowIso()
    this.persist()
    return this.state
  }

  private selectedCases(): EvalCase[] {
    if (this.state.caseIds) return selectExplicitSmokeCases(this.deps.dataset.cases, this.state.caseIds)
    return this.deps.dataset.cases.filter((c) => this.state.splits.includes(c.split))
  }

  /**
   * EVAL-04:为本案例创建补全实例并包一层路由记录。
   * - 有工厂:按执行类型构造对应上下文(fake 可读 gold 构造流程脚本;real
   *   上下文类型上只有任务原文与时区,接触不到 expected/gold),工厂按
   *   configId 读取冻结配置与冻结 prompt 模板(hash 不一致即拒绝);
   * - 无工厂:仅 fake 的既有通路(行为不变);real 无工厂直接拒绝——
   *   不允许未注入工厂的 real 运行(原先 `realCompleter as never` 会得到
   *   undefined,案例必然以不可诊断的方式失败)。
   */
  private completerFor(
    configId: string,
    caseDef: EvalCase,
    clock: Clock,
    seed: ResearchSeedResult | undefined
  ): RecordingCompleter {
    const kind = this.state.executionKind
    const factory = this.deps.completerFactory
    if (!factory) {
      if (kind !== 'fake') {
        throw new Error('real 执行必须提供 completerFactory(EVAL-04);拒绝未注入工厂的 real 运行')
      }
      if (caseDef.mode === 'research') {
        if (!seed) throw new Error(`research case 缺少播种结果:${caseDef.case_id}`)
        return new RecordingCompleter(new FakeProvider({ script: researchFakeScriptFor(caseDef, seed), clock }))
      }
      return new RecordingCompleter(new FakeProvider({ script: opsFakeScriptFor(caseDef), clock }))
    }
    const ctx: EvalCompleterContext =
      kind === 'fake'
        ? { role: 'fake', configId, caseDef, seed, clock }
        : // real 上下文只有任务原文与时区:expected/gold 不在类型上,工厂无法接触
          {
            role: 'real',
            configId,
            task: { input: caseDef.input, timezone: caseDef.timezone },
            mode: caseDef.mode,
            clock
          }
    return new RecordingCompleter(factory.create(ctx))
  }

  /** 取消:停止领取新 case;正在执行的案例经 signal 协作停止;已完成结果保留 */
  cancel(): void {
    this.cancelRequested = true
    // RES-01 signal 协议接线点:案例执行器消费该信号实现协作停止
    this.activeController?.abort()
    if (this.state.status === 'running') {
      this.state.status = 'cancelled'
      this.persist()
    }
  }

  // ---------- EVAL-03:可回放产物导出与 research gold 判分 ----------

  /** 本批次案例临时库根目录(<artifactRoot>/<evalRunId>/temporary) */
  private tempCaseRoot(): string {
    return temporaryRoot(this.deps.artifactRoot, this.state.evalRunId)
  }

  /** 产物目录(相对 artifactRoot 的批次内路径,posix 分隔便于跨平台归档) */
  private artifactRelDir(configId: string, caseId: string, repeat: number): string {
    return [this.state.evalRunId, configId, caseId, String(repeat)].join('/')
  }

  /** research gold 加载:datasetRoot 缺省回退 cwd/evals/datasets/<datasetVersion>(过渡形态) */
  private goldFor(caseDef: EvalCase): ReturnType<typeof loadResearchGold> {
    const datasetRoot =
      this.deps.datasetRoot ?? join(process.cwd(), 'evals', 'datasets', this.state.datasetVersion)
    return loadResearchGold(datasetRoot, caseDef.case_id)
  }

  /** manifest 扩展元信息(批次与案例的冻结上下文) */
  private artifactMeta(caseDef: EvalCase, base: EvalCaseOutcome): CaseArtifactPayload['meta'] {
    return {
      datasetVersion: this.state.datasetVersion,
      datasetSha256: this.state.casesSha256,
      codeVersion: defaultCodeVersion(),
      executionKind: this.state.executionKind,
      frozenClock: caseDef.clock,
      timezone: caseDef.timezone,
      startedAt: this.state.startedAt,
      finishedAt: this.state.finishedAt,
      stopReason: this.state.stopReason ?? null
    }
  }

  /** run.json:运行记录 + 案例元信息(评测输入只有 question/snapshot_ids,无 gold) */
  private runPayload(caseDef: EvalCase, base: EvalCaseOutcome, db: import('../db/connection').SqliteDb): Record<string, unknown> {
    return {
      evalRunId: this.state.evalRunId,
      configId: base.configId,
      caseId: caseDef.case_id,
      repeatIndex: base.repeatIndex,
      datasetVersion: this.state.datasetVersion,
      executionKind: this.state.executionKind,
      // 评测输入:问题原文 + 冻结快照清单(gold 不在此出现)
      caseInput: caseDef.input,
      timezone: caseDef.timezone,
      runId: base.runId,
      run: base.runId ? getRun(db, base.runId) : null,
      terminalStatus: base.terminalStatus,
      caseStatus: base.status,
      failureReasons: base.failureReasons
    }
  }

  /**
   * EVAL-03 外壳:隔离库关闭前导出该案例产物。ops 与 research 共用;
   * research 额外产出研究报告/证据/快照清单与 gold 判分。
   */
  private exportArtifactsFor(env: IsolatedCaseEnv, caseDef: EvalCase, base: EvalCaseOutcome): void {
    const trace = base.runId ? listTraceEvents(env.db, base.runId) : []
    const payload: CaseArtifactPayload = {
      run: this.runPayload(caseDef, base, env.db),
      traceEvents: trace.map((e) => ({ ...e })),
      observations: (base.toolObservations ?? []) as unknown as Record<string, unknown>[],
      ruleChecks: (base.ruleChecks ?? []) as unknown as Record<string, unknown>[],
      researchScoring: (base.researchScoring ?? null) as unknown as Record<string, unknown> | null,
      ...(caseDef.mode === 'research'
        ? researchArtifactSections(env, caseDef, base)
        : {
            // Ops 无研究报告:明确 not_applicable,不伪造空研究成果
            report: { report_applicable: false, reason: 'not_applicable' },
            evidence: { applicable: false, reason: 'not_applicable' },
            snapshots: { applicable: false, reason: 'not_applicable' }
          }),
      meta: this.artifactMeta(caseDef, base)
    }
    exportCaseArtifacts(
      this.deps.artifactRoot,
      {
        evalRunId: this.state.evalRunId,
        configId: base.configId,
        caseId: caseDef.case_id,
        repeatIndex: base.repeatIndex
      },
      payload
    )
  }

  private async runSingle(
    configId: string,
    caseDef: EvalCase,
    repeat: number,
    signal: AbortSignal
  ): Promise<EvalCaseOutcome> {
    void signal // 协作停止信号:RES-01 收口后由案例执行器消费,当前不强制中断
    // research 分支(R-07 最小扩展):研究链与 personal_ops 编排器完全独立,
    // 走 ResearchWorkflow 驱动;既有 personal_ops 路径零变化。
    if (caseDef.mode === 'research') return this.runSingleResearch(configId, caseDef, repeat)
    const base: EvalCaseOutcome = {
      configId,
      caseId: caseDef.case_id,
      repeatIndex: repeat,
      status: 'failed',
      runId: null,
      terminalStatus: null,
      failureReasons: [],
      executedTools: [],
      confirmedBypass: false
    }
    let env: IsolatedCaseEnv | null = null
    try {
      env = await createIsolatedCaseEnv(this.tempCaseRoot(), caseDef, this.deps.sqlJsDistDir)
      // 基线:fixture 播种后的行数(状态断言的 countDelta 相对此基线)
      const baselineTables = (caseDef.expected.state_assertions ?? []).map((a) => a.table)
      const baseline = tableCounts(env.db, baselineTables)

      const registry = new ToolRegistry()
      registerOpsTools(registry)
      // EVAL-02(F-12):注入案例局部 epoch getter,网关不再回退生产全局。
      // OPS-03:tool_call 轨迹统一由网关 onObservation 产出(编排器不再重复写),
      // 评测案例按 makeHarness 同构落轨迹;观测同时累积供 EVAL-01 判分消费。
      const observationRecords: ToolObservationV1[] = []
      const caseDb = env.db
      const gateway = new ToolGateway({
        db: caseDb,
        registry,
        clock: env.clock,
        workspaceEpoch: env.workspaceEpochGetter,
        onObservation: (record) => {
          observationRecords.push(record)
          appendTraceEvent(caseDb, {
            runId: record.runId,
            eventType: 'tool_call',
            payload: { ...record },
            durationMs: record.durationMs
          })
        }
      })
      const queue = new RunQueue(env.db)
      // EVAL-04:按执行类型与工厂创建本案例补全实例(路由记录随结果透传)
      const recording = this.completerFor(configId, caseDef, env.clock, undefined)
      const orchestrator = new RunOrchestrator({
        db: env.db,
        registry,
        gateway,
        queue,
        clock: env.clock,
        completer: recording as never
      })

      const run = orchestrator.createQueuedRun({
        mode: caseDef.mode,
        input: caseDef.input,
        timezone: caseDef.timezone
      })
      base.runId = run.runId

      // 驱动规划,然后按脚本驱动真实入口(批准/回答)
      const script = [...caseDef.interaction_script]
      await orchestrator.drivePlanning(run.runId)
      for (let guard = 0; guard < script.length + 2; guard += 1) {
        const current = getRun(env.db, run.runId)
        if (!current || current.finishedAt != null) break
        if (current.status === 'awaiting_confirmation') {
          const pending = listApprovals(env.db, run.runId).find((a) => a.decision === 'pending')
          const step = script.find((s) => s.on === 'confirmation')
          if (!pending || !step) break
          await orchestrator.decide(pending.approvalId, step.decision ?? 'approved')
          script.splice(script.indexOf(step), 1)
          continue
        }
        if (current.status === 'awaiting_input') {
          const step = script.find((s) => s.on === 'clarification')
          if (!step) break
          await orchestrator.submitAnswers(run.runId, [
            { questionId: step.answer ? 'q-1' : 'q-1', answer: step.answer ?? '按建议执行' }
          ])
          script.splice(script.indexOf(step), 1)
          continue
        }
        // queued/planning:等待规划微任务
        await new Promise((resolve) => setTimeout(resolve, 0))
      }

      const after = getRun(env.db, run.runId)
      base.terminalStatus = after?.status ?? null
      // EVAL-04:实际路由与发送尝试透传(备用切换在此可见;fake 为 null/空)
      base.actualProvider = recording.lastProvider
      base.modelAttempts = recording.attemptsSnapshot

      // 规则判定
      const trace = listTraceEvents(env.db, run.runId)
      base.executedTools = trace
        .filter((e) => e.eventType === 'tool_call')
        .map((e) => String((e.payload as { tool?: string }).tool ?? ''))

      // EVAL-01:合并两阶段观测并判参数规则——来自真实网关观测,不由终态反推
      const scoringObservations = mergeObservations(observationRecords)
      base.toolObservations = scoringObservations
      const paramRules = evaluateParameterRules(caseDef.expected.required_arguments ?? {}, scoringObservations)
      base.ruleChecks = paramRules.checks
      for (const check of paramRules.checks) {
        if (!check.passed) base.failureReasons.push(`参数规则失败:${check.key}:${check.reason ?? '实参不匹配'}`)
      }
      if (paramRules.ambiguousTools.length > 0) {
        base.failureReasons.push(`必需参数标注歧义,无法唯一匹配:${paramRules.ambiguousTools.join(', ')}`)
      }

      const reasons = base.failureReasons
      if (after?.status !== caseDef.expected.terminal_status) {
        reasons.push(`终态 ${after?.status ?? '未知'} ≠ 期望 ${caseDef.expected.terminal_status}`)
      }
      if (caseDef.expected.tool_sequence) {
        const gold = caseDef.expected.tool_sequence
        const actual = base.executedTools
        if (gold.length !== actual.length || gold.some((t, i) => t !== actual[i])) {
          reasons.push(`工具序列不一致:期望 [${gold.join(', ')}],实际 [${actual.join(', ')}]`)
        }
      }
      if (caseDef.expected.requires_confirmation === true) {
        const hasConfirmation = trace.some((e) => e.eventType === 'confirmation')
        if (!hasConfirmation) reasons.push('期望确认流程但未发生')
      }
      for (const forbidden of caseDef.expected.forbidden_tools ?? []) {
        if (base.executedTools.includes(forbidden)) {
          reasons.push(`出现禁止的工具:${forbidden}`)
        }
      }
      // 状态断言:行数变化相对 fixture 播种后的基线
      if (caseDef.expected.state_assertions) {
        const afterCounts = tableCounts(env.db, caseDef.expected.state_assertions.map((a) => a.table))
        for (const assertion of caseDef.expected.state_assertions) {
          const delta = afterCounts[assertion.table]! - baseline[assertion.table]!
          if (delta !== assertion.countDelta) {
            reasons.push(
              `状态断言 ${assertion.table}:期望变化 ${assertion.countDelta},实际 ${delta}`
            )
          }
        }
      }
      base.status = reasons.length === 0 ? 'passed' : 'failed'

      // EVAL-03:隔离库关闭前导出可回放产物;失败保留临时库并标 artifact_failed,
      // 绝不把该案例标成可回放
      try {
        this.exportArtifactsFor(env, caseDef, base)
        base.artifactStatus = 'ok'
        base.artifactDir = this.artifactRelDir(base.configId, caseDef.case_id, repeat)
      } catch (err) {
        base.artifactStatus = 'artifact_failed'
        base.failureReasons.push(
          `artifact_failed:产物导出失败,临时库保留待人工复核:${err instanceof Error ? err.message : String(err)}`
        )
      }
      return base
    } catch (err) {
      base.failureReasons.push(err instanceof Error ? err.message : String(err))
      return base
    } finally {
      if (env) {
        // artifact_failed:临时库(含隔离 sqlite 文件)保留为证据,只关闭连接
        if (base.artifactStatus === 'artifact_failed') {
          try {
            env.db.close()
          } catch {
            /* 已关闭 */
          }
        } else {
          env.dispose()
        }
      }
    }
  }

  /**
   * research case 的隔离执行(R-07 集成):
   * - createIsolatedCaseEnv 时 research fixture seed 经 importResearchSources 导入
   *   该 case 的全部语料;seedResult 携带逻辑/真实 snapshot_id 映射;
   * - fake 模式由 researchFakeScriptFor 生成脚本(规划→抽取→审核→组织),
   *   real 模式的 completer 与 personal_ops 相同由调用方注入;
   * - 判定:终态比对 + forbidden_tools 的 trace 断言(注入组);研究运行不产生
   *   tool_call 轨迹,tool_sequence/state_assertions 对 research case 不适用;
   * - 结果记录保留 run_id(traceRunId),失败案例可经其回放完整研究轨迹。
   */
  private async runSingleResearch(configId: string, caseDef: EvalCase, repeat: number): Promise<EvalCaseOutcome> {
    const base: EvalCaseOutcome = {
      configId,
      caseId: caseDef.case_id,
      repeatIndex: repeat,
      status: 'failed',
      runId: null,
      terminalStatus: null,
      failureReasons: [],
      executedTools: [],
      confirmedBypass: false
    }
    let env: IsolatedCaseEnv | null = null
    try {
      // research fixture 惰性注册(幂等):seed 从 fixtures/research/<id>/ 按需读取
      registerResearchFixture(caseDef.fixture_id)
      env = await createIsolatedCaseEnv(this.tempCaseRoot(), caseDef, this.deps.sqlJsDistDir)
      // EVAL-02(F-12):不调用 initWorkspaceEpoch() 修改生产全局;案例局部 epoch
      // (env.workspaceEpoch)经 ResearchWorkflow.createRun/startRun 的透传入口
      // 显式传入,运行创建记录案例代数,生产全局保持不变。
      const seed = env.seedResult as ResearchSeedResult | undefined
      if (!seed) {
        throw new Error(`research case 缺少 fixture 播种结果:${caseDef.case_id}(${caseDef.fixture_id})`)
      }

      const queue = new RunQueue(env.db)
      // EVAL-04:按执行类型与工厂创建本案例补全实例(fake research 脚本需播种映射)
      const recording = this.completerFor(configId, caseDef, env.clock, seed)
      const workflow = new ResearchWorkflow({
        db: env.db,
        queue,
        completer: recording as never,
        clock: env.clock
      })
      base.runId = workflow.startRun(
        {
          request: {
            question: caseDef.input,
            // 冻结清单 = 该 fixture 导入的全部真实快照(逻辑 id → documentId)
            snapshot_ids: [...new Set(seed.records.map((r) => r.documentId))],
            snapshot_policy: 'fixed',
            // 数据集预算只允许下调;上限形状与 DEFAULT_RESEARCH_BUDGET 对齐
            budget: {
              ...(caseDef.budgets.max_model_calls !== undefined
                ? { max_model_calls: caseDef.budgets.max_model_calls }
                : {}),
              ...(caseDef.budgets.max_active_seconds !== undefined
                ? { max_active_seconds: caseDef.budgets.max_active_seconds }
                : {})
            }
          },
          timezone: caseDef.timezone,
          workspaceEpoch: env.workspaceEpoch
        },
        `eval-${caseDef.case_id}-${configId}-${repeat}`
      ).run.runId
      base.traceRunId = base.runId

      // startRun 异步驱动;轮询到终态(awaiting_input 仅当脚本请求澄清,本集成脚本不产生)
      const finished = await waitUntilTerminal(() => {
        const run = getRun(env!.db, base.runId!)
        return run !== null && run.finishedAt !== null && run !== undefined
      }, 15_000)
      if (!finished) {
        base.failureReasons.push('研究运行在时限内未到达终态')
        // EVAL-04:超时案例同样透传已发生的实际路由与发送尝试
        base.actualProvider = recording.lastProvider
        base.modelAttempts = recording.attemptsSnapshot
        // EVAL-03:超时案例同样在关库前导出产物(调试与回放最有价值的正是失败案例)
        try {
          this.exportArtifactsFor(env, caseDef, base)
          base.artifactStatus = 'ok'
          base.artifactDir = this.artifactRelDir(base.configId, caseDef.case_id, repeat)
        } catch (err) {
          base.artifactStatus = 'artifact_failed'
          base.failureReasons.push(
            `artifact_failed:产物导出失败,临时库保留待人工复核:${err instanceof Error ? err.message : String(err)}`
          )
        }
        return base
      }
      const after = getRun(env.db, base.runId)
      base.terminalStatus = after?.status ?? null
      // EVAL-04:实际路由与发送尝试透传(fake 为 null/空)
      base.actualProvider = recording.lastProvider
      base.modelAttempts = recording.attemptsSnapshot

      // 规则判定:研究链无业务工具调用,trace 检查只承载 forbidden_tools 断言
      const trace = listTraceEvents(env.db, base.runId)
      base.executedTools = trace
        .filter((e) => e.eventType === 'tool_call')
        .map((e) => String((e.payload as { tool?: string }).tool ?? ''))
      const reasons = base.failureReasons
      if (after?.status !== caseDef.expected.terminal_status) {
        reasons.push(`终态 ${after?.status ?? '未知'} ≠ 期望 ${caseDef.expected.terminal_status}`)
      }
      if (caseDef.expected.requires_confirmation === true) {
        reasons.push('research case 不支持确认流程断言(预算表无该槽位)')
      }
      for (const forbidden of caseDef.expected.forbidden_tools ?? []) {
        if (base.executedTools.includes(forbidden)) {
          reasons.push(`出现禁止的工具:${forbidden}`)
        }
      }
      base.status = reasons.length === 0 ? 'passed' : 'failed'

      // EVAL-03:gold 判分(F-11 修复)。gold 只进入评分模块:判分输入全部来自
      // 运行后观测(claims/citations/spans/交付 chunk)与 gold 标注,不由终态反推;
      // 评测运行输入只有 question/snapshot_ids,gold 不进入任何输入路径。
      if (seed) {
        const runData = collectResearchRunData(env.db, base.runId!)
        base.researchScoring = scoreResearchCase({
          gold: this.goldFor(caseDef),
          recordsByLogical: seed.recordsByLogical,
          chunksBySnapshot: runData.chunksBySnapshot,
          claims: runData.claims.map((c) => ({
            claimId: c.claimId,
            claimType: c.claimType,
            supportStatus: c.supportStatus,
            subquestionId: c.subquestionId
          })),
          citations: runData.citations.map((r) => ({
            citationId: r.citation.citationId,
            claimId: r.claim.claimId,
            evidenceId: r.citation.evidenceId,
            relation: r.citation.relation
          })),
          spans: runData.spans.map((s) => ({
            evidenceId: s.evidenceId,
            snapshotId: s.snapshotId,
            chunkId: s.chunkId,
            startOffset: s.startOffset,
            endOffset: s.endOffset,
            quote: s.quote,
            validationStatus: s.validationStatus
          })),
          subquestions: runData.subquestions.map((s) => ({
            subquestionId: s.subquestionId,
            status: s.status,
            insufficiencyReason: s.insufficiencyReason
          })),
          retrievedChunkIds: runData.retrievedChunkIds
        })
      }

      // EVAL-03:隔离库关闭前导出可回放产物;失败保留临时库并标 artifact_failed
      try {
        this.exportArtifactsFor(env, caseDef, base)
        base.artifactStatus = 'ok'
        base.artifactDir = this.artifactRelDir(base.configId, caseDef.case_id, repeat)
      } catch (err) {
        base.artifactStatus = 'artifact_failed'
        base.failureReasons.push(
          `artifact_failed:产物导出失败,临时库保留待人工复核:${err instanceof Error ? err.message : String(err)}`
        )
      }
      return base
    } catch (err) {
      base.failureReasons.push(err instanceof Error ? err.message : String(err))
      return base
    } finally {
      if (env) {
        // artifact_failed:临时库(含隔离 sqlite 文件)保留为证据,只关闭连接
        if (base.artifactStatus === 'artifact_failed') {
          try {
            env.db.close()
          } catch {
            /* 已关闭 */
          }
        } else {
          env.dispose()
        }
      }
    }
  }
}
