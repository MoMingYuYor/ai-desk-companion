// EVAL-03 案例产物导出(artifacts.ts):把每个 (configId, caseId, repeatIndex)
// 的可回放产物写入 evals/artifacts/<evalRunId>/<configId>/<caseId>/<repeatIndex>/。
//
// 背景缺陷 F-11:案例结束删除临时库后仅剩 run ID,时间线/报告/证据无法回放。
// 本模块把回放所需的一切落成文件:run.json、trace.jsonl、observations.json、
// rule-results.json、report.json、evidence.json、snapshots-manifest.json、
// manifest.json(完整性标记,最后写)。
//
// 纪律(完成计划 eval.md EVAL-03):
// - ID 只允许安全字符;路径解析后必须仍在批次根目录内(pathGuard 防穿越);
// - 先原子写各内容文件,manifest.json(complete: true)最后写——存在完整
//   manifest 才算可回放;导出失败不写 manifest,由调用方保留临时库并标
//   artifact_failed,绝不把案例标成可回放;
// - Ops 无研究报告时 report.json/evidence.json 明确 not_applicable,
//   不伪造空研究成果;
// - hash 校验:verifyCaseArtifacts 逐文件重算 sha256;loadCaseArtifacts 在
//   校验失败时抛 ArtifactIntegrityError,调用方不得继续评分。

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** manifest schema 版本:解读产物前先核对 */
export const CASE_ARTIFACT_SCHEMA_VERSION = 1

/** manifest 中的单个文件条目(名称 + sha256) */
export interface CaseArtifactFileEntry {
  name: string
  sha256: string
}

/**
 * 案例产物 manifest(规范接口 + EVAL-03 落地扩展字段):
 * 必填字段与完成计划 eval.md 的 CaseArtifactManifest 接口一致;
 * 扩展字段承载"代码版本、数据 hash、冻结 clock/timezone、起止时间、
 * 终止原因、实际路由(execution_kind)"等批次元信息。
 */
export interface CaseArtifactManifest {
  schemaVersion: 1
  evalRunId: string
  caseId: string
  configId: string
  repeatIndex: number
  runId: string | null
  complete: boolean
  files: CaseArtifactFileEntry[]
  /** 数据集版本与 cases 内容 hash(续跑校验同源) */
  datasetVersion?: string
  datasetSha256?: string
  /** 代码版本(进程内默认取 npm_package_version,未知为 'unknown') */
  codeVersion?: string
  /** 实际路由:fake / real(fake 结果不代表模型能力) */
  executionKind?: 'fake' | 'real'
  /** 冻结领域时钟与时区(与案例定义一致) */
  frozenClock?: string
  timezone?: string
  /** 案例开始与结束时间(UTC ISO 8601) */
  startedAt?: string | null
  finishedAt?: string | null
  /** 本批次终止原因(案例随批次收尾) */
  stopReason?: string | null
  /** 产物导出状态:ok = 可回放;artifact_failed 由调用方在 outcome 上另行标注 */
  artifactStatus?: 'ok' | 'artifact_failed'
}

/** 导出载荷:回放所需的全部结构化内容(调用方在隔离库关闭前构造) */
export interface CaseArtifactPayload {
  /** run.json:运行记录 + 案例元信息 */
  run: Record<string, unknown>
  /** trace.jsonl:每行一个轨迹事件(时间线回放来源) */
  traceEvents: ReadonlyArray<Record<string, unknown>>
  /** observations.json:合并后的评分观测(ops;研究链为空数组) */
  observations: ReadonlyArray<Record<string, unknown>>
  /** rule-results.json:逐条规则判分 + research gold 判分(无则 null) */
  ruleChecks: ReadonlyArray<Record<string, unknown>>
  researchScoring?: Record<string, unknown> | null
  /** report.json:研究报告(ops 明确 not_applicable) */
  report: Record<string, unknown>
  /** evidence.json:claims/citations/spans/子问题(ops 明确 not_applicable) */
  evidence: Record<string, unknown>
  /** snapshots-manifest.json:冻结快照清单 + 规范全文 + 块索引(ops 明确 not_applicable) */
  snapshots: Record<string, unknown>
  /** manifest 扩展元信息 */
  meta: {
    datasetVersion?: string
    datasetSha256?: string
    codeVersion?: string
    executionKind?: 'fake' | 'real'
    frozenClock?: string
    timezone?: string
    startedAt?: string | null
    finishedAt?: string | null
    stopReason?: string | null
  }
}

/** 路径守卫失败:ID 含不安全字符或解析后越出批次根目录 */
export class ArtifactPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactPathError'
  }
}

/** 产物完整性校验失败:文件缺失或 hash 不符,不得继续评分 */
export class ArtifactIntegrityError extends Error {
  constructor(
    message: string,
    readonly mismatched: string[],
    readonly missing: string[]
  ) {
    super(message)
    this.name = 'ArtifactIntegrityError'
  }
}

// ---------- pathGuard:安全 ID 与批次根目录包含检查 ----------

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 校验单个路径段:只允许字母/数字开头,随后字母数字点横线下划线;拒绝 '.'/'..' */
export function safeSegment(label: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ArtifactPathError(`${label} 不能为空`)
  }
  if (value === '.' || value === '..') {
    throw new ArtifactPathError(`${label} 含不安全的相对段:${value}`)
  }
  if (!SAFE_SEGMENT.test(value)) {
    throw new ArtifactPathError(`${label} 含不安全字符(只允许 [A-Za-z0-9._-],且不以 ._- 开头):${value}`)
  }
  return value
}

/** 批次根目录:<artifactRoot>/<evalRunId>(状态文件所在目录) */
export function evalBatchRoot(artifactRoot: string, evalRunId: string): string {
  safeSegment('evalRunId', evalRunId)
  const root = resolve(artifactRoot)
  const batch = resolve(root, evalRunId)
  if (batch !== root && !batch.startsWith(root + sep)) {
    throw new ArtifactPathError(`批次目录解析后越出 artifactRoot:${batch}`)
  }
  return batch
}

/**
 * 案例产物目录:<artifactRoot>/<evalRunId>/<configId>/<caseId>/<repeatIndex>。
 * pathGuard:逐段校验安全字符,再对解析后的绝对路径断言仍在批次根目录内(防穿越)。
 */
export function caseArtifactDir(
  artifactRoot: string,
  evalRunId: string,
  configId: string,
  caseId: string,
  repeatIndex: number
): string {
  if (!Number.isInteger(repeatIndex) || repeatIndex < 0) {
    throw new ArtifactPathError(`repeatIndex 必须是不小于 0 的整数,收到 ${String(repeatIndex)}`)
  }
  safeSegment('configId', configId)
  safeSegment('caseId', caseId)
  const batch = evalBatchRoot(artifactRoot, evalRunId)
  const dir = resolve(batch, configId, caseId, String(repeatIndex))
  if (!dir.startsWith(batch + sep)) {
    throw new ArtifactPathError(`案例产物目录解析后越出批次根目录:${dir}`)
  }
  return dir
}

/** 批次临时库根目录:<artifactRoot>/<evalRunId>/temporary(案例隔离库在其下) */
export function temporaryRoot(artifactRoot: string, evalRunId: string): string {
  const batch = evalBatchRoot(artifactRoot, evalRunId)
  const dir = resolve(batch, 'temporary')
  if (!dir.startsWith(batch + sep)) {
    throw new ArtifactPathError(`临时库目录解析后越出批次根目录:${dir}`)
  }
  return dir
}

// ---------- 原子写与导出 ----------

function sha256OfBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha256OfText(text: string): string {
  return sha256OfBytes(Buffer.from(text, 'utf-8'))
}

/** 原子写:同目录临时文件写入后 rename,崩溃不留半写文件 */
function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, data, 'utf-8')
  renameSync(tmp, file)
}

/** manifest.json 之外的固定内容文件(写入顺序即枚举顺序) */
export const CASE_ARTIFACT_FILES = [
  'run.json',
  'trace.jsonl',
  'observations.json',
  'rule-results.json',
  'report.json',
  'evidence.json',
  'snapshots-manifest.json'
] as const

/**
 * 导出单个案例的全部产物:
 * 1) 逐个原子写内容文件(trace 事件每行一个 JSON);
 * 2) 全部成功后重算 sha256 构造 manifest(complete: true),最后原子写 manifest.json;
 * 3) 任一步失败即抛错:manifest 不会被写出,该案例绝不标记为可回放;
 *    调用方负责保留临时库并标 artifact_failed。
 */
export function exportCaseArtifacts(
  artifactRoot: string,
  ids: { evalRunId: string; configId: string; caseId: string; repeatIndex: number },
  payload: CaseArtifactPayload
): CaseArtifactManifest {
  const dir = caseArtifactDir(artifactRoot, ids.evalRunId, ids.configId, ids.caseId, ids.repeatIndex)
  mkdirSync(dir, { recursive: true })

  const contents = new Map<string, string>()
  contents.set(
    'run.json',
    JSON.stringify({ schemaVersion: CASE_ARTIFACT_SCHEMA_VERSION, ...payload.run }, null, 2)
  )
  // trace.jsonl:每行一个事件(时间线回放来源;空运行写空文件)
  const traceLines = payload.traceEvents.map((e) => JSON.stringify(e))
  contents.set('trace.jsonl', traceLines.length > 0 ? traceLines.join('\n') + '\n' : '')
  contents.set('observations.json', JSON.stringify({ schemaVersion: CASE_ARTIFACT_SCHEMA_VERSION, observations: payload.observations }, null, 2))
  contents.set(
    'rule-results.json',
    JSON.stringify(
      { schemaVersion: CASE_ARTIFACT_SCHEMA_VERSION, checks: payload.ruleChecks, researchScoring: payload.researchScoring ?? null },
      null,
      2
    )
  )
  contents.set('report.json', JSON.stringify(payload.report, null, 2))
  contents.set('evidence.json', JSON.stringify(payload.evidence, null, 2))
  contents.set('snapshots-manifest.json', JSON.stringify(payload.snapshots, null, 2))

  for (const name of CASE_ARTIFACT_FILES) {
    atomicWrite(join(dir, name), contents.get(name)!)
  }

  // 完整性标记最后写:文件 hash 齐全 + complete: true
  const manifest: CaseArtifactManifest = {
    schemaVersion: CASE_ARTIFACT_SCHEMA_VERSION,
    evalRunId: ids.evalRunId,
    caseId: ids.caseId,
    configId: ids.configId,
    repeatIndex: ids.repeatIndex,
    runId: (payload.run.runId as string | null | undefined) ?? null,
    complete: true,
    files: CASE_ARTIFACT_FILES.map((name) => ({
      name,
      sha256: sha256OfText(contents.get(name)!)
    })),
    ...payload.meta,
    artifactStatus: 'ok'
  }
  atomicWrite(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

// ---------- 校验与回放加载 ----------

export interface ArtifactVerifyResult {
  ok: boolean
  manifest: CaseArtifactManifest | null
  /** hash 不匹配的文件 */
  mismatched: string[]
  /** 缺失的文件(manifest 或磁盘) */
  missing: string[]
  /** manifest 本身不可读/不完整的原因 */
  manifestError: string | null
}

/**
 * 校验案例产物:manifest 必须存在、complete: true 且逐文件 sha256 与磁盘一致。
 * 篡改任意一个文件都会在这里暴露,调用方不得继续评分。
 */
export function verifyCaseArtifacts(dir: string): ArtifactVerifyResult {
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    return { ok: false, manifest: null, mismatched: [], missing: ['manifest.json'], manifestError: 'manifest.json 不存在(导出未完成或被删除)' }
  }
  let manifest: CaseArtifactManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as CaseArtifactManifest
  } catch (err) {
    return { ok: false, manifest: null, mismatched: [], missing: [], manifestError: `manifest.json 解析失败:${err instanceof Error ? err.message : String(err)}` }
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, manifest: null, mismatched: [], missing: [], manifestError: 'manifest 必须是对象' }
  }
  if (manifest.schemaVersion !== CASE_ARTIFACT_SCHEMA_VERSION) {
    return { ok: false, manifest, mismatched: [], missing: [], manifestError: `manifest schema 版本不支持:${String(manifest.schemaVersion)}` }
  }
  if (manifest.complete !== true) {
    return { ok: false, manifest, mismatched: [], missing: [], manifestError: 'manifest.complete !== true(导出未完成)' }
  }
  // 必须核对固定文件全集；空表、重复条目或路径穿越不能缩小校验范围。
  if (!Array.isArray(manifest.files) || manifest.files.length !== CASE_ARTIFACT_FILES.length ||
    manifest.files.some((entry) => !entry || typeof entry !== 'object' ||
      !CASE_ARTIFACT_FILES.includes(entry.name as typeof CASE_ARTIFACT_FILES[number]) ||
      typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) ||
    new Set(manifest.files.map((entry) => entry.name)).size !== CASE_ARTIFACT_FILES.length) {
    return { ok: false, manifest, mismatched: [], missing: [], manifestError: 'manifest 文件表不完整或非法（固定文件全集、唯一名称及 sha256 必须齐全）' }
  }
  const mismatched: string[] = []
  const missing: string[] = []
  for (const entry of manifest.files) {
    const file = join(dir, entry.name)
    if (!existsSync(file)) {
      missing.push(entry.name)
      continue
    }
    const actual = sha256OfBytes(readFileSync(file))
    if (actual !== entry.sha256) mismatched.push(entry.name)
  }
  return {
    ok: missing.length === 0 && mismatched.length === 0,
    manifest,
    mismatched,
    missing,
    manifestError: null
  }
}

/** 回放加载:校验通过后读出全部产物内容;校验失败抛 ArtifactIntegrityError */
export interface LoadedCaseArtifacts {
  manifest: CaseArtifactManifest
  run: Record<string, unknown>
  traceEvents: Record<string, unknown>[]
  observations: Record<string, unknown>[]
  ruleChecks: Record<string, unknown>[]
  researchScoring: Record<string, unknown> | null
  report: Record<string, unknown>
  evidence: Record<string, unknown>
  snapshots: Record<string, unknown>
}

export function loadCaseArtifacts(dir: string): LoadedCaseArtifacts {
  const verified = verifyCaseArtifacts(dir)
  if (!verified.ok || verified.manifest === null) {
    const detail = [
      verified.manifestError,
      verified.mismatched.length > 0 ? `hash 不匹配:${verified.mismatched.join(', ')}` : null,
      verified.missing.length > 0 ? `文件缺失:${verified.missing.join(', ')}` : null
    ]
      .filter((s): s is string => s !== null)
      .join(';')
    throw new ArtifactIntegrityError(`产物完整性校验失败,不继续评分:${dir} — ${detail}`, verified.mismatched, verified.missing)
  }
  const manifest = verified.manifest
  const traceEvents = readFileSync(join(dir, 'trace.jsonl'), 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  return {
    manifest,
    run: JSON.parse(readFileSync(join(dir, 'run.json'), 'utf-8')) as Record<string, unknown>,
    traceEvents,
    observations: (JSON.parse(readFileSync(join(dir, 'observations.json'), 'utf-8')) as { observations: Record<string, unknown>[] }).observations,
    ruleChecks: (JSON.parse(readFileSync(join(dir, 'rule-results.json'), 'utf-8')) as { checks: Record<string, unknown>[] }).checks,
    researchScoring: (JSON.parse(readFileSync(join(dir, 'rule-results.json'), 'utf-8')) as { researchScoring: Record<string, unknown> | null }).researchScoring,
    report: JSON.parse(readFileSync(join(dir, 'report.json'), 'utf-8')) as Record<string, unknown>,
    evidence: JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf-8')) as Record<string, unknown>,
    snapshots: JSON.parse(readFileSync(join(dir, 'snapshots-manifest.json'), 'utf-8')) as Record<string, unknown>
  }
}

/** 隔离库关闭后的最终评分投影；耗时确定后刷新 run 与 manifest，回放无需状态文件或数据库。 */
export function finalizeCaseArtifactOutcome(dir: string, outcome: Record<string, unknown>): void {
  const loaded = loadCaseArtifacts(dir)
  const manifest = loaded.manifest
  if (outcome.configId !== manifest.configId || outcome.caseId !== manifest.caseId || outcome.repeatIndex !== manifest.repeatIndex) {
    throw new ArtifactIntegrityError('最终评分对象与案例产物标识不一致', ['run.json'], [])
  }
  const run = { ...loaded.run, outcome, actualProvider: outcome.actualProvider ?? null, modelAttempts: outcome.modelAttempts ?? [], durationMs: outcome.durationMs ?? null }
  const contents = JSON.stringify(run, null, 2)
  atomicWrite(join(dir, 'run.json'), contents)
  const updated = { ...manifest, files: manifest.files.map(entry => entry.name === 'run.json' ? { ...entry, sha256: sha256OfText(contents) } : entry) }
  atomicWrite(join(dir, 'manifest.json'), JSON.stringify(updated, null, 2))
}

/** 代码版本默认值:进程内由 npm 注入,缺失时如实标 unknown */
export function defaultCodeVersion(): string {
  return process.env.npm_package_version ?? 'unknown'
}
