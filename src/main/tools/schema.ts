// 工具输入 schema 校验(C-04):严格模式——未知字段、缺失必填、类型不符、
// 枚举越界、数值越界一律拒绝。错误统一为 OperationError(VALIDATION),
// 由 IPC 边界按既有 AppError 形态透传。
//
// stableStringify:对象键排序后的确定性序列化,是参数 hash 的基础——
// 同一组参数无论键序如何必须得到同一 hash,否则批准绑定会误判参数变化。

import { createHash } from 'node:crypto'
import { appError } from '../../shared/operations'
import { OperationError } from '../db/operations'
import type { ToolFieldSpec, ToolInputSchema } from './types'

function invalid(message: string): OperationError {
  return new OperationError(appError('VALIDATION', message, { retryable: false }))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 确定性序列化:键排序、数组保序;undefined 归为 null */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const entries = Object.keys(value)
    .sort()
    .map((key) => JSON.stringify(key) + ':' + stableStringify((value as Record<string, unknown>)[key]))
  return '{' + entries.join(',') + '}'
}

/** 参数 hash:sha256(stableStringify(args));批准绑定与幂等回执共用 */
export function argumentsHash(args: unknown): string {
  return createHash('sha256').update(stableStringify(args)).digest('hex')
}

function checkField(spec: ToolFieldSpec, value: unknown): unknown {
  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') throw invalid(`字段 ${spec.name} 必须是字符串`)
      if (spec.enum && !spec.enum.includes(value)) {
        throw invalid(`字段 ${spec.name} 必须是 ${spec.enum.map((v) => `'${v}'`).join(' / ')} 之一`)
      }
      return value
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw invalid(`字段 ${spec.name} 必须是有限数字`)
      }
      if (spec.min !== undefined && value < spec.min) {
        throw invalid(`字段 ${spec.name} 不能小于 ${spec.min}`)
      }
      if (spec.max !== undefined && value > spec.max) {
        throw invalid(`字段 ${spec.name} 不能大于 ${spec.max}`)
      }
      return value
    }
    case 'boolean': {
      if (typeof value !== 'boolean') throw invalid(`字段 ${spec.name} 必须是布尔值`)
      return value
    }
  }
}

/**
 * 严格校验并归一化工具输入:只保留 schema 声明的字段,
 * 返回浅拷贝(调用方拿到的是干净参数,不是原始引用)。
 */
export function validateToolInput(schema: ToolInputSchema, input: unknown): Record<string, unknown> {
  if (!isPlainObject(input)) throw invalid('工具参数必须是对象')
  const known = new Set(schema.fields.map((f) => f.name))
  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw invalid(`未知字段:${key}`)
  }
  const out: Record<string, unknown> = {}
  for (const spec of schema.fields) {
    const value = input[spec.name]
    if (value === undefined) {
      if (spec.required) throw invalid(`缺少必填字段:${spec.name}`)
      continue
    }
    out[spec.name] = checkField(spec, value)
  }
  return out
}
