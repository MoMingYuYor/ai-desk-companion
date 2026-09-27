// R-07(可提前部分):research_v1 数据集与 gold 标注的静态完整性测试。
//
// 本测试不接入 Eval Runner,只做材料级校验:
// 1. 40 条、dev 24 / holdout 16、六组数量与冻结拆分一致;
// 2. loadDatasetFromDir 通过 loader 全部检测(manifest 一致、重复 id、跨 split 泄漏、缺 gold);
// 3. 每条 gold 证据可按规范化 v1 流程在规范全文中精确定位:
//    Array.from(normText).slice(start, end).join('') === quote 且 text_sha256 一致;
//    offset 越界、quote 多处命中视为失败;
// 4. 注入组 forbidden_actions 非空(且覆盖三类禁用动作);
// 5. 重复组:同 provenance_group 的样例不跨 split,且 duplicate-004 共模板不同岗位分属不同组;
// 6. 冲突组 gold 分别含 supports 与 contradicts 且声明 conflict_flags;
//    证据不足组 gold_claims 为空并以 tags 承载 missing 语义(E-01 注释)。
//
// 运行环境:默认 node(vitest.config.ts environment: 'node')。
// 本测试为纯文本校验,不建库;如需入库参照 tests/helpers.ts(本文件未使用)。
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  decodeBytes,
  normalizePlainText,
  projectJsonSource,
  sha256Hex,
  textSha256
} from '../../src/main/retrieval/normalize'
import { loadDatasetFromDir } from '../../src/main/evals/dataset'

const ROOT = process.cwd()
const DATA_DIR = join(ROOT, 'evals', 'datasets', 'research_v1')
const FIX_DIR = join(ROOT, 'fixtures', 'research')

/** 单文件语料的规范化全文(与 gold 生成/导入器 v1 同一重放契约) */
function canonOf(bytes: Buffer, fileName: string): string {
  if (fileName.endsWith('.json')) {
    return normalizePlainText(projectJsonSource(bytes.toString('utf8')))
  }
  if (fileName.endsWith('.csv')) {
    return normalizePlainText(csvProject(bytes.toString('utf8')))
  }
  return normalizePlainText(decodeBytes(bytes).text)
}

/**
 * CSV 投影:表头 + 数据行按列序展平;RFC 4180 引号语义(双写转义、
 * 引号内逗号/换行保留为记录内文本)。语料仅使用 LF 行尾与无 BOM UTF-8。
 */
function csvProject(content: string): string {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]!
    if (inQuotes) {
      if (ch === '"' && content[i + 1] === '"') {
        field += '"'
        i += 1
      } else if (ch === '"') {
        inQuotes = false
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  const [head, ...data] = rows
  if (!head || data.length === 0) throw new Error('CSV 缺少表头或数据行')
  const out: string[] = [...head]
  for (const r of data) out.push(...r)
  return out.join('\n')
}

interface GoldEvidence {
  snapshot_id: string
  text_sha256: string
  start_offset: number
  end_offset: number
  quote: string
  relation: 'supports' | 'contradicts'
  provenance_group_id: string
}

interface GoldClaim {
  gold_claim_id: string
  text: string
  acceptable_evidence_sets: GoldEvidence[][]
}

interface GoldAnnotation {
  schema_version: string
  case_id: string
  group: string
  split: 'dev' | 'holdout'
  input: string
  gold_claims: GoldClaim[]
  conflict_flags: string[]
  missing_requirements: string[]
  fabrication_bans: string[]
  forbidden_actions: string[]
  annotation: { status: string; guideline_version: string }
}

interface SnapshotManifest {
  fixture_id: string
  case_id: string
  normalization_version: number
  entries: Array<{ file: string; raw_sha256: string; text_sha256: string }>
}

const GROUPS = ['单文档定位', '跨文档综合', '冲突', '证据不足', '提示注入', '重复来源'] as const
const EXPECTED_GROUP_COUNTS: Record<string, { total: number; dev: number; holdout: number }> = {
  单文档定位: { total: 10, dev: 6, holdout: 4 },
  跨文档综合: { total: 10, dev: 6, holdout: 4 },
  冲突: { total: 5, dev: 3, holdout: 2 },
  证据不足: { total: 5, dev: 3, holdout: 2 },
  提示注入: { total: 5, dev: 3, holdout: 2 },
  重复来源: { total: 5, dev: 3, holdout: 2 }
}

describe('research_v1 数据集与 gold 完整性(R-07 静态部分)', () => {
  const loaded = loadDatasetFromDir(DATA_DIR)
  const { manifest, cases, dev, holdout } = loaded

  const caseIds = cases.map((c) => c.case_id)
  const golds = new Map<string, GoldAnnotation>()
  for (const id of caseIds) {
    const p = join(DATA_DIR, 'annotations', `${id}.json`)
    expect(existsSync(p), `缺少 gold 标注文件:${id}`).toBe(true)
    golds.set(id, JSON.parse(readFileSync(p, 'utf-8')) as GoldAnnotation)
  }

  it('共 40 条,dev 24 / holdout 16,六组数量与冻结拆分一致', () => {
    expect(cases.length).toBe(40)
    expect(dev.length).toBe(24)
    expect(holdout.length).toBe(16)
    const counts: Record<string, { total: number; dev: number; holdout: number }> = {}
    for (const c of cases) {
      counts[c.category] ??= { total: 0, dev: 0, holdout: 0 }
      counts[c.category]!.total += 1
      counts[c.category]![c.split] += 1
    }
    expect(Object.keys(counts).sort()).toEqual([...GROUPS].sort())
    for (const [group, expected] of Object.entries(EXPECTED_GROUP_COUNTS)) {
      expect(counts[group], `分组 ${group} 数量不符`).toEqual(expected)
    }
    // manifest 与实际一致由 loader 校验;此处再核对 manifest 声明本身
    for (const [group, expected] of Object.entries(EXPECTED_GROUP_COUNTS)) {
      expect(manifest.categories[group]).toEqual(expected)
    }
    expect(manifest.dataset_version).toBe('research_v1')
    expect(manifest.provenance).toContain('人工构造')
  })

  it('loader 全部检测通过:manifest 一致、无重复 id、无跨 split 输入泄漏、写类不缺 gold', () => {
    // loadDatasetFromDir 在 describe 顶部已执行,任何检测失败都会抛错;
    // 这里显式断言终值,保证失败信息可读。
    expect(loaded.casesSha256).toBe(manifest.cases_sha256)
    const ids = new Set(caseIds)
    expect(ids.size).toBe(40)
    expect(caseIds.every((id) => id.startsWith('research-'))).toBe(true)
    expect(cases.every((c) => c.mode === 'research')).toBe(true)
    expect(cases.every((c) => c.dataset_version === 'research_v1')).toBe(true)
  })

  it('四类语料格式(.md/.txt/.json/.csv)均出现在快照目录,且 fixtures 与 snapshots 副本逐字节一致', () => {
    const exts = new Set<string>()
    for (const c of cases) {
      const fixDir = join(FIX_DIR, c.fixture_id)
      const snapDir = join(DATA_DIR, 'snapshots', c.fixture_id)
      expect(existsSync(fixDir), `缺少语料目录 fixtures/research/${c.fixture_id}`).toBe(true)
      expect(existsSync(snapDir), `缺少快照目录 snapshots/${c.fixture_id}`).toBe(true)
      const files = readdirSync(fixDir)
      for (const f of files) {
        exts.add(f.split('.').pop()!)
        const a = readFileSync(join(fixDir, f))
        const b = readFileSync(join(snapDir, f))
        expect(a.equals(b), `fixtures 与 snapshots 副本不一致:${c.fixture_id}/${f}`).toBe(true)
      }
      expect(readdirSync(snapDir).sort()).toEqual([...files, 'manifest.json'].sort())
    }
    expect(exts.has('md')).toBe(true)
    expect(exts.has('txt')).toBe(true)
    expect(exts.has('json')).toBe(true)
    expect(exts.has('csv')).toBe(true)
  })

  describe('gold 证据精确定位(重放规范化 v1)', () => {
    const normCache = new Map<string, string>()

    function normTextOf(fixtureId: string, file: string): string {
      const key = `${fixtureId}/${file}`
      let text = normCache.get(key)
      if (text === undefined) {
        const bytes = readFileSync(join(FIX_DIR, fixtureId, file))
        text = canonOf(bytes, file)
        normCache.set(key, text)
      }
      return text
    }

    function verifyEvidence(fixtureId: string, e: GoldEvidence): void {
      const [snapFixture, snapFile] = e.snapshot_id.split('/')
      expect(snapFixture, `snapshot_id 的 fixture 部分应为 ${fixtureId}`).toBe(fixtureId)
      const norm = normTextOf(fixtureId, snapFile!)

      // text_sha256 与规范全文一致
      expect(e.text_sha256, `text_sha256 不一致:${e.snapshot_id}`).toBe(textSha256(norm))

      // offset 合法且切片逐字相等(码点视角)
      const chars = Array.from(norm)
      expect(e.start_offset, `start_offset 越界(负数):${e.snapshot_id}`).toBeGreaterThanOrEqual(0)
      expect(
        e.end_offset,
        `end_offset 越界:${e.snapshot_id} [${e.start_offset},${e.end_offset}) 长度 ${chars.length}`
      ).toBeLessThanOrEqual(chars.length)
      expect(e.start_offset).toBeLessThan(e.end_offset)
      const slice = chars.slice(e.start_offset, e.end_offset).join('')
      expect(slice, `offset 切片与 quote 不一致:${e.snapshot_id}`).toBe(e.quote)

      // quote 在规范全文中恰好命中一处(多处命中视为定位失败;码点视角逐位比较)
      const qChars = Array.from(e.quote)
      let hits = 0
      for (let i = 0; i + qChars.length <= chars.length; i += 1) {
        let ok = true
        for (let j = 0; j < qChars.length; j += 1) {
          if (chars[i + j] !== qChars[j]) {
            ok = false
            break
          }
        }
        if (ok) hits += 1
      }
      expect(hits, `quote 应在规范全文中唯一命中,实际 ${hits} 处:${e.quote}`).toBe(1)

      // relation 与 provenance_group_id 形态
      expect(['supports', 'contradicts']).toContain(e.relation)
      expect(e.provenance_group_id).toMatch(/^pg-/)
    }

    it('每条 gold 证据均可定位且 hash 一致;越界/多处命中即失败', () => {
      let evidenceCount = 0
      for (const c of cases) {
        const g = golds.get(c.case_id)!
        expect(g.case_id).toBe(c.case_id)
        expect(g.split).toBe(c.split)
        expect(g.group).toBe(c.category)
        expect(g.annotation.guideline_version).toBe('research-gold.v1')
        expect(g.annotation.status).toBe('adjudicated')
        for (const claim of g.gold_claims) {
          expect(claim.acceptable_evidence_sets.length, `gold claim ${claim.gold_claim_id} 至少一个证据集合`).toBeGreaterThan(0)
          for (const set of claim.acceptable_evidence_sets) {
            expect(set.length, `gold claim ${claim.gold_claim_id} 每个集合至少一条证据`).toBeGreaterThan(0)
            for (const e of set) {
              verifyEvidence(c.fixture_id, e)
              evidenceCount += 1
            }
          }
        }
      }
      expect(evidenceCount).toBeGreaterThan(40)
    })

    it('emoji / CRLF / BOM / NFD 特性语料的 offset 以码点计且可精确切片', () => {
      // emoji(locate-003):quote 含 U+1F64C,UTF-16 下标与码点下标不同
      const emojiNorm = normTextOf('locate-003', 'jd.txt')
      expect(Array.from(emojiNorm).some((ch) => ch.codePointAt(0)! > 0xffff)).toBe(true)
      // CRLF(locate-006)规范化后只剩 LF
      const crlfNorm = normTextOf('locate-006', 'jd.txt')
      expect(crlfNorm).not.toContain('\r')
      expect(crlfNorm).toContain('\n')
      // BOM(locate-007)被剥离
      const bomBytes = readFileSync(join(FIX_DIR, 'locate-007', 'jd.txt'))
      expect(bomBytes[0]).toBe(0xef)
      expect(normTextOf('locate-007', 'jd.txt').startsWith('样例岗位')).toBe(true)
      // NFD 分解形态(locate-006:café 的 e + U+0301)规范化后合并
      const nfdBytes = readFileSync(join(FIX_DIR, 'locate-006', 'jd.txt'))
      const nfdRaw = normalizePlainText(decodeBytes(nfdBytes).text)
      expect(nfdRaw).toContain('caf\u00e9')
    })

    it('JSON 语料按 projectJsonSource 投影后定位;CSV 按列序投影后定位', () => {
      // JSON:locate-005 的 gold 引用投影文本中的整行
      const jsonNorm = normTextOf('locate-005', 'jd.json')
      expect(jsonNorm.split('\n')).toContain('负责检索增强生成(RAG)与模型上下文协议(MCP)工具链开发。')
      const locate005 = golds.get('research-locate-005')!
      for (const set of locate005.gold_claims[0]!.acceptable_evidence_sets) {
        for (const e of set) {
          const chars = Array.from(jsonNorm)
          expect(chars.slice(e.start_offset, e.end_offset).join('')).toBe(e.quote)
        }
      }
      // CSV:cross-001 的 gold 引用列序投影文本
      const csvNorm = normTextOf('cross-001', 'data_engineer.csv')
      expect(csvNorm.split('\n')).toContain('精通 Python 与常用数据 ETL 库。')
    })
  })

  it('冲突组:gold 同时含 supports 与 contradicts 证据,且声明 conflict_flags', () => {
    const conflictCases = cases.filter((c) => c.category === '冲突')
    expect(conflictCases.length).toBe(5)
    for (const c of conflictCases) {
      const g = golds.get(c.case_id)!
      const relations = g.gold_claims.flatMap((cl) =>
        cl.acceptable_evidence_sets.flat().map((e) => e.relation)
      )
      expect(relations, `${c.case_id} 应含 supports 证据`).toContain('supports')
      expect(relations, `${c.case_id} 应含 contradicts 证据`).toContain('contradicts')
      expect(g.conflict_flags.length, `${c.case_id} 必须声明冲突标志`).toBeGreaterThan(0)
      expect(c.tags, `${c.case_id} 的 EvalCase tags 应承载冲突语义`).toContain('has-conflict-flag')
    }
  })

  it('证据不足组:gold_claims 为空,tags 承载 missing 语义,并给出禁止编造项', () => {
    const insuffCases = cases.filter((c) => c.category === '证据不足')
    expect(insuffCases.length).toBe(5)
    for (const c of insuffCases) {
      const g = golds.get(c.case_id)!
      expect(g.gold_claims, `${c.case_id} 允许 gold_claims 为空`).toHaveLength(0)
      expect(c.tags.some((t) => t.startsWith('missing:')), `${c.case_id} 缺少 missing 语义 tag`).toBe(true)
      expect(g.missing_requirements.length, `${c.case_id} 必须列出缺失项`).toBeGreaterThan(0)
      expect(g.fabrication_bans.length, `${c.case_id} 必须给出禁止编造项`).toBeGreaterThan(0)
    }
    const missingKinds = insuffCases.map((c) => c.tags.find((t) => t.startsWith('missing:')))
    expect(missingKinds).toContain('missing:salary')
    expect(missingKinds).toContain('missing:education')
    expect(missingKinds).toContain('missing:region')
  })

  it('提示注入组:forbidden_actions 非空且覆盖三类禁用动作', () => {
    const injectionCases = cases.filter((c) => c.category === '提示注入')
    expect(injectionCases.length).toBe(5)
    for (const c of injectionCases) {
      const g = golds.get(c.case_id)!
      expect(g.forbidden_actions.length, `${c.case_id} forbidden_actions 非空`).toBeGreaterThan(0)
      for (const act of ['todo.create', 'http.fetch', 'shell.exec']) {
        expect(g.forbidden_actions, `${c.case_id} 应禁止 ${act}`).toContain(act)
        expect(c.expected.forbidden_tools, `${c.case_id} 的 EvalCase expected.forbidden_tools 应含 ${act}`).toContain(act)
      }
      expect(g.gold_claims.length, `${c.case_id} 注入组仍需可定位的正常命题证据`).toBeGreaterThan(0)
    }
  })

  it('重复来源组:同 provenance_group 样例不跨 split;共模板不同岗位分属不同组', () => {
    const dupCases = cases.filter((c) => c.category === '重复来源')
    expect(dupCases.length).toBe(5)

    // 1. 每条重复案例内部:若同一 split 内多份材料共享 provenance_group,
    //    其证据 snapshot 必须同 split;任何组不得同时出现在 dev 与 holdout 案例。
    const pgToSplits = new Map<string, Set<'dev' | 'holdout'>>()
    for (const c of dupCases) {
      const g = golds.get(c.case_id)!
      for (const claim of g.gold_claims) {
        for (const set of claim.acceptable_evidence_sets) {
          for (const e of set) {
            const splits = pgToSplits.get(e.provenance_group_id) ?? new Set<'dev' | 'holdout'>()
            splits.add(c.split)
            pgToSplits.set(e.provenance_group_id, splits)
          }
        }
      }
    }
    for (const [pg, splits] of pgToSplits) {
      expect(splits.size, `provenance_group ${pg} 跨 split 泄漏`).toBe(1)
    }

    // 2. duplicate-004:同一 fixture 内两份同模板不同岗位,证据级 pg 必须不同组
    const g4 = golds.get('research-duplicate-004')!
    const pgs = new Set(g4.gold_claims.flatMap((cl) => cl.acceptable_evidence_sets.flat().map((e) => e.provenance_group_id)))
    expect(pgs.has('pg-tpl-a')).toBe(true)
    expect(pgs.has('pg-tpl-b')).toBe(true)
    expect(pgs.size).toBe(2)

    // 3. 转载类案例(duplicate-001/002/003/005):同组 pg 必须存在且不跨 split
    const repostGroups = ['pg-dup-1', 'pg-dup-2', 'pg-dup-3', 'pg-dup-5']
    for (const pg of repostGroups) {
      const splits = pgToSplits.get(pg)
      expect(splits, `转载组 ${pg} 应存在于重复来源案例中`).toBeDefined()
      expect(splits!.size).toBe(1)
    }
  })

  it('泄漏自查:近重复文本与同岗位衍生样例不跨 dev/holdout(除 loader 的输入归一化检测外再按 fixture 分组核查)', () => {
    // loader 已保证:归一化输入(去空白)不得跨 split。
    // 这里补充:同一 fixture_id 只出现在一个 split;六组内部逐组核对。
    const fixtureToSplits = new Map<string, Set<'dev' | 'holdout'>>()
    for (const c of cases) {
      const splits = fixtureToSplits.get(c.fixture_id) ?? new Set<'dev' | 'holdout'>()
      splits.add(c.split)
      fixtureToSplits.set(c.fixture_id, splits)
    }
    for (const [fixtureId, splits] of fixtureToSplits) {
      expect(splits.size, `fixture ${fixtureId} 跨 split 泄漏`).toBe(1)
    }
    // 每个案例有唯一 fixture,fixture 数与案例数一致(同岗位衍生材料收敛在单 fixture 内)
    expect(fixtureToSplits.size).toBe(40)
    for (const group of GROUPS) {
      const groupCases = cases.filter((c) => c.category === group)
      const fixtures = groupCases.map((c) => c.fixture_id)
      expect(new Set(fixtures).size, `分组 ${group} 的 fixture 应一一对应案例`).toBe(fixtures.length)
    }
  })

  it('快照 manifest 的 raw/text sha256 与文件实际重放结果一致', () => {
    for (const c of cases) {
      const snapManifestPath = join(DATA_DIR, 'snapshots', c.fixture_id, 'manifest.json')
      expect(existsSync(snapManifestPath), `缺少快照清单:${c.fixture_id}`).toBe(true)
      const snapManifest = JSON.parse(readFileSync(snapManifestPath, 'utf-8')) as SnapshotManifest
      expect(snapManifest.fixture_id).toBe(c.fixture_id)
      expect(snapManifest.normalization_version).toBe(1)
      const files = readdirSync(join(FIX_DIR, c.fixture_id))
      expect(snapManifest.entries.map((e) => e.file).sort()).toEqual([...files].sort())
      for (const entry of snapManifest.entries) {
        const bytes = readFileSync(join(FIX_DIR, c.fixture_id, entry.file))
        expect(entry.raw_sha256, `raw_sha256 不一致:${c.fixture_id}/${entry.file}`).toBe(sha256Hex(bytes))
        expect(entry.text_sha256, `text_sha256 不一致:${c.fixture_id}/${entry.file}`).toBe(textSha256(canonOf(bytes, entry.file)))
      }
    }
  })

  it('语料零真实数据自查:域名全部为 example.invalid/样例占位,无手机号等联系方式', () => {
    for (const c of cases) {
      const dir = join(FIX_DIR, c.fixture_id)
      for (const f of readdirSync(dir)) {
        const raw = readFileSync(join(dir, f), 'utf-8')
        // URL 只允许 example.invalid 保留域
        const urls = raw.match(/https?:\/\/[^\s\)"\]]+/g) ?? []
        for (const u of urls) {
          expect(u, `发现非保留域 URL:${u}(${c.fixture_id}/${f})`).toMatch(/^https?:\/\/[a-z0-9.-]+\.example\.invalid/)
        }
        // 公司名仅允许「样例岗位」系
        const companies = raw.match(/"company":\s*"([^"]*)"/g) ?? []
        for (const comp of companies) {
          expect(comp, `JSON company 字段应为样例岗位系:${comp}`).toContain('样例岗位')
        }
        // 不含 11 位手机号形态
        expect(raw, `疑似手机号:${c.fixture_id}/${f}`).not.toMatch(/1[3-9]\d{9}/)
        // 不含常见真实招聘域名
        expect(raw.toLowerCase()).not.toMatch(/zhipin|lagou|51job|boss直聘|linkedin|indeed/)
      }
    }
  })
})
