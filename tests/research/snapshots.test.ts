// R-02 导入快照与精确定位测试。覆盖执行清单步骤 14 的验收项:
// 1. JSON/CSV 按固定 schema 投影,source_locator 保存 JSON Pointer/CSV 行号;
// 2. collected_at 未知 → 导入时间 + collection_time_basis=imported;
// 3. 不可变清单:运行创建后无任何修改途径(篡改任一被冻结字段即 SNAPSHOT_HASH_MISMATCH);
// 4. 所有 span 可重定位:导入 → 切 span → 码点切片 === quote,chunk 覆盖 span;
// 5. BOM/CRLF/NFD/emoji、相同文件不同名称(raw_sha256 幂等)、不同岗位相似模板不误合并、
//    损坏字节明确报错、同 quote 多次出现;
// 6. 来源分组:转载副本同组,模板相似不同组;更换原始文件不改变历史快照;
// 7. 规范化 golden fixture(fixtures/research/normalization)逐字一致。
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase, type SqliteDb } from '../../src/main/db/connection'
import { initSchema } from '../../src/main/db/dao'
import { fixedClock } from '../../src/shared/clock'
import { OperationError, initWorkspaceEpoch } from '../../src/main/db/operations'
import { verifyChunkAlignment, type TextChunk } from '../../src/main/retrieval/chunker'
import {
  createEvidenceSpan,
  createResearchRun,
  createSubQuestion,
  getResearchTaskByRun,
  verifySnapshotManifest
} from '../../src/main/research/repository'
import {
  IMPORT_BATCH_LIMIT,
  importResearchSources,
  type ImportedResearchSource,
  type ResearchSourceInput
} from '../../src/main/research/snapshots'

const SQL_JS_DIST = join(process.cwd(), 'node_modules', 'sql.js', 'dist')
const FIXED_CLOCK = fixedClock('2026-09-27T12:00:00.000Z')
const CONTEXT_CLOCK = '2026-09-27T12:00:00.000Z'
const NORM_DIR = join(process.cwd(), 'fixtures', 'research', 'normalization')

async function makeTestDb(): Promise<SqliteDb> {
  const dir = mkdtempSync(join(tmpdir(), 'research-snapshots-'))
  const { db } = await openDatabase(join(dir, 'test.sqlite'), SQL_JS_DIST)
  initSchema(db)
  initWorkspaceEpoch()
  return db
}

function bytesOf(text: string): Buffer {
  return Buffer.from(text, 'utf-8')
}

function okOf(outcomes: ReturnType<typeof importResearchSources>): ImportedResearchSource[] {
  return outcomes.filter((o): o is ImportedResearchSource => o.ok)
}

function appCode(err: unknown): string | undefined {
  if (err instanceof OperationError) return err.appError.code
  return undefined
}

/** 失败结果的类型收窄助手 */
function failOf(outcome: ReturnType<typeof importResearchSources>[number]): { sourceName: string; sourceType: string | null; recordIndex: number | null; sourceLocator: string | null; error: { code: string; message: string } } {
  expect(outcome.ok).toBe(false)
  if (outcome.ok) throw new Error('应当失败')
  return outcome
}

/** 导入一份文件并断言成功,返回首个逻辑 Source 结果 */
function importOk(db: SqliteDb, input: ResearchSourceInput): ImportedResearchSource {
  const outcomes = importResearchSources(db, { sources: [input], clock: FIXED_CLOCK })
  expect(outcomes).toHaveLength(1)
  const first = outcomes[0]!
  expect(first.ok, first.ok ? '' : JSON.stringify(first.error)).toBe(true)
  return first as ImportedResearchSource
}

function researchRequest(snapshotIds: string[], question = '比较这些岗位的 Python 要求。'): Record<string, unknown> {
  return { question, snapshot_ids: snapshotIds, snapshot_policy: 'fixed', budget: {} }
}

/** 导入给定来源并创建研究运行,返回 runId、导入结果与清单 hash */
function seedRun(
  db: SqliteDb,
  sources: ResearchSourceInput[]
): { runId: string; imported: ImportedResearchSource[]; manifestSha256: string } {
  const imported = okOf(importResearchSources(db, { sources, clock: FIXED_CLOCK }))
  expect(imported.length).toBeGreaterThan(0)
  const { value } = createResearchRun(
    db,
    { request: researchRequest(imported.map((s) => s.documentId)), contextClock: CONTEXT_CLOCK, clock: FIXED_CLOCK },
    'op-seed-' + Math.random().toString(36).slice(2)
  )
  return { runId: value.run.runId, imported, manifestSha256: value.manifest.manifestSha256 }
}

/** 建一个只含指定快照的研究运行与 1 号子问题(供 createEvidenceSpan 使用) */
function seedRunForSpan(db: SqliteDb, snapshotId: string): { runId: string; subquestionId: string } {
  const { value } = createResearchRun(
    db,
    { request: researchRequest([snapshotId], '这些材料说了什么?'), contextClock: CONTEXT_CLOCK, clock: FIXED_CLOCK },
    'op-span-' + snapshotId
  )
  const sub = createSubQuestion(db, value.run.runId, { ordinal: 1, question: '该片段说了什么?' })
  return { runId: value.run.runId, subquestionId: sub.subquestionId }
}

function normTextOf(db: SqliteDb, documentId: string): string {
  return db.get<{ normalized_text: string }>(
    'SELECT normalized_text FROM retrieval_documents WHERE document_id = ?',
    [documentId]
  )!.normalized_text
}

function chunksOf(db: SqliteDb, documentId: string): Array<TextChunk & { chunk_id: string }> {
  return db.all<{ chunk_id: string; index: number; startOffset: number; endOffset: number; content: string }>(
    `SELECT chunk_id, chunk_index AS "index", start_offset AS "startOffset", end_offset AS "endOffset", content
     FROM retrieval_chunks WHERE document_id = ? ORDER BY chunk_index`,
    [documentId]
  ) as Array<TextChunk & { chunk_id: string }>
}

/** 在规范全文中查找 quote 的全部码点起始位置(与 gold_integrity 的唯一命中判定同一逻辑) */
function occurrencesOf(normText: string, quote: string): number[] {
  const chars = Array.from(normText)
  const qChars = Array.from(quote)
  const hits: number[] = []
  outer: for (let i = 0; i + qChars.length <= chars.length; i += 1) {
    for (let j = 0; j < qChars.length; j += 1) {
      if (chars[i + j] !== qChars[j]) continue outer
    }
    hits.push(i)
  }
  return hits
}

// ---------- 1. JSON/CSV 投影与 source_locator ----------

describe('JSON/CSV 投影与 source_locator', () => {
  it('JSON 数组每条记录是一个逻辑 Source,locator 为 JSON Pointer,description 缺失按记录报错且保持记录序', async () => {
    const db = await makeTestDb()
    const good = {
      title: '样例岗位后端实习生',
      company: '样例岗位 平台部',
      location: '合肥',
      description: '要求:会 Python。',
      source_url: 'https://careers.example.invalid/jobs/snap-a',
      published_at: '2026-09-01'
    }
    const bad = { ...good, description: undefined, source_url: 'https://careers.example.invalid/jobs/snap-b' }
    const payload = JSON.stringify([good, bad])
    const src = { sourceName: 'list.json', bytes: bytesOf(payload) }
    const outcomes = importResearchSources(db, { sources: [src], clock: FIXED_CLOCK })
    expect(outcomes).toHaveLength(2)
    const first = outcomes[0]!
    const second = failOf(outcomes[1]!)
    expect(first.ok, first.ok ? '' : JSON.stringify(first.error)).toBe(true)
    expect((first as ImportedResearchSource).sourceLocator).toBe('/0')
    expect(second.error.code).toBe('DOCUMENT_PARSE_ERROR')
    expect(second.error.message).toContain('description')
    expect(second.sourceLocator).toBe('/1')

    // 记录行的 normalized_text 是整文件投影,码点长度与结果一致
    const stored = first as ImportedResearchSource
    expect(Array.from(normTextOf(db, stored.documentId)).length).toBe(stored.codePointLength)
  })

  it('CSV 每条数据行是一个逻辑 Source,locator 为 row:N;记录各自成组,投影含表头且全文件坐标可定位', async () => {
    const db = await makeTestDb()
    const csv = [
      'title,company,location,description,source_url,published_at',
      '样例岗位数据实习生,样例岗位 数据部,北京,"要求:精通 Python,有 ETL 经验。",https://careers.example.invalid/jobs/snap-c,2026-09-03',
      '样例岗位运营实习生,样例岗位 数据部,北京,"要求:会用 SQL。",https://careers.example.invalid/jobs/snap-d,2026-09-04'
    ].join('\n')
    const outcomes = okOf(
      importResearchSources(db, { sources: [{ sourceName: 'roles.csv', bytes: bytesOf(csv) }], clock: FIXED_CLOCK })
    )
    expect(outcomes.map((o) => o.sourceLocator)).toEqual(['row:1', 'row:2'])
    expect(new Set(outcomes.map((o) => o.provenanceGroupId)).size).toBe(2)
    // 投影全文 = 表头 + 数据行按列序展平(与 gold 重放契约一致)
    const full = normTextOf(db, outcomes[0]!.documentId)
    const lines = full.split('\n')
    expect(lines).toContain('title')
    expect(lines).toContain('要求:精通 Python,有 ETL 经验。')
    // 两条记录的行共享同一份全文件投影文本,第二行的内容也可定位(全文件坐标)
    expect(normTextOf(db, outcomes[1]!.documentId)).toBe(full)
    expect(occurrencesOf(full, '会用 SQL。')).toHaveLength(1)
  })

  it('JSON 单对象:整文件一个逻辑 Source,locator 为 null', async () => {
    const db = await makeTestDb()
    const obj = {
      title: '样例岗位测试实习生',
      company: '样例岗位 质量部',
      location: '长沙',
      description: '要求:细心。',
      source_url: 'https://careers.example.invalid/jobs/snap-e',
      published_at: '2026-09-05'
    }
    const only = importOk(db, { sourceName: 'one.json', bytes: bytesOf(JSON.stringify(obj)) })
    expect(only.sourceLocator).toBeNull()
    expect(only.recordIndex).toBeNull()
    expect(only.representative).toBe(true)
  })
})

// ---------- 2. collected_at 语义与来源元数据 ----------

describe('collected_at 与来源元数据', () => {
  it('collected_at 未知 → 导入时间 + imported 标记;提供时 → source 标记', async () => {
    const db = await makeTestDb()
    const base = {
      title: '样例岗位行政实习生',
      company: '样例岗位 综合部',
      location: '昆明',
      description: '要求:沟通顺畅。',
      source_url: 'https://careers.example.invalid/jobs/snap-f',
      published_at: '2026-01-10'
    }
    const unknown = importOk(db, { sourceName: 'a.json', bytes: bytesOf(JSON.stringify(base)) })
    expect(unknown.collectedAt).toBe('2026-09-27T12:00:00.000Z')
    expect(unknown.collectionTimeBasis).toBe('imported')
    const rowA = db.get<{ source_metadata_json: string; collection_time_basis: string }>(
      'SELECT source_metadata_json, collection_time_basis FROM retrieval_documents WHERE document_id = ?',
      [unknown.documentId]
    )!
    expect(rowA.collection_time_basis).toBe('imported')
    const metaA = JSON.parse(rowA.source_metadata_json) as Record<string, unknown>
    expect(metaA.published_at).toMatchObject({ value: '2026-01-10', verified: false })

    const known = importOk(db, {
      sourceName: 'b.json',
      bytes: bytesOf(JSON.stringify({ ...base, title: '样例岗位前台实习生', description: '要求:接待访客。' })),
      collectedAt: '2026-09-20T00:00:00.000Z'
    })
    expect(known.collectedAt).toBe('2026-09-20T00:00:00.000Z')
    expect(known.collectionTimeBasis).toBe('source')
  })

  it('published_at 独立保存来源与可验证状态,默认 verified=false(不冒充可核验)', async () => {
    const db = await makeTestDb()
    const obj = {
      title: '样例岗位前台实习生',
      company: '样例岗位 综合部',
      location: '昆明',
      description: '要求:接待访客。',
      published_at: '2026-02-02'
    }
    const only = importOk(db, { sourceName: 'meta.json', bytes: bytesOf(JSON.stringify(obj)) })
    const meta = JSON.parse(
      db.get<{ source_metadata_json: string }>(
        'SELECT source_metadata_json FROM retrieval_documents WHERE document_id = ?',
        [only.documentId]
      )!.source_metadata_json
    ) as Record<string, unknown>
    expect(meta.published_at).toMatchObject({ value: '2026-02-02', source: 'record', verified: false })
  })
})

// ---------- 3. 不可变清单 ----------

describe('不可变清单', () => {
  it('运行创建后清单内容被冻结:篡改 text_sha256 / source_identity / provenance_group_id / collection_time_basis 任一项即 SNAPSHOT_HASH_MISMATCH', async () => {
    const db = await makeTestDb()
    const { runId } = seedRun(db, [{
      sourceName: 'frozen.json',
      bytes: bytesOf(JSON.stringify({
        title: '样例岗位冻结岗',
        company: '样例岗位 冻结部',
        location: '兰州',
        description: '要求:熟悉 Git。',
        source_url: 'https://careers.example.invalid/jobs/snap-g',
        published_at: '2026-03-01'
      }))
    }])
    const task = getResearchTaskByRun(db, runId)!
    const documentId = db.get<{ document_id: string }>('SELECT document_id FROM retrieval_documents LIMIT 1')!.document_id

    const mutations = [
      `UPDATE retrieval_documents SET normalized_text = '篡改后的文本', text_sha256 = 'tampered' WHERE document_id = '${documentId}'`,
      `UPDATE retrieval_documents SET source_identity = '别的岗位' WHERE document_id = '${documentId}'`,
      `UPDATE retrieval_documents SET provenance_group_id = 'pg-其他' WHERE document_id = '${documentId}'`,
      `UPDATE retrieval_documents SET collection_time_basis = 'source' WHERE document_id = '${documentId}'`
    ]
    for (const sql of mutations) {
      db.run(sql)
      try {
        verifySnapshotManifest(db, task.snapshotManifestId)
        expect.unreachable(`应当抛出 SNAPSHOT_HASH_MISMATCH:${sql}`)
      } catch (err) {
        expect(appCode(err)).toBe('CONFLICT')
        expect((err as OperationError).message).toMatch(/SNAPSHOT_HASH_MISMATCH/)
      }
    }
  })

  it('清单冻结后 manifest_sha256 复核一致;快照完好时 verify 通过', async () => {
    const db = await makeTestDb()
    const { runId, manifestSha256 } = seedRun(db, [{
      sourceName: 'ok.txt',
      bytes: bytesOf('样例岗位冻结核对\n\n要求:稳定。\n')
    }])
    const task = getResearchTaskByRun(db, runId)!
    expect(verifySnapshotManifest(db, task.snapshotManifestId).manifestSha256).toBe(manifestSha256)
  })

  it('运行创建后修改清单条目本身(entries_json)会在复核时暴露:无任何修改途径被容忍', async () => {
    const db = await makeTestDb()
    const { runId } = seedRun(db, [{ sourceName: 'guard.txt', bytes: bytesOf('样例岗位I\n\n要求:Python。\n') }])
    const task = getResearchTaskByRun(db, runId)!
    const row = db.get<{ entries_json: string; manifest_sha256: string }>(
      'SELECT entries_json, manifest_sha256 FROM research_snapshot_manifests WHERE manifest_id = ?',
      [task.snapshotManifestId]
    )!
    const tampered = row.entries_json.replace('"collection_time_basis":"imported"', '"collection_time_basis":"source"')
    db.run('UPDATE research_snapshot_manifests SET entries_json = ?, manifest_sha256 = ? WHERE manifest_id = ?', [
      tampered,
      row.manifest_sha256,
      task.snapshotManifestId
    ])
    try {
      verifySnapshotManifest(db, task.snapshotManifestId)
      expect.unreachable('应当抛出 SNAPSHOT_HASH_MISMATCH')
    } catch (err) {
      expect(appCode(err)).toBe('CONFLICT')
      expect((err as OperationError).message).toMatch(/采集时间依据/)
    }
  })
})

// ---------- 4. span 可重定位与 chunk 对齐 ----------

describe('span 可重定位(码点坐标)与 chunk 覆盖', () => {
  it('导入后切多个 span:Array.from(normText).slice(start,end) === quote,且 span 被某个 chunk 覆盖(verifyChunkAlignment)', async () => {
    const db = await makeTestDb()
    const only = importOk(db, {
      sourceName: 'locate.txt',
      bytes: bytesOf('样例岗位算法实习生(远程)\n\n要求:精通 Python 与检索基础;有 🎯 项目经验者优先;每周四天。\n')
    })
    const normText = normTextOf(db, only.documentId)
    const chunks = chunksOf(db, only.documentId)
    expect(chunks.length).toBeGreaterThan(0)
    for (const chunk of chunks) {
      expect(verifyChunkAlignment(normText, chunk)).toBe(true)
    }

    const { runId, subquestionId } = seedRunForSpan(db, only.documentId)
    const chars = Array.from(normText)
    // 取 8 个分布在不同位置的 span(含 emoji 区段),走 createEvidenceSpan 全链路校验
    for (let i = 0; i < 8; i += 1) {
      const start = Math.min(chars.length - 2, Math.floor((chars.length - 2) * (i / 8)))
      const end = Math.max(start + 1, Math.min(chars.length, start + 3 + (i % 5)))
      const quote = chars.slice(start, end).join('')
      const covering = chunks.find((c) => c.startOffset <= start && end <= c.endOffset)
      expect(covering, `chunk 应覆盖 [${start},${end})`).toBeDefined()
      const span = createEvidenceSpan(db, runId, subquestionId, {
        snapshot_id: only.documentId,
        chunk_id: covering!.chunk_id,
        start_offset: start,
        end_offset: end,
        quote
      })
      const stored = db.get<{ normalized_text: string }>(
        `SELECT d.normalized_text FROM research_evidence_spans s
         JOIN retrieval_documents d ON d.document_id = s.snapshot_id WHERE s.evidence_id = ?`,
        [span.evidenceId]
      )!
      expect(Array.from(stored.normalized_text).slice(start, end).join('')).toBe(quote)
    }
  })

  it('同 quote 多次出现:同一 quote 对应两个有效 offset,各自切片逐字等于 quote(必须显式定位)', async () => {
    const db = await makeTestDb()
    const only = importOk(db, {
      sourceName: 'repeat.txt',
      bytes: bytesOf('要求:细心。\n其他:认真。\n要求:细心。\n')
    })
    const normText = normTextOf(db, only.documentId)
    const quote = '要求:细心。'
    const hits = occurrencesOf(normText, quote)
    expect(hits).toHaveLength(2)
    expect(hits[0]).not.toBe(hits[1])
    // 每个 offset 起点的码点切片都逐字等于 quote:两处都是合法定位,
    // 只给 quote 无法区分,服务端必须要求显式 offset(或拒绝该证据)
    const chars = Array.from(normText)
    for (const start of hits) {
      const end = start + Array.from(quote).length
      expect(chars.slice(start, end).join('')).toBe(quote)
    }
  })
})

// ---------- 5. 特性语料与幂等、损坏字节 ----------

describe('BOM/CRLF/NFD/emoji 与幂等、损坏字节', () => {
  it('BOM 剥离、CRLF 转 LF、NFD 合并、emoji 按码点计长(UTF-16 下标与码点数不同)', async () => {
    const db = await makeTestDb()
    const bom = importOk(db, {
      sourceName: 'bom.txt',
      bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytesOf('样例岗位A\r\n要求:Python。\r\n')])
    })
    const normBom = normTextOf(db, bom.documentId)
    expect(normBom.startsWith('样例岗位A')).toBe(true)
    expect(normBom).not.toContain('\r')

    const nfd = importOk(db, { sourceName: 'nfd.txt', bytes: bytesOf('样例岗位B\n\n要求:掌握 cafe\u0301 拉花。\n') })
    const normNfd = normTextOf(db, nfd.documentId)
    expect(normNfd).toContain('café')

    const emoji = importOk(db, { sourceName: 'emoji.txt', bytes: bytesOf('样例岗位C\n\n要求:沟通 🙌 顺畅。\n') })
    const normEmoji = normTextOf(db, emoji.documentId)
    expect(Array.from(normEmoji).length).toBeLessThan(normEmoji.length)
  })

  it('相同文件不同名称:raw_sha256 幂等去重,返回既有快照不新建', async () => {
    const db = await makeTestDb()
    const payload = bytesOf('样例岗位D\n\n要求:Python。\n')
    const first = importOk(db, { sourceName: 'original.txt', bytes: payload })
    const again = importOk(db, { sourceName: 'renamed-copy.txt', bytes: payload })
    expect(again.documentId).toBe(first.documentId)
    expect(again.deduped).toBe(true)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM retrieval_documents')!.n).toBe(1)
  })

  it('损坏字节明确报错(不用替换字符悄悄导入),有效文件不受影响', async () => {
    const db = await makeTestDb()
    const bad = Buffer.from([0x61, 0xff, 0xfe, 0x62]) // 非法 UTF-8 序列
    const outcomes = importResearchSources(db, {
      sources: [
        { sourceName: 'broken.txt', bytes: bad },
        { sourceName: 'good.txt', bytes: bytesOf('样例岗位E\n\n要求:Python。\n') }
      ],
      clock: FIXED_CLOCK
    })
    const broken = failOf(outcomes[0]!)
    expect(broken.error.code).toBe('DOCUMENT_PARSE_ERROR')
    expect(broken.error.message).toContain('UTF-8')
    expect(outcomes[1]!.ok).toBe(true)
  })

  it('JSON/CSV 结构错误报 DOCUMENT_PARSE_ERROR;批量超过 100 文件拒绝;空文件拒绝', async () => {
    const db = await makeTestDb()
    const bad = failOf(importResearchSources(db, {
      sources: [{ sourceName: 'bad.json', bytes: bytesOf('{not-json') }],
      clock: FIXED_CLOCK
    })[0]!)
    expect(bad.error.code).toBe('DOCUMENT_PARSE_ERROR')

    const noHeader = failOf(importResearchSources(db, {
      sources: [{ sourceName: 'noheader.csv', bytes: bytesOf('只有一行没有逗号\n') }],
      clock: FIXED_CLOCK
    })[0]!)
    expect(noHeader.error.code).toBe('DOCUMENT_PARSE_ERROR')

    const empty = failOf(importResearchSources(db, {
      sources: [{ sourceName: 'empty.txt', bytes: Buffer.alloc(0) }],
      clock: FIXED_CLOCK
    })[0]!)
    expect(empty.error.code).toBe('DOCUMENT_PARSE_ERROR')

    const overflow = Array.from({ length: IMPORT_BATCH_LIMIT + 1 }, (_, i) => ({
      sourceName: `f${i}.txt`,
      bytes: bytesOf(`文件${i}`)
    }))
    expect(() => importResearchSources(db, { sources: overflow, clock: FIXED_CLOCK })).toThrow(/100/)
  })

  it('更换原始文件(同名不同字节)不改变历史快照:旧行保持原 hash 与原文本,重导旧字节幂等回旧行', async () => {
    const db = await makeTestDb()
    const firstBytes = bytesOf('样例岗位F 第一版\n\n要求:Python。\n')
    const first = importOk(db, { sourceName: 'jd.txt', bytes: firstBytes })
    const before = db.get<{ normalized_text: string; text_sha256: string; raw_sha256: string }>(
      'SELECT normalized_text, text_sha256, raw_sha256 FROM retrieval_documents WHERE document_id = ?',
      [first.documentId]
    )!
    // 内容变化的"同名"文件:raw_sha256 不同 → 新行,旧行不动
    const second = importOk(db, { sourceName: 'jd.txt', bytes: bytesOf('样例岗位F 第二版\n\n要求:Python 与 SQL。\n') })
    expect(second.documentId).not.toBe(first.documentId)
    const after = db.get<{ normalized_text: string; text_sha256: string; raw_sha256: string }>(
      'SELECT normalized_text, text_sha256, raw_sha256 FROM retrieval_documents WHERE document_id = ?',
      [first.documentId]
    )!
    expect(after).toEqual(before)
    // 重导旧文件字节仍幂等回到第一行
    const replay = importOk(db, { sourceName: 'jd.txt', bytes: firstBytes })
    expect(replay.documentId).toBe(first.documentId)
    expect(replay.deduped).toBe(true)
  })
})

// ---------- 6. 来源分组 ----------

describe('来源分组(provenance)', () => {
  it('同一 JD 的转载/副本归入同组;不同岗位相似模板不同组', async () => {
    const db = await makeTestDb()
    const jd = {
      title: '样例岗位内容审核实习生',
      company: '样例岗位 审核中心',
      location: '福州',
      description: '负责样例内容审核。\n要求:细致耐心。\n',
      source_url: 'https://careers.example.invalid/jobs/pg-src',
      published_at: '2026-04-01'
    }
    // 转载:核心字段相同,仅 URL 与发布日期不同
    const repost = { ...jd, source_url: 'https://careers.example.invalid/jobs/pg-repost', published_at: '2026-04-03' }
    // 相似模板的不同岗位:同一公司、同模板句式,但 title/location/description 内容不同
    const otherRole = {
      title: '样例岗位内容标注实习生',
      company: '样例岗位 审核中心',
      location: '厦门',
      description: '负责样例数据标注。\n要求:细致耐心。\n',
      source_url: 'https://careers.example.invalid/jobs/pg-other',
      published_at: '2026-04-05'
    }
    const outcomes = okOf(
      importResearchSources(db, {
        sources: [
          { sourceName: 'src.json', bytes: bytesOf(JSON.stringify(jd)) },
          { sourceName: 'repost.json', bytes: bytesOf(JSON.stringify(repost)) },
          { sourceName: 'other.json', bytes: bytesOf(JSON.stringify(otherRole)) }
        ],
        clock: FIXED_CLOCK
      })
    )
    expect(outcomes).toHaveLength(3)
    const [src, rp, other] = outcomes
    // 转载副本同组(relation=copy)
    expect(rp!.provenanceGroupId).toBe(src!.provenanceGroupId)
    expect(rp!.provenanceRelation).toBe('copy')
    expect(rp!.sourceIdentity).toBe(src!.sourceIdentity)
    // 不同岗位相似模板:identity 不同,绝不合并
    expect(other!.sourceIdentity).not.toBe(src!.sourceIdentity)
    expect(other!.provenanceGroupId).not.toBe(src!.provenanceGroupId)
    expect(other!.provenanceRelation).toBe('unknown')
    // 首条为 unknown(无既有传播信息)
    expect(src!.provenanceRelation).toBe('unknown')
  })

  it('声明式分组(provenanceGroupId)直接采用调用方指定的组', async () => {
    const db = await makeTestDb()
    const outcomes = okOf(
      importResearchSources(db, {
        sources: [
          { sourceName: 'a.txt', bytes: bytesOf('样例岗位G\n\n要求:Python。\n'), provenanceGroupId: 'pg-eval-1' },
          { sourceName: 'b.txt', bytes: bytesOf('样例岗位G(转载)\n\n要求:Python。\n'), provenanceGroupId: 'pg-eval-1' }
        ],
        clock: FIXED_CLOCK
      })
    )
    expect(outcomes[0]!.provenanceGroupId).toBe('pg-eval-1')
    expect(outcomes[1]!.provenanceGroupId).toBe('pg-eval-1')
    expect(outcomes[1]!.provenanceRelation).toBe('declared')
  })

  it('md/txt 来源身份:字节相同回既有快照;改写正文不自动合并,contentKey 声明等价后才并组;title 不同不合并', async () => {
    const db = await makeTestDb()
    const body = '样例岗位H\n\n要求:Python。\n'
    const a = importOk(db, { sourceName: 'a.md', title: '样例岗位H', bytes: bytesOf(body) })
    // 字节相同 → raw_sha256 幂等去重(与 C-05 契约一致):回同一快照,不产生第二行
    const sameBytes = importOk(db, { sourceName: 'a-renamed.md', title: '样例岗位H', bytes: bytesOf(body) })
    expect(sameBytes.documentId).toBe(a.documentId)
    expect(sameBytes.deduped).toBe(true)
    // 内容不同但 title 相同(转载改写):身份相同但核心内容 hash 不同 → 不自动合并(unknown)
    const b = importOk(db, {
      sourceName: 'b.txt',
      title: '样例岗位H',
      bytes: bytesOf('样例岗位H(转载)\n\n要求:Python。\n')
    })
    expect(b.documentId).not.toBe(a.documentId)
    expect(b.provenanceGroupId).not.toBe(a.provenanceGroupId)
    expect(b.provenanceRelation).toBe('unknown')
    // 调用方以 contentKey 声明"剥离转载标记后同正文"(人工确认过的等价) → 并组(copy)
    const c = importOk(db, {
      sourceName: 'c.txt',
      title: '样例岗位H',
      bytes: bytesOf('样例岗位H(二次转发)\n\n要求:Python。\n'),
      contentKey: body
    })
    expect(c.provenanceGroupId).toBe(a.provenanceGroupId)
    expect(c.provenanceRelation).toBe('copy')
    // title 不同 → 身份不同,绝不合并
    const d = importOk(db, { sourceName: 'd.md', title: '样例岗位I', bytes: bytesOf('样例岗位I\n\n要求:Python。\n') })
    expect(d.provenanceGroupId).not.toBe(a.provenanceGroupId)
  })
})

// ---------- 7. 端到端:导入 → 创建运行 → span 写入 → 清单复核 ----------

describe('端到端:导入、运行创建、span 与清单复核', () => {
  it('研究运行引用导入快照;清单条目含 R-02 扩展字段;evidence span 落库后清单复核通过', async () => {
    const db = await makeTestDb()
    const { runId, imported } = seedRun(db, [{
      sourceName: 'e2e.json',
      bytes: bytesOf(JSON.stringify({
        title: '样例岗位端到端岗',
        company: '样例岗位 集成部',
        location: '南宁',
        description: '负责端到端联调。\n要求:会 Python。\n',
        source_url: 'https://careers.example.invalid/jobs/snap-h',
        published_at: '2026-05-01'
      }))
    }])
    const task = getResearchTaskByRun(db, runId)!
    const manifest = verifySnapshotManifest(db, task.snapshotManifestId)
    expect(manifest.entries).toHaveLength(1)
    const entry = manifest.entries[0]!
    expect(entry.snapshot_id).toBe(imported[0]!.documentId)
    expect(entry.source_identity).toBe(imported[0]!.sourceIdentity)
    expect(entry.provenance_group_id).toBe(imported[0]!.provenanceGroupId)
    expect(entry.collection_time_basis).toBe('imported')

    const sub = createSubQuestion(db, runId, { ordinal: 1, question: '该岗位是否要求 Python?' })
    const chunks = chunksOf(db, imported[0]!.documentId)
    const normText = normTextOf(db, imported[0]!.documentId)
    const start = occurrencesOf(normText, '要求:会 Python。')[0]!
    const end = start + Array.from('要求:会 Python。').length
    const covering = chunks.find((c) => c.startOffset <= start && end <= c.endOffset)
    expect(covering).toBeDefined()
    const span = createEvidenceSpan(db, runId, sub.subquestionId, {
      snapshot_id: imported[0]!.documentId,
      chunk_id: covering!.chunk_id,
      start_offset: start,
      end_offset: end,
      quote: '要求:会 Python。'
    })
    // span 从持久化数据可重定位(引用检查的同一逻辑)
    const stored = db.get<{ normalized_text: string }>(
      `SELECT d.normalized_text FROM research_evidence_spans s
       JOIN retrieval_documents d ON d.document_id = s.snapshot_id WHERE s.evidence_id = ?`,
      [span.evidenceId]
    )!
    expect(Array.from(stored.normalized_text).slice(start, end).join('')).toBe('要求:会 Python。')
    // span 落库不影响清单复核(清单只冻结快照与元数据)
    expect(verifySnapshotManifest(db, task.snapshotManifestId).manifestSha256).toBe(manifest.manifestSha256)
  })
})

// ---------- 8. 规范化 golden fixture ----------

describe('规范化 golden fixture(fixtures/research/normalization)', () => {
  interface GoldenAnchor {
    quote: string
    start_offset: number
    end_offset: number
    occurrences: number
  }
  interface GoldenEntry {
    file: string
    raw_sha256: string
    text_sha256: string
    code_points: number
    normalized_text: string
    anchors: GoldenAnchor[]
  }
  const golden = JSON.parse(readFileSync(join(NORM_DIR, 'golden.expected.json'), 'utf-8')) as {
    normalization_version: number
    entries: GoldenEntry[]
  }

  it('五类样例(BOM+CRLF、NFD、emoji、JSON 投影、CSV 投影)规范化全文逐字一致、双 hash 匹配、锚点唯一命中', async () => {
    expect(golden.normalization_version).toBe(1)
    expect(golden.entries.length).toBe(5)
    const db = await makeTestDb()
    for (const entry of golden.entries) {
      const raw = readFileSync(join(NORM_DIR, entry.file))
      expect(raw.length).toBeGreaterThan(0)

      // raw_sha256 对导入字节(文件在仓库中不被改动)
      expect(
        importResearchSources(db, { sources: [{ sourceName: entry.file, bytes: raw }], clock: FIXED_CLOCK })[0]
      ).toMatchObject({ ok: true, rawSha256: entry.raw_sha256 })

      // text_sha256 与规范全文逐字一致(码点视角)
      const doc = db.get<{ document_id: string; text_sha256: string; normalized_text: string }>(
        'SELECT document_id, text_sha256, normalized_text FROM retrieval_documents WHERE source_name = ? ORDER BY rowid DESC LIMIT 1',
        [entry.file]
      )!
      expect(doc.text_sha256).toBe(entry.text_sha256)
      expect(Array.from(doc.normalized_text).join('')).toBe(Array.from(entry.normalized_text).join(''))
      expect(Array.from(doc.normalized_text).length).toBe(entry.code_points)

      // offset 标定点:逐锚点切片 === quote,且在全文中恰好命中一处
      for (const anchor of entry.anchors) {
        expect(occurrencesOf(doc.normalized_text, anchor.quote), `锚点应唯一命中:${anchor.quote}`).toHaveLength(1)
        const slice = Array.from(doc.normalized_text).slice(anchor.start_offset, anchor.end_offset).join('')
        expect(slice, `${entry.file} [${anchor.start_offset},${anchor.end_offset})`).toBe(anchor.quote)
      }
    }
  })
})
