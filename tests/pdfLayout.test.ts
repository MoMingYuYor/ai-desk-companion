import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractPdfContent, layoutText, parseLocalFile } from '../src/main/services/materials'

/** 组装最小合法 PDF(自动计算 xref 偏移) */
function buildPdf(contentStream: string, extraObjects: string[] = [], contentObjIndex = 4): Buffer {
  const objects: string[] = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objects[3] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> >>'
  objects[4] = `<< /Length ${Buffer.byteLength(contentStream, 'latin1')} >>\nstream\n${contentStream}\nendstream`
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
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

describe('PDF 版面还原(纯函数)', () => {
  it('按 y 聚类成行、x 排序成列,列间距用 | 分隔', () => {
    const out = layoutText([
      { str: 'Math 08:00', transform: [1, 0, 0, 1, 150, 700], width: 60 },
      { str: 'Monday', transform: [1, 0, 0, 1, 50, 700], width: 40 },
      { str: 'Tuesday', transform: [1, 0, 0, 1, 50, 680], width: 45 },
      { str: 'English 10:00', transform: [1, 0, 0, 1, 150, 680], width: 65 }
    ])
    const lines = out.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('Monday | Math 08:00')
    expect(lines[1]).toBe('Tuesday | English 10:00')
  })

  it('同一单元格内的小间距用空格而非列分隔', () => {
    const out = layoutText([
      { str: '高等', transform: [1, 0, 0, 1, 50, 700], width: 24 },
      { str: '数学', transform: [1, 0, 0, 1, 76, 700], width: 24 }
    ])
    expect(out).toBe('高等 数学')
  })
})

describe('PDF 材料解析', () => {
  it('文本型课表 PDF:提取结果保留表格行列结构', async () => {
    // 两行两列的课表:同一行内水平 Td 移动,行间垂直 Td 移动
    const stream = [
      'BT',
      '/F1 12 Tf',
      '50 700 Td (Monday) Tj',
      '100 0 Td (Math 08:00) Tj',
      '-100 -20 Td (Tuesday) Tj',
      '100 0 Td (English 10:00) Tj',
      'ET'
    ].join('\n')
    const dir = mkdtempSync(join(tmpdir(), 'pdf-test-'))
    const p = join(dir, 'timetable.pdf')
    writeFileSync(p, buildPdf(stream))

    const parsed = await parseLocalFile(p)
    expect(parsed.parseError).toBeUndefined()
    expect(parsed.content).toContain('--- 第1页 ---')
    const lines = (parsed.content ?? '').split('\n').filter((l) => l.includes('Monday') || l.includes('Tuesday'))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('Monday')
    expect(lines[0]).toContain('|')
    expect(lines[0]).toContain('Math 08:00')
    expect(lines[1]).toContain('Tuesday')
    expect(lines[1]).toContain('English 10:00')
  })

  it('扫描版(图片型)PDF:给出清晰指引而非空结果', async () => {
    // 1x1 像素图片 + 绘制指令,无任何文本操作
    const imgStream = '\x00\xFF\x00'
    const content = 'q 200 0 0 200 50 50 cm /Im1 Do Q'
    const dir = mkdtempSync(join(tmpdir(), 'pdf-test-'))
    const p = join(dir, 'scan.pdf')
    const extraObjects = [
      `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${Buffer.byteLength(
        imgStream,
        'latin1'
      )} >>\nstream\n${imgStream}\nendstream`
    ]
    writeFileSync(p, buildPdf(content, extraObjects))

    const parsed = await parseLocalFile(p)
    expect(parsed.parseError ?? '').toContain('扫描件')
    expect(parsed.parseError ?? '').toContain('截图')
  })

  it('损坏的 PDF 给出可诊断错误', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdf-test-'))
    const p = join(dir, 'broken.pdf')
    writeFileSync(p, Buffer.from('this is not a pdf at all %PDF'))
    const r = await extractPdfContent(p)
    expect(r.error ?? '').toContain('PDF 解析失败')
  })
})
