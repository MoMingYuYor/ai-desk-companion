import { describe, expect, it } from 'vitest'
import {
  decodeBytes,
  normalizePlainText,
  projectJsonSource,
  sha256Hex,
  textSha256
} from '../../src/main/retrieval/normalize'

// C-05:解码与规范化 v1。顺序契约:识别编码 → 解码 → 去 BOM → CRLF/CR→LF → NFC。

describe('decodeBytes 编码识别', () => {
  it('无 BOM 按 UTF-8 严格解码', () => {
    const bytes = Buffer.from('要求：机器学习。', 'utf8')
    const got = decodeBytes(bytes)
    expect(got.encoding).toBe('utf-8')
    expect(got.text).toBe('要求：机器学习。')
  })

  it('UTF-8 BOM 被剥离', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('正文', 'utf8')])
    const got = decodeBytes(bytes)
    expect(got.encoding).toBe('utf-8')
    expect(got.text).toBe('正文')
  })

  it('UTF-16LE BOM 解码', () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文', 'utf16le')])
    const got = decodeBytes(bytes)
    expect(got.encoding).toBe('utf-16le')
    expect(got.text).toBe('中文')
  })

  it('UTF-16BE BOM 解码(字节交换后按 LE 解)', () => {
    // Node Buffer 无 utf16be 编码:先取 LE 字节再手工交换成 BE 字节序
    const le = Buffer.from('中文', 'utf16le')
    const be = Buffer.from(le)
    for (let i = 0; i + 1 < be.length; i += 2) {
      const tmp = be[i]!
      be[i] = be[i + 1]!
      be[i + 1] = tmp
    }
    const bytes = Buffer.concat([Buffer.from([0xfe, 0xff]), be])
    const got = decodeBytes(bytes)
    expect(got.encoding).toBe('utf-16be')
    expect(got.text).toBe('中文')
  })

  it('无效 UTF-8 明确报错,不用替换字符悄悄导入', () => {
    // 0xFF 是永不出现在合法 UTF-8 中的字节
    expect(() => decodeBytes(Buffer.from([0x61, 0xff, 0x62]))).toThrow(/UTF-8/)
  })

  it('rawSha256 是原始字节的 sha256', () => {
    const bytes = Buffer.from('abc', 'utf8')
    expect(decodeBytes(bytes).rawSha256).toBe(sha256Hex(bytes))
  })
})

describe('normalizePlainText', () => {
  it('CRLF 与孤 CR 统一为 LF', () => {
    expect(normalizePlainText('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('保留空格与标点,不压缩空白,不做 NFKC', () => {
    expect(normalizePlainText('a  b　c。')).toBe('a  b　c。')
    // 全角斜线 NFKC 会变半角,NFC 不变
    expect(normalizePlainText('／')).toBe('／')
  })

  it('NFC 合并组合字符', () => {
    const decomposed = 'e\u0301' // é = e + U+0301
    expect(normalizePlainText(decomposed)).toBe('é')
    expect(normalizePlainText(decomposed).length).toBe(1)
  })

  it('残留 BOM 字符移除', () => {
    expect(normalizePlainText('\uFEFF正文')).toBe('正文')
  })
})

describe('sha256 与 textSha256', () => {
  it('规范全文的 hash 基于 UTF-8 字节', () => {
    expect(textSha256('要求')).toBe(sha256Hex(Buffer.from('要求', 'utf8')))
  })

  it('CRLF 与 LF 版本 raw hash 不同,text 规范化后 hash 相同', () => {
    const crlf = Buffer.from('a\r\nb', 'utf8')
    const lf = Buffer.from('a\nb', 'utf8')
    expect(sha256Hex(crlf)).not.toBe(sha256Hex(lf))
    expect(textSha256(normalizePlainText(decodeBytes(crlf).text))).toBe(
      textSha256(normalizePlainText(decodeBytes(lf).text))
    )
  })
})

describe('projectJsonSource', () => {
  it('对象键排序投影,嵌套与数组保序', () => {
    const source = JSON.stringify({
      company: '示例公司',
      description: '要求机器学习',
      tags: ['实习', 'Python'],
      meta: { location: '上海' }
    })
    const text = projectJsonSource(source)
    // 键序:company < description < meta < tags
    const lines = text.split('\n')
    expect(lines[0]).toBe('示例公司')
    expect(lines[1]).toBe('要求机器学习')
    expect(lines).toContain('上海')
    expect(lines.indexOf('实习')).toBeLessThan(lines.indexOf('Python')) // 数组保序
  })

  it('数值与布尔转文本,null 与空字符串跳过', () => {
    const text = projectJsonSource(JSON.stringify({ a: 3, b: true, c: null, d: '' }))
    expect(text).toBe('3\ntrue')
  })

  it('非法 JSON 明确报错', () => {
    expect(() => projectJsonSource('{not json')).toThrow(/JSON 解析失败/)
  })

  it('顶层标量拒绝', () => {
    expect(() => projectJsonSource('"just a string"')).toThrow(/顶层必须是对象或数组/)
    expect(() => projectJsonSource('42')).toThrow(/顶层必须是对象或数组/)
  })
})
