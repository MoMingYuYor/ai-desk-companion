// 材料接收与解析:文本、文件、图片;PDF 尽力提取文本
import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { MaterialType } from '../../shared/types'

export interface ParsedFile {
  name: string
  type: MaterialType
  mime?: string
  size?: number
  content?: string
  path?: string
  parseError?: string
}

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.log'])
const IMAGE_EXTS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}
const MAX_TEXT_BYTES = 2 * 1024 * 1024

export function fileToDataUrl(path: string): string | null {
  try {
    const ext = extname(path).toLowerCase()
    const mime = IMAGE_EXTS[ext]
    if (!mime) return null
    const b = readFileSync(path)
    return `data:${mime};base64,${b.toString('base64')}`
  } catch {
    return null
  }
}

export async function parseLocalFile(filePath: string): Promise<ParsedFile> {
  const name = basename(filePath)
  const ext = extname(filePath).toLowerCase()
  let size: number | undefined
  try {
    size = statSync(filePath).size
  } catch {
    return { name, type: 'file', parseError: '文件不存在或无法读取' }
  }

  if (TEXT_EXTS.has(ext)) {
    try {
      const content = readFileSync(filePath, 'utf-8')
      return { name, type: 'file', size, content: truncate(content) }
    } catch (err) {
      return { name, type: 'file', size, parseError: '读取文本失败:' + String(err) }
    }
  }

  if (IMAGE_EXTS[ext]) {
    return { name, type: 'image', mime: IMAGE_EXTS[ext], size, path: filePath }
  }

  if (ext === '.pdf') {
    const r = await extractPdfText(filePath)
    return r.content
      ? { name, type: 'file', mime: 'application/pdf', size, content: r.content }
      : { name, type: 'file', mime: 'application/pdf', size, path: filePath, parseError: r.error }
  }

  // 其他类型:尝试按文本读取
  try {
    const content = readFileSync(filePath, 'utf-8')
    if (content && hasPrintableRatio(content)) {
      return { name, type: 'file', size, content: truncate(content) }
    }
  } catch {
    /* ignore */
  }
  return {
    name,
    type: 'file',
    size,
    parseError: `暂不支持直接读取 ${ext || '该类型'} 文件,请将内容复制为文本后粘贴提交`
  }
}

/** PDF 文本提取(动态加载,失败不致命) */
export async function extractPdfText(filePath: string): Promise<{ content?: string; error?: string }> {
  try {
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
      getDocument: (src: { data: Uint8Array; useSystemFonts?: boolean }) => {
        promise: Promise<{
          numPages: number
          getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: Array<{ str?: string }> }> }>
        }>
      }
    }
    const data = new Uint8Array(readFileSync(filePath))
    const doc = await pdfjs.getDocument({ data, useSystemFonts: false }).promise
    const maxPages = Math.min(doc.numPages, 30)
    const parts: string[] = []
    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      const text = tc.items.map((it) => it.str ?? '').join(' ')
      parts.push(`--- 第${i}页 ---\n${text}`)
    }
    const content = parts.join('\n').trim()
    if (!content) {
      return { error: 'PDF 中没有可提取的文本(可能是扫描件)。请将关键页截图后以图片提交。' }
    }
    return { content: truncate(content) + (doc.numPages > maxPages ? `\n(仅提取前 ${maxPages} 页,共 ${doc.numPages} 页)` : '') }
  } catch (err) {
    return { error: 'PDF 解析失败:' + String(err) }
  }
}

function hasPrintableRatio(s: string): boolean {
  const printable = s.replace(/[^\x20-\x7E\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\n\r\t]/g, '')
  return s.length === 0 || printable.length / s.length > 0.7
}

function truncate(s: string): string {
  return s.length > 200_000 ? s.slice(0, 200_000) + '\n…(内容过长已截断)' : s
}
