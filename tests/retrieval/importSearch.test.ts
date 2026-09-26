import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importDocument, MAX_DOCUMENT_BYTES, retrievalStats } from '../../src/main/retrieval/importer'
import { searchDocuments } from '../../src/main/retrieval/search'
import { exportBackup, importBackup } from '../../src/main/services/backup'
import { makeTestDb } from '../helpers'

// C-05:导入与检索集成。核心断言:
// 1. 同一原始文件重复导入不产生重复 chunk(raw_sha256 去重);
// 2. 中文短词与英文缩写均可检索(依赖基线 §7 的基线样例);
// 3. 恶意输入经分词归一后不可能进入 MATCH 表达式;
// 4. 恢复备份整体替换 chunks 后,索引自动重建,检索仍可用。

const JD_A = '岗位要求:熟悉 Python 与 FastAPI,有检索经验优先。工作地点上海。'
const JD_B = '岗位职责:负责机器学习平台建设,要求扎实的工程能力。'

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'retrieval-test-'))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, content, 'utf-8')
  return file
}

describe('导入与去重', () => {
  it('导入产出文档与分块,FTS 索引可命中', async () => {
    const db = await makeTestDb()
    const result = importDocument(db, {
      sourceName: '岗位A.md',
      sourceType: 'markdown',
      bytes: Buffer.from(JD_A, 'utf8')
    })
    expect(result.deduped).toBe(false)
    expect(result.document.chunkCount).toBeGreaterThan(0)
    expect(retrievalStats(db)).toEqual({ documents: 1, chunks: result.document.chunkCount })

    const hits = searchDocuments(db, 'Python')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.sourceName).toBe('岗位A.md')
    expect(hits[0]!.sourceType).toBe('markdown')
    expect(hits[0]!.content).toContain('Python')
  })

  it('同一原始文件重复导入:deduped=true,不产生重复 chunk', async () => {
    const db = await makeTestDb()
    const bytes = Buffer.from(JD_A, 'utf8')
    const first = importDocument(db, { sourceName: '岗位A.md', sourceType: 'markdown', bytes })
    const second = importDocument(db, { sourceName: '改名也无妨.md', sourceType: 'markdown', bytes })
    expect(second.deduped).toBe(true)
    expect(second.document.documentId).toBe(first.document.documentId)
    expect(second.document.chunkCount).toBe(first.document.chunkCount)
    expect(retrievalStats(db).documents).toBe(1)
  })

  it('不同内容同名文件各自保留(不按文件名去重)', async () => {
    const db = await makeTestDb()
    importDocument(db, { sourceName: '岗位.md', sourceType: 'markdown', bytes: Buffer.from(JD_A, 'utf8') })
    importDocument(db, { sourceName: '岗位.md', sourceType: 'markdown', bytes: Buffer.from(JD_B, 'utf8') })
    expect(retrievalStats(db).documents).toBe(2)
  })

  it('超 5 MB 拒绝;空文件拒绝', async () => {
    const db = await makeTestDb()
    expect(() =>
      importDocument(db, {
        sourceName: 'big.txt',
        sourceType: 'txt',
        bytes: Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x61)
      })
    ).toThrow(/5 MB/)
    expect(() =>
      importDocument(db, { sourceName: 'empty.txt', sourceType: 'txt', bytes: Buffer.alloc(0) })
    ).toThrow(/空文件/)
  })

  it('JSON 按确定顺序投影后可检索', async () => {
    const db = await makeTestDb()
    importDocument(db, {
      sourceName: '岗位.json',
      sourceType: 'json',
      bytes: Buffer.from(
        JSON.stringify({ company: '示例公司', description: '要求机器学习与检索经验' }),
        'utf8'
      )
    })
    const hits = searchDocuments(db, '机器学习')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.content).toContain('机器学习')
  })

  it('CSV 按文本导入可检索', async () => {
    const db = await makeTestDb()
    importDocument(db, {
      sourceName: '岗位.csv',
      sourceType: 'csv',
      bytes: Buffer.from('岗位,要求\n算法实习,机器学习\n', 'utf8')
    })
    expect(searchDocuments(db, '机器学习').length).toBeGreaterThan(0)
  })
})

describe('检索与排序', () => {
  it('基线样例:默认分词下中文可检索(预处理生效)', async () => {
    const db = await makeTestDb()
    importDocument(db, { sourceName: 'a.md', sourceType: 'markdown', bytes: Buffer.from('要求：机器学习。', 'utf8') })
    importDocument(db, { sourceName: 'b.md', sourceType: 'markdown', bytes: Buffer.from('Python/FastAPI/MCP 实习经验', 'utf8') })
    // 六个基线测试词全部命中(依赖与工具链基线 §7.1)
    for (const term of ['机器学习', '学习', '实习', 'Python', 'FastAPI', 'MCP']) {
      expect(searchDocuments(db, term).length).toBeGreaterThan(0)
    }
    // 无结果返回空数组而非报错
    expect(searchDocuments(db, '不存在的词汇组合')).toEqual([])
  })

  it('多词查询按词频得分排序:命中更多词的块排前', async () => {
    const db = await makeTestDb()
    importDocument(db, {
      sourceName: 'both.md',
      sourceType: 'markdown',
      bytes: Buffer.from('机器学习与检索:机器学习平台需要检索能力,机器学习与检索结合。', 'utf8')
    })
    importDocument(db, {
      sourceName: 'only-one.md',
      sourceType: 'markdown',
      bytes: Buffer.from('这里只提到检索。', 'utf8')
    })
    const hits = searchDocuments(db, '机器学习 检索')
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(hits[0]!.sourceName).toBe('both.md')
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
    // matchedTerms 为查询 token 的去重命中集合(数组按默认字典序比较)
    expect([...hits[0]!.matchedTerms].sort()).toEqual(['器学', '学习', '机器', '检索'])
  })

  it('同分按 document_id、chunk_index 稳定排序(可复现)', async () => {
    const db = await makeTestDb()
    // 内容必须不同,否则触发 raw_sha256 去重只会得到一份文档
    const a = importDocument(db, { sourceName: 'a.md', sourceType: 'markdown', bytes: Buffer.from('重复内容一样甲', 'utf8') })
    const b = importDocument(db, { sourceName: 'b.md', sourceType: 'markdown', bytes: Buffer.from('重复内容一样乙', 'utf8') })
    const hits = searchDocuments(db, '重复')
    expect(hits.length).toBe(2)
    const ids = hits.map((h) => h.documentId).sort()
    expect([a.document.documentId, b.document.documentId].sort()).toEqual(ids)
    expect(hits.map((h) => h.documentId)).toEqual([...hits.map((h) => h.documentId)].sort())
  })

  it('恶意输入经分词归一后不产生 MATCH 语法错误,也不越权', async () => {
    const db = await makeTestDb()
    importDocument(db, { sourceName: 'a.md', sourceType: 'markdown', bytes: Buffer.from(JD_A, 'utf8') })
    for (const evil of ['x" OR y', 'NEAR(', 'a* b', '""', "' OR '1'='1", '机器学习" NOT "机器']) {
      expect(() => searchDocuments(db, evil)).not.toThrow()
    }
    // 合法词仍可从混杂输入中提取(查询词与语料匹配)
    const hits = searchDocuments(db, '机器学习" OR "检索')
    expect(hits.length).toBeGreaterThan(0)
  })

  it('limit 生效', async () => {
    const db = await makeTestDb()
    for (let i = 0; i < 5; i += 1) {
      importDocument(db, {
        sourceName: `doc-${i}.md`,
        sourceType: 'markdown',
        bytes: Buffer.from(`第${i}份:机器学习岗位`, 'utf8')
      })
    }
    expect(searchDocuments(db, '机器学习', 3)).toHaveLength(3)
  })
})

describe('备份恢复后的索引重建', () => {
  it('恢复整体替换 chunks 后 FTS 索引自动重建,检索仍可用', async () => {
    const db = await makeTestDb()
    importDocument(db, { sourceName: '岗位A.md', sourceType: 'markdown', bytes: Buffer.from(JD_A, 'utf8') })
    importDocument(db, { sourceName: '岗位B.md', sourceType: 'markdown', bytes: Buffer.from(JD_B, 'utf8') })
    expect(searchDocuments(db, '机器学习').length).toBeGreaterThan(0)

    const file = tempFile('backup.json', '')
    exportBackup(db, file)
    // 恢复(整体替换,含 chunks 的 rowid 变化)
    const imported = importBackup(db, file)
    expect(imported.imported.retrieval_documents).toBe(2)

    // 索引已重建:检索仍然可用且结果一致
    const hits = searchDocuments(db, '机器学习')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.sourceName === '岗位B.md' || h.sourceName === '岗位A.md')).toBe(true)
  })
})
