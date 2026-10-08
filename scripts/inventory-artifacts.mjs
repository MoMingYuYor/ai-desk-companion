#!/usr/bin/env node
// 目录清单扫描器（ENG-01）：只读扫描指定根目录，产出分类清单、身份绑定与保留建议。
//
// 约束（见 docs/superpowers/plans/2026-10-08-desk-companion-improvements/engineering-showcase.md ENG-01 节）：
// - 全程只读：不读取文件正文（身份清单 build-info.json / manifest.json 除外），不跟随符号链接/reparse point；
// - 不执行任何删除，也不提供删除开关；删除单列为需要用户确认的后续操作；
// - 输出目录不得落入扫描范围（自计数防护）；
// - 不可读项记入 errors，不得当作零字节成功；
// - 无法获取构建身份时 buildCommit 为 null 并给出明确原因，不推断 commit。
//
// 用法：node scripts/inventory-artifacts.mjs --root <绝对路径> --output <绝对JSON路径>
// 环境变量 INVENTORY_PROTECTED_ROOTS：以分号分隔的额外保护路径（仅登记不遍历），用于测试与临时扩展。

import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCHEMA_VERSION = 1
// 身份清单收集的相对深度上限（相对被统计条目本身）
const MAX_MANIFEST_DEPTH = 4
// 最多收集的清单文件数，防止异常目录拖慢扫描
const MAX_MANIFESTS_COLLECTED = 32
// 身份清单文件体积上限（超过则视为不可读，避免误读大文件正文）
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024
// 身份搜索时跳过的目录名（依赖与版本历史里不存在有效身份清单）
const MANIFEST_SKIP_DIRS = new Set(['node_modules', '.git'])

// 固定分类：扫描根的顶层目录名 → 类别
const TOP_LEVEL_CATEGORIES = {
  src: 'source',
  tests: 'source',
  docs: 'source',
  scripts: 'source',
  evals: 'source',
  fixtures: 'source',
  resources: 'source',
  '.git': 'version-history',
  node_modules: 'dev-dependencies',
  out: 'build',
  dist: 'build',
  artifacts: 'evidence',
}

// 各类别的保留建议与理由（与 docs/engineering/artifact-policy.md 对应）
const CATEGORY_POLICY = {
  source: {
    recommendation: 'keep',
    reason: '源文件目录：长期保留，随版本演进',
  },
  'version-history': {
    recommendation: 'keep',
    reason: '版本历史：长期保留，是追溯与回退的唯一来源',
  },
  'dev-dependencies': {
    recommendation: 'keep-current',
    reason: '开发依赖：保留当前一份，可由 lockfile 重建，不计入可释放收益',
  },
  build: {
    recommendation: 'keep-current',
    reason: '构建产物：保留最近一次可验证构建；历史包逐项列入候选清单',
  },
  evidence: {
    recommendation: 'keep',
    reason: '验收证据：按 run/commit 索引长期保留',
  },
  'acceptance-copy': {
    recommendation: 'review',
    reason: '验收副本：核对 manifest 与独有证据后逐项决定',
  },
  protected: {
    recommendation: 'protected',
    reason: '保护对象：个人数据/用户数据，仅登记，不遍历、不统计、不删除',
  },
  other: {
    recommendation: 'keep',
    reason: '仓库根其他文件/目录：默认保留',
  },
}

// 内置保护路径：个人用户数据目录，仅登记，绝不遍历
const BUILTIN_PROTECTED_ROOTS = [
  'C:\\Users\\Administrator\\AppData\\Roaming\\事务助手',
]

/** 扫描参数或前置校验错误（进程以退出码区分） */
class UsageError extends Error {}
/** 扫描执行错误（root 非法、自计数防护等） */
class ScanError extends Error {
  constructor(code, message) {
    super(`[${code}] ${message}`)
    this.code = code
  }
}

/** 取当前生效的保护路径列表（内置 + 环境变量扩展，分号分隔） */
function protectedRoots() {
  const extra = process.env.INVENTORY_PROTECTED_ROOTS ?? ''
  const extras = extra
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => resolve(s))
  return [...BUILTIN_PROTECTED_ROOTS.map((s) => resolve(s)), ...extras]
}

/** 判断路径是否为保护路径（Windows 大小写不敏感，统一小写比较） */
function isProtectedRoot(root) {
  const lower = root.toLowerCase()
  return protectedRoots().some((p) => p.toLowerCase() === lower)
}

/** 确保候选路径是扫描根内的后代；越界直接抛错（规范要求先 relative 判断再递归） */
function assertInsideRoot(root, p) {
  const rel = relative(root, p)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ScanError('PATH_OUTSIDE_ROOT', `路径越出扫描根: ${p}`)
  }
}

/** 解析命令行参数；非法用法抛 UsageError */
export function parseArgs(argv) {
  const args = { root: null, output: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') {
      args.root = argv[++i]
    } else if (a === '--output') {
      args.output = argv[++i]
    } else {
      throw new UsageError(`未知参数: ${a}`)
    }
  }
  if (!args.root) throw new UsageError('缺少 --root <绝对路径>')
  if (!args.output) throw new UsageError('缺少 --output <绝对JSON路径>')
  return args
}

/** 判断扫描根是否处于验收工作区（路径任一段名为 acceptance） */
function isAcceptanceScope(root) {
  return root.split(sep).includes('acceptance')
}

/** 判断文件名是否可作为身份清单候选 */
function isManifestName(name) {
  const lower = name.toLowerCase()
  return lower === 'build-info.json' || lower === 'manifest.json' || /-manifest\.json$/.test(lower)
}

/** 从身份清单 JSON 中提取显式提交字段；没有则返回 null，绝不推断 */
function extractCommit(json) {
  if (json === null || typeof json !== 'object') return null
  for (const key of ['gitCommit', 'buildCommit', 'codeCommit']) {
    const v = json[key]
    if (typeof v === 'string' && /^[0-9a-f]{7,64}$/i.test(v)) return v
  }
  return null
}

/**
 * 读取收集到的身份清单，返回 { buildCommit, manifestPath, identityReason }。
 * 优先 build-info.json（路径浅者优先），其次其他 manifest（mtime 新者优先）；
 * 解析失败或无提交字段时给出明确原因。
 */
function pickIdentity(manifests) {
  if (manifests.length === 0) {
    return { buildCommit: null, manifestPath: null, identityReason: 'NO_IDENTITY_MANIFEST' }
  }
  const buildInfo = manifests
    .filter((m) => m.name.toLowerCase() === 'build-info.json')
    .sort((a, b) => a.depth - b.depth || (a.path < b.path ? -1 : 1))
  const others = manifests
    .filter((m) => m.name.toLowerCase() !== 'build-info.json')
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  const ordered = [...buildInfo, ...others].slice(0, 8)
  let sawReadable = false
  let sawUnreadable = false
  for (const m of ordered) {
    let text
    try {
      const st = lstatSync(m.path)
      if (st.size > MANIFEST_MAX_BYTES) {
        sawUnreadable = true
        continue
      }
      text = readFileSync(m.path, 'utf-8')
      sawReadable = true
    } catch {
      sawUnreadable = true
      continue
    }
    let json
    try {
      json = JSON.parse(text)
    } catch {
      sawUnreadable = true
      continue
    }
    const commit = extractCommit(json)
    if (commit) {
      return { buildCommit: commit, manifestPath: m.path, identityReason: null }
    }
  }
  if (!sawReadable && sawUnreadable) {
    return { buildCommit: null, manifestPath: null, identityReason: 'IDENTITY_MANIFEST_UNREADABLE' }
  }
  return { buildCommit: null, manifestPath: null, identityReason: 'MANIFEST_WITHOUT_COMMIT' }
}

/**
 * 深度优先统计一个子树。acc 累加器字段：
 * logicalBytes/files/directories/maxMtimeMs/errors/excluded/manifests。
 * 只使用 lstat/Dirent 判断；遇到符号链接记录 excluded 并停止该分支递归。
 */
function walk(root, dir, acc, depthFromItem, underSkipDir) {
  assertInsideRoot(root, dir)
  try {
    const st = lstatSync(dir)
    if (st.mtimeMs > acc.maxMtimeMs) acc.maxMtimeMs = st.mtimeMs
  } catch (err) {
    acc.errors.push({ absolutePath: dir, code: err.code ?? 'UNKNOWN', message: err.message })
  }
  let dirents
  try {
    dirents = readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    // 不可读必须显式记录，不能当零字节成功
    acc.errors.push({ absolutePath: dir, code: err.code ?? 'UNKNOWN', message: err.message })
    return
  }
  for (const dirent of dirents) {
    const child = join(dir, dirent.name)
    // 每个候选必须是根目录内的后代：先 relative 判断，再递归
    assertInsideRoot(root, child)
    if (dirent.isSymbolicLink()) {
      // 链接（含 Windows junction 等 reparse point）一律排除并停止该分支递归
      acc.excluded.push({ absolutePath: child, reason: 'LINK_NOT_FOLLOWED' })
      continue
    }
    const nameLower = dirent.name.toLowerCase()
    const childSkip = underSkipDir || MANIFEST_SKIP_DIRS.has(nameLower)
    if (dirent.isDirectory()) {
      acc.directories += 1
      walk(root, child, acc, depthFromItem + 1, childSkip)
      continue
    }
    if (dirent.isFile()) {
      let st
      try {
        st = lstatSync(child)
      } catch (err) {
        acc.errors.push({ absolutePath: child, code: err.code ?? 'UNKNOWN', message: err.message })
        continue
      }
      acc.files += 1
      acc.logicalBytes += st.size
      if (st.mtimeMs > acc.maxMtimeMs) acc.maxMtimeMs = st.mtimeMs
      if (
        !childSkip &&
        depthFromItem <= MAX_MANIFEST_DEPTH &&
        isManifestName(dirent.name) &&
        acc.manifests.length < MAX_MANIFESTS_COLLECTED
      ) {
        acc.manifests.push({
          path: child,
          name: dirent.name,
          depth: depthFromItem,
          mtimeMs: st.mtimeMs,
        })
      }
      continue
    }
    // FIFO/socket/设备文件等其他类型：排除并记录，不计入统计
    acc.excluded.push({ absolutePath: child, reason: 'UNSUPPORTED_TYPE_SKIPPED' })
  }
}

/** 对单个顶层条目做完整统计，返回该条目专用的累加结果 */
function measureItem(root, itemPath, isDirectory) {
  const acc = {
    logicalBytes: 0,
    files: 0,
    directories: 0,
    maxMtimeMs: 0,
    errors: [],
    excluded: [],
    manifests: [],
  }
  if (isDirectory) {
    walk(root, itemPath, acc, 0, false)
  } else {
    try {
      const st = lstatSync(itemPath)
      acc.files = 1
      acc.logicalBytes = st.size
      acc.maxMtimeMs = st.mtimeMs
    } catch (err) {
      acc.errors.push({ absolutePath: itemPath, code: err.code ?? 'UNKNOWN', message: err.message })
    }
  }
  return acc
}

/** 列出验收副本条目的一层内容，据标记文件描述副本性质（仅 readdir 元数据，不读正文） */
function describeAcceptanceChild(childPath) {
  let names
  try {
    names = readdirSync(childPath, { withFileTypes: true }).map((d) => d.name)
  } catch {
    return '内容不可列读'
  }
  const has = (n) => names.includes(n)
  const markers = []
  if (has('node_modules')) markers.push('含开发依赖副本')
  if (has('package.json') && has('src')) markers.push('源码副本')
  if (names.some((n) => n.toLowerCase().endsWith('.exe'))) markers.push('解包应用')
  if (has('Cache') || has('Code Cache') || has('data.sqlite') || has('Local State')) {
    markers.push('应用用户数据副本')
  }
  if (has('electron-perf-owner.json')) markers.push('性能记录')
  if (has('evals')) markers.push('评测数据/配置')
  if (has('case-ids.json') && has('target.json')) markers.push('评测注入配置')
  return markers.length > 0 ? markers.join('、') : '未识别性质'
}

/** 单个顶层条目的分类：先查固定映射，再按验收工作区/兜底归类 */
function categoryForChild(root, name) {
  const fixed = TOP_LEVEL_CATEGORIES[name.toLowerCase()]
  if (fixed) return fixed
  if (isAcceptanceScope(root)) return 'acceptance-copy'
  return 'other'
}

/**
 * 扫描一个根目录，返回完整清单结果（不写文件）。
 * 抛出 ScanError/UsageError 由调用方决定进程行为。
 */
export function scanRoot(rootArg, outputArg) {
  // 前置校验：绝对路径
  if (!isAbsolute(rootArg)) {
    throw new ScanError('ROOT_NOT_ABSOLUTE', `--root 必须是绝对路径: ${rootArg}`)
  }
  if (!isAbsolute(outputArg)) {
    throw new ScanError('OUTPUT_NOT_ABSOLUTE', `--output 必须是绝对路径: ${outputArg}`)
  }
  const root = resolve(rootArg)
  const output = resolve(outputArg)
  // 自计数防护：输出文件不得落入扫描范围
  const relOut = relative(root, output)
  if (!(relOut.startsWith(`..${sep}`) || relOut === '..' || isAbsolute(relOut))) {
    throw new ScanError(
      'OUTPUT_INSIDE_ROOT',
      `输出路径位于扫描范围内，会造成自计数: ${output}`
    )
  }
  // 保护路径：仅登记，绝不遍历
  if (isProtectedRoot(root)) {
    const item = {
      absolutePath: root,
      category: 'protected',
      logicalBytes: null,
      files: null,
      directories: null,
      modifiedAtUtc: null,
      buildCommit: null,
      manifestPath: null,
      recommendation: 'protected',
      reason: '保护路径（用户数据）：仅登记，不遍历、不统计、不做任何删除',
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      tool: 'scripts/inventory-artifacts.mjs',
      scannedAtUtc: new Date().toISOString(),
      root,
      output,
      totals: { items: 1, logicalBytes: null, files: null, directories: null, errorCount: 0, excludedCount: 0 },
      categories: { protected: { items: 1, logicalBytes: null, files: null, directories: null } },
      items: [item],
      errors: [],
      excluded: [],
    }
  }
  // root 必须存在且是目录（不能是链接本身）
  let rootStat
  try {
    rootStat = lstatSync(root)
  } catch (err) {
    throw new ScanError('ROOT_NOT_FOUND', `扫描根不存在或不可访问: ${root} (${err.code ?? 'UNKNOWN'})`)
  }
  if (rootStat.isSymbolicLink()) {
    throw new ScanError('ROOT_IS_LINK', `扫描根本身是符号链接，已按 LINK_NOT_FOLLOWED 拒绝: ${root}`)
  }
  if (!rootStat.isDirectory()) {
    throw new ScanError('ROOT_NOT_DIRECTORY', `扫描根不是目录: ${root}`)
  }

  const acceptanceScope = isAcceptanceScope(root)
  const items = []
  const errors = []
  const excluded = []

  let dirents
  try {
    dirents = readdirSync(root, { withFileTypes: true })
  } catch (err) {
    throw new ScanError('ROOT_UNREADABLE', `扫描根不可读: ${root} (${err.code ?? 'UNKNOWN'})`)
  }

  const children = dirents
    .filter((d) => !d.isSymbolicLink())
    .map((d) => ({ dirent: d, name: d.name }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  for (const { dirent, name } of children) {
    const child = join(root, name)
    assertInsideRoot(root, child)
    if (dirent.isSymbolicLink()) {
      excluded.push({ absolutePath: child, reason: 'LINK_NOT_FOLLOWED' })
      continue
    }
    const isDir = dirent.isDirectory()
    const acc = measureItem(root, child, isDir)
    errors.push(...acc.errors)
    excluded.push(...acc.excluded)
    const category = categoryForChild(root, name)
    const policy = CATEGORY_POLICY[category]
    const identity = pickIdentity(acc.manifests)
    let reason = policy.reason
    if (acceptanceScope && category === 'acceptance-copy') {
      reason = `验收副本（${describeAcceptanceChild(child)}）：核对 manifest 与独有证据后逐项决定`
    }
    if (identity.identityReason) {
      reason += `；buildCommit 为 null 的原因: ${identity.identityReason}`
    }
    items.push({
      absolutePath: child,
      category,
      logicalBytes: acc.logicalBytes,
      files: acc.files,
      directories: acc.directories,
      modifiedAtUtc: acc.maxMtimeMs > 0 ? new Date(acc.maxMtimeMs).toISOString() : null,
      buildCommit: identity.buildCommit,
      manifestPath: identity.manifestPath,
      recommendation: policy.recommendation,
      reason,
    })
  }

  // 链接形式的顶层条目也输出为排除项条目，保证清单完整
  for (const d of dirents) {
    if (d.isSymbolicLink()) {
      const child = join(root, d.name)
      assertInsideRoot(root, child)
      excluded.push({ absolutePath: child, reason: 'LINK_NOT_FOLLOWED' })
    }
  }

  // 分类汇总（保护路径 null 不参与求和）
  const categories = {}
  for (const item of items) {
    const bucket = (categories[item.category] ??= {
      items: 0,
      logicalBytes: 0,
      files: 0,
      directories: 0,
    })
    bucket.items += 1
    if (typeof item.logicalBytes === 'number') bucket.logicalBytes += item.logicalBytes
    if (typeof item.files === 'number') bucket.files += item.files
    if (typeof item.directories === 'number') bucket.directories += item.directories
  }
  const totals = {
    items: items.length,
    logicalBytes: items.reduce((s, i) => s + (typeof i.logicalBytes === 'number' ? i.logicalBytes : 0), 0),
    files: items.reduce((s, i) => s + (typeof i.files === 'number' ? i.files : 0), 0),
    directories: items.reduce((s, i) => s + (typeof i.directories === 'number' ? i.directories : 0), 0),
    errorCount: errors.length,
    excludedCount: excluded.length,
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    tool: 'scripts/inventory-artifacts.mjs',
    scannedAtUtc: new Date().toISOString(),
    root,
    output,
    totals,
    categories,
    items,
    errors,
    excluded,
  }
}

/** 打印人类可读摘要 */
function printSummary(result) {
  const { totals, categories } = result
  console.log(`扫描根: ${result.root}`)
  console.log(
    `条目 ${totals.items}，逻辑字节 ${totals.logicalBytes}，文件 ${totals.files}，目录 ${totals.directories}，错误 ${totals.errorCount}，排除 ${totals.excludedCount}`
  )
  for (const [cat, bucket] of Object.entries(categories)) {
    console.log(
      `  ${cat}: ${bucket.items} 项 / ${bucket.logicalBytes} 字节 / ${bucket.files} 文件 / ${bucket.directories} 目录`
    )
  }
  console.log(`输出: ${result.output}`)
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`用法: node scripts/inventory-artifacts.mjs --root <绝对路径> --output <绝对JSON路径>`)
    console.error(err instanceof UsageError ? err.message : err)
    process.exit(2)
  }
  let result
  try {
    result = scanRoot(args.root, args.output)
  } catch (err) {
    console.error(err instanceof UsageError || err instanceof ScanError ? err.message : err)
    process.exit(1)
  }
  try {
    mkdirSync(dirname(result.output), { recursive: true })
    writeFileSync(result.output, `${JSON.stringify(result, null, 2)}\n`, 'utf-8')
  } catch (err) {
    console.error(`写出结果失败: ${err.message}`)
    process.exit(1)
  }
  printSummary(result)
  if (result.totals.errorCount > 0) {
    console.warn(`注意：扫描过程中有 ${result.totals.errorCount} 个不可读项，已记入 errors 字段。`)
  }
}

// 仅在直接执行时运行 CLI（被测试/其他模块导入时不触发扫描）
const entryFile = process.argv[1] ? resolve(process.argv[1]) : ''
if (entryFile !== '' && entryFile === fileURLToPath(import.meta.url)) {
  main()
}
