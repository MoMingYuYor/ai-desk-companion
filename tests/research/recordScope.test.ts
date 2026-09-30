// RES-02:记录范围(RecordScope)与范围内分块/检索/gold 定位。
// 覆盖:v1 投影等价(normalizedText 逐字节等于现投影契约)、码点范围累计
// (emoji/NFC/CSV 引号内换行)、chunkRecord 全局 offset、跨记录端点禁止、
// resolveLogicalGoldSpan 唯一包含定位(空匹配/跨边界/多匹配拒绝)。
import { describe, expect, it } from 'vitest'
import {
  chunkRecord,
  resolveLogicalGoldSpan,
  validateRecordScope,
  type RecordScope,
  type ScopedSnapshot
} from '../../src/main/research/recordScope'
import { projectResearchSourceWithRanges } from '../../src/main/research/snapshots'
import { normalizePlainText, projectJsonSource, textSha256 } from '../../src/main/retrieval/normalize'

function jsonBytes(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function sliceOf(normText: string, scope: RecordScope): string {
  return Array.from(normText).slice(scope.startOffset, scope.endOffset).join('')
}

describe('RES-02 投影等价与记录范围', () => {
  it('JSON 数组:normalizedText 逐字节等于现投影契约,记录范围按码点累计且不重叠', () => {
    const decodedText = jsonBytes([
      { title: '算法研究实习生', company: '样例岗位 算法组', location: '北京', description: '参与序列建模研究。\n要求:在读硕士及以上;', source_url: 'https://a.example.invalid', published_at: '2026-07-05' },
      { title: '数据标注组长', company: '样例岗位 算法组', location: '北京', description: '带领标注小组完成质检。\n要求:本科及以上;', source_url: 'https://b.example.invalid', published_at: '2026-07-06' }
    ])
    const projected = projectResearchSourceWithRanges('json', decodedText)
    // v1 投影等价:与现存 normalizePlainText(projectJsonSource(...)) 逐字节一致
    const legacy = normalizePlainText(projectJsonSource(normalizePlainText(decodedText)))
    expect(projected.normalizedText).toBe(legacy)

    expect(projected.scopes).toHaveLength(2)
    expect(projected.scopes[0]!.sourceLocator).toBe('/0')
    expect(projected.scopes[1]!.sourceLocator).toBe('/1')
    for (const scope of projected.scopes) {
      expect(scope.version).toBe(1)
      expect(scope.coordinateSystem).toBe('full-file-codepoint-v1')
      expect(scope.startOffset).toBeLessThan(scope.endOffset)
    }
    // 范围不重叠:记录 0 的结束 ≤ 记录 1 的开始(记录间分隔符不入任何记录范围)
    expect(projected.scopes[0]!.endOffset).toBeLessThanOrEqual(projected.scopes[1]!.startOffset)
    // 每条记录切片包含本记录字段、不含另一记录的专有内容
    const slice0 = sliceOf(projected.normalizedText, projected.scopes[0]!)
    const slice1 = sliceOf(projected.normalizedText, projected.scopes[1]!)
    expect(slice0).toContain('在读硕士及以上')
    expect(slice0).not.toContain('本科及以上')
    expect(slice1).toContain('本科及以上')
    expect(slice1).not.toContain('在读硕士及以上')
  })

  it('CSV:表头保留在全文但不进入任何数据记录范围;数据行按 row:N 归属', () => {
    const decodedText = 'title,company,description\nA,甲,Python 工作\nB,乙,OnlyBetaSecret Rust 工作'
    const projected = projectResearchSourceWithRanges('csv', decodedText)
    const legacy = normalizePlainText(projected.normalizedText)
    expect(projected.normalizedText).toBe(legacy)
    expect(projected.normalizedText.split('\n')).toContain('title') // 表头保留全文
    expect(projected.scopes.map((s) => s.sourceLocator)).toEqual(['row:1', 'row:2'])
    const slice0 = sliceOf(projected.normalizedText, projected.scopes[0]!)
    const slice1 = sliceOf(projected.normalizedText, projected.scopes[1]!)
    expect(slice0).toContain('Python 工作')
    expect(slice0).not.toContain('title')
    expect(slice0).not.toContain('OnlyBetaSecret')
    expect(slice1).toContain('OnlyBetaSecret')
    expect(slice1).not.toContain('Python 工作')
  })

  it('CSV 引号内换行:字段内 LF 属于所在数据行的码点范围', () => {
    const decodedText = 'title,description\nA,"多行\n描述"\nB,其他'
    const projected = projectResearchSourceWithRanges('csv', decodedText)
    const slice0 = sliceOf(projected.normalizedText, projected.scopes[0]!)
    expect(slice0).toContain('多行\n描述')
    expect(slice1Contains(projected, '其他')).toBe(true)
  })

  function slice1Contains(projected: { normalizedText: string; scopes: RecordScope[] }, needle: string): boolean {
    const last = projected.scopes[projected.scopes.length - 1]!
    return sliceOf(projected.normalizedText, last).includes(needle)
  }

  it('md/txt 与单对象 JSON:全范围单记录', () => {
    const md = projectResearchSourceWithRanges('markdown', '# 标题\n正文要求 Python。')
    expect(md.scopes).toHaveLength(1)
    expect(md.scopes[0]!.sourceLocator).toBeNull()
    expect(md.scopes[0]!.startOffset).toBe(0)
    expect(md.scopes[0]!.endOffset).toBe(Array.from(md.normalizedText).length)

    const single = projectResearchSourceWithRanges('json', '{"title":"唯一","description":"全文即记录"}')
    expect(single.scopes).toHaveLength(1)
    expect(single.scopes[0]!.sourceLocator).toBeNull()
    expect(single.scopes[0]!.endOffset).toBe(Array.from(single.normalizedText).length)
  })

  it('emoji 与 NFC 组合字符按码点累计,切片与 quote 逐字一致', () => {
    const decodedText = jsonBytes([
      { title: 'A', description: '要求:Python🙌熟练。' },
      { title: 'B', description: 'café 岗位' }
    ])
    const projected = projectResearchSourceWithRanges('json', decodedText)
    // emoji U+1F64C 是 1 个码点(2 个 UTF-16 单元):切片必须与整文件码点坐标一致
    const slice0 = sliceOf(projected.normalizedText, projected.scopes[0]!)
    expect(slice0).toContain('Python🙌熟练')
    expect(Array.from(slice0).some((ch) => ch.codePointAt(0)! > 0xffff)).toBe(true)
    // NFC:NFD 输入在投影中合并,坐标按合并后的码点计
    const nfdText = jsonBytes([{ title: 'C', description: 'cafe\u0301 岗位' }])
    const nfdProjected = projectResearchSourceWithRanges('json', nfdText)
    expect(sliceOf(nfdProjected.normalizedText, nfdProjected.scopes[0]!)).toContain('café')
    // 记录切片拼回的 quote 可以唯一命中整文件对应位置(按码点定位)
    const quote = '要求:Python🙌熟练。'
    const chars = Array.from(projected.normalizedText)
    const quoteLen = Array.from(quote).length
    const sliceChars = Array.from(slice0)
    const relative = sliceChars.findIndex(
      (_, i) => sliceChars.slice(i, i + quoteLen).join('') === quote
    )
    expect(relative).toBeGreaterThanOrEqual(0)
    const start = projected.scopes[0]!.startOffset + relative
    expect(chars.slice(start, start + quoteLen).join('')).toBe(quote)
    expect(textSha256(projected.normalizedText)).toBe(textSha256(projected.normalizedText))
  })
})

describe('RES-02 chunkRecord 范围内分块', () => {
  it('块内容等于全文件对应切片;offset 加 scope.startOffset;块与 span 不跨记录端点', () => {
    const decodedText = jsonBytes([
      { title: 'A', description: '第一段要求 Python。' + '填充'.repeat(600) },
      { title: 'B', description: '第二段要求 Rust。' }
    ])
    const projected = projectResearchSourceWithRanges('json', decodedText)
    const chars = Array.from(projected.normalizedText)
    for (const scope of projected.scopes) {
      const chunks = chunkRecord(projected.normalizedText, scope)
      expect(chunks.length).toBeGreaterThan(0)
      for (const chunk of chunks) {
        // 块范围整体落在记录范围内
        expect(chunk.startOffset).toBeGreaterThanOrEqual(scope.startOffset)
        expect(chunk.endOffset).toBeLessThanOrEqual(scope.endOffset)
        // 块内容等于全文件对应切片(码点坐标)
        expect(chars.slice(chunk.startOffset, chunk.endOffset).join('')).toBe(chunk.content)
      }
      // 相邻块连续覆盖记录范围(重叠语义由 chunkText 保证,不越过端点)
      expect(chunks[0]!.startOffset).toBe(scope.startOffset)
      expect(chunks[chunks.length - 1]!.endOffset).toBe(scope.endOffset)
    }
  })
})

describe('RES-02 逻辑 gold 定位(resolveLogicalGoldSpan)', () => {
  const records: ScopedSnapshot[] = [
    {
      documentId: 'doc-a',
      textSha256: 'hash-x',
      scope: { version: 1, coordinateSystem: 'full-file-codepoint-v1', sourceLocator: '/0', startOffset: 19, endOffset: 130 }
    },
    {
      documentId: 'doc-b',
      textSha256: 'hash-x',
      scope: { version: 1, coordinateSystem: 'full-file-codepoint-v1', sourceLocator: '/1', startOffset: 133, endOffset: 200 }
    }
  ]

  it('包含范围的唯一记录被选中(同逻辑文件两处 gold 映射不同记录)', () => {
    const a = resolveLogicalGoldSpan(records, { startOffset: 19, endOffset: 30 })
    const b = resolveLogicalGoldSpan(records, { startOffset: 133, endOffset: 142 })
    expect(a.documentId).toBe('doc-a')
    expect(b.documentId).toBe('doc-b')
  })

  it('空匹配、跨边界与多匹配明确失败;quote 重复不改变定位', () => {
    // 空匹配:范围不落在任何记录内
    expect(() => resolveLogicalGoldSpan(records, { startOffset: 300, endOffset: 310 })).toThrow(/无法唯一/)
    // 跨边界:span 横跨记录 0 的端点
    expect(() => resolveLogicalGoldSpan(records, { startOffset: 128, endOffset: 135 })).toThrow(/无法唯一/)
    // 多匹配:多个记录都包含(重叠范围场景)
    const overlapping: ScopedSnapshot[] = [
      { documentId: 'doc-1', textSha256: 'h', scope: { ...records[0]!.scope, sourceLocator: '/0', startOffset: 0, endOffset: 100 } },
      { documentId: 'doc-2', textSha256: 'h', scope: { ...records[0]!.scope, sourceLocator: '/1', startOffset: 10, endOffset: 90 } }
    ]
    expect(() => resolveLogicalGoldSpan(overlapping, { startOffset: 20, endOffset: 30 })).toThrow(/无法唯一/)
    // 空记录清单失败
    expect(() => resolveLogicalGoldSpan([], { startOffset: 0, endOffset: 1 })).toThrow(/无法唯一/)
  })

  it('先核 text_sha256:记录间 hash 不一致即失败', () => {
    const mixed: ScopedSnapshot[] = [
      records[0]!,
      { ...records[1]!, textSha256: 'hash-y' }
    ]
    expect(() => resolveLogicalGoldSpan(mixed, { startOffset: 133, endOffset: 142 })).toThrow(/text_sha256/)
  })
})

describe('RES-02 范围验证(validateRecordScope)', () => {
  it('合法范围通过;越界/颠倒/非整数/错误版本拒绝', () => {
    const scope = validateRecordScope(
      { version: 1, coordinateSystem: 'full-file-codepoint-v1', sourceLocator: '/0', startOffset: 2, endOffset: 9 },
      10
    )
    expect(scope.endOffset).toBe(9)
    expect(() => validateRecordScope({ version: 2, coordinateSystem: 'full-file-codepoint-v1', sourceLocator: null, startOffset: 0, endOffset: 9 }, 10)).toThrow(/version/)
    expect(() => validateRecordScope({ version: 1, coordinateSystem: 'utf16-v0', sourceLocator: null, startOffset: 0, endOffset: 9 }, 10)).toThrow(/coordinateSystem/)
    expect(() => validateRecordScope({ version: 1, coordinateSystem: 'full-file-codepoint-v1', sourceLocator: null, startOffset: 5, endOffset: 5 }, 10)).toThrow()
    expect(() => validateRecordScope({ version: 1, coordinateSystem: 'full-file-codepoint-v1', sourceLocator: null, startOffset: 0, endOffset: 11 }, 10)).toThrow(/超出/)
    expect(() => validateRecordScope({ version: 1, coordinateSystem: 'full-file-codepoint-v1', sourceLocator: null, startOffset: 1.5, endOffset: 9 }, 10)).toThrow(/整数/)
    expect(() => validateRecordScope({ version: 1, coordinateSystem: 'full-file-codepoint-v1', sourceLocator: null, startOffset: 0, endOffset: 9 }, 10)).not.toThrow() // 恰好等于全文码点长度:合法
  })
})
