import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parseLocalFile } from '../src/main/services/materials'

function writeXlsx(rows: unknown[][], fileName = '课表.xlsx'): string {
  const dir = mkdtempSync(join(tmpdir(), 'xlsx-test-'))
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '课表')
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  const p = join(dir, fileName)
  writeFileSync(p, buf)
  return p
}

describe('Excel 课表材料解析', () => {
  it('xlsx 教务课表被转成模型可读的表格文本', async () => {
    const p = writeXlsx([
      ['课程表', null, null, null],
      ['节次', '星期一', '星期二', '星期三'],
      ['第1-2节', '高等数学 A-302 1-17周', '大学英语 B-201 1-16周', null],
      ['第3-4节', null, '数据结构 C-105 2-17周', '体育 D-001 1-17周']
    ])
    const parsed = await parseLocalFile(p)
    expect(parsed.parseError).toBeUndefined()
    expect(parsed.content).toContain('工作表:课表')
    expect(parsed.content).toContain('高等数学 A-302 1-17周')
    expect(parsed.content).toContain('数据结构 C-105 2-17周')
    // 单元格之间有分隔符,模型可按列区分
    expect(parsed.content).toContain(' | ')
  })

  it('多工作表全部保留', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xlsx-test-'))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['第一页数据']]), '第一节')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['第二页数据']]), '第二节')
    const p = join(dir, '校历.xlsx')
    writeFileSync(p, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer)
    const parsed = await parseLocalFile(p)
    expect(parsed.content).toContain('工作表:第一节')
    expect(parsed.content).toContain('工作表:第二节')
    expect(parsed.content).toContain('第二页数据')
  })

  it('损坏的 xlsx 不致命,给出可诊断错误', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xlsx-test-'))
    const p = join(dir, 'broken.xlsx')
    // 带 ZIP 魔数但内容损坏,SheetJS 会抛"Unsupported ZIP encryption"
    writeFileSync(p, Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('junkjunkjunkjunk')]))
    const parsed = await parseLocalFile(p)
    expect(parsed.parseError).toContain('表格解析失败')
    expect(parsed.content).toBeUndefined()
  })

  it('全空工作表给出明确错误而非空内容', async () => {
    const p = writeXlsx([['', ''], ['', '']])
    const parsed = await parseLocalFile(p)
    // 全空单元格在 blankrows:false + trim 后为空 → 明确报错
    expect(parsed.parseError ?? '').toContain('表格中没有可提取的内容')
  })
})
