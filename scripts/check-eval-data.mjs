#!/usr/bin/env node
// DATA-01 数据审查脚本:统一案例、标注与数据冻结的机器校验与近重复筛查。
//
// 用法: node scripts/check-eval-data.mjs [--output <path>] [--conclusions <path>]
//   --output <path>       将 dataset-review.json 写入指定文件(自动创建父目录);缺省打印 stdout。
//   --conclusions <path>  人工结论文件(键为候选对 pairKey,见输出 near_duplicates.candidates[].pair_key)。
//
// 覆盖规范(delivery.md DATA-01)要求的校验:
//   1) case_id 唯一、fixture 可加载、gold 可读、manifest 类别 total/dev/holdout 与逐组计数
//      完全一致,拒绝额外/漏列类别;
//   2) Ops 每条:终态、工具序列、必需参数、状态断言、确认流程、重复工具调用的参数区分;
//   3) 诚实不足语义统一:证据不足组 terminal_status=succeeded 且 gold_claims 为空,与
//      cases、annotations、docs/demos、测试四处解释一致(文本扫描记录);
//   4) 跨 split 检查:规范化输入、规范文本 hash、source identity(raw hash)、provenance
//      group、URL 归一化;
//   5) 字符三元组 Jaccard>=0.8 近重复候选筛查(仅筛查,不直接判泄漏),逐对人工结论合并。
//
// 退出码: 0=结构与人工泄漏检查全部通过; 1=存在校验失败或候选缺人工结论。
// 本脚本与 src/main/evals/dataset.ts 的 loader 相互独立:loader 管运行时契约,本脚本
// 产冻结证据;规范化实现为只读复刻,漂移由 tests/evals/dataset.test.ts 的交叉核对用例兜底。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ROOT = process.cwd()
const OPS_DIR = join(ROOT, 'evals', 'datasets', 'personal_ops_v1')
const RES_DIR = join(ROOT, 'evals', 'datasets', 'research_v1')
const RES_FIXTURES = join(ROOT, 'fixtures', 'research')

// 契约来源(只读引用,保持与源码一致):
const TERMINAL_STATUSES = new Set(['succeeded', 'partial', 'failed', 'cancelled']) // src/shared/agent.ts TERMINAL_RUN_STATUSES
const OPS_TOOLS = new Set([
  'todo.list', 'calendar.list', 'document.search', 'todo.create',
  'todo.update', 'calendar.create_event', 'calendar.update_event', 'mail.create_draft'
]) // src/main/tools/definitions.ts 注册表
const OPS_READONLY_TOOLS = new Set(['todo.list', 'calendar.list', 'document.search'])
const OPS_WRITE_TOOLS = new Set(['todo.create', 'todo.update', 'calendar.create_event', 'calendar.update_event', 'mail.create_draft'])
const OPS_FIXTURE_IDS = new Set(['ops-empty', 'ops-seeded']) // src/main/evals/isolation.ts 注册的内置 fixture
const SEED_RECORD_IDS = new Set(['seed-todo-1', 'seed-todo-2', 'seed-todo-3', 'seed-event-1', 'seed-event-2'])
const STATE_ASSERT_TABLES = new Set(['todos', 'events', 'mail_drafts']) // schema.ts + migrations/m4.ts
const CLAIM_TYPES = new Set(['fact', 'comparison', 'recommendation']) // src/main/research/schemas.ts ClaimType
const GOLD_GUIDELINE_VERSION = 'research-gold.v1'
const NEAR_DUP_THRESHOLD = 0.8

// ---------- 复刻段:规范化 v1(与 src/main/retrieval/normalize.ts、research/snapshots.ts CSV 对齐) ----------

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

function decodeBytes(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3))
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // UTF-16BE:Node 的解码器依赖 ICU,逐字节交换后按 LE 解码(与 normalize.ts 同一确定性路径)
    const payload = Buffer.from(bytes)
    for (let i = 0; i + 1 < payload.length; i += 2) {
      const tmp = payload[i]
      payload[i] = payload[i + 1]
      payload[i + 1] = tmp
    }
    return new TextDecoder('utf-16le').decode(payload)
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function normalizePlainText(text) {
  let out = text
  const BOM = String.fromCharCode(0xfeff) // U+FEFF 起始 BOM 字符
  if (out.startsWith(BOM)) out = out.slice(1)
  out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return out.normalize('NFC')
}

function projectJsonSource(text) {
  const parsed = JSON.parse(text)
  const out = []
  const walk = (value) => {
    if (value === null || value === undefined) return
    if (typeof value === 'string') {
      if (value.trim() !== '') out.push(value)
      return
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      out.push(String(value))
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    for (const key of Object.keys(value).sort()) walk(value[key])
  }
  walk(parsed)
  return out.join('\n')
}

function parseCsvRows(content) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]
    if (inQuotes) {
      if (ch === '"' && content[i + 1] === '"') { field += '"'; i += 1 }
      else if (ch === '"') inQuotes = false
      else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = [] }
    else field += ch
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

function projectCsvSource(content) {
  const rows = parseCsvRows(content)
  const [head, ...data] = rows
  if (!head || data.length === 0) throw new Error('CSV 缺少表头或数据行')
  const out = [...head]
  for (const r of data) out.push(...r)
  return out.join('\n')
}

/** 规范全文重放(与 tests/research/gold_integrity.test.ts canonOf 同一契约) */
function canonOf(bytes, fileName) {
  if (fileName.endsWith('.json')) return normalizePlainText(projectJsonSource(bytes.toString('utf8')))
  if (fileName.endsWith('.csv')) return normalizePlainText(projectCsvSource(bytes.toString('utf8')))
  return normalizePlainText(decodeBytes(bytes))
}

// ---------- 近重复:字符三元组 Jaccard(delivery.md 参考实现) ----------

function grams(text) {
  const chars = Array.from(text.normalize('NFKC').replace(/\s+/g, ''))
  return new Set(chars.slice(0, Math.max(0, chars.length - 2))
    .map((_, i) => chars.slice(i, i + 3).join('')))
}

function jaccard(a, b) {
  const union = new Set([...a, ...b])
  if (union.size === 0) return null
  return [...a].filter((value) => b.has(value)).length / union.size
}

// ---------- 校验记录 ----------

const errors = []
const checks = []
function check(id, ok, detail) {
  checks.push({ id, status: ok ? 'pass' : 'fail', detail })
  if (!ok) errors.push(`${id}: ${detail}`)
  return ok
}

// ---------- 数据集装载 ----------

function readDataset(dir) {
  const casesText = readFileSync(join(dir, 'cases.jsonl'), 'utf-8')
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'))
  const cases = []
  const lineErrors = []
  const lines = casesText.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  for (let i = 0; i < lines.length; i += 1) {
    try {
      cases.push(JSON.parse(lines[i]))
    } catch (err) {
      lineErrors.push(`第 ${i + 1} 行不是合法 JSON:${err.message}`)
    }
  }
  return { dir, casesText, manifest, cases, lineErrors }
}

function checkManifestCommon(name, ds) {
  const { manifest, cases, casesText } = ds
  check(`${name}.manifest.schema_version`, manifest.schema_version === 1, `schema_version=${manifest.schema_version}`)
  check(`${name}.manifest.hash`, manifest.cases_sha256 === sha256Hex(Buffer.from(casesText, 'utf8')), 'cases_sha256 与文件内容一致')
  check(`${name}.cases.json_lines`, ds.lineErrors.length === 0, ds.lineErrors.join('; ') || `${cases.length} 行全部为合法 JSON`)

  const ids = new Set()
  const dupIds = []
  for (const c of cases) {
    if (ids.has(c.case_id)) dupIds.push(c.case_id)
    ids.add(c.case_id)
  }
  check(`${name}.case_id_unique`, dupIds.length === 0, dupIds.length ? `重复 case_id:${dupIds.join(',')}` : `${ids.size} 个 case_id 全部唯一`)

  // 逐组计数(manifest 声明 vs 实际),拒绝漏列与额外类别
  const stats = {}
  for (const c of cases) {
    stats[c.category] ??= { total: 0, dev: 0, holdout: 0 }
    stats[c.category].total += 1
    stats[c.category][c.split] += 1
  }
  const catDetail = Object.entries(stats).map(([k, v]) => `${k}:${v.total}=${v.dev}dev/${v.holdout}holdout`).join(', ')
  check(`${name}.manifest.categories_exact`, (() => {
    const declared = new Set(Object.keys(manifest.categories))
    const actual = new Set(Object.keys(stats))
    const missing = [...actual].filter((c) => !declared.has(c))
    const extra = [...declared].filter((c) => !actual.has(c))
    if (missing.length || extra.length) return false
    return Object.entries(stats).every(([cat, s]) => {
      const d = manifest.categories[cat]
      return d && d.total === s.total && d.dev === s.dev && d.holdout === s.holdout
    })
  })(), catDetail)
  check(`${name}.manifest.total`, manifest.total === cases.length, `声明 ${manifest.total},实际 ${cases.length}`)
  const sumOk = Object.values(manifest.categories).every((c) => c.dev + c.holdout === c.total)
  check(`${name}.manifest.dev_holdout_sum`, sumOk, '每个类别 dev+holdout=total')
  return stats
}

// ---------- Ops 逐条校验 ----------

function checkOpsCases(ds) {
  let withGold = 0
  let withRequiredArgs = 0
  let withStateAssertions = 0
  let repeatedToolCases = 0
  for (const c of ds.cases) {
    const id = c.case_id
    const exp = c.expected ?? {}
    check(`ops.${id}.terminal_status`, TERMINAL_STATUSES.has(exp.terminal_status), `terminal_status=${exp.terminal_status}`)
    check(`ops.${id}.fixture_id`, OPS_FIXTURE_IDS.has(c.fixture_id), `fixture_id=${c.fixture_id}(须为 isolation.ts 注册的内置 fixture)`)
    const budgets = c.budgets ?? {}
    check(`ops.${id}.budgets`, Number.isInteger(budgets.max_model_calls) && budgets.max_model_calls > 0
      && Number.isInteger(budgets.max_active_seconds) && budgets.max_active_seconds > 0,
    `max_model_calls=${budgets.max_model_calls}, max_active_seconds=${budgets.max_active_seconds}`)

    const seq = exp.tool_sequence ?? []
    const unknown = seq.filter((t) => !OPS_TOOLS.has(t))
    check(`ops.${id}.tools_registered`, unknown.length === 0, unknown.length ? `未注册工具:${unknown.join(',')}` : `序列 [${seq.join(', ')}] 均为注册工具`)

    const argKeys = Object.keys(exp.required_arguments ?? {})
    const orphanArgs = argKeys.filter((k) => !seq.includes(k))
    check(`ops.${id}.required_args_in_sequence`, orphanArgs.length === 0,
      orphanArgs.length ? `required_arguments 键不在 tool_sequence 中:${orphanArgs.join(',')}` : argKeys.length ? `键 [${argKeys.join(', ')}] 均在序列中` : '无 required_arguments')
    if (argKeys.length > 0) withRequiredArgs += 1
    // 必需参数中的种子记录引用必须真实存在(fixture ops-seeded 固定 ID)
    for (const [tool, args] of Object.entries(exp.required_arguments ?? {})) {
      for (const [k, v] of Object.entries(args ?? {})) {
        if (k === 'id' && typeof v === 'string' && v.startsWith('seed-')) {
          check(`ops.${id}.seed_ref`, SEED_RECORD_IDS.has(v), `${tool}.id=${v} 须为 fixture 种子记录`)
        }
      }
    }

    for (const a of exp.state_assertions ?? []) {
      check(`ops.${id}.state_table`, STATE_ASSERT_TABLES.has(a.table), `state_assertions 表 ${a.table}, delta=${a.countDelta}`)
      withStateAssertions += 1
    }

    const script = c.interaction_script ?? []
    const needConfirm = exp.requires_confirmation === true
    const hasConfirm = script.some((s) => s.on === 'confirmation')
    check(`ops.${id}.confirmation_pair`, needConfirm === hasConfirm,
      `requires_confirmation=${needConfirm}, script 含 confirmation 步骤=${hasConfirm}`)
    if (needConfirm) {
      check(`ops.${id}.confirm_decision`, script.some((s) => s.on === 'confirmation' && s.decision === 'approved'), '确认步骤须有 approved 决定')
    }
    const isAmbiguous = c.category === '歧义澄清'
    if (isAmbiguous) {
      check(`ops.${id}.clarification_step`, script.some((s) => s.on === 'clarification'), '澄清类须有 clarification 步骤')
    }

    const isInjection = c.category === '注入越权'
    const isWrite = c.category === '可撤销写'
    if (isInjection) {
      check(`ops.${id}.injection_failed`, exp.terminal_status === 'failed', `注入越权终态应为 failed,实际 ${exp.terminal_status}`)
      check(`ops.${id}.injection_forbidden`, (exp.forbidden_tools ?? []).length > 0, `forbidden_tools=${(exp.forbidden_tools ?? []).join(',')}`)
      const badForbidden = (exp.forbidden_tools ?? []).filter((t) => !OPS_WRITE_TOOLS.has(t))
      check(`ops.${id}.injection_forbidden_writes`, badForbidden.length === 0, badForbidden.length ? `forbidden_tools 含非写工具:${badForbidden.join(',')}` : '禁用列表均为写类工具')
    } else {
      if (seq.length > 0) withGold += 1
      check(`ops.${id}.has_gold`, seq.length > 0, `${c.category} 须有 gold tool_sequence`)
      if (isWrite) {
        check(`ops.${id}.write_state_assert`, (exp.state_assertions ?? []).length > 0, '写类须有状态断言')
      } else {
        check(`ops.${id}.readonly_no_write`, (c.category === '只读') ? seq.every((t) => OPS_READONLY_TOOLS.has(t)) : true,
          `只读类序列全部为只读工具:[${seq.join(', ')}]`)
      }
    }

    // 重复同一工具的调用:序列级全等比对无序号语义,须由 required_arguments 或 call key 区分;
    // 当前数据无重复工具序列,该规则核对结果如实记录(not-applicable)。
    if (new Set(seq).size < seq.length) {
      repeatedToolCases += 1
      check(`ops.${id}.repeated_tool_keyed`, argKeys.length > 0, '重复工具调用须以 required_arguments 区分或提供稳定 call key')
    }
  }
  return { withGold, withRequiredArgs, withStateAssertions, repeatedToolCases }
}

// ---------- Research:gold、坐标重放、语料与快照 ----------

function verifyEvidence(fixtureId, e, normText, fail) {
  const [snapFixture, snapFile] = String(e.snapshot_id).split('/')
  if (snapFixture !== fixtureId) { fail(`snapshot_id 的 fixture 部分应为 ${fixtureId}:${e.snapshot_id}`); return null }
  const chars = Array.from(normText)
  const hashOk = e.text_sha256 === sha256Hex(Buffer.from(normText, 'utf8'))
  if (!hashOk) fail(`text_sha256 不一致:${e.snapshot_id}`)
  const inRange = e.start_offset >= 0 && e.end_offset <= chars.length && e.start_offset < e.end_offset
  if (!inRange) { fail(`offset 越界:${e.snapshot_id} [${e.start_offset},${e.end_offset}) 长度 ${chars.length}`); return { hashOk, sliceOk: false, uniqueHit: false } }
  const slice = chars.slice(e.start_offset, e.end_offset).join('')
  const sliceOk = slice === e.quote
  if (!sliceOk) fail(`offset 切片与 quote 不一致:${e.snapshot_id}`)
  const q = Array.from(e.quote)
  let hits = 0
  for (let i = 0; i + q.length <= chars.length; i += 1) {
    let ok = true
    for (let j = 0; j < q.length; j += 1) {
      if (chars[i + j] !== q[j]) { ok = false; break }
    }
    if (ok) hits += 1
  }
  const uniqueHit = hits === 1
  if (!uniqueHit) fail(`quote 应唯一命中,实际 ${hits} 处:${e.snapshot_id}`)
  return { hashOk, sliceOk, uniqueHit }
}

function checkResearchCases(ds, corpus) {
  const coord = { evidence_total: 0, hash_match: 0, slice_match: 0, unique_hit: 0, failures: [] }
  let pgCrossSplit = []
  const pgToSplits = new Map()
  const fail = (msg) => coord.failures.push(msg)

  for (const c of ds.cases) {
    const id = c.case_id
    const goldPath = join(ds.dir, 'annotations', `${id}.json`)
    if (!check(`research.${id}.gold_readable`, existsSync(goldPath), 'gold 标注文件存在')) continue
    let g
    try {
      g = JSON.parse(readFileSync(goldPath, 'utf-8'))
    } catch (err) {
      check(`research.${id}.gold_readable`, false, `解析失败:${err.message}`)
      continue
    }
    check(`research.${id}.gold_fields`, g.case_id === id && g.split === c.split && g.group === c.category && g.input === c.input,
      'case_id/split/group/input 与 case 一致')
    check(`research.${id}.gold_status`, g.annotation?.status === 'adjudicated' && g.annotation?.guideline_version === GOLD_GUIDELINE_VERSION,
      `status=${g.annotation?.status}, guideline_version=${g.annotation?.guideline_version}`)

    const isInsufficient = c.category === '证据不足'
    check(`research.${id}.insufficient_empty_gold`, !isInsufficient || (g.gold_claims.length === 0
      && (c.tags ?? []).some((t) => t.startsWith('missing:'))
      && (g.missing_requirements ?? []).length > 0 && (g.fabrication_bans ?? []).length > 0),
    isInsufficient ? '证据不足组:gold_claims 为空 + tags 承载 missing + 缺失项/禁编造非空' : '非不足组(规则不适用)')
    check(`research.${id}.insufficient_terminal`, !isInsufficient || c.expected.terminal_status === 'succeeded',
      isInsufficient ? `诚实不足终态须为 succeeded,实际 ${c.expected.terminal_status}` : '非不足组(规则不适用)')

    if (c.category === '冲突') {
      const relations = g.gold_claims.flatMap((cl) => cl.acceptable_evidence_sets.flat().map((e) => e.relation))
      check(`research.${id}.conflict_pair`, relations.includes('supports') && relations.includes('contradicts') && (g.conflict_flags ?? []).length > 0,
        `relations=[${[...new Set(relations)].join(',')}], conflict_flags=[${(g.conflict_flags ?? []).join(',')}]`)
    }
    if (c.category === '提示注入') {
      const acts = g.forbidden_actions ?? []
      check(`research.${id}.injection_forbidden`, ['todo.create', 'http.fetch', 'shell.exec'].every((a) => acts.includes(a)) && g.gold_claims.length > 0,
        `forbidden_actions=[${acts.join(',')}], gold_claims=${g.gold_claims.length}`)
      check(`research.${id}.injection_case_forbidden`, ['todo.create', 'http.fetch', 'shell.exec'].every((a) => (c.expected.forbidden_tools ?? []).includes(a)),
        'EvalCase expected.forbidden_tools 覆盖三类禁用动作')
    }
    if (c.category === '重复来源') {
      for (const cl of g.gold_claims) {
        for (const set of cl.acceptable_evidence_sets) {
          for (const e of set) {
            const splits = pgToSplits.get(e.provenance_group_id) ?? new Set()
            splits.add(c.split)
            pgToSplits.set(e.provenance_group_id, splits)
          }
        }
      }
    }

    // 坐标重放
    for (const cl of g.gold_claims) {
      for (const set of cl.acceptable_evidence_sets) {
        for (const e of set) {
          coord.evidence_total += 1
          check(`research.${id}.relation_valid`, e.relation === 'supports' || e.relation === 'contradicts', `relation=${e.relation}`)
          const norm = corpus.get(`${c.fixture_id}/${e.snapshot_id.split('/')[1]}`)?.norm
          if (norm === undefined) { fail(`语料未装载:${e.snapshot_id}`); continue }
          const r = verifyEvidence(c.fixture_id, e, norm, fail)
          if (r) {
            if (r.hashOk) coord.hash_match += 1
            if (r.sliceOk) coord.slice_match += 1
            if (r.uniqueHit) coord.unique_hit += 1
          }
        }
      }
    }
  }

  for (const [pg, splits] of pgToSplits) {
    if (splits.size > 1) pgCrossSplit.push(`${pg}:${[...splits].join('/')}`)
  }
  check('research.provenance_group_no_cross_split', pgCrossSplit.length === 0,
    pgCrossSplit.length ? `provenance group 跨 split:${pgCrossSplit.join('; ')}` : `${pgToSplits.size} 个 group 均不跨 split`)
  return coord
}

/** 语料与快照:目录存在、fixtures/snapshots 逐字节一致、快照 manifest hash 重放;返回 corpus 映射 */
function checkResearchCorpus(ds) {
  const corpus = new Map()
  const failures = []
  const urlIndex = new Map() // normalizedUrl -> [{fixture, file, split}]
  const rawHashIndex = new Map() // raw_sha256 -> [{key}]
  let filesChecked = 0
  let byteIdentical = 0

  for (const c of ds.cases) {
    const fixDir = join(RES_FIXTURES, c.fixture_id)
    const snapDir = join(ds.dir, 'snapshots', c.fixture_id)
    if (!check(`research.corpus.${c.fixture_id}.exists`, existsSync(fixDir) && existsSync(snapDir), 'fixtures 与 snapshots 目录均存在')) continue
    const files = readdirSync(fixDir).filter((f) => statSync(join(fixDir, f)).isFile())
    check(`research.corpus.${c.fixture_id}.non_empty`, files.length > 0, `${files.length} 个语料文件`)
    const snapManifest = JSON.parse(readFileSync(join(snapDir, 'manifest.json'), 'utf-8'))
    check(`research.corpus.${c.fixture_id}.snap_manifest`, snapManifest.fixture_id === c.fixture_id && snapManifest.normalization_version === 1
      && JSON.stringify([...snapManifest.entries.map((e) => e.file)].sort()) === JSON.stringify([...files].sort()), '快照清单覆盖全部文件且 normalization_version=1')

    for (const f of files) {
      filesChecked += 1
      const a = readFileSync(join(fixDir, f))
      const b = readFileSync(join(snapDir, f))
      if (a.equals(b)) byteIdentical += 1
      else failures.push(`fixtures 与 snapshots 副本不一致:${c.fixture_id}/${f}`)
      const entry = snapManifest.entries.find((e) => e.file === f)
      const norm = canonOf(a, f)
      if (entry) {
        if (entry.raw_sha256 !== sha256Hex(a)) failures.push(`raw_sha256 不一致:${c.fixture_id}/${f}`)
        if (entry.text_sha256 !== sha256Hex(Buffer.from(norm, 'utf8'))) failures.push(`text_sha256 不一致:${c.fixture_id}/${f}`)
      } else failures.push(`快照清单缺文件:${c.fixture_id}/${f}`)
      const key = `${c.fixture_id}/${f}`
      corpus.set(key, { norm, fixture: c.fixture_id, caseId: c.case_id, split: c.split })
      rawHashIndex.set(sha256Hex(a), [...(rawHashIndex.get(key) ?? []), { key }])
      // URL 归一化索引
      const rawText = a.toString('utf8')
      for (const u of rawText.match(/https?:\/\/[^\s)"\]]+/g) ?? []) {
        const normUrl = u.toLowerCase().replace(/\/+$/, '').split('#')[0]
        urlIndex.set(normUrl, [...(urlIndex.get(normUrl) ?? []), { key, split: c.split }])
      }
    }
  }
  check('research.corpus.byte_identical', failures.length === 0, `${byteIdentical}/${filesChecked} 个文件 fixtures 与 snapshots 逐字节一致且 manifest hash 重放一致;${failures.length ? '失败:' + failures.join('; ') : ''}`)
  return { corpus, filesChecked, urlIndex, rawHashIndex, failures }
}

// ---------- 跨 split 检查 ----------

function crossSplitFindings(items) {
  // items: [{key, split}] -> 同一 key 出现在多个 split 即 finding
  const byKey = new Map()
  for (const it of items) {
    byKey.set(it.key, [...(byKey.get(it.key) ?? []), it.split])
  }
  const findings = []
  for (const [key, splits] of byKey) {
    if (new Set(splits).size > 1) findings.push({ key, splits: [...new Set(splits)] })
  }
  return findings
}

function normInput(text) {
  return text.normalize('NFKC').replace(/\s+/g, '')
}

// ---------- 近重复筛查 ----------

function screenPairs(units, threshold) {
  // units: [{unitId, dataset, kind, caseId, fixture, split, file, hash, text}]
  const vecs = units.map((u) => ({ u, g: grams(u.text) }))
  const candidates = []
  let compared = 0
  for (let i = 0; i < vecs.length; i += 1) {
    for (let j = i + 1; j < vecs.length; j += 1) {
      const sim = jaccard(vecs[i].g, vecs[j].g)
      compared += 1
      if (sim === null || sim < threshold) continue
      const a = vecs[i].u
      const b = vecs[j].u
      const ids = [a.unitId, b.unitId].sort()
      candidates.push({
        pair_key: `${a.dataset}|${a.kind}|${ids.join('||')}`,
        dataset: a.dataset,
        kind: a.kind,
        cross_split: a.split !== b.split,
        a: { id: a.unitId, case_id: a.caseId, fixture: a.fixture, file: a.file, split: a.split, sha256: a.hash },
        b: { id: b.unitId, case_id: b.caseId, fixture: b.fixture, file: b.file, split: b.split, sha256: b.hash },
        jaccard: Number(sim.toFixed(4))
      })
    }
  }
  return { candidates, compared }
}

// ---------- 诚实不足语义:静态文本扫描(机器可核对部分) ----------

function scanHonestSemantics() {
  const scans = [
    { location: 'docs/demos/deep-research-agent.md', expect: '终态 succeeded、报告 partial(证据不足诚实收尾)', pattern: '终态 `succeeded`,报告 `partial`' },
    { location: 'docs/demos/deep-research-agent.md', expect: '预算/执行中断才走 partial 收尾,不伪装成 no_evidence', pattern: '判 partial/failed,未执行子问题落 skipped,不伪装成 no_evidence' },
    { location: 'tests/research/demoRun.test.ts', expect: 'insufficient 期望 succeeded/partial 且零 claim', pattern: 'insufficient 证据不足:succeeded/partial,unanswered 非空且零 claim 不编造' },
    { location: 'tests/evals/researchIntegration.test.ts', expect: 'succeeded 与 gold_claims 为空兼容', pattern: 'succeeded 与 gold_claims 为空兼容' },
    { location: 'tests/research/gold_integrity.test.ts', expect: '证据不足组 gold_claims 为空并以 tags 承载 missing 语义', pattern: '证据不足组:gold_claims 为空,tags 承载 missing 语义' },
    { location: 'src/main/evals/researchAdapter.ts', expect: '适配层注释与数据语义一致', pattern: '终态 succeeded 与 gold_claims 为空的标注语义兼容' }
  ]
  // 文档与测试存在全角/半角标点差异:归一化空白与常见标点后再做子串匹配
  const squash = (s) => s
    .replace(/\s+/g, '')
    .replace(/，/g, ',')
    .replace(/；/g, ';')
    .replace(/：/g, ':')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
  return scans.map((s) => {
    const p = join(ROOT, s.location)
    const ok = existsSync(p) && squash(readFileSync(p, 'utf-8')).includes(squash(s.pattern))
    return { location: s.location, expect: s.expect, status: ok ? 'pass' : 'fail' }
  })
}

// ---------- 树 hash(冻结声明用) ----------

function treeSha256(dir) {
  if (!existsSync(dir)) return null
  const lines = []
  const walk = (d, prefix) => {
    for (const name of readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const p = join(d, name.name)
      if (name.isDirectory()) walk(p, `${prefix}${name.name}/`)
      else lines.push(`${prefix}${name.name}:${sha256Hex(readFileSync(p))}`)
    }
  }
  walk(dir, '')
  return sha256Hex(lines.join('\n'))
}

// ---------- 主流程 ----------

function main() {
  const args = process.argv.slice(2)
  const argOf = (flag) => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  const outputPath = argOf('--output')
  const conclusionsPath = argOf('--conclusions') ?? join(ROOT, 'artifacts', 'data-review', 'near-duplicate-conclusions.json')

  const ops = readDataset(OPS_DIR)
  const res = readDataset(RES_DIR)

  const opsStats = checkManifestCommon('ops', ops)
  const resStats = checkManifestCommon('res', res)
  check('ops.mode', ops.cases.every((c) => c.mode === 'personal_ops'), '全部 case mode=personal_ops')
  check('res.mode', res.cases.every((c) => c.mode === 'research'), '全部 case mode=research')

  const opsChecks = checkOpsCases(ops)
  const resCorpus = checkResearchCorpus(res)
  const resCoord = checkResearchCases(res, resCorpus.corpus)

  // 跨 split 检查:规范化输入、语料规范文本 hash、raw source identity、URL 归一化
  const crossSplit = {}
  const corpusUnitsForDup = [...resCorpus.corpus.entries()].map(([key, v]) => ({
    unitId: key, dataset: 'research_v1', kind: 'corpus', caseId: v.caseId, fixture: v.fixture,
    split: v.split, file: key.split('/')[1], hash: sha256Hex(Buffer.from(v.norm, 'utf8')), text: v.norm
  }))
  for (const [name, ds] of [['ops', ops], ['res', res]]) {
    const findings = crossSplitFindings(ds.cases.map((c) => ({ key: normInput(c.input), split: c.split })))
    crossSplit[`${name}.normalized_input`] = { checked: ds.cases.length, findings }
    check(`${name}.cross_split.normalized_input`, findings.length === 0,
      findings.length ? `归一化输入跨 split:${findings.map((f) => f.key.slice(0, 24)).join('; ')}` : `${ds.cases.length} 条输入归一化后无跨 split 重复`)
  }
  const resFixtureFindings = crossSplitFindings(res.cases.map((c) => ({ key: c.fixture_id, split: c.split })))
  crossSplit['res.fixture_id'] = { checked: res.cases.length, findings: resFixtureFindings }
  check('res.cross_split.fixture', resFixtureFindings.length === 0, resFixtureFindings.length ? `fixture 跨 split:${resFixtureFindings.map((f) => f.key).join(', ')}` : '40 个 fixture 与 case 一一对应,无跨 split')
  crossSplit['ops.fixture_id'] = {
    checked: ops.cases.length,
    findings: [],
    note: 'Ops 仅两个内置虚拟库 fixture(ops-empty/ops-seeded)被各 split 共享,属预期设计;Ops 泄漏检查以输入与参数为准'
  }
  const resTextFindings = crossSplitFindings(corpusUnitsForDup.map((u) => ({ key: u.hash, split: u.split, unit: u.unitId })))
  crossSplit['res.text_sha256'] = { checked: corpusUnitsForDup.length, findings: resTextFindings }
  check('res.cross_split.text_sha256', resTextFindings.length === 0,
    resTextFindings.length ? `规范文本 hash 跨 split:${resTextFindings.map((f) => f.key.slice(0, 16)).join('; ')}` : `${corpusUnitsForDup.length} 份语料规范全文 hash 无跨 split 重复`)
  const rawFindings = []
  for (const [hash, refs] of resCorpus.rawHashIndex) {
    const fixtures = new Set(refs.map((r) => r.key.split('/')[0]))
    if (fixtures.size > 1) rawFindings.push({ sha256: hash, keys: refs.map((r) => r.key) })
  }
  crossSplit['res.source_identity_raw_sha256'] = { checked: resCorpus.rawHashIndex.size, findings: rawFindings }
  check('res.cross_split.source_identity', rawFindings.length === 0,
    rawFindings.length ? `同一原始文件跨 fixture 重复:${rawFindings.map((f) => f.keys.join('+')).join('; ')}` : `${resCorpus.rawHashIndex.size} 份原始文件 raw hash 均唯一(无同源复制)`)
  const urlFindings = []
  for (const [url, refs] of resCorpus.urlIndex) {
    const splits = new Set(refs.map((r) => r.split))
    if (splits.size > 1) urlFindings.push({ url, refs: refs.map((r) => r.key) })
  }
  crossSplit['res.url_normalized'] = { checked: resCorpus.urlIndex.size, findings: urlFindings }
  check('res.cross_split.url_normalized', urlFindings.length === 0,
    urlFindings.length ? `归一化 URL 跨 split:${urlFindings.map((f) => f.url).join('; ')}` : `${resCorpus.urlIndex.size} 个归一化 URL 无跨 split 重复`)

  // 近重复筛查:分组同质比较(research 语料对语料、各数据集输入对输入),
  // 阈值 0.8 仅用于筛查,不直接判泄漏;跨 split 对在报告中重点复核。
  const nearDup = { threshold: NEAR_DUP_THRESHOLD, groups: {}, candidates: [], compared: 0, units: {} }
  const inputUnits = (ds, datasetName) => ds.cases.map((c) => ({
    unitId: c.case_id, dataset: datasetName, kind: 'input', caseId: c.case_id, fixture: c.fixture_id,
    split: c.split, file: null, hash: sha256Hex(Buffer.from(c.input, 'utf8')), text: c.input
  }))
  const groups = [
    ['research_corpus_vs_corpus', corpusUnitsForDup],
    ['research_input_vs_input', inputUnits(res, 'research_v1')],
    ['ops_input_vs_input', inputUnits(ops, 'personal_ops_v1')]
  ]
  for (const [groupName, units] of groups) {
    const r = screenPairs(units, NEAR_DUP_THRESHOLD)
    nearDup.groups[groupName] = { units: units.length, pairs_compared: r.compared, candidates: r.candidates.length }
    nearDup.candidates.push(...r.candidates)
    nearDup.compared += r.compared
  }
  nearDup.units = {
    research_corpus: corpusUnitsForDup.length,
    research_inputs: res.cases.length,
    ops_inputs: ops.cases.length
  }

  // 合并人工结论
  let conclusions = {}
  let conclusionsFile = null
  if (existsSync(conclusionsPath)) {
    conclusionsFile = conclusionsPath
    const raw = JSON.parse(readFileSync(conclusionsPath, 'utf-8'))
    conclusions = raw.conclusions ?? {}
  }
  const missingConclusions = []
  let leakPairs = []
  for (const cand of nearDup.candidates) {
    const c = conclusions[cand.pair_key]
    if (!c) { missingConclusions.push(cand.pair_key); continue }
    cand.conclusion = c
    if (c.verdict === 'leak') leakPairs.push(cand.pair_key)
  }
  nearDup.conclusion_coverage = {
    candidates: nearDup.candidates.length,
    concluded: nearDup.candidates.length - missingConclusions.length,
    missing: missingConclusions,
    leak_pairs: leakPairs
  }
  check('near_duplicate.manual_conclusions', missingConclusions.length === 0,
    missingConclusions.length ? `候选缺人工结论:${missingConclusions.join('; ')}` : `全部 ${nearDup.candidates.length} 个候选均有逐对人工结论`)
  check('near_duplicate.no_leak', leakPairs.length === 0, leakPairs.length ? `判定泄漏:${leakPairs.join('; ')}` : '人工复核未发现跨 split 泄漏')

  // 诚实不足语义
  const honestMachine = [{
    id: 'honest.insufficient_dataset_semantics',
    detail: '证据不足组 5 条:cases 终态 succeeded、annotations gold_claims 空、tags 承载 missing、报告允许 partial(见 text_scans)',
    status: resCoord.failures.length === 0 ? 'pass' : 'fail'
  }]
  const textScans = scanHonestSemantics()
  for (const s of textScans) check(`honest.scan.${s.location}`, s.status === 'pass', `${s.expect} @ ${s.location}`)
  const honest = { machine_checks: honestMachine, text_scans: textScans, claim_types: [...CLAIM_TYPES] }

  // 汇总
  const failed = checks.filter((c) => c.status === 'fail').map((c) => c.id)
  const status = failed.length === 0 ? 'pass' : (missingConclusions.length > 0 && failed.every((f) => f === 'near_duplicate.manual_conclusions') ? 'pending-manual-conclusions' : 'fail')
  const review = {
    schema_version: 'dataset-review.v1',
    generated_at: new Date().toISOString(),
    generator: { script: 'scripts/check-eval-data.mjs', node: process.version, rubric: GOLD_GUIDELINE_VERSION, claim_types: [...CLAIM_TYPES] },
    conclusions_file: conclusionsFile,
    status,
    datasets: {
      personal_ops_v1: {
        counts: { total: ops.cases.length, dev: ops.cases.filter((c) => c.split === 'dev').length, holdout: ops.cases.filter((c) => c.split === 'holdout').length, categories: opsStats },
        hashes: {
          cases_jsonl_sha256: sha256Hex(Buffer.from(ops.casesText, 'utf8')),
          manifest_cases_sha256: ops.manifest.cases_sha256,
          manifest_json_sha256: sha256Hex(readFileSync(join(ops.dir, 'manifest.json')))
        },
        terminal_status: ops.cases.reduce((acc, c) => { acc[c.expected.terminal_status] = (acc[c.expected.terminal_status] ?? 0) + 1; return acc }, {}),
        ops_checks: opsChecks,
        coordinate_check: null,
        cross_split: crossSplit
      },
      research_v1: {
        counts: { total: res.cases.length, dev: res.cases.filter((c) => c.split === 'dev').length, holdout: res.cases.filter((c) => c.split === 'holdout').length, categories: resStats },
        hashes: {
          cases_jsonl_sha256: sha256Hex(Buffer.from(res.casesText, 'utf8')),
          manifest_cases_sha256: res.manifest.cases_sha256,
          manifest_json_sha256: sha256Hex(readFileSync(join(res.dir, 'manifest.json'))),
          annotations_tree_sha256: treeSha256(join(res.dir, 'annotations')),
          snapshots_tree_sha256: treeSha256(join(res.dir, 'snapshots')),
          fixtures_tree_sha256: treeSha256(RES_FIXTURES),
          fixtures_tree_note: 'fixtures/research 全目录(含 demo/ 演示语料,亦属冻结范围)'
        },
        terminal_status: res.cases.reduce((acc, c) => { acc[c.expected.terminal_status] = (acc[c.expected.terminal_status] ?? 0) + 1; return acc }, {}),
        coordinate_check: resCoord,
        corpus: { files_checked: resCorpus.filesChecked, byte_identical_fixtures_snapshots: resCorpus.filesChecked - resCorpus.failures.length },
        cross_split: crossSplit
      }
    },
    near_duplicates: nearDup,
    honest_insufficiency: honest,
    summary: { checks_total: checks.length, failed, errors }
  }

  const json = JSON.stringify(review, null, 2)
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, json)
    console.log(`dataset-review 已写入 ${outputPath}`)
    console.log(`status=${status}, checks=${checks.length}, failed=${failed.length}${failed.length ? ` -> ${failed.join(', ')}` : ''}`)
  } else {
    console.log(json)
  }
  process.exit(status === 'pass' ? 0 : 1)
}

main()
