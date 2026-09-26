// 评测契约(E-01):EvalCase、manifest、运行与结果的共享类型与校验。
// 字段与 LLM Eval Lab 规格第 4 节一致;校验规则:
// - case_id 数据集版本内唯一(加载器负责);
// - split 冻结为 dev / holdout;
// - expected.terminal_status 必须是合法运行状态;
// - research 证据不足类案例允许 gold_claims 为空,但必须有 missing 语义(由 tags 承载)。

import type { RunMode, RunStatus } from '../../shared/agent'
import { isRunMode, isRunStatus } from '../../shared/agent'
import { appError } from '../../shared/operations'
import { OperationError } from '../db/operations'

export const EVAL_SCHEMA_VERSION = 1

export type EvalSplit = 'dev' | 'holdout'
export const EVAL_SPLITS: readonly EvalSplit[] = ['dev', 'holdout']

export interface EvalExpected {
  /** 期望终态;澄清/拒答类按各自目标判定(如 partial) */
  terminal_status: RunStatus
  /** 期望的业务工具序列(规范化后全等比对);无则视为无 gold 工具序列 */
  tool_sequence?: string[]
  /** 按工具名给出必须匹配的参数子集 */
  required_arguments?: Record<string, Record<string, unknown>>
  /** 该案例是否要求确认流程发生 */
  requires_confirmation?: boolean
  /** 禁止执行的工具(注入/越权类) */
  forbidden_tools?: string[]
  /** 状态断言:表行数变化断言(与 fixture 基线比较) */
  state_assertions?: Array<{ table: string; countDelta: number }>
}

/** 预定的回答脚本:事件名 → 决定/回答 */
export interface ScriptStep {
  on: 'confirmation' | 'clarification'
  decision?: 'approved' | 'rejected'
  answer?: string
}

export interface EvalCase {
  schema_version: number
  case_id: string
  dataset_version: string
  mode: RunMode
  category: string
  split: EvalSplit
  input: string
  fixture_id: string
  /** 固定领域时钟(UTC ISO 8601) */
  clock: string
  timezone: string
  expected: EvalExpected
  interaction_script: ScriptStep[]
  budgets: { max_model_calls?: number; max_active_seconds?: number }
  tags: string[]
}

export interface EvalManifest {
  dataset_version: string
  schema_version: number
  /** 数据集内容 hash(cases 文件拼接后的 sha256) */
  cases_sha256: string
  categories: Record<string, { total: number; dev: number; holdout: number }>
  total: number
  /** 数据来源与标注者说明 */
  provenance: string
}

function invalid(message: string): OperationError {
  return new OperationError(appError('VALIDATION', `评测数据集:${message}`, { retryable: false }))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 解析并校验单条案例;形状不合法抛错(加载器按行收集错误) */
export function parseEvalCase(raw: unknown, datasetVersion: string): EvalCase {
  if (!isPlainObject(raw)) throw invalid('案例必须是对象')
  const allowed = new Set([
    'schema_version', 'case_id', 'dataset_version', 'mode', 'category', 'split', 'input',
    'fixture_id', 'clock', 'timezone', 'expected', 'interaction_script', 'budgets', 'tags'
  ])
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw invalid(`案例含未知字段:${key}`)
  }
  if (raw.schema_version !== EVAL_SCHEMA_VERSION) {
    throw invalid(`schema_version 必须是 ${EVAL_SCHEMA_VERSION}`)
  }
  const caseId = raw.case_id
  if (typeof caseId !== 'string' || caseId.trim() === '') throw invalid('缺少 case_id')
  if (raw.dataset_version !== datasetVersion) {
    throw invalid(`案例 ${caseId} 的 dataset_version 与 manifest 不一致`)
  }
  if (!isRunMode(raw.mode)) throw invalid(`案例 ${caseId} mode 非法`)
  if (typeof raw.category !== 'string' || raw.category === '') throw invalid(`案例 ${caseId} 缺少 category`)
  if (raw.split !== 'dev' && raw.split !== 'holdout') throw invalid(`案例 ${caseId} split 非法`)
  if (typeof raw.input !== 'string' || raw.input.trim() === '') throw invalid(`案例 ${caseId} 缺少 input`)
  if (typeof raw.fixture_id !== 'string' || raw.fixture_id === '') throw invalid(`案例 ${caseId} 缺少 fixture_id`)
  if (typeof raw.clock !== 'string' || Number.isNaN(new Date(raw.clock).getTime())) {
    throw invalid(`案例 ${caseId} clock 无效`)
  }
  if (typeof raw.timezone !== 'string' || raw.timezone === '') throw invalid(`案例 ${caseId} 缺少 timezone`)

  const expectedRaw = raw.expected
  if (!isPlainObject(expectedRaw)) throw invalid(`案例 ${caseId} 缺少 expected`)
  if (!isRunStatus(expectedRaw.terminal_status)) throw invalid(`案例 ${caseId} terminal_status 非法`)
  const expected: EvalExpected = { terminal_status: expectedRaw.terminal_status }
  if (expectedRaw.tool_sequence !== undefined) {
    if (
      !Array.isArray(expectedRaw.tool_sequence) ||
      expectedRaw.tool_sequence.some((t) => typeof t !== 'string')
    ) {
      throw invalid(`案例 ${caseId} tool_sequence 必须是字符串数组`)
    }
    expected.tool_sequence = expectedRaw.tool_sequence as string[]
  }
  if (expectedRaw.required_arguments !== undefined) {
    if (!isPlainObject(expectedRaw.required_arguments)) {
      throw invalid(`案例 ${caseId} required_arguments 必须是对象`)
    }
    expected.required_arguments = expectedRaw.required_arguments as Record<string, Record<string, unknown>>
  }
  if (expectedRaw.requires_confirmation !== undefined) {
    if (typeof expectedRaw.requires_confirmation !== 'boolean') {
      throw invalid(`案例 ${caseId} requires_confirmation 必须是布尔`)
    }
    expected.requires_confirmation = expectedRaw.requires_confirmation
  }
  if (expectedRaw.forbidden_tools !== undefined) {
    if (!Array.isArray(expectedRaw.forbidden_tools) || expectedRaw.forbidden_tools.some((t) => typeof t !== 'string')) {
      throw invalid(`案例 ${caseId} forbidden_tools 必须是字符串数组`)
    }
    expected.forbidden_tools = expectedRaw.forbidden_tools as string[]
  }
  if (expectedRaw.state_assertions !== undefined) {
    if (!Array.isArray(expectedRaw.state_assertions)) throw invalid(`案例 ${caseId} state_assertions 必须是数组`)
    expected.state_assertions = expectedRaw.state_assertions as EvalExpected['state_assertions']
  }

  let script: ScriptStep[] = []
  if (raw.interaction_script !== undefined) {
    if (!Array.isArray(raw.interaction_script)) throw invalid(`案例 ${caseId} interaction_script 必须是数组`)
    for (const step of raw.interaction_script as unknown[]) {
      if (!isPlainObject(step)) throw invalid(`案例 ${caseId} interaction_script 步骤必须是对象`)
      if (step.on !== 'confirmation' && step.on !== 'clarification') {
        throw invalid(`案例 ${caseId} interaction_script.on 非法`)
      }
      script.push({ on: step.on, decision: step.decision as ScriptStep['decision'], answer: step.answer as string | undefined })
    }
  }

  const budgets = { max_model_calls: undefined, max_active_seconds: undefined } as EvalCase['budgets']
  if (raw.budgets !== undefined) {
    if (!isPlainObject(raw.budgets)) throw invalid(`案例 ${caseId} budgets 必须是对象`)
    if (raw.budgets.max_model_calls !== undefined) budgets.max_model_calls = raw.budgets.max_model_calls as number
    if (raw.budgets.max_active_seconds !== undefined) budgets.max_active_seconds = raw.budgets.max_active_seconds as number
  }

  const tags = Array.isArray(raw.tags) ? (raw.tags as unknown[]).filter((t): t is string => typeof t === 'string') : []

  return {
    schema_version: EVAL_SCHEMA_VERSION,
    case_id: caseId,
    dataset_version: datasetVersion,
    mode: raw.mode,
    category: raw.category,
    split: raw.split,
    input: raw.input,
    fixture_id: raw.fixture_id,
    clock: raw.clock,
    timezone: raw.timezone,
    expected,
    interaction_script: script,
    budgets,
    tags
  }
}
