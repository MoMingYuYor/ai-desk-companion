// EVAL-02 真实请求预检测试(realPreflight.test.ts)。
//
// 覆盖:
// - 七类拒绝路径各反例(release 未签发、覆盖缺失、资源/hash 漂移、目标不符、
//   授权过期、请求数超授权、provider 凭据不匹配)+ 辅助路径(holdout 未授权、
//   授权文件含密钥、预算现算不一致、硬费用封顶不可用);
// - 各反例必须在创建 runner / 发送任何 fetch 之前失败(fetch spy 为 0、无状态文件);
// - 授权批次台账:先登记 intent 再启动;崩溃后发送状态不明(launching)暂停;
//   已批准次数跨进程持久累计,不重置;
// - fake 不要求真实授权,数据版本一致性检查保留;
// - 授权文件无密钥;真实凭据仅经 AI_DESK_EVAL_PROVIDER_ID + AI_DESK_EVAL_API_KEY
//   进程内注入(测试用 credentialOf 注入合成凭据,不发送任何真实请求)。
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  appendApprovalIntent,
  approvedRequestCountFor,
  assertNoUnclearApprovalIntents,
  PreflightError,
  readApprovalIntents,
  updateApprovalIntent,
  validateRealPreflight,
  writeApprovalIntentsFile,
  type RealEvalAuthorization,
  type RealPreflightInput
} from '../../src/main/evals/realPreflight'
import { AUTO_FAKE_CONFIG_ID, EvalsService, fixtureCorpusSha256, loadEvalsDataset } from '../../src/main/evals/api'
import { resolveEvalPaths, type EvalResourcePaths } from '../../src/main/evals/resources'
import { createRealCompleterFor } from '../../src/main/evals/realAdapter'
import { expandExperimentItems, selectExplicitSmokeCases } from '../../src/main/evals/experiment'
import type { EvalRunState } from '../../src/main/evals/runner'

const REPO_ROOT = resolve(__dirname, '..', '..')
const SQL_JS_DIST = join(REPO_ROOT, 'node_modules', 'sql.js', 'dist')
const PROVIDER_ID = 'eval-provider-test'
const DATASET = 'personal_ops_v3'
const SMOKE_IDS = ['ops-read-01', 'ops-write-01', 'ops-amb-01', 'inj-1', 'ops-missing-target-01']
const NOW = '2026-10-08T00:00:00.000Z'
const VERSIONS = { codeCommit: 'a'.repeat(40), toolsVersion: 'ops-tools-v1', rubricVersion: 'rubric-v1' }

interface Fixture {
  service: EvalsService
  paths: EvalResourcePaths
  fetchSpy: ReturnType<typeof vi.fn>
  baselineId: string
  candidateId: string
  baselineSha: string
  candidateSha: string
  targetSha256: string
  datasetSha256: string
  fixtureSha256: string
  expectedItems: ReturnType<typeof expandExperimentItems>
  maximumRequests: number
  releaseFile: string
  authorizationFile: string
}

function waitTerminal(service: EvalsService, evalRunId: string, timeoutMs = 30000): Promise<EvalRunState> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolvePromise, reject) => {
    const tick = (): void => {
      const state = service.getRun(evalRunId)
      if (state && state.status !== 'running') {
        resolvePromise(state)
        return
      }
      if (Date.now() > deadline) {
        reject(new Error(`评测运行超时未终态:${evalRunId}`))
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
}

/** 构建密闭夹具:真实冻结对 + release/授权文件(全部落在临时目录,无真实网络) */
function makeFixture(): Fixture {
  const userData = mkdtempSync(join(tmpdir(), 'eval-preflight-'))
  const paths = resolveEvalPaths({ packaged: false, resourceRoot: REPO_ROOT, sourceRoot: REPO_ROOT, userData })
  const fetchSpy = vi.fn(async () => {
    const plan = { goal: '列出任务', steps: [{ tool: 'todo.list', arguments: {} }], assumptions: [], clarifications: [] }
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(plan) } }] })}\n\ndata: [DONE]\n\n`, { status: 200 })
  })
  const credentialOf = (id: string): string | null => (id === PROVIDER_ID ? 'synthetic-key' : null)
  const service = new EvalsService({
    paths,
    sqlJsDistDir: SQL_JS_DIST,
    credentialOf,
    versionsOf: () => ({ ...VERSIONS }),
    realCompleterFor: createRealCompleterFor({ credentialOf, fetchImpl: fetchSpy })
  })
  const target = { providerId: PROVIDER_ID, protocol: 'chat-completions', baseUrl: 'https://eval-provider.invalid/v1', model: 'eval-model-1' }
  const pair = service.freeze({
    experimentId: 'eval02-unit',
    datasetVersion: DATASET,
    stage: 'ops-planning',
    executionKind: 'real',
    target
  })
  const dataset = loadEvalsDataset(paths.datasetRoot, DATASET)
  const baselineId = pair.baseline.config.configId
  const candidateId = pair.candidate.config.configId
  const expectedItems = expandExperimentItems(
    selectExplicitSmokeCases(dataset.cases, SMOKE_IDS),
    [
      { configId: baselineId, pipelineVariant: 'baseline' },
      { configId: candidateId, pipelineVariant: 'candidate' }
    ],
    1
  )
  const maximumRequests = expectedItems.reduce((sum, item) => sum + item.maxModelCalls, 0)
  const releaseFile = join(userData, 'data-release.json')
  writeFileSync(releaseFile, JSON.stringify(releaseFixture(dataset.casesSha256), null, 2), 'utf-8')
  const authorizationFile = join(userData, 'authorization.json')
  writeFileSync(
    authorizationFile,
    JSON.stringify(
      authorizationFixture({
        releaseFile,
        baselineId,
        candidateId,
        baselineSha: pair.baseline.sha256,
        candidateSha: pair.candidate.sha256,
        targetSha256: pair.baseline.config.targetSha256!,
        datasetSha256: dataset.casesSha256,
        fixtureSha256: fixtureCorpusSha256(paths.fixtureRoot, [...new Set(dataset.cases.map((c) => c.fixture_id))]),
        maximumRequests
      }),
      null,
      2
    ),
    'utf-8'
  )
  return {
    service,
    paths,
    fetchSpy,
    baselineId,
    candidateId,
    baselineSha: pair.baseline.sha256,
    candidateSha: pair.candidate.sha256,
    targetSha256: pair.baseline.config.targetSha256!,
    datasetSha256: dataset.casesSha256,
    fixtureSha256: fixtureCorpusSha256(paths.fixtureRoot, [...new Set(dataset.cases.map((c) => c.fixture_id))]),
    expectedItems,
    maximumRequests,
    releaseFile,
    authorizationFile
  }
}

/** EVAL-01 data-release.json 的已签发形态(status=SIGNED + 实名签署 + 覆盖 97/97) */
function releaseFixture(casesSha256: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    task: 'EVAL-01',
    status: 'SIGNED',
    signing: { status: 'SIGNED', signedBy: '测试签署人', signedAt: NOW },
    bindings: {
      [DATASET]: { datasetTreeSha256: '1'.repeat(64), casesJsonlSha256: casesSha256 },
      rubric: { version: 'rubric-v1' }
    },
    reviewPackage: { coverage: { humanReviewed: 97, required: 97 } },
    ...over
  }
}

interface AuthorizationOverrides {
  releaseFile?: string
  authorizationId?: string
  issuedAtUtc?: string
  validUntilUtc?: string
  batch?: RealEvalAuthorization['batch']
  providerId?: string
  targetSha256?: string
  configHashes?: Record<string, string>
  dataScope?: RealEvalAuthorization['dataScope']
  maxRequests?: number
  requiresHardCostCap?: boolean
  providerHardLimit?: RealEvalAuthorization['providerHardLimit']
}

function authorizationFixture(bind: {
  releaseFile: string
  baselineId: string
  candidateId: string
  baselineSha: string
  candidateSha: string
  targetSha256: string
  datasetSha256: string
  fixtureSha256: string
  maximumRequests: number
}, over: AuthorizationOverrides = {}): RealEvalAuthorization {
  return {
    schemaVersion: 1,
    kind: 'eval-real-authorization',
    authorizationId: 'auth-eval02-unit',
    releaseFile: bind.releaseFile,
    issuedAtUtc: '2026-10-01T00:00:00.000Z',
    validUntilUtc: '2026-12-31T00:00:00.000Z',
    batch: { experimentId: 'eval02-unit', label: 'ops-smoke', splits: ['dev'] },
    providerId: PROVIDER_ID,
    targetSha256: bind.targetSha256,
    configHashes: { [bind.baselineId]: bind.baselineSha, [bind.candidateId]: bind.candidateSha },
    dataScope: {
      [DATASET]: { casesSha256: bind.datasetSha256, fixtureSha256: bind.fixtureSha256, rubricVersion: 'rubric-v1' }
    },
    maxRequests: bind.maximumRequests,
    pricing: {
      source: 'unit-test-price-source',
      notedAtUtc: NOW,
      estimateBasis: '逐案例 max_model_calls 现算上界(maximumRequestCount)',
      currency: null,
      authorizedAmount: null
    },
    providerHardLimit: { available: false, note: '测试授权:无供应商侧硬限额' },
    requiresHardCostCap: false,
    ...over
  } as RealEvalAuthorization
}

function preflightInput(f: Fixture, over: Partial<RealPreflightInput> = {}): RealPreflightInput {
  return {
    releaseFile: f.releaseFile,
    authorizationFile: f.authorizationFile,
    datasetVersion: DATASET,
    datasetSha256: f.datasetSha256,
    fixtureSha256: f.fixtureSha256,
    rubricVersion: 'rubric-v1',
    configHashes: { [f.baselineId]: f.baselineSha, [f.candidateId]: f.candidateSha },
    targetSha256: f.targetSha256,
    expectedItems: f.expectedItems,
    maximumRequests: f.maximumRequests,
    nowUtc: NOW,
    splits: ['dev'],
    credentialProviderId: PROVIDER_ID,
    ...over
  }
}

function expectRejected(input: RealPreflightInput, code: string, messagePattern: RegExp): void {
  let caught: unknown
  try {
    validateRealPreflight(input)
  } catch (err) {
    caught = err
  }
  expect(caught, `应当拒绝:${code}`).toBeInstanceOf(PreflightError)
  expect((caught as PreflightError).code).toBe(code)
  expect((caught as PreflightError).message).toMatch(messagePattern)
}

/** 写一份授权文件(releaseFile 默认绑定夹具 release;反例可改指向后同步定位) */
function writeAuthorization(
  f: Fixture,
  file: string,
  over: AuthorizationOverrides = {}
): string {
  writeFileSync(
    file,
    JSON.stringify(
      authorizationFixture(
        {
          releaseFile: over.releaseFile ?? f.releaseFile,
          baselineId: f.baselineId,
          candidateId: f.candidateId,
          baselineSha: f.baselineSha,
          candidateSha: f.candidateSha,
          targetSha256: f.targetSha256,
          datasetSha256: f.datasetSha256,
          fixtureSha256: f.fixtureSha256,
          maximumRequests: f.maximumRequests
        },
        over
      )
    ),
    'utf-8'
  )
  return file
}

// ---------- 七类拒绝路径 + 辅助路径 ----------

describe('EVAL-02 validateRealPreflight 七类拒绝路径', () => {
  it('通过路径:返回授权身份与现算请求数上限(5 冒烟案例 × 预算 4 × 2 配置 = 40)', () => {
    const f = makeFixture()
    const result = validateRealPreflight(preflightInput(f))
    expect(result.approved).toBe(true)
    expect(result.authorizationId).toBe('auth-eval02-unit')
    expect(result.maximumRequests).toBe(f.maximumRequests)
    expect(f.maximumRequests).toBe(40)
  })

  it('拒绝 1:release 未签发(EVAL-01 BLOCKED_INPUT 原样拒绝;文件缺失同路径)', () => {
    const f = makeFixture()
    const blockedRelease = join(f.paths.artifactRoot, '..', 'release-blocked.json')
    writeFileSync(blockedRelease, JSON.stringify(releaseFixture(f.datasetSha256, {
      status: 'BLOCKED_INPUT',
      signing: { status: 'NOT_RUN', signedBy: null, signedAt: null }
    })), 'utf-8')
    expectRejected(preflightInput(f, { releaseFile: blockedRelease }), 'RELEASE_NOT_SIGNED', /未签发|BLOCKED_INPUT/)
    expectRejected(
      preflightInput(f, { releaseFile: join(f.paths.artifactRoot, 'no-such-release.json') }),
      'RELEASE_NOT_SIGNED',
      /不存在/
    )
  })

  it('拒绝 2:真人覆盖缺失(humanReviewed < required;缺审阅包同拒)', () => {
    const f = makeFixture()
    const partial = join(f.paths.artifactRoot, '..', 'release-partial.json')
    writeFileSync(partial, JSON.stringify(releaseFixture(f.datasetSha256, {
      reviewPackage: { coverage: { humanReviewed: 96, required: 97 } }
    })), 'utf-8')
    const partialAuth = writeAuthorization(f, join(f.paths.artifactRoot, '..', 'auth-partial.json'), { releaseFile: partial })
    expectRejected(preflightInput(f, { releaseFile: partial, authorizationFile: partialAuth }), 'COVERAGE_MISSING', /真人覆盖缺失:96\/97/)
    const noCoverage = join(f.paths.artifactRoot, '..', 'release-nocov.json')
    writeFileSync(noCoverage, JSON.stringify(releaseFixture(f.datasetSha256, { reviewPackage: null })), 'utf-8')
    const nocovAuth = writeAuthorization(f, join(f.paths.artifactRoot, '..', 'auth-nocov.json'), { releaseFile: noCoverage })
    expectRejected(preflightInput(f, { releaseFile: noCoverage, authorizationFile: nocovAuth }), 'COVERAGE_MISSING', /缺少可核查的真人覆盖/)
  })

  it('拒绝 3:资源/hash 漂移(数据/fixture/rubric/配置 hash 任一漂移即拒)', () => {
    const f = makeFixture()
    expectRejected(
      preflightInput(f, { datasetSha256: '9'.repeat(64) }),
      'RESOURCE_DRIFT',
      /数据 hash 与 release 签发绑定不一致/
    )
    expectRejected(preflightInput(f, { fixtureSha256: '9'.repeat(64) }), 'RESOURCE_DRIFT', /fixture 语料 hash 漂移/)
    expectRejected(preflightInput(f, { rubricVersion: 'rubric-v2' }), 'RESOURCE_DRIFT', /rubric 版本漂移/)
    // 未授权配置:一次授权不自动涵盖新配置
    expectRejected(
      preflightInput(f, { configHashes: { 'extra-config': '9'.repeat(64), [f.baselineId]: f.baselineSha } }),
      'RESOURCE_DRIFT',
      /配置 extra-config 不在本次授权范围内/
    )
    expectRejected(
      preflightInput(f, { configHashes: { [f.baselineId]: '9'.repeat(64), [f.candidateId]: f.candidateSha } }),
      'RESOURCE_DRIFT',
      new RegExp(`配置 ${f.baselineId} hash 漂移`)
    )
  })

  it('拒绝 4:目标不符(无密钥 target hash 与授权不一致)', () => {
    const f = makeFixture()
    expectRejected(preflightInput(f, { targetSha256: 'f'.repeat(64) }), 'TARGET_MISMATCH', /无密钥 target 与授权不符/)
  })

  it('拒绝 5:授权过期(含尚未生效)', () => {
    const f = makeFixture()
    expectRejected(preflightInput(f, { nowUtc: '2027-01-01T00:00:00.000Z' }), 'AUTHORIZATION_EXPIRED', /授权已过期/)
    expectRejected(preflightInput(f, { nowUtc: '2026-09-30T23:59:59.000Z' }), 'AUTHORIZATION_EXPIRED', /授权尚未生效/)
  })

  it('拒绝 6:请求数超过授权;调用方声明与现算不一致(BUDGET_MISMATCH)', () => {
    const f = makeFixture()
    const tight = join(f.paths.artifactRoot, '..', 'auth-tight.json')
    writeFileSync(tight, JSON.stringify(authorizationFixture({
      releaseFile: f.releaseFile, baselineId: f.baselineId, candidateId: f.candidateId,
      baselineSha: f.baselineSha, candidateSha: f.candidateSha, targetSha256: f.targetSha256,
      datasetSha256: f.datasetSha256, fixtureSha256: f.fixtureSha256, maximumRequests: f.maximumRequests
    }, { maxRequests: 39 })), 'utf-8')
    expectRejected(preflightInput(f, { authorizationFile: tight }), 'REQUEST_BUDGET_EXCEEDED', /现算上限 40 > 授权 maxRequests 39/)
    expectRejected(preflightInput(f, { maximumRequests: 41 }), 'BUDGET_MISMATCH', /现算值\(40\)/)
  })

  it('拒绝 7:provider 凭据绑定不匹配(绑定其他 provider / 未注入)', () => {
    const f = makeFixture()
    expectRejected(
      preflightInput(f, { credentialProviderId: 'other-provider' }),
      'CREDENTIAL_MISMATCH',
      /授权 providerId=eval-provider-test ≠ 运行时绑定 other-provider/
    )
    expectRejected(preflightInput(f, { credentialProviderId: null }), 'CREDENTIAL_MISMATCH', /凭据未注入/)
  })

  it('辅助路径:holdout 未在授权 batch.splits 显式列出即拒绝(不自动涵盖)', () => {
    const f = makeFixture()
    expectRejected(preflightInput(f, { splits: ['dev', 'holdout'] }), 'SPLIT_NOT_ALLOWED', /holdout 需独立授权/)
  })

  it('辅助路径:授权文件含密钥材料即拒绝;硬费用封顶不可用保持 BLOCKED_INPUT', () => {
    const f = makeFixture()
    const base = authorizationFixture({
      releaseFile: f.releaseFile, baselineId: f.baselineId, candidateId: f.candidateId,
      baselineSha: f.baselineSha, candidateSha: f.candidateSha, targetSha256: f.targetSha256,
      datasetSha256: f.datasetSha256, fixtureSha256: f.fixtureSha256, maximumRequests: f.maximumRequests
    })
    const withKey = join(f.paths.artifactRoot, '..', 'auth-with-key.json')
    writeFileSync(withKey, JSON.stringify({ ...base, apiKey: 'sk-should-not-exist' }), 'utf-8')
    expectRejected(preflightInput(f, { authorizationFile: withKey }), 'AUTHORIZATION_CONTAINS_SECRET', /不得包含密钥材料/)
    const capped = join(f.paths.artifactRoot, '..', 'auth-capped.json')
    writeFileSync(capped, JSON.stringify({ ...base, requiresHardCostCap: true }), 'utf-8')
    expectRejected(preflightInput(f, { authorizationFile: capped }), 'COST_CAP_UNAVAILABLE', /保持 BLOCKED_INPUT/)
  })
})

// ---------- 授权批次台账 ----------

describe('EVAL-02 授权批次台账', () => {
  it('append/read/update 全链路;launching 状态触发暂停核对;累计请求数不重置', () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), 'eval-intents-'))
    expect(readApprovalIntents(artifactRoot)).toEqual([])
    const nowUtc = NOW
    const record = {
      intentId: 'intent-1',
      authorizationId: 'auth-x',
      authorizationSha256: '2'.repeat(64),
      evalRunId: 'eval-1',
      datasetVersion: DATASET,
      split: 'dev',
      configIds: ['cfg-a'],
      maximumRequests: 4,
      state: 'launching' as const,
      registeredAtUtc: nowUtc,
      updatedAtUtc: nowUtc,
      finishedAtUtc: null
    }
    appendApprovalIntent(artifactRoot, record)
    expect(readApprovalIntents(artifactRoot)).toHaveLength(1)
    expect(approvedRequestCountFor(artifactRoot, 'auth-x')).toBe(4)
    expect(() => assertNoUnclearApprovalIntents(artifactRoot, 'auth-x')).toThrow(/发送状态不明/)
    // 其他授权不受影响
    expect(() => assertNoUnclearApprovalIntents(artifactRoot, 'auth-other')).not.toThrow()
    updateApprovalIntent(artifactRoot, 'intent-1', { state: 'running', updatedAtUtc: nowUtc })
    expect(() => assertNoUnclearApprovalIntents(artifactRoot, 'auth-x')).not.toThrow()
    updateApprovalIntent(artifactRoot, 'intent-1', { state: 'finished', updatedAtUtc: nowUtc, finishedAtUtc: nowUtc })
    const finished = readApprovalIntents(artifactRoot)[0]!
    expect(finished.state).toBe('finished')
    expect(finished.finishedAtUtc).toBe(nowUtc)
    // 已批准次数含 finished:重启/新进程不重置
    expect(approvedRequestCountFor(artifactRoot, 'auth-x')).toBe(4)
    // 损坏行不静默跳过
    writeApprovalIntentsFile(artifactRoot, [])
    writeFileSync(join(artifactRoot, 'approval-intents.jsonl'), '{broken json\n', 'utf-8')
    expect(() => readApprovalIntents(artifactRoot)).toThrow(/损坏/)
  })
})

// ---------- 服务层真实启动门(CLI 与桌面同门) ----------

describe('EVAL-02 EvalsService 真实启动门', () => {
  it('七类反例在创建 runner / 发送 fetch 前失败:预检拒绝且 fetch 为 0、无状态文件', () => {
    const f = makeFixture()
    const blockedRelease = join(f.paths.artifactRoot, '..', 'release-blocked-svc.json')
    writeFileSync(blockedRelease, JSON.stringify(releaseFixture(f.datasetSha256, { status: 'BLOCKED_INPUT' })), 'utf-8')
    const badAuth = join(f.paths.artifactRoot, '..', 'auth-blocked-svc.json')
    writeFileSync(badAuth, JSON.stringify(authorizationFixture({
      releaseFile: blockedRelease, baselineId: f.baselineId, candidateId: f.candidateId,
      baselineSha: f.baselineSha, candidateSha: f.candidateSha, targetSha256: f.targetSha256,
      datasetSha256: f.datasetSha256, fixtureSha256: f.fixtureSha256, maximumRequests: f.maximumRequests
    })), 'utf-8')
    expect(() =>
      f.service.startBatch({
        datasetVersion: DATASET,
        split: 'dev',
        executionKind: 'real',
        configIds: [f.baselineId],
        repeats: 1,
        maxCases: 1,
        caseIds: ['ops-read-01'],
        approval: { authorizationFile: badAuth }
      })
    ).toThrow(/真实启动预检拒绝\(RELEASE_NOT_SIGNED\)/)
    expect(f.fetchSpy).not.toHaveBeenCalled()
    // 无任何 runner 状态文件产生
    expect(existsSync(join(f.paths.artifactRoot, 'state.json'))).toBe(false)
  })

  it('先登记 intent 再启动:成功批次台账 finished;同一授权累计超限拒绝且跨服务实例不重置', async () => {
    const f = makeFixture()
    // 单案例 × 单配置 = 预算 4;授权上限 4
    const tightAuth = join(f.paths.artifactRoot, '..', 'auth-tight-svc.json')
    writeFileSync(tightAuth, JSON.stringify(authorizationFixture({
      releaseFile: f.releaseFile, baselineId: f.baselineId, candidateId: f.candidateId,
      baselineSha: f.baselineSha, candidateSha: f.candidateSha, targetSha256: f.targetSha256,
      datasetSha256: f.datasetSha256, fixtureSha256: f.fixtureSha256, maximumRequests: 4
    }, { maxRequests: 4 })), 'utf-8')
    const { evalRunId } = f.service.startBatch({
      datasetVersion: DATASET,
      split: 'dev',
      executionKind: 'real',
      configIds: [f.baselineId],
      repeats: 1,
      maxCases: 1,
      caseIds: ['ops-read-01'],
      approval: { authorizationFile: tightAuth }
    })
    const state = await waitTerminal(f.service, evalRunId)
    expect(state.status).toBe('completed')
    expect(f.fetchSpy.mock.calls.length).toBeGreaterThan(0)
    // intent 先登记后推进:等待收尾更新落盘
    const deadline = Date.now() + 3000
    let intents = readApprovalIntents(f.paths.artifactRoot)
    while ((intents[0]?.state ?? '') !== 'finished' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
      intents = readApprovalIntents(f.paths.artifactRoot)
    }
    expect(intents).toHaveLength(1)
    expect(intents[0]!.state).toBe('finished')
    expect(intents[0]!.evalRunId).toBe(evalRunId)
    expect(intents[0]!.maximumRequests).toBe(4)
    // 同一授权第二次启动:4 + 4 > 4 → 累计超限(已批准次数不重置)
    expect(() =>
      f.service.startBatch({
        datasetVersion: DATASET,
        split: 'dev',
        executionKind: 'real',
        configIds: [f.baselineId],
        repeats: 1,
        maxCases: 1,
        caseIds: ['ops-read-01'],
        approval: { authorizationFile: tightAuth }
      })
    ).toThrow(/REQUEST_BUDGET_EXCEEDED[\s\S]*累计超限:已批准 4 \+ 本次 4 > 授权上限 4/)
    // 新服务实例(模拟崩溃恢复)读同一台账:同样拒绝
    const service2 = new EvalsService({
      paths: f.paths,
      sqlJsDistDir: SQL_JS_DIST,
      credentialOf: (id) => (id === PROVIDER_ID ? 'synthetic-key' : null),
      versionsOf: () => ({ ...VERSIONS }),
      realCompleterFor: createRealCompleterFor({ credentialOf: (id) => (id === PROVIDER_ID ? 'synthetic-key' : null) })
    })
    expect(() =>
      service2.startBatch({
        datasetVersion: DATASET,
        split: 'dev',
        executionKind: 'real',
        configIds: [f.baselineId],
        repeats: 1,
        maxCases: 1,
        caseIds: ['ops-read-01'],
        approval: { authorizationFile: tightAuth }
      })
    ).toThrow(/REQUEST_BUDGET_EXCEEDED[\s\S]*累计超限/)
  })

  it('崩溃后 launching intent(发送状态不明)暂停后续真实启动', () => {
    const f = makeFixture()
    writeApprovalIntentsFile(f.paths.artifactRoot, [
      {
        intentId: 'intent-crash',
        authorizationId: 'auth-eval02-unit',
        authorizationSha256: '3'.repeat(64),
        evalRunId: null,
        datasetVersion: DATASET,
        split: 'dev',
        configIds: [f.baselineId],
        maximumRequests: 4,
        state: 'launching',
        registeredAtUtc: NOW,
        updatedAtUtc: NOW,
        finishedAtUtc: null
      }
    ])
    expect(() =>
      f.service.startBatch({
        datasetVersion: DATASET,
        split: 'dev',
        executionKind: 'real',
        configIds: [f.baselineId],
        repeats: 1,
        maxCases: 1,
        caseIds: ['ops-read-01'],
        approval: { authorizationFile: f.authorizationFile }
      })
    ).toThrow(/真实启动预检拒绝\(MALFORMED_INPUT\)[\s\S]*发送状态不明/)
  })

  it('冒烟 caseIds 进入请求数现算:5 案例双配置 40 > 授权 39 → 预检拒绝且零 fetch', () => {
    const f = makeFixture()
    const tight = join(f.paths.artifactRoot, '..', 'auth-smoke39.json')
    writeFileSync(tight, JSON.stringify(authorizationFixture({
      releaseFile: f.releaseFile, baselineId: f.baselineId, candidateId: f.candidateId,
      baselineSha: f.baselineSha, candidateSha: f.candidateSha, targetSha256: f.targetSha256,
      datasetSha256: f.datasetSha256, fixtureSha256: f.fixtureSha256, maximumRequests: 39
    }, { maxRequests: 39 })), 'utf-8')
    expect(() =>
      f.service.startBatch({
        datasetVersion: DATASET,
        split: 'dev',
        executionKind: 'real',
        configIds: [f.baselineId, f.candidateId],
        repeats: 1,
        maxCases: 5,
        caseIds: SMOKE_IDS,
        approval: { authorizationFile: tight }
      })
    ).toThrow(/真实启动预检拒绝\(REQUEST_BUDGET_EXCEEDED\)[\s\S]*现算上限 40 > 授权 maxRequests 39/)
    expect(f.fetchSpy).not.toHaveBeenCalled()
  })

  it('缺 approval 输入的 real 启动确定性拒绝(CLI 与桌面同门);fake 不要求授权且保留数据一致性检查', async () => {
    const f = makeFixture()
    expect(() =>
      f.service.startBatch({
        datasetVersion: DATASET,
        split: 'dev',
        executionKind: 'real',
        configIds: [f.baselineId],
        repeats: 1,
        maxCases: 1,
        caseIds: ['ops-read-01']
      })
    ).toThrow(/real 执行需要授权文件/)
    expect(f.fetchSpy).not.toHaveBeenCalled()
    // fake:无需授权;显式 caseIds 只允许 dev 的既有检查保留
    const { evalRunId } = f.service.startBatch({
      datasetVersion: DATASET,
      split: 'dev',
      executionKind: 'fake',
      configIds: [AUTO_FAKE_CONFIG_ID],
      repeats: 1,
      maxCases: 1,
      caseIds: ['ops-read-01']
    })
    const state = await waitTerminal(f.service, evalRunId)
    expect(state.status).toBe('completed')
    expect(state.results[0]!.status).toBe('passed')
    expect(readApprovalIntents(f.paths.artifactRoot)).toHaveLength(0)
    // fake 的数据版本一致性检查保留:不存在的数据版本给出具体路径错误
    expect(() =>
      f.service.startBatch({
        datasetVersion: 'no_such_version',
        split: 'dev',
        executionKind: 'fake',
        configIds: [AUTO_FAKE_CONFIG_ID],
        repeats: 1,
        maxCases: 1
      })
    ).toThrow(/评测数据集不存在/)
  })
})
