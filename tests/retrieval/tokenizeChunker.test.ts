import { describe, expect, it } from 'vitest'
import { buildMatchQuery, SEARCH_VERSION, tokenizeForSearch } from '../../src/main/retrieval/tokenize'
import { chunkText, verifyChunkAlignment } from '../../src/main/retrieval/chunker'

// C-05:分词与分块。分词产物只含 [a-z0-9] 与 CJK(二元组),这是 MATCH 注入防线;
// 分块 offset 是码点索引,content 必须能从原文码点切片复原。

describe('tokenizeForSearch', () => {
  it('CJK 连续段拆相邻二元组', () => {
    expect(tokenizeForSearch('机器学习')).toEqual(['机器', '器学', '学习'])
  })

  it('单个 CJK 字符自成一词', () => {
    expect(tokenizeForSearch('学')).toEqual(['学'])
  })

  it('英文数字词转小写,标点作分隔符', () => {
    expect(tokenizeForSearch('Python/FastAPI, MCP v2')).toEqual(['python', 'fastapi', 'mcp', 'v2'])
  })

  it('基线实测样例:中英混排(全角标点打断 CJK 连续段)', () => {
    // '：' U+FF1A 与 '。' 不在 CJK 范围内,作为分隔符;检索仍按二元组命中
    expect(tokenizeForSearch('要求：机器学习。地点：上海。')).toEqual([
      '要求', '机器', '器学', '学习', '地点', '上海'
    ])
  })

  it('纯标点与空串产出空序列', () => {
    expect(tokenizeForSearch('。！？')).toEqual([])
    expect(tokenizeForSearch('')).toEqual([])
  })

  it('emoji 与组合字符不进入 token(作为分隔符丢弃)', () => {
    expect(tokenizeForSearch('a😀b')).toEqual(['a', 'b'])
  })
})

describe('buildMatchQuery', () => {
  it('双引号包裹、OR 连接', () => {
    expect(buildMatchQuery(['机器', 'python'])).toBe('"机器" OR "python"')
  })

  it('空 token 序列返回空表达式(调用方应先短路)', () => {
    expect(buildMatchQuery([])).toBe('')
  })

  it('越形 token(含引号/空格/运算符)拒绝,不进入 MATCH 表达式', () => {
    expect(() => buildMatchQuery(['x" OR y'])).toThrow(/非法检索词/)
    expect(() => buildMatchQuery(['a b'])).toThrow(/非法检索词/)
    expect(() => buildMatchQuery(['NEAR('])).toThrow(/非法检索词/)
  })
})

describe('SEARCH_VERSION 锁定', () => {
  it('分词实现版本为 1(锁定记录,调整预处理须升版本并重建索引)', () => {
    expect(SEARCH_VERSION).toBe(1)
  })
})

describe('chunkText', () => {
  it('短文本单块全覆盖,offset 左闭右开', () => {
    const text = '要求：机器学习。'
    const chunks = chunkText(text)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.startOffset).toBe(0)
    expect(chunks[0]!.endOffset).toBe(Array.from(text).length)
    expect(chunks[0]!.content).toBe(text)
    expect(verifyChunkAlignment(text, chunks[0]!)).toBe(true)
  })

  it('码点 offset 而非 UTF-16 下标:emoji 占 1 个 offset', () => {
    const text = 'a😀b'
    const chunks = chunkText(text)
    expect(chunks[0]!.endOffset).toBe(3) // UTF-16 下标会是 4
    expect(chunks[0]!.content).toBe('a😀b')
    expect(verifyChunkAlignment(text, chunks[0]!)).toBe(true)
  })

  it('超长文本多块:每块 ≤ 上限、相邻重叠 ≤ 120、content 全部可复原', () => {
    const text = Array.from({ length: 100 }, (_, i) => `第${i}段落的内容,用于分块测试。`).join('\n')
    const chunks = chunkText(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.endOffset - chunk.startOffset).toBeLessThanOrEqual(1200)
      expect(verifyChunkAlignment(text, chunk)).toBe(true)
    }
    for (let i = 1; i < chunks.length; i += 1) {
      const prev = chunks[i - 1]!
      const curr = chunks[i]!
      expect(curr.startOffset).toBeLessThan(prev.endOffset) // 有重叠
      expect(prev.endOffset - curr.startOffset).toBeLessThanOrEqual(120) // 重叠不超限
      expect(curr.startOffset).toBeGreaterThan(prev.startOffset) // 严格推进
    }
  })

  it('段落优先:窗口内有换行时断在换行后', () => {
    // 40 个字符 + \n + 40 个字符:目标 800 内不会触发,构造长文本让窗口覆盖 \n
    const para = 'x'.repeat(700)
    const text = `${para}\n${'y'.repeat(700)}`
    const chunks = chunkText(text)
    expect(chunks.length).toBeGreaterThan(1)
    // 第一块应断在 \n 之后(即 content 以 \n 结尾)
    expect(chunks[0]!.content.endsWith('\n')).toBe(true)
    expect(verifyChunkAlignment(text, chunks[0]!)).toBe(true)
  })

  it('空文本产出零块', () => {
    expect(chunkText('')).toEqual([])
  })

  it('非法参数组合拒绝', () => {
    expect(() => chunkText('x', { max: 100, target: 200 })).toThrow(/分块参数非法/)
    expect(() => chunkText('x', { max: 100, overlap: 100 })).toThrow(/分块参数非法/)
  })
})
