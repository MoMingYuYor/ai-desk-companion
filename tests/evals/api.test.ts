// EVAL-05 三层接线测试(服务层):资源路径契约、cwd 无关的资源发现、
// 缓存键(绝对数据根+版本+hash)、启动校验(配置冻结/数据 hash/预算/数量/凭据门)、
// 运行管理(取消/并发语义)、case 产物查询、人工审阅读写与审阅总览、报告生成,
// 以及 eval:* 通道的窗口能力(仅 workbench)。
import { mkdtempSync, cpSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { EvalsService, loadEvalsDataset, AUTO_FAKE_CONFIG_ID, EVAL_START_LIMITS, type EvalStartRequest } from '../../src/main/evals/api'
import { resolveEvalPaths, type EvalResourcePaths } from '../../src/main/evals/resources'
import { saveFrozenConfig, type FrozenEvalConfig } from '../../src/main/evals/configStore'
import type { EvalRunState } from '../../src/main/evals/runner'
import { authorizeIpc, type IpcPolicyEvent, type IpcPolicyWindow } from '../../src/main/security/ipcPolicy'
import { Channels } from '../../src/shared/api'

const REPO_ROOT = resolve(__dirname, '..', '..')
const REPO_DATASETS = join(REPO_ROOT, 'evals', 'datasets')
const REPO_FIXTURES = join(REPO_ROOT, 'fixtures', 'research')
const SQL_JS_DIST = join(REPO_ROOT, 'node_modules', 'sql.js', 'dist')

// ---------- 工具 ----------

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

const tempDirs: string[] = []
afterAll(() => {
  // 临时目录交给系统清理;这里只保证 cwd 复位(测试进程后续用例依赖)
  if (process.cwd() !== REPO_ROOT) process.chdir(REPO_ROOT)
})

interface ServiceHandle {
  service: EvalsService
  paths: EvalResourcePaths
}

/** 构建被测服务:只读资源默认指向仓库,可写三项落在临时 userData */
function makeService(over: Partial<EvalResourcePaths> = {}): ServiceHandle {
  const userData = mkdtempSync(join(tmpdir(), 'eval-api-'))
  tempDirs.push(userData)
  const paths = { ...resolveEvalPaths({ packaged: false, resourceRoot: REPO_ROOT, sourceRoot: REPO_ROOT, userData }), ...over }
  const service = new EvalsService({
    paths,
    sqlJsDistDir: SQL_JS_DIST,
    credentialOf: (providerId) => (providerId === 'unresolvable' ? null : 'test-credential')
  })
  return { service, paths }
}

function startRequest(over: Partial<EvalStartRequest> = {}): EvalStartRequest {
  return {
    datasetVersion: 'personal_ops_v1',
    split: 'dev',
    executionKind: 'fake',
    configIds: [AUTO_FAKE_CONFIG_ID],
    repeats: 1,
    maxCases: 1,
    ...over
  }
}

async function waitTerminal(service: EvalsService, evalRunId: string, timeoutMs = 60000): Promise<EvalRunState> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = service.getRun(evalRunId)
    if (state && state.status !== 'running') return state
    if (Date.now() > deadline) throw new Error(`评测运行超时未终态:${evalRunId}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

function frozenConfig(over: Partial<FrozenEvalConfig> & { configId: string; datasetSha256: string }): FrozenEvalConfig {
  return {
    schemaVersion: 1,
    executionKind: 'fake',
    model: 'fake-model',
    providerId: 'eval-fake',
    pipelineVariant: 'baseline',
    promptSha256: 'a'.repeat(64),
    toolsVersion: 'test',
    codeCommit: 'unknown',
    fixtureSha256: 'b'.repeat(64),
    budgetSha256: 'c'.repeat(64),
    interactionScriptSha256: 'd'.repeat(64),
    rubricVersion: 'rubric-v1',
    ...over
  }
}

// ---------- resources.resolveEvalPaths ----------

describe('EVAL-05 资源路径契约', () => {
  it('开发模式:datasetRoot=sourceRoot/evals/datasets,fixtureRoot=sourceRoot/fixtures/research', () => {
    const paths = resolveEvalPaths({ packaged: false, resourceRoot: '/unused', sourceRoot: '/repo', userData: '/user' })
    expect(paths.datasetRoot).toBe(join('/repo', 'evals', 'datasets'))
    expect(paths.fixtureRoot).toBe(join('/repo', 'fixtures', 'research'))
    expect(paths.artifactRoot).toBe(join('/user', 'evals', 'artifacts'))
    expect(paths.configRoot).toBe(join('/user', 'evals', 'configs'))
    expect(paths.reviewRoot).toBe(join('/user', 'evals', 'reviews'))
  })

  it('打包模式:只读资源定位 resourceRoot/evals 之下,可写三项仍在 userData/evals', () => {
    const paths = resolveEvalPaths({ packaged: true, resourceRoot: '/resources', sourceRoot: '/repo', userData: '/user' })
    expect(paths.datasetRoot).toBe(join('/resources', 'evals', 'datasets'))
    expect(paths.fixtureRoot).toBe(join('/resources', 'evals', 'fixtures', 'research'))
    expect(paths.artifactRoot).toBe(join('/user', 'evals', 'artifacts'))
    expect(paths.configRoot).toBe(join('/user', 'evals', 'configs'))
    expect(paths.reviewRoot).toBe(join('/user', 'evals', 'reviews'))
  })

  it('全部路径为绝对路径且互不重叠(可写与只读分离)', () => {
    // Windows 上 resolve('/') 会补盘符:用 tmpdir 下的绝对根避免歧义
    const base = mkdtempSync(join(tmpdir(), 'eval-paths-'))
    const resources = join(base, 'resources')
    const source = join(base, 'src')
    const user = join(base, 'user')
    const paths = resolveEvalPaths({ packaged: true, resourceRoot: resources, sourceRoot: source, userData: user })
    for (const p of [paths.datasetRoot, paths.fixtureRoot, paths.artifactRoot, paths.configRoot, paths.reviewRoot]) {
      expect(resolve(p)).toBe(p)
    }
    expect(paths.datasetRoot).toBe(join(resources, 'evals', 'datasets'))
    expect(paths.artifactRoot.startsWith(paths.datasetRoot)).toBe(false)
    expect(paths.artifactRoot.startsWith(paths.fixtureRoot)).toBe(false)
  })
})

// ---------- 资源发现:cwd 无关 + 缺资源显式报错 ----------

describe('EVAL-05 资源发现(改变 cwd 仍可发现;缺资源不静默)', () => {
  it('改变 cwd 后仍能发现两套 cases/manifest/Research annotations 与 fixtures', () => {
    const { service, paths } = makeService()
    const prevCwd = process.cwd()
    const foreign = mkdtempSync(join(tmpdir(), 'eval-cwd-'))
    try {
      process.chdir(foreign)
      const datasets = service.listDatasets()
      expect(datasets.map((d) => d.version).sort()).toEqual(['personal_ops_v1', 'research_v1'])
      // 两套 cases/manifest 经加载校验(含 hash 一致性)
      const ops = loadEvalsDataset(paths.datasetRoot, 'personal_ops_v1')
      const research = loadEvalsDataset(paths.datasetRoot, 'research_v1')
      expect(ops.cases.length).toBe(ops.manifest.total)
      expect(research.cases.length).toBe(research.manifest.total)
      // Research annotations 与 fixtures 均在路径契约位置
      expect(existsSync(join(paths.datasetRoot, 'research_v1', 'annotations'))).toBe(true)
      expect(existsSync(join(paths.fixtureRoot, 'demo'))).toBe(true)
    } finally {
      process.chdir(prevCwd)
    }
  })

  it('数据集根缺失:listDatasets 抛错并给出具体路径,不静默返回空清单', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'eval-missing-')), 'nope')
    const { service } = makeService({ datasetRoot: missing })
    expect(() => service.listDatasets()).toThrow(missing)
  })

  it('数据集版本缺失:startBatch 抛错并给出具体路径', () => {
    const { service, paths } = makeService()
    try {
      service.startBatch(startRequest({ datasetVersion: 'no_such_version' }))
      throw new Error('应当抛错')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).toContain('no_such_version')
      expect(message).toContain(join(paths.datasetRoot, 'no_such_version'))
    }
  })
})

// ---------- 缓存键:绝对数据根 + 版本 + hash ----------

describe('EVAL-05 数据集缓存键', () => {
  function copyDataset(target: string): void {
    mkdirSync(target, { recursive: true })
    cpSync(join(REPO_DATASETS, 'personal_ops_v1'), join(target, 'personal_ops_v1'), { recursive: true })
  }

  it('不同资源根的同名版本不共享缓存:一个根损坏不影响另一个根的已缓存结果', () => {
    const rootA = join(mkdtempSync(join(tmpdir(), 'eval-cache-')), 'ds')
    const rootB = join(mkdtempSync(join(tmpdir(), 'eval-cache-')), 'ds')
    copyDataset(rootA)
    copyDataset(rootB)
    const dsA = loadEvalsDataset(rootA, 'personal_ops_v1')
    expect(dsA.cases.length).toBe(50)
    // 破坏 rootB 的 cases 内容(hash 与 manifest 不一致):rootB 加载必须失败,
    // 且不能命中 rootA 同版本的成功缓存
    const casesFileB = join(rootB, 'personal_ops_v1', 'cases.jsonl')
    writeFileSync(casesFileB, readFileSync(casesFileB, 'utf-8') + '\n', 'utf-8')
    expect(() => loadEvalsDataset(rootB, 'personal_ops_v1')).toThrow(/hash 不一致|校验失败/)
    expect(dsA.cases.length).toBe(50)
  })

  it('缓存键含数据 hash:同根同版本内容变更后重新加载', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'eval-cache-')), 'ds')
    copyDataset(root)
    const dir = join(root, 'personal_ops_v1')
    const first = loadEvalsDataset(root, 'personal_ops_v1')
    // 修改一条案例输入并同步 manifest hash:合法数据集,内容 hash 变化
    const casesFile = join(dir, 'cases.jsonl')
    const lines = readFileSync(casesFile, 'utf-8').trimEnd().split('\n')
    const firstCase = JSON.parse(lines[0]!) as { input: string }
    firstCase.input = `${firstCase.input}(v2)`
    lines[0] = JSON.stringify(firstCase)
    const updated = lines.join('\n') + '\n'
    writeFileSync(casesFile, updated, 'utf-8')
    const manifestFile = join(dir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf-8')) as { cases_sha256: string }
    manifest.cases_sha256 = sha256(updated)
    writeFileSync(manifestFile, JSON.stringify(manifest), 'utf-8')
    const second = loadEvalsDataset(root, 'personal_ops_v1')
    expect(second.casesSha256).not.toBe(first.casesSha256)
    expect(second.cases[0]!.input.endsWith('(v2)')).toBe(true)
  })
})

// ---------- 启动校验:配置冻结 / 数据 hash / 预算与数量 / 凭据门 ----------

describe('EVAL-05 start 服务端校验', () => {
  it('未冻结配置:报错带 configId 与 configRoot 期望路径', () => {
    const { service, paths } = makeService()
    try {
      service.startBatch(startRequest({ configIds: ['no-such-config'] }))
      throw new Error('应当抛错')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).toContain('no-such-config')
      expect(message).toContain(join(paths.configRoot, 'no-such-config.json'))
    }
  })

  it('配置执行类型与请求不一致:拒绝(fake/real 不可混跑)', () => {
    const { service, paths } = makeService()
    saveFrozenConfig(paths.configRoot, frozenConfig({ configId: 'real-mismatch', executionKind: 'real', datasetSha256: loadEvalsDataset(paths.datasetRoot, 'personal_ops_v1').casesSha256 }))
    try {
      service.startBatch(startRequest({ configIds: ['real-mismatch'] }))
      throw new Error('应当抛错')
    } catch (err) {
      expect((err as Error).message).toContain('executionKind')
    }
  })

  it('配置冻结的数据 hash 与当前数据集不一致:拒绝', () => {
    const { service, paths } = makeService()
    saveFrozenConfig(paths.configRoot, frozenConfig({ configId: 'fake-stale', datasetSha256: '0'.repeat(64) }))
    try {
      service.startBatch(startRequest({ configIds: ['fake-stale'] }))
      throw new Error('应当抛错')
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('数据 hash')
      expect(message).toContain('fake-stale')
    }
  })

  it('repeats/maxCases 越界:服务端拒绝(预算与最大启动数量收口)', () => {
    const { service } = makeService()
    expect(() => service.startBatch(startRequest({ repeats: 0 }))).toThrow(/repeats/)
    expect(() => service.startBatch(startRequest({ repeats: EVAL_START_LIMITS.maxRepeats + 1 }))).toThrow(/repeats/)
    expect(() => service.startBatch(startRequest({ maxCases: 0 }))).toThrow(/maxCases/)
    expect(() => service.startBatch(startRequest({ maxCases: EVAL_START_LIMITS.maxCases + 1 }))).toThrow(/maxCases/)
  })

  it('real 执行:无适配器拒绝;有适配器但凭据不可解析拒绝;凭据可解析才放行', async () => {
    const { service, paths } = makeService()
    saveFrozenConfig(
      paths.configRoot,
      frozenConfig({ configId: 'real-x', executionKind: 'real', providerId: 'unresolvable', datasetSha256: loadEvalsDataset(paths.datasetRoot, 'personal_ops_v1').casesSha256 })
    )
    expect(() => service.startBatch(startRequest({ executionKind: 'real', configIds: ['real-x'] }))).toThrow(/真实补全适配器/)

    const wired = new EvalsService({
      paths,
      sqlJsDistDir: SQL_JS_DIST,
      realCompleter: { completeJson: vi.fn() } as never,
      credentialOf: () => null
    })
    expect(() => wired.startBatch(startRequest({ executionKind: 'real', configIds: ['real-x'] }))).toThrow(/凭据引用无法/)

    const ok = new EvalsService({
      paths,
      sqlJsDistDir: SQL_JS_DIST,
      realCompleter: { completeJson: vi.fn() } as never,
      credentialOf: () => 'env-key'
    })
    // 校验通过即放行启动;第二个组合领取前取消,不推进更多案例
    let claims = 0
    const holder: { id: string } = { id: '' }
    const { evalRunId } = ok.startBatch(startRequest({ executionKind: 'real', configIds: ['real-x'] }), {
      beforeClaim: () => {
        claims += 1
        if (holder.id) ok.cancelRun(holder.id)
      }
    })
    holder.id = evalRunId
    const state = await waitTerminal(ok, evalRunId, 30000)
    expect(claims).toBeGreaterThanOrEqual(2)
    expect(state.status).toBe('cancelled')
    expect(state.stopReason).toBe('user_cancelled')
  }, 45000)
})

// ---------- 端到端(fake 离线批次)+ 取消 + 产物 + 审阅 + 报告 ----------

describe('EVAL-05 EvalsService fake 批次(离线端到端)', () => {
  it('fake-flow-v1 自动注册并冻结;dev 全批跑通且产物完整可查询', async () => {
    const { service, paths } = makeService()
    // dev 全部 30 条(数据集 dev 拆分),预算内全部启动 → 正常 completed 收尾
    const { evalRunId } = service.startBatch(startRequest({ maxCases: 30 }))
    expect(evalRunId).toBeTruthy()
    const state = await waitTerminal(service, evalRunId)
    expect(state.status).toBe('completed')
    expect(state.executionKind).toBe('fake')
    expect(state.results).toHaveLength(30)
    // dev 全批 28/30 通过;ops-write-03/08 与内置 fake 通路(ops50)结果一致,
    // 属数据集既有失败,不是接线引入的回归
    expect(state.results.filter((r) => r.status === 'passed')).toHaveLength(28)
    expect(
      state.results.filter((r) => r.status !== 'passed').map((r) => r.caseId).sort()
    ).toEqual(['ops-write-03', 'ops-write-08'])
    expect(state.results.every((r) => r.artifactStatus === 'ok')).toBe(true)
    expect((state.results[0]!.toolObservations ?? []).length).toBeGreaterThan(0)

    // 自动注册的冻结配置落在 configRoot,配置发现可见且 hash 文件齐备
    expect(existsSync(join(paths.configRoot, `${AUTO_FAKE_CONFIG_ID}.json`))).toBe(true)
    expect(existsSync(join(paths.configRoot, `${AUTO_FAKE_CONFIG_ID}.sha256`))).toBe(true)
    const summaries = service.listConfigs()
    expect(summaries.find((c) => c.configId === AUTO_FAKE_CONFIG_ID)?.executionKind).toBe('fake')

    // case 产物查询:manifest 完整,run/observations 内容可读
    const result = state.results[0]!
    const artifacts = service.getCaseArtifacts(evalRunId, result.configId, result.caseId, result.repeatIndex)
    expect(artifacts.ok).toBe(true)
    expect((artifacts.manifest as { complete: boolean }).complete).toBe(true)
    expect((artifacts.artifacts!.run as { caseId: string }).caseId).toBe(result.caseId)
    expect(artifacts.artifacts!.observations.length).toBeGreaterThan(0)
    // 非法 repeatIndex:路径守卫拒绝
    expect(() => service.getCaseArtifacts(evalRunId, result.configId, result.caseId, -1)).toThrow(/repeatIndex/)

    // 报告:fake 标识 + schema 版本
    const report = service.getReport(evalRunId)
    expect(report).toContain('评测报告')
    expect(report).toContain('execution_kind = fake')
  }, 60000)

  it('取消:首个案例完成后请求取消,后续组合不执行,终态 cancelled', async () => {
    const { service } = makeService()
    let beforeClaims = 0
    let started: { evalRunId: string } | null = null
    const { evalRunId } = service.startBatch(startRequest({ maxCases: 5 }), {
      beforeClaim: () => {
        beforeClaims += 1
        if (beforeClaims === 2 && started) service.cancelRun(started.evalRunId)
      }
    })
    started = { evalRunId }
    const state = await waitTerminal(service, evalRunId)
    expect(state.status).toBe('cancelled')
    expect(state.stopReason).toBe('user_cancelled')
    // 领取在第二个组合前停止:恰好 1 个已执行结果,其余全部 not_run(不覆盖已完成)
    expect(state.results.filter((r) => r.status !== 'not_run').length).toBe(1)
    expect(state.results.filter((r) => r.status === 'not_run').length).toBe(state.results.length - 1)
  }, 60000)

  it('未知 run:cancelRun 幂等返回 cancelled=false;审阅总览报未知运行', () => {
    const { service } = makeService()
    expect(service.cancelRun('eval-nope').cancelled).toBe(false)
    expect(() => service.getReviewOverview('eval-nope')).toThrow(/eval-nope/)
  })
})

// ---------- 人工审阅读写(FileReviewStore)+ 审阅总览 ----------

describe('EVAL-05 人工审阅读写', () => {
  it('审阅持久写成功后可读回;按 evalRunId 过滤;空理由拒绝', async () => {
    const { service, paths } = makeService()
    const saved = service.saveReview({
      evalRunId: 'eval-r1',
      configId: 'cfg',
      caseId: 'case-1',
      repeatIndex: 0,
      claimId: 'claim-1',
      evidenceId: 'ev-1',
      decision: 'supported',
      reason: '片段直接支持',
      reviewer: '测试审阅人'
    })
    expect(saved.reviewId).toBeTruthy()
    expect(existsSync(join(paths.reviewRoot, 'reviews.jsonl'))).toBe(true)
    // 先持久写成功再返回:文件里能找到该记录
    expect(readFileSync(join(paths.reviewRoot, 'reviews.jsonl'), 'utf-8')).toContain(saved.reviewId)
    // 同一对象重新审阅保留历史
    service.saveReview({
      evalRunId: 'eval-r1', configId: 'cfg', caseId: 'case-1', repeatIndex: 0,
      claimId: 'claim-1', evidenceId: 'ev-1', decision: 'contradicted', reason: '复核后推翻', reviewer: '测试审阅人'
    })
    expect(service.listReviews('eval-r1')).toHaveLength(2)
    expect(service.listReviews('eval-other')).toHaveLength(0)
    // 空理由拒绝(有效判定必须有理由)
    expect(() =>
      service.saveReview({
        evalRunId: 'eval-r1', configId: 'cfg', caseId: 'case-1', repeatIndex: 0,
        claimId: 'claim-1', evidenceId: 'ev-1', decision: 'supported', reason: '', reviewer: '测试审阅人'
      })
    ).toThrow(/理由/)
    // 无引用 claim 的 evidenceId 归一为 NO_EVIDENCE_SEGMENT 段
    const none = service.saveReview({
      evalRunId: 'eval-r1', configId: 'cfg', caseId: 'case-1', repeatIndex: 0,
      claimId: 'claim-2', evidenceId: '', decision: 'insufficient', reason: '缺引用', reviewer: '测试审阅人'
    })
    expect(none.subjectKey.endsWith('::none')).toBe(true)
  })

  it('ops 批次的审阅总览:无研究证据 → 空集、coverage N/A、holdout 未完成', async () => {
    const { service } = makeService()
    const { evalRunId } = service.startBatch(startRequest({ maxCases: 1 }))
    await waitTerminal(service, evalRunId)
    const overview = service.getReviewOverview(evalRunId)
    expect(overview.subjects).toHaveLength(0)
    expect(overview.coverage.expected).toBe(0)
    expect(overview.coverage.value).toBeNull()
    expect(overview.holdoutComplete).toBe(false)
    expect(overview.unreviewed).toHaveLength(0)
  }, 60000)
})

// ---------- eval:* 通道的窗口能力(仅 workbench) ----------

describe('EVAL-05 评测通道窗口能力', () => {
  const EVAL_CHANNELS = [
    Channels.EvalListDatasets,
    Channels.EvalStartBatch,
    Channels.EvalGetRun,
    Channels.EvalGetReport,
    Channels.EvalCancelRun,
    Channels.EvalListConfigs,
    Channels.EvalCaseArtifacts,
    Channels.EvalReviewSave,
    Channels.EvalReviewList
  ]
  const PROD = {
    workbench: 'file:///D:/app/out/renderer/workbench.html',
    pet: 'file:///D:/app/out/renderer/pet.html',
    panel: 'file:///D:/app/out/renderer/panel.html'
  }
  function win(role: IpcPolicyWindow['role'], id: number): IpcPolicyWindow {
    return { role, webContentsId: id, pageUrl: PROD[role], isDestroyed: () => false }
  }
  function evt(senderId: number, url: string): IpcPolicyEvent {
    return { sender: { id: senderId }, senderFrame: { url, parent: null } }
  }
  const registry = [win('workbench', 1), win('pet', 2), win('panel', 3)]

  it('workbench 全部放行;pet/panel 一律拒绝', () => {
    for (const channel of EVAL_CHANNELS) {
      expect(authorizeIpc(evt(1, PROD.workbench), channel, registry)).toBe(true)
      expect(authorizeIpc(evt(2, PROD.pet), channel, registry)).toBe(false)
      expect(authorizeIpc(evt(3, PROD.panel), channel, registry)).toBe(false)
    }
  })

  it('启动请求契约不含自动批准标志(渲染层不可注入)', () => {
    const request = startRequest()
    expect(Object.keys(request)).not.toContain('autoApprove')
    expect(JSON.stringify(request)).not.toContain('approve')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
})
