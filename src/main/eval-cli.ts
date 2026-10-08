// 评测最小复现 CLI(EVAL-05):main 的第二构建入口 out/main/eval-cli.js。
//
// 纪律(完成计划 eval.md EVAL-05;EVAL-02/EVAL-03 扩展):
// - 复用与桌面完全相同的 API/runner(EvalsService);本文件及其传递依赖不导入
//   Electron——只有经纯 Node 构建运行测试确认无 Electron 运行时依赖,该入口
//   才算完成;
// - 路径:源根由构建位置推导(__dirname = out/main → 仓库根),数据集与 fixture
//   走仓库只读资源;可写目录来自 --user-data(缺省 <cwd>/.eval-user-data),
//   --artifact-root 覆盖产物根;全部经 resources.resolveEvalPaths 显式构造,
//   不依赖调用时 cwd 推导资源;
// - real 凭据仅从环境变量 AI_DESK_EVAL_API_KEY 解析,不读取业务库;
//   real 补全适配器未注入时明确报错(不做静默桩);
// - EVAL-02:real run 必须提供 --approval-file(授权文件;其 releaseFile 字段
//   定位数据 release);预检在 EvalsService 层执行,CLI 与桌面同门;
// - EVAL-03:compare 子命令按计划文件逐批协调 startBatch/getRun/cancelRun,
//   台账断点续跑,并产出效果报告(JSON + Markdown);
// - 退出码:成功 0;必需参数缺失 2;运行或资源错误 1。
//
// 用法:
//   node out/main/eval-cli.js freeze --experiment adc-... --dataset personal_ops_v3 \
//     --stage ops-planning --execution real --target-file target.json --user-data <目录>
//   node out/main/eval-cli.js run --dataset personal_ops_v3 --split dev --execution real \
//     --config <baselineId>,<candidateId> --repeats 1 --max-cases 10 \
//     --case-ids-file ops-smoke-ids.json --approval-file authorization.json \
//     --user-data <目录> --artifact-root <目录>
//   node out/main/eval-cli.js compare --plan-file plan.json --ledger ledger.json \
//     [--approval-file authorization.json] --user-data <目录> [--artifact-root <目录>]
//   node out/main/eval-cli.js report --run-id <evalRunId> --artifact-root <目录>

import { join, resolve, dirname } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolveEvalPaths } from './evals/resources'
import { EvalsService, EVAL_START_LIMITS, loadEvalsDataset, type EvalStartRequest } from './evals/api'
import { currentEvalVersions } from './evals/buildVersions'
import { createRealCompleterFor } from './evals/realAdapter'
import { frozenConfigSha256, loadFrozenConfig } from './evals/configStore'
import {
  buildPairedPlan,
  readPairedLedger,
  renderPairedReport,
  runPairedBatches,
  summarizePairedRuns,
  type PairedPlanFile,
  type PairedRunRecord
} from './evals/pairedExperiment'
import type { FreezeInput } from '../shared/evals'

interface ParsedArgs {
  command: string
  flags: Record<string, string>
}

/** 极简 flags 解析:首个非 --token 为子命令,其余按 --key value 成对读取 */
export function parseArgs(argv: readonly string[]): ParsedArgs | null {
  if (argv.length === 0) return null
  const command = argv[0]!
  if (command.startsWith('--')) return null
  const flags: Record<string, string> = {}
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]!
    if (!token.startsWith('--')) return null
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) return null
    flags[token.slice(2)] = value
    i += 1
  }
  return { command, flags }
}

export function usage(): string {
  return [
    '评测最小复现 CLI(EVAL-05 + EVAL-02/EVAL-03):',
    '  eval-cli freeze --experiment <ID> --dataset <版本> --stage <ops-planning|research-extraction>',
    '        --execution <fake|real> --user-data <目录> [--target-file <无密钥JSON>]',
    '  eval-cli run --dataset <版本> --split <dev|holdout> --execution <fake|real>',
    '        --config <configId>[,<configId>…] [--repeats 1] [--max-cases 20]',
    '        [--artifact-root <目录>] [--user-data <目录>]',
    '        [--case-ids-file <dev冒烟ID数组JSON>]',
    '        [--approval-file <授权JSON>(real 必需;其 releaseFile 字段定位数据 release)]',
    '  eval-cli plan --experiment <ID> --execution <fake|real>',
    '        --ops-dataset <版本> --ops-baseline <configId> --ops-candidate <configId>',
    '        --research-dataset <版本> --research-baseline <configId> --research-candidate <configId>',
    '        --user-data <目录> [--out <计划JSON>] [--max-dev-cases-per-batch K](截断须声明)',
    '  eval-cli compare --plan-file <计划JSON> --ledger <台账JSON>',
    '        [--approval-file <授权JSON>(real 计划必需)] [--user-data <目录>]',
    '        [--artifact-root <目录>](产出 paired-report.json/.md 到产物根)',
    '  eval-cli report --run-id <evalRunId> [--artifact-root <目录>] [--user-data <目录>]',
    '',
    '退出码:成功 0;缺参 2;运行/资源错误 1。',
    `real 凭据仅从环境变量 AI_DESK_EVAL_API_KEY 解析;启动上限 maxCases≤${EVAL_START_LIMITS.maxCases};`,
    'real 启动必须通过真实预检(release 签发/覆盖/资源 hash/目标/授权/请求数/凭据绑定七类拒绝路径)。',
    'compare:计划文件绑定配置 hash 与案例清单;台账断点续跑;取消不领取下一批。'
  ].join('\n')
}

/** CLI 运行错误(退出码 1) */
class CliError extends Error {}

/** 构建 CLI 服务:fake 离线可跑;real 凭据仅认环境变量 */
function buildService(flags: Record<string, string>): { service: EvalsService; artifactRoot: string } {
  // 源根:构建产物 out/main/eval-cli.js → 仓库根(两级向上)
  const sourceRoot = resolve(__dirname, '..', '..')
  const cwd = process.cwd()
  const userData = flags['user-data'] ? resolve(cwd, flags['user-data']) : join(cwd, '.eval-user-data')
  const paths = resolveEvalPaths({ packaged: false, resourceRoot: sourceRoot, sourceRoot, userData })
  // --artifact-root 覆盖产物根(相对路径按调用时 cwd 解析);其余可写目录仍在 userData
  const artifactRoot = flags['artifact-root'] ? resolve(cwd, flags['artifact-root']) : paths.artifactRoot
  const credentialOf = (providerId: string): string | null =>
    process.env.AI_DESK_EVAL_PROVIDER_ID === providerId ? process.env.AI_DESK_EVAL_API_KEY ?? null : null
  const service = new EvalsService({
    paths: { ...paths, artifactRoot },
    sqlJsDistDir: join(sourceRoot, 'node_modules', 'sql.js', 'dist'),
    // real 凭据:仅显式环境变量;不读取业务库/凭据库
    credentialOf,
    realCompleterFor: createRealCompleterFor({ credentialOf }),
    versionsOf: () => currentEvalVersions(sourceRoot)
  })
  return { service, artifactRoot }
}

async function cmdFreeze(flags: Record<string, string>): Promise<number> {
  if (['experiment', 'dataset', 'stage', 'execution', 'user-data'].some(key => !flags[key]) ||
    !['fake', 'real'].includes(flags.execution!) || !['ops-planning', 'research-extraction'].includes(flags.stage!) ||
    (flags.execution === 'real' && !flags['target-file'])) {
    console.error(`[eval-cli] freeze 参数缺失或非法\n${usage()}`)
    return 2
  }
  const input: FreezeInput = {
    experimentId: flags.experiment!, datasetVersion: flags.dataset!, stage: flags.stage as FreezeInput['stage'],
    executionKind: flags.execution as FreezeInput['executionKind'],
    target: flags.execution === 'real' ? JSON.parse(readFileSync(resolve(flags['target-file']!), 'utf8')) : null
  }
  const { service } = buildService(flags)
  const result = service.freeze(input)
  console.log(JSON.stringify({ baseline: { configId: result.baseline.config.configId, sha256: result.baseline.sha256 }, candidate: { configId: result.candidate.config.configId, sha256: result.candidate.sha256 }, manifestSha256: result.manifestSha256 }))
  return 0
}

async function waitTerminal(service: EvalsService, evalRunId: string): Promise<NonNullable<ReturnType<EvalsService['getRun']>>> {
  for (;;) {
    const state = service.getRun(evalRunId)
    if (state && state.status !== 'running') return state
    await new Promise((r) => setTimeout(r, 250))
  }
}

async function cmdRun(flags: Record<string, string>): Promise<number> {
  const missing = ['dataset', 'split', 'execution', 'config'].filter((k) => !flags[k])
  if (missing.length > 0) {
    console.error(`[eval-cli] 缺少必需参数:${missing.map((k) => `--${k}`).join(' ')}\n\n${usage()}`)
    return 2
  }
  const execution = flags['execution']!
  if (execution !== 'fake' && execution !== 'real') {
    console.error(`[eval-cli] --execution 非法:${execution}(只允许 fake | real)\n\n${usage()}`)
    return 2
  }
  const split = flags['split']!
  if (split !== 'dev' && split !== 'holdout') {
    console.error(`[eval-cli] --split 非法:${split}(只允许 dev | holdout)\n\n${usage()}`)
    return 2
  }
  // EVAL-02:real 执行必须提供授权文件(缺参即拒绝;深度预检在 EvalsService 层)
  if (execution === 'real' && !flags['approval-file']) {
    console.error('[eval-cli] real 执行缺少 --approval-file(授权 JSON;其 releaseFile 字段定位数据 release;fake 不需要)\n\n请先完成 EVAL-01 签发与本次批次授权。')
    return 2
  }
  const repeats = flags.repeats !== undefined ? Number(flags.repeats) : 1
  const maxCases = flags['max-cases'] !== undefined ? Number(flags['max-cases']) : 20
  const configIds = flags['config']!.split(',').map((s) => s.trim()).filter((s) => s !== '')
  const request: EvalStartRequest = {
    datasetVersion: flags['dataset']!,
    split,
    executionKind: execution,
    configIds,
    repeats,
    maxCases,
    ...(flags['case-ids-file'] ? { caseIds: JSON.parse(readFileSync(resolve(flags['case-ids-file']), 'utf8')) } : {}),
    ...(flags['approval-file'] ? { approval: { authorizationFile: resolve(flags['approval-file']!) } } : {})
  }
  if (execution === 'real' && !process.env.AI_DESK_EVAL_API_KEY) {
    console.error('[eval-cli] real 执行需要环境变量 AI_DESK_EVAL_API_KEY(凭据仅从显式 config 与该变量解析,不读取业务库)')
    return 1
  }
  const { service, artifactRoot } = buildService(flags)
  const { evalRunId } = service.startBatch(request)
  console.error(`[eval-cli] 批次已启动:${evalRunId}(artifactRoot=${artifactRoot})`)
  const state = await waitTerminal(service, evalRunId)
  const counts = {
    passed: state.results.filter((r) => r.status === 'passed').length,
    failed: state.results.filter((r) => r.status === 'failed').length,
    not_run: state.results.filter((r) => r.status === 'not_run').length
  }
  // 结果摘要打到 stdout(JSON,单行):供验收脚本消费
  console.log(
    JSON.stringify({
      evalRunId: state.evalRunId,
      status: state.status,
      stopReason: state.stopReason ?? null,
      datasetVersion: state.datasetVersion,
      executionKind: state.executionKind,
      configIds: state.configIds,
      repeats: state.repeats,
      maxCases: state.maxCases,
      ...counts,
      artifactRoot
    })
  )
  // 到达终态即执行成功(部分批次含 not_run 属预算内结果,退出码仍为 0)
  return 0
}

async function cmdReport(flags: Record<string, string>): Promise<number> {
  if (!flags['run-id']) {
    console.error(`[eval-cli] 缺少必需参数:--run-id\n\n${usage()}`)
    return 2
  }
  const { service } = buildService(flags)
  const report = service.getReport(flags['run-id']!)
  if (report === null) {
    console.error(`[eval-cli] 报告生成失败:找不到运行状态(${flags['run-id']};检查 --artifact-root 是否与启动一致)`)
    return 1
  }
  // 报告 Markdown 原文写到 stdout(重定向即保存)
  console.log(report)
  return 0
}

/**
 * EVAL-03 plan:从冻结配置与数据集展开 24 批成对计划(绑定配置 hash 与案例
 * 清单),写出计划文件供 compare 消费。计划展开是确定性的,同输入逐字节一致。
 */
async function cmdPlan(flags: Record<string, string>): Promise<number> {
  const missing = ['experiment', 'execution', 'ops-dataset', 'ops-baseline', 'ops-candidate', 'research-dataset', 'research-baseline', 'research-candidate', 'user-data'].filter((k) => !flags[k])
  if (missing.length > 0 || !['fake', 'real'].includes(flags.execution!)) {
    console.error(`[eval-cli] plan 参数缺失或非法:${missing.map((k) => `--${k}`).join(' ')}\n\n${usage()}`)
    return 2
  }
  const { service } = buildService(flags)
  const { datasetRoot, configRoot } = service.paths
  const modules = [
    { dataset: flags['ops-dataset']!, baseline: flags['ops-baseline']!, candidate: flags['ops-candidate']! },
    { dataset: flags['research-dataset']!, baseline: flags['research-baseline']!, candidate: flags['research-candidate']! }
  ]
  const configSha256: Record<string, string> = {}
  for (const m of modules) {
    for (const configId of [m.baseline, m.candidate]) {
      // 冻结配置缺失/损坏直接抛错:计划必须绑定真实冻结 hash
      configSha256[configId] = frozenConfigSha256(loadFrozenConfig(configRoot, configId))
    }
  }
  const plan = buildPairedPlan(
    modules.map((m) => {
      const dataset = loadEvalsDataset(datasetRoot, m.dataset)
      return {
        datasetVersion: m.dataset,
        casesSha256: dataset.casesSha256,
        cases: dataset.cases,
        baselineConfigId: m.baseline,
        candidateConfigId: m.candidate
      }
    }),
    {
      experimentId: flags.experiment!,
      executionKind: flags.execution as 'fake' | 'real',
      configSha256,
      ...(flags['max-dev-cases-per-batch'] !== undefined ? { maxDevCasesPerBatch: Number(flags['max-dev-cases-per-batch']) } : {})
    }
  )
  const json = JSON.stringify(plan, null, 2) + '\n'
  if (flags.out) {
    const outFile = resolve(flags.out)
    mkdirSync(dirname(outFile), { recursive: true })
    writeFileSync(outFile, json, 'utf-8')
    console.error(`[eval-cli] 计划已写入:${outFile}(${plan.batches.length} 批,execution=${plan.executionKind}${plan.truncation ? ',已声明截断' : ''})`)
  } else {
    console.log(json)
  }
  return 0
}

/**
 * EVAL-03 compare:按计划文件逐批协调 fake/real 批次,台账断点续跑,
 * 结束后从台账 + run 状态汇总效果报告(JSON + Markdown 写到产物根)。
 */
async function cmdCompare(flags: Record<string, string>): Promise<number> {
  const missing = ['plan-file', 'ledger'].filter((k) => !flags[k])
  if (missing.length > 0) {
    console.error(`[eval-cli] compare 缺少必需参数:${missing.map((k) => `--${k}`).join(' ')}\n\n${usage()}`)
    return 2
  }
  const planFile = resolve(flags['plan-file']!)
  let plan: PairedPlanFile
  try {
    plan = JSON.parse(readFileSync(planFile, 'utf8')) as PairedPlanFile
  } catch (err) {
    console.error(`[eval-cli] 计划文件不可读或损坏:${planFile}:${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  if (plan.kind !== 'eval-paired-plan' || plan.schemaVersion !== 1 || !Array.isArray(plan.batches) || plan.batches.length === 0) {
    console.error(`[eval-cli] 计划文件形态非法(kind/schemaVersion/batches):${planFile}`)
    return 1
  }
  if (plan.executionKind === 'real' && !flags['approval-file']) {
    console.error('[eval-cli] real 计划的 compare 缺少 --approval-file(授权 JSON;fake 计划不需要)')
    return 2
  }
  const { service, artifactRoot } = buildService(flags)
  const ledgerFile = resolve(flags['ledger']!)
  console.error(`[eval-cli] compare 开始:plan=${planFile}(${plan.batches.length} 批,execution=${plan.executionKind}) ledger=${ledgerFile}`)
  const controller = new AbortController()
  let cancelled = false
  const onInterrupt = (): void => {
    cancelled = true
    controller.abort()
  }
  process.on('SIGINT', onInterrupt)
  let bindings
  try {
    bindings = await runPairedBatches(plan.batches, service, ledgerFile, controller.signal, {
      executionKind: plan.executionKind
    })
  } catch (err) {
    process.off('SIGINT', onInterrupt)
    console.error(`[eval-cli] compare 停止:${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  process.off('SIGINT', onInterrupt)
  // 从台账与 run 状态汇总效果报告(已完成/取消批次;failed/cancelled 批次可见)
  const ledger = readPairedLedger(ledgerFile)
  const runs: PairedRunRecord[] = []
  if (ledger !== null) {
    for (const entry of Object.values(ledger.batches)) {
      if ((entry.status !== 'completed' && entry.status !== 'cancelled') || !entry.evalRunId) continue
      const state = service.getRun(entry.evalRunId)
      if (state === null) continue
      runs.push({
        datasetVersion: entry.datasetVersion,
        split: entry.split,
        globalRepeatIndex: entry.globalRepeatIndex,
        pipelineVariant: entry.pipelineVariant,
        configId: entry.configId,
        evalRunId: entry.evalRunId,
        state
      })
    }
  }
  const report = summarizePairedRuns({
    runs,
    mode: plan.executionKind,
    planSha256: null,
    ...(plan.executionKind === 'fake'
      ? { note: 'fake 预检示例:结果来自离线 fake 流程,不代表真实模型能力(计划验证/通路验证用)。' }
      : {})
  })
  mkdirSync(artifactRoot, { recursive: true })
  const reportJsonFile = join(artifactRoot, 'paired-report.json')
  const reportMdFile = join(artifactRoot, 'paired-report.md')
  writeFileSync(reportJsonFile, JSON.stringify(report, null, 2) + '\n', 'utf-8')
  writeFileSync(reportMdFile, renderPairedReport(report), 'utf-8')
  const completedBatches = ledger === null ? 0 : Object.values(ledger.batches).filter((b) => b.status === 'completed').length
  console.log(
    JSON.stringify({
      status: cancelled ? 'cancelled' : 'done',
      planBatches: plan.batches.length,
      completedBatches,
      bindings: bindings.length,
      reportJson: reportJsonFile,
      reportMd: reportMdFile,
      artifactRoot
    })
  )
  return 0
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed) {
    console.error(`${usage()}`)
    return 2
  }
  switch (parsed.command) {
    case 'freeze': return cmdFreeze(parsed.flags)
    case 'plan':
      return cmdPlan(parsed.flags)
    case 'run':
      return cmdRun(parsed.flags)
    case 'compare':
      return cmdCompare(parsed.flags)
    case 'report':
      return cmdReport(parsed.flags)
    case 'help':
    case '--help':
      console.log(usage())
      return 0
    default:
      console.error(`[eval-cli] 未知子命令:${parsed.command}\n\n${usage()}`)
      return 2
  }
}

/** 仅当本文件被 node 直接执行时进入主流程;测试导入参数面时不启动 main */
function invokedAsCli(): boolean {
  return /eval-cli\.(js|mjs|cjs)$/.test(String(process.argv[1] ?? '').replace(/\\/g, '/'))
}

if (invokedAsCli()) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err: unknown) => {
      console.error(`[eval-cli] 运行错误:${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    })
}

export { CliError }
