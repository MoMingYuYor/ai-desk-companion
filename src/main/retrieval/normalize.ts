// 检索导入的解码与规范化(C-05)。
//
// 规范化 v1 顺序(总体规格第 5 节):识别编码 → 解码 → 移除起始 BOM →
// CRLF/CR 转 LF → Unicode NFC。保留正文空格与标点,不全局压缩空白、不做 NFKC。
// 无法可靠识别/解码的输入明确报错,不用替换字符悄悄导入。

import { createHash } from 'node:crypto'
import { appError } from '../../shared/operations'
import { OperationError } from '../db/operations'

export const NORMALIZATION_VERSION = 1

export type DecodedEncoding = 'utf-8' | 'utf-16le' | 'utf-16be'

export interface DecodedText {
  text: string
  encoding: DecodedEncoding
  /** 原始字节的 sha256(规范化之前) */
  rawSha256: string
}

function parseError(message: string): OperationError {
  return new OperationError(appError('VALIDATION', message, { retryable: false }))
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function decodeUtf8Strict(bytes: Buffer): string {
  try {
    // fatal:true——无效字节直接失败,不用 U+FFFD 悄悄替换
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw parseError('文件不是有效的 UTF-8 编码;请转换编码后重新导入,或改用支持的编码')
  }
}

function decodeUtf16(bytes: Buffer, byteOrder: 'le' | 'be'): string {
  if (bytes.length % 2 !== 0) throw parseError('UTF-16 文件长度必须为偶数字节')
  let payload = bytes
  if (byteOrder === 'be') {
    // Node 的 TextDecoder('utf-16be') 依赖 ICU;逐字节交换后按 le 解码,行为确定
    payload = Buffer.from(bytes)
    for (let i = 0; i + 1 < payload.length; i += 2) {
      const tmp = payload[i]!
      payload[i] = payload[i + 1]!
      payload[i + 1] = tmp
    }
  }
  return new TextDecoder('utf-16le').decode(payload)
}

/**
 * 解码导入字节:BOM 显式识别 UTF-8 / UTF-16LE / UTF-16BE;
 * 无 BOM 一律按 UTF-8 严格解码(无效字节报错)。
 */
export function decodeBytes(bytes: Buffer): DecodedText {
  const rawSha256 = sha256Hex(bytes)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: decodeUtf8Strict(bytes.subarray(3)), encoding: 'utf-8', rawSha256 }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decodeUtf16(bytes.subarray(2), 'le'), encoding: 'utf-16le', rawSha256 }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decodeUtf16(bytes.subarray(2), 'be'), encoding: 'utf-16be', rawSha256 }
  }
  return { text: decodeUtf8Strict(bytes), encoding: 'utf-8', rawSha256 }
}

/** 文本规范化:CRLF/CR → LF、NFC;残留 BOM 字符移除。保留空格与标点 */
export function normalizePlainText(text: string): string {
  let out = text
  if (out.startsWith('\uFEFF')) out = out.slice(1)
  out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return out.normalize('NFC')
}

/** 规范全文的 sha256(UTF-8 字节) */
export function textSha256(text: string): string {
  return sha256Hex(Buffer.from(text, 'utf8'))
}

// ---------- JSON 投影 ----------
//
// C-05 基线:对 JSON 做确定顺序的通用文本投影(对象键排序、数组保序、
// 字符串叶子原样、数值与布尔转文本)。岗位 JD 的固定字段映射
// (title/company/description 等)属 R-02 的研究侧职责,不在本层。

function projectJson(value: unknown, out: string[]): void {
  if (value === null || value === undefined) return
  if (typeof value === 'string') {
    if (value.trim() !== '') out.push(value)
    return
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value))
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) projectJson(item, out)
    return
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value).sort()) {
      projectJson((value as Record<string, unknown>)[key], out)
    }
  }
}

/** JSON 源 → 确定顺序的字段文本;顶层必须是对象或数组 */
export function projectJsonSource(text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw parseError('JSON 解析失败:文件不是合法的 JSON')
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw parseError('JSON 顶层必须是对象或数组')
  }
  const out: string[] = []
  projectJson(parsed, out)
  return out.join('\n')
}
