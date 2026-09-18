// 材料接收与解析:文本、图片、PDF(版面文本/扫描件内嵌图)、Excel、Word;能解析的都交给 AI
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import zlib from 'node:zlib'
import * as XLSX from 'xlsx'
import type { MaterialType } from '../../shared/types'

export interface ParsedFile {
  name: string
  type: MaterialType
  mime?: string
  size?: number
  content?: string
  path?: string
  parseError?: string
  /** 扫描版 PDF 中提取出的其余页面图片(第一张在 path) */
  extraImagePaths?: string[]
}

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.log'])
const SPREADSHEET_EXTS = new Set(['.xlsx', '.xls', '.xlsm', '.ods'])
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
    const r = await extractPdfContent(filePath)
    if (r.text?.trim()) {
      return { name, type: 'file', mime: 'application/pdf', size, content: truncate(r.text.trim()) }
    }
    // 扫描版 PDF:页面就是一张大图,直接提取内嵌扫描图交给视觉模型(纯 JS,无渲染崩溃风险)
    const images = extractEmbeddedImages(filePath)
    if (images.length > 0) {
      return {
        name,
        type: 'image',
        mime: images[0].mime,
        size,
        path: images[0].path,
        extraImagePaths: images.slice(1).map((img) => img.path)
      }
    }
    return {
      name,
      type: 'file',
      mime: 'application/pdf',
      size,
      path: filePath,
      parseError: r.error ?? 'PDF 中没有可提取的内容'
    }
  }

  if (ext === '.docx') {
    const r = await extractDocxText(filePath)
    return r.content
      ? { name, type: 'file', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size, content: r.content }
      : { name, type: 'file', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size, parseError: r.error }
  }

  if (ext === '.doc') {
    const r = await extractDocText(filePath)
    return r.content
      ? { name, type: 'file', mime: 'application/msword', size, content: r.content }
      : { name, type: 'file', mime: 'application/msword', size, parseError: r.error }
  }

  if (SPREADSHEET_EXTS.has(ext)) {
    // 教务系统导出的课表多为 Excel;用 SheetJS 转成可读表格文本交给模型
    const r = extractSpreadsheetText(filePath)
    return r.content
      ? { name, type: 'file', mime: 'application/vnd.ms-excel', size, content: r.content }
      : { name, type: 'file', mime: 'application/vnd.ms-excel', size, parseError: r.error }
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
    parseError: `暂不支持读取 ${ext || '该类型'} 文件。当前支持:图片、PDF、Word(.docx/.doc)、Excel(.xlsx/.xls)、文本/CSV/Markdown;也可以直接把内容复制为文本粘贴提交。`
  }
}

// ---------- Word 文档 ----------

async function extractDocxText(filePath: string): Promise<{ content?: string; error?: string }> {
  try {
    const mammoth = (await import('mammoth')) as unknown as {
      convertToHtml: (input: { path: string }) => Promise<{ value: string }>
    }
    const { value: html } = await mammoth.convertToHtml({ path: filePath })
    // 表格结构转为列分隔文本,与 PDF/Excel 的输出风格一致
    const text = html
      .replace(/<\/p>\s*<\/(td|th)>/gi, ' | ')
      .replace(/<\/(td|th)>/gi, ' | ')
      .replace(/<\/(tr|p|div|h[1-6]|li)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .split('\n')
      .map((line) => line.replace(/\s*\|\s*$/, '').trim())
      .filter(Boolean)
      .join('\n')
    if (!text.trim()) return { error: 'Word 文档中没有可提取的文本' }
    return { content: truncate(text) }
  } catch (err) {
    return { error: 'Word(.docx)解析失败:' + String(err) }
  }
}

async function extractDocText(filePath: string): Promise<{ content?: string; error?: string }> {
  try {
    const mod = (await import('word-extractor')) as unknown as {
      default: new () => { extract: (p: string) => Promise<{ getBody: () => string }> }
    }
    const extractor = new mod.default()
    const doc = await extractor.extract(filePath)
    const text = (doc.getBody() ?? '').replace(/\r\n/g, '\n').trim()
    if (!text) return { error: 'Word 文档中没有可提取的文本' }
    return { content: truncate(text) }
  } catch (err) {
    return { error: 'Word(.doc)解析失败:' + String(err) }
  }
}

// ---------- 扫描版 PDF:提取内嵌图片 ----------

interface ExtractedImage {
  path: string
  mime: string
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 最小 PNG 编码器:把 PDF 中解出的原始位图(RGB/灰度)包装成 PNG 供视觉模型识别 */
function encodePng(width: number, height: number, channels: 1 | 3, raw: Buffer): Buffer {
  const stride = width * channels
  const scanned = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw.copy(scanned, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = channels === 3 ? 2 : 0 // RGB / gray
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(scanned)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * 从 PDF 二进制中提取内嵌图片 XObject(扫描件每页一张大图):
 * - /DCTDecode(JPEG,扫描件最常见):字节原样透出
 * - /FlateDecode 位图(RGB/灰度):解压后重打包为 PNG
 * 按像素量降序取前 maxImages,自动过滤图标/印章类小图。
 */
export function extractEmbeddedImages(filePath: string, maxImages = 5): ExtractedImage[] {
  let buf: Buffer
  try {
    buf = readFileSync(filePath)
  } catch {
    return []
  }
  const found: Array<{ mime: string; bytes: Buffer; pixels: number }> = []
  let pos = 0
  while (pos < buf.length) {
    const sub = buf.indexOf('/Subtype', pos)
    if (sub < 0 || resultsDone(found, maxImages)) break
    let p = skipSpace(buf, sub + 8)
    if (buf.subarray(p, p + 6).toString('latin1') !== '/Image') {
      pos = sub + 8
      continue
    }
    const dictStart = buf.lastIndexOf('<<', sub)
    const streamMark = buf.indexOf(Buffer.from('stream', 'latin1'), p)
    if (dictStart < 0 || streamMark < 0) break
    const dict = buf.subarray(dictStart, streamMark).toString('latin1')
    const width = dictNum(dict, '/Width')
    const height = dictNum(dict, '/Height')
    const bits = dictNum(dict, '/BitsPerComponent') ?? 8
    let dataStart = streamMark + 6
    if (buf[dataStart] === 0x0d) dataStart++
    if (buf[dataStart] === 0x0a) dataStart++
    const dataEnd = buf.indexOf(Buffer.from('endstream', 'latin1'), dataStart)
    if (dataEnd < 0) break
    let data = buf.subarray(dataStart, dataEnd)
    while (data.length > 0 && (data[data.length - 1] === 0x0a || data[data.length - 1] === 0x0d)) {
      data = data.subarray(0, data.length - 1)
    }
    pos = dataEnd + 9

    if (!width || !height || width * height < 100 * 100) continue // 过滤图标/装饰小图
    const isJpeg = dict.includes('/DCTDecode') || (data[0] === 0xff && data[1] === 0xd8)
    if (isJpeg) {
      found.push({ mime: 'image/jpeg', bytes: Buffer.from(data), pixels: width * height })
      continue
    }
    if (dict.includes('/FlateDecode') && bits === 8) {
      const channels = dict.includes('/DeviceGray') ? 1 : 3
      try {
        const raw = zlib.inflateSync(data)
        const expected = width * height * channels
        if (raw.length >= expected) {
          found.push({
            mime: 'image/png',
            bytes: encodePng(width, height, channels as 1 | 3, raw.subarray(0, expected)),
            pixels: width * height
          })
        }
      } catch {
        // 解压失败:跳过该图
      }
    }
  }

  const top = found.sort((a, b) => b.pixels - a.pixels).slice(0, maxImages)
  if (top.length === 0) return []
  const dir = mkdtempSync(join(tmpdir(), 'pdf-scan-'))
  return top.map((img, i) => {
    const ext = img.mime === 'image/jpeg' ? '.jpg' : '.png'
    const path = join(dir, `page-${i + 1}${ext}`)
    writeFileSync(path, img.bytes)
    return { path, mime: img.mime }
  })
}

/** 默认保留 7 天:近期会话仍可能引用提取出的页面图片路径 */
const PDF_TEMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 清理扫描件提取(extractEmbeddedImages)遗留在系统临时目录的 pdf-scan- 前缀目录:
 * 只删除 mtime 超过 maxAgeMs 且匹配前缀的目录,不碰临时目录里的其他内容。
 */
export function sweepStalePdfTemp(maxAgeMs = PDF_TEMP_MAX_AGE_MS): void {
  let entries: string[]
  try {
    entries = readdirSync(tmpdir())
  } catch {
    return // 临时目录不可读时静默跳过,清理失败不影响主流程
  }
  const now = Date.now()
  for (const name of entries) {
    if (!name.startsWith('pdf-scan-')) continue
    const dir = join(tmpdir(), name)
    try {
      const st = statSync(dir)
      if (st.isDirectory() && now - st.mtimeMs > maxAgeMs) {
        rmSync(dir, { recursive: true, force: true })
      }
    } catch {
      // 单个目录清理失败(被占用等)不影响其余目录
    }
  }
}

function skipSpace(buf: Buffer, from: number): number {
  let p = from
  while (p < buf.length && (buf[p] === 0x20 || buf[p] === 0x0a || buf[p] === 0x0d || buf[p] === 0x09)) p++
  return p
}

function dictNum(dict: string, key: string): number | null {
  const m = new RegExp(`${key.replace('/', '\\/')}\\s+(\\d+)`).exec(dict)
  return m ? Number(m[1]) : null
}

function resultsDone(found: Array<{ mime: string }>, maxImages: number): boolean {
  return found.length >= maxImages * 3 // 多收集一些候选,最后按大小挑选
}

/** 把 PDF 文本项按 y 坐标聚类成行、x 坐标排序成列,还原表格版面(空格列距用 | 分隔) */
export function layoutText(items: PdfTextItem[]): string {
  const entries = items
    .filter(
      (it): it is { str: string; transform: number[]; width: number } =>
        typeof it.str === 'string' && it.str.trim() !== '' && Array.isArray(it.transform)
    )
    .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width ?? 0 }))
  if (entries.length === 0) return ''

  // PDF 坐标系 y 向上:按 y 降序聚类行(容差 3pt)
  const TOL = 3
  const sorted = [...entries].sort((a, b) => b.y - a.y)
  const rows: Array<typeof sorted> = []
  for (const e of sorted) {
    const row = rows.find((r) => Math.abs(r[0].y - e.y) <= TOL)
    if (row) row.push(e)
    else rows.push([e])
  }

  return rows
    .map((row) => {
      row.sort((a, b) => a.x - b.x)
      let line = ''
      let prevEnd = -Infinity
      for (const cell of row) {
        if (line !== '') {
          // 列间距大于 10pt 视为不同表格列
          line += cell.x - prevEnd > 10 ? ' | ' : ' '
        }
        line += cell.str.trim()
        prevEnd = cell.x + cell.w
      }
      return line
    })
    .join('\n')
}

interface PdfTextItem {
  str?: string
  transform?: number[]
  width?: number
}

interface PdfjsModule {
  getDocument: (src: Record<string, unknown>) => {
    promise: Promise<{
      numPages: number
      getPage: (n: number) => Promise<{
        getTextContent: () => Promise<{ items: PdfTextItem[] }>
      }>
    }>
  }
}

export interface PdfExtractResult {
  text?: string
  pageCount?: number
  error?: string
}

/** pdfjs 的 cMap/标准字体目录:开发态取 node_modules,打包态取 resources;结尾必须带分隔符(pdfjs 直接拼接) */
function pdfjsAssetDir(name: 'cmaps' | 'standard_fonts'): string | undefined {
  const candidates = [join(process.cwd(), 'node_modules', 'pdfjs-dist', name)]
  if (process.resourcesPath) candidates.push(join(process.resourcesPath, name))
  for (const dir of candidates) {
    try {
      if (statSync(dir).isDirectory()) return dir.replace(/\\/g, '/').replace(/\/?$/, '/')
    } catch {
      // 尝试下一个候选路径
    }
  }
  return undefined
}

/**
 * PDF 文本提取:按版面还原行列结构(课表等表格的可读性关键)。
 * 中文 CID 字体依赖 cMaps;扫描件没有文本,返回指引错误(用户可截图后以图片提交,走视觉模型)。
 */
export async function extractPdfContent(filePath: string): Promise<PdfExtractResult> {
  try {
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsModule
    const data = new Uint8Array(readFileSync(filePath))
    const cMapUrl = pdfjsAssetDir('cmaps')
    const standardFontDataUrl = pdfjsAssetDir('standard_fonts')
    const doc = await pdfjs.getDocument({
      data,
      useSystemFonts: false,
      ...(cMapUrl ? { cMapUrl, cMapPacked: true } : {}),
      ...(standardFontDataUrl ? { standardFontDataUrl } : {})
    }).promise
    const pageCount = doc.numPages
    const maxPages = Math.min(pageCount, 30)
    const parts: string[] = []
    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      const pageText = layoutText(tc.items)
      // 无文本的页面不生成标记,避免"只有页码标记"被误判为有内容
      if (pageText.trim()) parts.push(`--- 第${i}页 ---\n${pageText}`)
    }
    const text = parts.join('\n\n').trim()
    if (!text || !hasPrintableRatio(text)) {
      return {
        error:
          'PDF 中没有可提取的文本(可能是扫描件或纯图片)。请把课表页截图后直接拖入,图片可由视觉模型识别。'
      }
    }
    const suffix = pageCount > 30 ? `\n(仅提取前 30 页,共 ${pageCount} 页)` : ''
    return { text: text + suffix, pageCount }
  } catch (err) {
    return { error: 'PDF 解析失败:' + String(err) }
  }
}

/** Excel/xls/ods 表格提取:每个工作表转成管道分隔的网格文本,便于模型按行列读课表 */
export function extractSpreadsheetText(filePath: string): { content?: string; error?: string } {
  try {
    const wb = XLSX.read(readFileSync(filePath), { type: 'buffer' })
    const parts: string[] = []
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName]
      if (!ws) continue
      const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false, FS: ' | ' })
      // 丢弃全空单元格行(空表会输出纯分隔符行)
      const lines = csv.split(/\r?\n/).filter((line) => line.split('|').some((cell) => cell.trim() !== ''))
      if (lines.length > 0) parts.push(`--- 工作表:${sheetName} ---\n${lines.join('\n')}`)
    }
    const content = parts.join('\n\n').trim()
    if (!content) return { error: '表格中没有可提取的内容(全部工作表为空)' }
    return { content: truncate(content) }
  } catch (err) {
    return { error: '表格解析失败:' + String(err) }
  }
}

function hasPrintableRatio(s: string): boolean {
  const printable = s.replace(/[^\x20-\x7E\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\n\r\t]/g, '')
  return s.length === 0 || printable.length / s.length > 0.7
}

function truncate(s: string): string {
  return s.length > 200_000 ? s.slice(0, 200_000) + '\n…(内容过长已截断)' : s
}
