// 记录范围(RES-02;recordScope.ts):多记录文件(JSON 数组/CSV 多行)在整文件
// 规范全文坐标系内的记录级范围验证、范围内分块与逻辑 gold 定位。
//
// 坐标系契约:full-file-codepoint-v1 —— offset 是整文件规范化全文的 Unicode 码点
// 索引(零起点、左闭右开),与 Array.from(normalized_text) 切片对齐;
// NORMALIZATION_VERSION=1 与 gold research-eval.v1 坐标保持不变。
//
// 关键约束:
// - 范围只能由导入期的码点累计产生(与投影同序遍历),禁止通过 indexOf 文本猜边界;
// - chunkRecord 只对记录范围内切片分块,再把局部 offset 加 scope.startOffset,
//   FTS 只索引这些范围内块;chunk/邻块/span 一律不得跨记录端点;
// - 旧多记录来源无范围时必须拒绝执行([RECORD_SCOPE_REQUIRED]),不能从扁平全文猜边界;
// - resolveLogicalGoldSpan 先核 text_sha256,再用完整 [start,end) 选唯一包含范围
//   的记录;空匹配、跨边界或多匹配明确失败,quote 重复不改变定位。

import { appError } from '../../shared/operations'
import { OperationError } from '../db/operations'
import { chunkText, type TextChunk } from '../retrieval/chunker'

/** 记录范围:整文件规范全文码点坐标系内的一条记录(v1) */
export interface RecordScope {
  version: 1
  coordinateSystem: 'full-file-codepoint-v1'
  sourceLocator: string | null
  startOffset: number
  endOffset: number
}

/** 带范围的快照引用:逻辑 gold 定位与冻结清单复核的最小形态 */
export interface ScopedSnapshot {
  documentId: string
  scope: RecordScope
  textSha256: string
}

function scopeInvalid(message: string): OperationError {
  return new OperationError(appError('VALIDATION', `记录范围非法:${message}`, { retryable: false }))
}

/**
 * 验证未信 record_scope 载荷(导入元数据/冻结清单/库读取方向):形状、坐标系、
 * 整数边界与全文码点长度越界逐项拒绝;通过后返回定型范围。
 */
export function validateRecordScope(raw: unknown, fullTextCodePointLength: number): RecordScope {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw scopeInvalid('必须是对象')
  }
  const obj = raw as Record<string, unknown>
  const allowed = new Set(['version', 'coordinateSystem', 'sourceLocator', 'startOffset', 'endOffset'])
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw scopeInvalid(`含未知字段:${key}`)
  }
  if (obj.version !== 1) throw scopeInvalid(`version 仅接受 1,收到 ${String(obj.version)}`)
  if (obj.coordinateSystem !== 'full-file-codepoint-v1') {
    throw scopeInvalid(`coordinateSystem 仅接受 'full-file-codepoint-v1',收到 ${String(obj.coordinateSystem)}`)
  }
  if (obj.sourceLocator !== null && typeof obj.sourceLocator !== 'string') {
    throw scopeInvalid('sourceLocator 必须是字符串或 null')
  }
  const startOffset = obj.startOffset
  const endOffset = obj.endOffset
  if (typeof startOffset !== 'number' || !Number.isInteger(startOffset) || startOffset < 0) {
    throw scopeInvalid(`startOffset 必须是不小于 0 的整数,收到 ${String(startOffset)}`)
  }
  if (typeof endOffset !== 'number' || !Number.isInteger(endOffset) || endOffset < 0) {
    throw scopeInvalid(`endOffset 必须是不小于 0 的整数,收到 ${String(endOffset)}`)
  }
  if (startOffset >= endOffset) {
    throw scopeInvalid(`范围颠倒或为空:[${String(startOffset)},${String(endOffset)})`)
  }
  if (endOffset > fullTextCodePointLength) {
    throw scopeInvalid(`endOffset ${String(endOffset)} 超出全文码点长度 ${fullTextCodePointLength}`)
  }
  return {
    version: 1,
    coordinateSystem: 'full-file-codepoint-v1',
    sourceLocator: obj.sourceLocator,
    startOffset,
    endOffset
  }
}

/**
 * 范围内分块:只对 Array.from(normalizedText).slice(scope.startOffset, scope.endOffset)
 * 切片分块,再把局部 offset 加 scope.startOffset —— 块内容与全文件对应切片逐字一致,
 * 所有块、邻块、span 均不会跨记录端点。
 */
export function chunkRecord(normalizedText: string, scope: RecordScope): TextChunk[] {
  const slice = Array.from(normalizedText).slice(scope.startOffset, scope.endOffset).join('')
  return chunkText(slice).map((chunk) => ({
    index: chunk.index,
    startOffset: chunk.startOffset + scope.startOffset,
    endOffset: chunk.endOffset + scope.startOffset,
    content: chunk.content
  }))
}

/**
 * 逻辑 gold 定位:同一逻辑文件(多记录共享整文件规范全文)的记录清单中,
 * 选出唯一包含完整 [start,end) 范围的记录。先核 text_sha256(全部记录必须
 * 共享同一逻辑文件的 hash);空匹配、跨边界、多匹配抛 [GOLD_SPAN_UNRESOLVABLE],
 * quote 重复不改变定位(gold 的 span→记录映射只用于判分,不选择运行输入)。
 */
export function resolveLogicalGoldSpan(
  records: readonly ScopedSnapshot[],
  span: { startOffset: number; endOffset: number }
): ScopedSnapshot {
  const unresolvable = (reason: string): OperationError =>
    new OperationError(
      appError('VALIDATION', `[GOLD_SPAN_UNRESOLVABLE] gold span [${span.startOffset},${span.endOffset}) 无法唯一映射到记录:${reason}`, { retryable: false })
    )
  if (records.length === 0) throw unresolvable('记录清单为空')
  const hashes = new Set(records.map((r) => r.textSha256))
  if (hashes.size !== 1) {
    throw unresolvable('记录间 text_sha256 不一致,不属于同一逻辑文件')
  }
  const containing = records.filter(
    (r) => r.scope.startOffset <= span.startOffset && span.endOffset <= r.scope.endOffset
  )
  if (containing.length === 0) {
    throw unresolvable('无记录包含该完整范围(越界或跨记录边界)')
  }
  if (containing.length > 1) {
    throw unresolvable(`${containing.length} 条记录同时包含该范围(范围重叠)`)
  }
  return containing[0]!
}
