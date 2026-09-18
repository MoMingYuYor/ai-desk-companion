import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { extractEmbeddedImages, parseLocalFile } from '../src/main/services/materials'

/** 组装最小合法 PDF(自动计算 xref 偏移);支持二进制安全的流内容 */
function buildPdf(contentStream: string, extraObjects: string[] = []): Buffer {
  const objects: string[] = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objects[3] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 6 0 R >> >> >>'
  objects[4] = `<< /Length ${Buffer.byteLength(contentStream, 'latin1')} >>\nstream\n${contentStream}\nendstream`
  extraObjects.forEach((body, i) => {
    objects[6 + i] = body
  })
  const total = objects.length - 1
  const chunks: Buffer[] = []
  let offset = 0
  const offsets: number[] = [0]
  const push = (s: string): void => {
    const buf = Buffer.from(s, 'latin1')
    chunks.push(buf)
    offset += buf.length
  }
  push('%PDF-1.4\n')
  for (let i = 1; i <= total; i++) {
    offsets[i] = offset
    push(`${i} 0 obj\n${objects[i]}\nendobj\n`)
  }
  const xrefStart = offset
  push(`xref\n0 ${total + 1}\n0000000000 65535 f \n`)
  for (let i = 1; i <= total; i++) {
    push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`)
  }
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`)
  return Buffer.concat(chunks)
}

function imageXObject(width: number, height: number, filter: string, data: Buffer, colorSpace: string): string {
  return `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter ${filter} /Length ${data.length} >>\nstream\n${data.toString(
    'latin1'
  )}\nendstream`
}

/** 手写 ZIP(stored 方式),用于构造 docx 测试文件 */
function buildZip(entries: Array<{ name: string; content: string }>): Buffer {
  const crc32 = (data: Buffer): number => zlib.crc32 ? zlib.crc32(data) : 0
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const data = Buffer.from(entry.content, 'utf8')
    const name = Buffer.from(entry.name, 'utf8')
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0, 8)
    header.writeUInt32LE(crc32(data), 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(name.length, 26)
    locals.push(header, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += 30 + name.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

function writeDocx(bodyXml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'docx-test-'))
  const p = join(dir, '课表.docx')
  writeFileSync(
    p,
    buildZip([
      {
        name: '[Content_Types].xml',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
      },
      {
        name: '_rels/.rels',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
      },
      {
        name: 'word/document.xml',
        content:
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`
      }
    ])
  )
  return p
}

describe('扫描版 PDF:提取内嵌图片', () => {
  it('FlateDecode 扫描位图被解出并重打包为 PNG', async () => {
    const width = 200
    const height = 150
    const raw = Buffer.alloc(width * height * 3, 0x80)
    const deflateBytes = zlib.deflateSync(raw)
    const content = 'q 400 0 0 300 50 50 cm /Im1 Do Q'
    const dir = mkdtempSync(join(tmpdir(), 'scan-pdf-'))
    const p = join(dir, 'scan.pdf')
    writeFileSync(
      p,
      buildPdf(content, [imageXObject(width, height, '/FlateDecode', deflateBytes, '/DeviceRGB')])
    )

    const parsed = await parseLocalFile(p)
    expect(parsed.parseError).toBeUndefined()
    expect(parsed.type).toBe('image')
    expect(parsed.path).toContain('.png')
    expect(existsSync(parsed.path ?? '')).toBe(true)
    expect(readFileSync(parsed.path ?? '').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  it('DCTDecode(JPEG)扫描图原样透出', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096, 0x7f)])
    const dir = mkdtempSync(join(tmpdir(), 'scan-pdf-'))
    const p = join(dir, 'photo.pdf')
    writeFileSync(p, buildPdf('q 400 0 0 300 50 50 cm /Im1 Do Q', [imageXObject(300, 400, '/DCTDecode', jpeg, '/DeviceRGB')]))

    const images = extractEmbeddedImages(p)
    expect(images).toHaveLength(1)
    expect(images[0].mime).toBe('image/jpeg')
    expect(images[0].path.endsWith('.jpg')).toBe(true)
    expect(readFileSync(images[0].path).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
  })

  it('小图(图标/印章)被过滤,纯装饰 PDF 回退到清晰指引', async () => {
    const raw = Buffer.alloc(50 * 50 * 3, 0x10)
    const dir = mkdtempSync(join(tmpdir(), 'scan-pdf-'))
    const p = join(dir, 'tiny.pdf')
    writeFileSync(p, buildPdf('q 40 0 0 40 5 5 cm /Im1 Do Q', [imageXObject(50, 50, '/FlateDecode', zlib.deflateSync(raw), '/DeviceRGB')]))

    expect(extractEmbeddedImages(p)).toHaveLength(0)
    const parsed = await parseLocalFile(p)
    expect(parsed.parseError ?? '').toContain('扫描件')
  })
})

describe('Word 文档解析', () => {
  it('docx 课表:段落与表格转成行列分隔文本', async () => {
    const p = writeDocx(
      '<w:p><w:r><w:t>2026 秋季课表</w:t></w:r></w:p>' +
        '<w:tbl><w:tr>' +
        '<w:tc><w:p><w:r><w:t>课程</w:t></w:r></w:p></w:tc>' +
        '<w:tc><w:p><w:r><w:t>时间</w:t></w:r></w:p></w:tc>' +
        '</w:tr><w:tr>' +
        '<w:tc><w:p><w:r><w:t>高等数学</w:t></w:r></w:p></w:tc>' +
        '<w:tc><w:p><w:r><w:t>周一 08:00-09:35</w:t></w:r></w:p></w:tc>' +
        '</w:tr></w:tbl>'
    )
    const parsed = await parseLocalFile(p)
    expect(parsed.parseError).toBeUndefined()
    expect(parsed.content).toContain('2026 秋季课表')
    expect(parsed.content).toContain('高等数学')
    expect(parsed.content).toContain('课程 | 时间')
    expect(parsed.content).toContain('高等数学 | 周一 08:00-09:35')
  })

  it('损坏的 docx 给出可诊断错误', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'docx-test-'))
    const p = join(dir, 'broken.docx')
    writeFileSync(p, Buffer.from('这不是zip'))
    const parsed = await parseLocalFile(p)
    expect(parsed.parseError ?? '').toContain('解析失败')
  })
})
