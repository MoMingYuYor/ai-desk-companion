// R-03 有界检索与来源去重测试。覆盖执行清单步骤 15 的验收项:
// 1. 版本化 search_text 与中英混合查询预处理(「提示词工程 RAG」命中);
// 2. 安全 FTS 构造:恶意输入(`"`、NEAR(、*、OR)不抛未捕获异常、不成任意语法;
// 3. 稳定排序(score 降序 → documentId → chunkIndex,多次调用可复现);
// 4. 每题 8 chunk 上限(超命中语料 truncated=true 且 hits.length=上限);
// 5. 相邻片段联合:pairedWith 标注 + expandAdjacent,交付/取回数 ≤ 上限;
// 6. 候选不足置 insufficient(不扩写查询、无模型调用);
// 7. provenance 去重:同组多副本命中组计数=1;同模板不同岗位不误合并;
// 8. 检索不越过冻结清单(清单外命中被过滤、永不截断交付);
// 9. trace 完整字段(查询文本、命中 ID、分数、截断标记、实际使用数量);
// 10. 空结果;11. 确定性可复现(两次调用 JSON.stringify 相等;重建索引后一致)。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase, type SqliteDb } from '../../src/main/db/connection'
import { initSchema } from '../../src/main/db/dao'
import { fixedClock } from '../../src/shared/clock'
import { rebuildSearchIndex } from '../../src/main/retrieval/search'
import {
  MAX_CHUNKS_PER_SUBQUERY,
  expandAdjacent,
  retrieveForSubquestion,
  type RetrievalResult
} from '../../src/main/research/retrieval'
import {
  importResearchSources,
  type ImportedResearchSource,
  type ResearchSourceInput
} from '../../src/main/research/snapshots'

const SQL_JS_DIST = join(process.cwd(), 'node_modules', 'sql.js', 'dist')
const FIXED_CLOCK = fixedClock('2026-09-27T12:00:00.000Z')

async function makeTestDb(): Promise<SqliteDb> {
  const dir = mkdtempSync(join(tmpdir(), 'research-retrieval-'))
  const { db } = await openDatabase(join(dir, 'test.sqlite'), SQL_JS_DIST)
  initSchema(db)
  return db
}

function bytesOf(text: string): Buffer {
  return Buffer.from(text, 'utf-8')
}

function okOf(outcomes: ReturnType<typeof importResearchSources>): ImportedResearchSource[] {
  return outcomes.filter((o): o is ImportedResearchSource => o.ok)
}

/** 导入一批来源并断言全部成功,返回导入结果(含 documentId 与分组) */
function importOk(db: SqliteDb, sources: ResearchSourceInput[]): ImportedResearchSource[] {
  const outcomes = importResearchSources(db, { sources, clock: FIXED_CLOCK })
  for (const outcome of outcomes) {
    expect(outcome.ok, outcome.ok ? '' : JSON.stringify(outcome.error)).toBe(true)
  }
  return okOf(outcomes)
}

/** 导入单个来源的简写 */
function importOne(db: SqliteDb, input: ResearchSourceInput): ImportedResearchSource {
  return importOk(db, [input])[0]!
}

/** 导入来源并以首个 documentId 组成冻结清单的检索简写 */
function retrieveFrozen(
  db: SqliteDb,
  documentIds: readonly string[],
  input: Omit<Parameters<typeof retrieveForSubquestion>[1], 'frozenSnapshotIds' | 'chunkLimit'> &
    Partial<Pick<Parameters<typeof retrieveForSubquestion>[1], 'chunkLimit'>>
): RetrievalResult {
  return retrieveForSubquestion(db, {
    ...input,
    frozenSnapshotIds: documentIds,
    chunkLimit: input.chunkLimit ?? MAX_CHUNKS_PER_SUBQUERY
  })
}

// ---------- 中文/英文查询与安全构造 ----------

describe('中英查询预处理与安全 FTS 构造', () => {
  it('混合查询「提示词工程 RAG」命中中文 JD(中文技术词无空格)', async () => {
    const db = await makeTestDb()
    const doc = importOne(db, {
      sourceName: 'jd-a.md',
      sourceType: 'markdown',
      bytes: bytesOf('岗位职责:负责提示词工程与检索增强(RAG)流水线,要求熟悉 Python。')
    })
    const result = retrieveFrozen(db, [doc.documentId], { query: '提示词工程 RAG' })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0]!.documentId).toBe(doc.documentId)
    expect(result.hits[0]!.content).toContain('提示词工程')
    expect(result.insufficient).toBe(true) // 单文档候选远少于 8
    expect(result.trace.queryTokens).toContain('rag')
    expect(result.trace.queryTokens).toContain('提示')
  })

  it('英文缩写单独命中,trace 记录版本化分词与 MATCH 表达式', async () => {
    const db = await makeTestDb()
    const doc = importOne(db, {
      sourceName: 'jd-b.md',
      sourceType: 'markdown',
      bytes: bytesOf('要求:熟悉 SQL 与数据建模,了解 FTS 全文检索。')
    })
    const result = retrieveFrozen(db, [doc.documentId], { query: 'FTS' })
    expect(result.hits.length).toBe(1)
    expect(result.trace.searchVersion).toBe(1)
    expect(result.trace.queryTokens).toEqual(['fts'])
    expect(result.trace.matchQuery).toBe('"fts"')
    expect(result.trace.queryUsed).toBe('FTS')
  })

  it('恶意输入(`"`、NEAR(、*、OR)不抛未捕获异常且不成任意语法', async () => {
    const db = await makeTestDb()
    const doc = importOne(db, {
      sourceName: 'jd-c.md',
      sourceType: 'markdown',
      bytes: bytesOf('岗位职责:数据处理与分析,要求 Python 与 SQL。')
    })
    // 空格/标点只作分隔,OR/NEAR 是查询文本的普通字符,经分词归一不构成 FTS 语法
    for (const malicious of ['"', 'NEAR(', '*', 'OR Python', '" OR 1', '*) NEAR (a b']) {
      const result = retrieveFrozen(db, [doc.documentId], { query: malicious })
      // 不抛异常即通过;能命中的查询其结果与其他调用方式一致(普通词频计分)
      expect(result.trace.matchQuery).not.toMatch(/(?<!")\bNEAR\b|^\s*[*+(-]/)
      expect(() => JSON.stringify(result)).not.toThrow()
      for (const hit of result.hits) {
        expect(hit.documentId).toBe(doc.documentId)
      }
    }
    // 纯标点/空白:分词为空,检索不足而非报错
    const empty = retrieveFrozen(db, [doc.documentId], { query: '" * ) NEAR' })
    expect(empty.hits).toEqual([])
    expect(empty.insufficient).toBe(true)
  })

  it('空结果:冻结清单内无命中返回空且 insufficient=true,trace 全量落零', async () => {
    const db = await makeTestDb()
    const doc = importOne(db, {
      sourceName: 'jd-d.md',
      sourceType: 'markdown',
      bytes: bytesOf('岗位职责:嵌入式开发,要求 C 与 RTOS。')
    })
    const result = retrieveFrozen(db, [doc.documentId], { query: '机器学习平台' })
    expect(result.hits).toEqual([])
    expect(result.usedCount).toBe(0)
    expect(result.truncated).toBe(false)
    expect(result.insufficient).toBe(true)
    expect(result.provenanceGroups).toEqual([])
    expect(result.trace.candidateCount).toBe(0)
    expect(result.trace.hitChunkIds).toEqual([])
    expect(result.trace.hitScores).toEqual([])
    expect(result.trace.usedCount).toBe(0)
    expect(result.trace.insufficient).toBe(true)
    expect(result.trace.distinctProvenanceGroups).toBe(0)
  })
})

// ---------- 稳定排序与冻结清单钳制 ----------

describe('稳定排序与冻结清单钳制', () => {
  it('同分按 documentId+chunkIndex 稳定排序,多次调用可复现', async () => {
    const db = await makeTestDb()
    // 两份不同文档(内容不同避免 raw_sha256 幂等折叠)对查询词各出现一次:
    // score 相同,排序落 documentId 字典序
    let a = importOne(db, { sourceName: 'b-jd.md', bytes: bytesOf('要求熟悉 Python 与容器。') })
    let b = importOne(db, { sourceName: 'a-jd.md', bytes: bytesOf('要求熟悉 Python 与脚本。') })
    if (b.documentId > a.documentId) {
      // UUID 无序:按实际字典序互换引用,使断言与"字典序在先者排前"同义
      const swap = a
      a = b
      b = swap
    }
    const r1 = retrieveFrozen(db, [a.documentId, b.documentId], { query: 'Python' })
    const r2 = retrieveFrozen(db, [a.documentId, b.documentId], { query: 'Python' })
    expect(r1.hits.map((h) => h.documentId)).toEqual([b.documentId, a.documentId])
    expect(r1.hits.map((h) => h.score)).toEqual([1, 1])
    expect(r1.hits.map((h) => h.score)).toEqual(r2.hits.map((h) => h.score))
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2))
  })

  it('清单外文档的高分命中被过滤,不挤占交付名额', async () => {
    const db = await makeTestDb()
    const outside = importOne(db, {
      sourceName: '清单外.md',
      bytes: bytesOf('Python Python Python Python Python Python Python Python 机器学习平台。')
    })
    const inside = importOne(db, {
      sourceName: '清单内.md',
      bytes: bytesOf('Python 机器学习平台。')
    })
    // 冻结清单只含 inside:清单外高分文档必须被整体过滤
    const result = retrieveFrozen(db, [inside.documentId], { query: 'Python 机器学习平台' })
    expect(result.hits.length).toBeGreaterThan(0)
    for (const hit of result.hits) {
      expect(hit.documentId).toBe(inside.documentId)
    }
    expect(outside.documentId).not.toBe(inside.documentId) // 两者确为不同快照
  })

  it('跨文档 chunk 交替交付时冻结过滤后仍按稳定序截断到上限', async () => {
    const db = await makeTestDb()
    const sources: ResearchSourceInput[] = []
    for (let i = 0; i < 3; i += 1) {
      sources.push({
        sourceName: `bulk-${i}.md`,
        bytes: bytesOf(`Python 算法 工程 岗位 ${i}。`)
      })
    }
    const imported = importOk(db, sources)
    const result = retrieveFrozen(db, imported.map((s) => s.documentId), {
      query: 'Python 算法 工程 岗位',
      chunkLimit: 2
    })
    expect(result.hits.length).toBe(2)
    expect(result.truncated).toBe(true)
    const sorted = [...result.hits].sort((x, y) => y.score - x.score || (x.documentId < y.documentId ? -1 : 1) || x.chunkIndex - y.chunkIndex)
    expect(result.hits.map((h) => h.chunkId)).toEqual(sorted.map((h) => h.chunkId))
  })
})

// ---------- 每题 8 chunk 上限 ----------

describe('每题 8 chunk 上限与截断', () => {
  it('候选超过上限:truncated=true 且 hits.length=上限,实际数量进 trace', async () => {
    const db = await makeTestDb()
    // 8 份短 JD:每份 1 chunk,共 8 命中;再加 1 份凑 9 候选
    const sources: ResearchSourceInput[] = []
    for (let i = 0; i < 9; i += 1) {
      sources.push({ sourceName: `jd-${i}.md`, bytes: bytesOf(`岗位${i}:要求熟悉 Python 与检索技术。`) })
    }
    const imported = importOk(db, sources)
    const result = retrieveFrozen(db, imported.map((s) => s.documentId), { query: 'Python 检索' })
    expect(result.usedCount).toBe(MAX_CHUNKS_PER_SUBQUERY)
    expect(result.hits.length).toBe(MAX_CHUNKS_PER_SUBQUERY)
    expect(result.truncated).toBe(true)
    expect(result.trace.truncated).toBe(true)
    expect(result.trace.usedCount).toBe(MAX_CHUNKS_PER_SUBQUERY)
    expect(result.trace.candidateCount).toBeGreaterThanOrEqual(9)
    expect(result.trace.hitChunkIds).toHaveLength(MAX_CHUNKS_PER_SUBQUERY)
    expect(result.trace.hitScores).toHaveLength(MAX_CHUNKS_PER_SUBQUERY)
  })

  it('chunkLimit 允许下调至 1;超过 8 拒绝(预算钳制)', async () => {
    const db = await makeTestDb()
    const doc = importOne(db, { sourceName: 'jd.md', bytes: bytesOf('要求 Python。') })
    const down = retrieveFrozen(db, [doc.documentId], { query: 'Python', chunkLimit: 1 })
    expect(down.hits.length).toBe(1)
    for (const bad of [0, 9, -1, 1.5]) {
      expect(() =>
        retrieveForSubquestion(db, {
          query: 'Python',
          frozenSnapshotIds: [doc.documentId],
          chunkLimit: bad as number
        })
      ).toThrow()
    }
  })
})

// ---------- 相邻片段联合 ----------

describe('相邻片段联合', () => {
  it('同文档相邻块同时交付时互相标注 pairedWith,各占一个名额', async () => {
    const db = await makeTestDb()
    // 单文档长正文(>1200 码点)切成多块,查询词散布各处让多块全部命中
    const paragraphs: string[] = []
    for (let i = 0; i < 12; i += 1) {
      paragraphs.push(`第${i}段:岗位要求涵盖 Python 工程实践与检索系统设计,涉及数据处理。${'补充说明内容。'.repeat(60)}`)
    }
    const doc = importOne(db, {
      sourceName: 'long-jd.md',
      bytes: bytesOf(paragraphs.join('\n\n'))
    })
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM retrieval_chunks WHERE document_id = ?', [doc.documentId])!.n)
      .toBeGreaterThanOrEqual(3)
    const result = retrieveFrozen(db, [doc.documentId], { query: 'Python 检索', chunkLimit: 2 })
    expect(result.hits.length).toBe(2)
    expect(result.usedCount).toBe(2)
    const [first, second] = result.hits
    expect(first!.documentId).toBe(second!.documentId)
    expect(Math.abs(second!.chunkIndex - first!.chunkIndex)).toBe(1)
    expect(first!.pairedWith).toBe(second!.chunkId)
    expect(second!.pairedWith).toBe(first!.chunkId)
    expect(result.trace.pairedChunkIds).toEqual([first!.chunkId, second!.chunkId])
  })

  it('expandAdjacent:后块优先,未命中邻块 matched=false(须计入名额),末块回退前块', async () => {
    const db = await makeTestDb()
    const paragraphs: string[] = []
    for (let i = 0; i < 8; i += 1) {
      const keyword = i === 0 ? 'Python' : `旁述${i}`
      paragraphs.push(`第${i}段:${keyword} 相关描述。${'常规职责描述。'.repeat(60)}`)
    }
    const doc = importOne(db, { sourceName: 'adj.md', bytes: bytesOf(paragraphs.join('\n\n')) })
    const result = retrieveFrozen(db, [doc.documentId], { query: 'Python', chunkLimit: 1 })
    expect(result.hits.length).toBe(1)
    const hit = result.hits[0]!
    expect(hit.chunkIndex).toBe(0)
    // 后块(1)存在且未命中:matched=false,调用方把它计入名额后总数仍 ≤ 上限
    const next = expandAdjacent(db, result, hit)
    expect(next).not.toBeNull()
    expect(next!.chunkIndex).toBe(1)
    expect(next!.matched).toBe(false)
    expect(result.hits.some((h) => h.chunkId === next!.chunkId)).toBe(false)
    // 交付 1 + 邻块 1 = 2 ≤ 上限
    expect(result.usedCount + 1).toBeLessThanOrEqual(MAX_CHUNKS_PER_SUBQUERY)
    // 末块查询:块尾唯一标记词只落在最后一个 chunk,同分序不再受重叠干扰
    const lastIndex = db.get<{ m: number }>(
      'SELECT MAX(chunk_index) AS m FROM retrieval_chunks WHERE document_id = ?',
      [doc.documentId]
    )!.m
    const tailMark = '文末收束词'
    db.run(
      'UPDATE retrieval_chunks SET content = content || ?, search_text = search_text || ? WHERE document_id = ? AND chunk_index = ?',
      [tailMark, ` ${Array.from(tailMark).map((_, k) => tailMark.slice(k, k + 2) || tailMark).join(' ')}`, doc.documentId, lastIndex]
    )
    const ftsRowid = db.get<{ rid: number }>(
      'SELECT rowid AS rid FROM retrieval_chunks WHERE document_id = ? AND chunk_index = ?',
      [doc.documentId, lastIndex]
    )!.rid
    db.run('UPDATE retrieval_fts SET search_text = (SELECT search_text FROM retrieval_chunks WHERE rowid = ?) WHERE docid = ?', [
      ftsRowid,
      ftsRowid
    ])
    const lastResult = retrieveFrozen(db, [doc.documentId], { query: '文末收束词', chunkLimit: 1 })
    expect(lastResult.hits.length).toBe(1)
    expect(lastResult.hits[0]!.chunkIndex).toBe(lastIndex)
    const prev = expandAdjacent(db, lastResult, lastResult.hits[0]!)
    expect(prev!.chunkIndex).toBe(lastIndex - 1)
  })
})

// ---------- provenance 去重 ----------

describe('provenance 去重与来源组统计', () => {
  it('同组多副本(同 identity+核心内容)命中时组计数=1,组内 chunk 全部交付', async () => {
    const db = await makeTestDb()
    const body = '岗位职责:负责机器学习平台建设,要求扎实的 Python 工程能力与检索经验。'
    // 原始 JD 与其转载(不同文件名/剥离转载标记的等价核心内容,调用方声明 contentKey)
    const original = importOne(db, { sourceName: '原始JD.md', bytes: bytesOf(body) })
    const repost = importOne(db, {
      sourceName: '转载JD.md',
      bytes: bytesOf(`【转载】${body}`),
      sourceIdentity: original.sourceIdentity,
      contentKey: body
    })
    expect(repost.provenanceGroupId).toBe(original.provenanceGroupId)
    expect(repost.documentId).not.toBe(original.documentId)

    const result = retrieveFrozen(db, [original.documentId, repost.documentId], { query: 'Python 检索' })
    const chunkCount = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM retrieval_chunks WHERE document_id IN (?, ?)',
      [original.documentId, repost.documentId]
    )!.n
    expect(result.hits.length).toBe(chunkCount) // 每个 chunk 都计入交付(占名额)
    expect(result.provenanceGroups).toHaveLength(1) // 去重后 1 个来源组
    expect(result.provenanceGroups[0]!.provenanceGroupId).toBe(original.provenanceGroupId)
    expect(result.provenanceGroups[0]!.hitCount).toBe(chunkCount)
    expect(result.provenanceGroups[0]!.documentIds).toHaveLength(2)
    expect(result.trace.distinctProvenanceGroups).toBe(1)
    for (const hit of result.hits) {
      expect(hit.provenanceGroupId).toBe(original.provenanceGroupId)
    }
  })

  it('同模板不同岗位(不同来源身份)不误合并:两组独立计数', async () => {
    const db = await makeTestDb()
    // 相同模板、不同公司与岗位:近似文本不得自动并组(须人工确认)
    const template = '岗位职责:参与核心系统研发,要求良好的工程素养与协作能力。'
    const jdA = importOne(db, {
      sourceName: 'jd-a.csv',
      sourceType: 'json',
      bytes: bytesOf(JSON.stringify([{ title: '后端工程师', company: '甲公司', location: '上海', description: template }]))
    })
    const jdB = importOne(db, {
      sourceName: 'jd-b.csv',
      sourceType: 'json',
      bytes: bytesOf(JSON.stringify([{ title: '后端工程师', company: '乙公司', location: '北京', description: template }]))
    })
    expect(jdB.provenanceGroupId).not.toBe(jdA.provenanceGroupId)

    const result = retrieveFrozen(db, [jdA.documentId, jdB.documentId], { query: '核心系统研发' })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.provenanceGroups).toHaveLength(2)
    const groupIds = result.provenanceGroups.map((g) => g.provenanceGroupId).sort()
    expect(groupIds).toEqual([jdA.provenanceGroupId, jdB.provenanceGroupId].sort())
    for (const group of result.provenanceGroups) {
      expect(group.hitCount).toBe(1)
    }
    expect(result.trace.distinctProvenanceGroups).toBe(2)
  })

  it('多记录文件:同文件多 Source 按 document_id 独立计额与过滤', async () => {
    const db = await makeTestDb()
    const imported = importOk(db, [
      {
        sourceName: 'batch.json',
        sourceType: 'json',
        bytes: bytesOf(
          JSON.stringify([
            { title: '算法工程师', company: '甲公司', location: '上海', description: '负责推荐算法与 Python 服务开发。' },
            { title: '前端工程师', company: '甲公司', location: '上海', description: '负责 Web 界面与交互实现。' }
          ])
        )
      }
    ])
    expect(imported).toHaveLength(2)
    const [algo, frontend] = imported
    expect(algo.sourceLocator).toBe('/0')
    expect(frontend.sourceLocator).toBe('/1')
    expect(algo.provenanceGroupId).not.toBe(frontend.provenanceGroupId)

    // 冻结清单只含算法岗:前端记录被过滤
    const result = retrieveFrozen(db, [algo.documentId], { query: 'Python 开发' })
    for (const hit of result.hits) {
      expect(hit.documentId).toBe(algo.documentId)
    }
    expect(result.provenanceGroups).toHaveLength(1)
    // 两个记录都冻结:各自独立一组、独立计额
    const both = retrieveFrozen(db, [algo.documentId, frontend.documentId], { query: '开发' })
    expect(both.provenanceGroups).toHaveLength(2)
  })

  it('无 provenance_group_id 的共享导入文档:逐文档独立成 null 组', async () => {
    const db = await makeTestDb()
    // 绕开研究导入器,模拟共享导入器(C-05)写入的无研究列文档
    db.run(
      `INSERT INTO retrieval_documents
         (document_id, source_name, source_type, raw_sha256, text_sha256, normalized_text, size_bytes, created_at)
       VALUES ('doc-legacy', 'legacy.md', 'markdown', 'raw', 'text', '要求 Python 与 SQL 能力。', 64, '2026-09-27T00:00:00.000Z')`
    )
    db.run(
      `INSERT INTO retrieval_chunks
         (chunk_id, document_id, chunk_index, start_offset, end_offset, content, search_text, search_version)
       VALUES ('chunk-legacy', 'doc-legacy', 0, 0, 14, '要求 Python 与 SQL', '要求 python 与 sql', 1)`
    )
    db.run('INSERT INTO retrieval_fts(docid, search_text) VALUES ((SELECT rowid FROM retrieval_chunks WHERE chunk_id = ?), ?)', [
      'chunk-legacy',
      '要求 python 与 sql'
    ])
    const result = retrieveFrozen(db, ['doc-legacy'], { query: 'Python' })
    expect(result.hits.length).toBe(1)
    expect(result.hits[0]!.provenanceGroupId).toBeNull()
    expect(result.provenanceGroups).toHaveLength(1)
    expect(result.provenanceGroups[0]!.provenanceGroupId).toBeNull()
    expect(result.provenanceGroups[0]!.hitCount).toBe(1)
    expect(result.provenanceGroups[0]!.documentIds).toEqual(['doc-legacy'])
  })
})

// ---------- trace 与确定性 ----------

describe('检索 trace 与确定性可复现', () => {
  it('trace 保存查询文本、命中 ID、分数、截断标记与实际使用数量,并可作 JSON 持久化', async () => {
    const db = await makeTestDb()
    const a = importOne(db, { sourceName: 't1.md', bytes: bytesOf('负责推荐系统,要求 Python。') })
    const b = importOne(db, { sourceName: 't2.md', bytes: bytesOf('负责推荐系统,要求 Go。') })
    const result = retrieveFrozen(db, [a.documentId, b.documentId], { query: '推荐系统', chunkLimit: 1 })
    const trace = result.trace
    expect(trace.queryUsed).toBe('推荐系统')
    expect(trace.queryParts).toEqual(['推荐系统'])
    expect(trace.queryTokens.length).toBeGreaterThan(0)
    expect(trace.matchQuery).toContain('"')
    expect(trace.frozenSnapshotIds).toEqual([a.documentId, b.documentId])
    expect(trace.hitChunkIds).toEqual(result.hits.map((h) => h.chunkId))
    expect(trace.hitScores.map((s) => s.chunkId)).toEqual(trace.hitChunkIds)
    expect(trace.hitScores[0]!.score).toBe(result.hits[0]!.score)
    expect(trace.truncated).toBe(result.truncated)
    expect(trace.usedCount).toBe(result.usedCount)
    expect(() => JSON.stringify({ runId: 'r1', eventType: 'retrieval', payload: trace })).not.toThrow()
  })

  it('比较维度与实体范围并入同一次查询,queryParts 有序可复核', async () => {
    const db = await makeTestDb()
    const doc = importOne(db, {
      sourceName: 'cmp.md',
      bytes: bytesOf('要求:Python 经验;工作地点上海;涉及数据方向。')
    })
    const result = retrieveFrozen(db, [doc.documentId], {
      query: 'Python 经验',
      compareDimensions: ['工作地点'],
      entityScope: ['上海', '数据']
    })
    expect(result.queryUsed).toBe('Python 经验 工作地点 上海 数据')
    expect(result.trace.queryParts).toEqual(['Python 经验', '工作地点', '上海', '数据'])
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.trace.candidateCount).toBeGreaterThan(0)
  })

  it('确定性:同输入多次调用逐字节一致;重建索引(rebuildSearchIndex)后顺序可复核', async () => {
    const db = await makeTestDb()
    const sources: ResearchSourceInput[] = []
    for (let i = 0; i < 5; i += 1) {
      sources.push({ sourceName: `det-${i}.md`, bytes: bytesOf(`岗位${i}:要求 Python 与检索,涉及数据管道与算法工程。`) })
    }
    const imported = importOk(db, sources)
    const frozenIds = imported.map((s) => s.documentId)

    const runOnce = (): string => JSON.stringify(retrieveFrozen(db, frozenIds, { query: 'Python 检索 算法' }))
    const first = runOnce()
    expect(runOnce()).toBe(first)

    // 重建 FTS 索引(备份恢复后的等价场景):同一冻结查询命中与顺序不变
    rebuildSearchIndex(db)
    expect(runOnce()).toBe(first)

    // 冻结清单变更(加入新快照)改变结果——命中可由查询、版本、快照集合复现
    const subset = retrieveFrozen(db, frozenIds.slice(0, 3), { query: 'Python 检索 算法' })
    const subsetTrace = { ...subset.trace }
    expect(subsetTrace.frozenSnapshotIds).toEqual(frozenIds.slice(0, 3))
    expect(subset.hits.length).toBeLessThanOrEqual(subset.usedCount)
    for (const hit of subset.hits) {
      expect(frozenIds.slice(0, 3)).toContain(hit.documentId)
    }
  })

  it('输入校验:空冻结清单、非字符串 query、非数组维度均拒绝', async () => {
    const db = await makeTestDb()
    const doc = importOne(db, { sourceName: 'v.md', bytes: bytesOf('要求 Python。') })
    expect(() =>
      retrieveForSubquestion(db, { query: 'Python', frozenSnapshotIds: [], chunkLimit: 8 })
    ).toThrow()
    expect(() =>
      retrieveForSubquestion(db, { query: 42 as unknown as string, frozenSnapshotIds: [doc.documentId], chunkLimit: 8 })
    ).toThrow()
    expect(() =>
      retrieveForSubquestion(db, {
        query: 'Python',
        frozenSnapshotIds: [doc.documentId],
        chunkLimit: 8,
        entityScope: '上海' as unknown as string[]
      })
    ).toThrow()
    expect(() =>
      retrieveForSubquestion(db, { query: 'Python', frozenSnapshotIds: [''], chunkLimit: 8 })
    ).toThrow()
  })
})
