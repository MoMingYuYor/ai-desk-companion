// DEL-01 包身份校验器(scripts/verify-package-identity.mjs):
//
// 契约(delivery.md DEL-01):
//   node scripts/verify-package-identity.mjs --packaged <绝对包目录 win-unpacked> \
//     --expected-commit <完整commit> --output <绝对JSON路径>
// 可选 --source-root <绝对目录>:源根注入(默认 = 仓库根,由脚本位置推导);
// 仅测试夹具与工具链复用使用,不影响上述契约。
//
// 核对内容(源 = 本仓库根,由脚本位置推导;包 = --packaged 指向的 win-unpacked):
//   (a) 打包 build-info(resources/build-info.json,经 extraResources 落位):
//       commit 与 expected 一致、gitDirty=false、appVersion 与源 package.json 及
//       asar 内 package.json 三方一致;若 asar 内也存在 build-info.json 则交叉核对;
//   (b) 三棵只读资源树逐文件 SHA-256 + 树 hash:
//       源 evals/datasets     ↔ 包 resources/evals/datasets
//       源 fixtures/research  ↔ 包 resources/evals/fixtures/research
//       源 evals/prompts      ↔ 包 resources/evals/prompts
//       且两侧树 hash 与 build-info.resources 记录的预构建身份一致(逐文件清单同样核对);
//   (c) 源 out/** ↔ asar 内 out/**:路径集合 + 逐文件字节 SHA-256
//       (main/preload/三 renderer/CLI 六个关键入口单列核对;wasm/cmaps/字体
//       仍由 check-build.mjs 核查,不在此重复)。
//
// 输出:identity JSON(verdict PASS/FAIL、checks、diffs、树 hash、ZIP hash 引用、环境);
// 差异清单逐项打印到 stderr。存在性通过但身份错误的包必须 FAIL。
//
// 退出码:0 = PASS;1 = FAIL(输出 JSON 仍写出);2 = 用法错误(不写输出)。

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asarReadFile, collectTreeDiffs, hashTreeDir, walkAsarFiles } from './lib/build-identity.mjs'

const USAGE = [
  '用法:node scripts/verify-package-identity.mjs --packaged <绝对包目录> --expected-commit <完整commit> --output <绝对JSON>',
  '  --packaged        打包形态根目录(electron-builder win-unpacked 或解压后的便携目录),须为绝对路径',
  '  --expected-commit 预构建候选提交(40 位十六进制)',
  '  --output          身份 JSON 输出路径,须为绝对路径',
  '退出码:0=PASS;1=FAIL;2=用法错误'
].join('\n')

function failUsage(message) {
  console.error(`[verify-package-identity] ${message}\n${USAGE}`)
  process.exit(2)
}

// ---- 参数解析与校验 ----
const argv = process.argv.slice(2)
function argOf(name) {
  const i = argv.indexOf(name)
  return i === -1 ? null : argv[i + 1] ?? null
}
const packagedDir = argOf('--packaged')
const expectedCommit = argOf('--expected-commit')
const outputFile = argOf('--output')
const sourceRootArg = argOf('--source-root')
if (packagedDir === null || expectedCommit === null || outputFile === null) failUsage('缺少必需参数')
if (!isAbsolute(packagedDir)) failUsage(`--packaged 必须是绝对路径:${packagedDir}`)
if (!isAbsolute(outputFile)) failUsage(`--output 必须是绝对路径:${outputFile}`)
if (sourceRootArg !== null && !isAbsolute(sourceRootArg)) failUsage(`--source-root 必须是绝对路径:${sourceRootArg}`)
if (!/^[0-9a-f]{40}$/.test(expectedCommit)) failUsage(`--expected-commit 必须是 40 位十六进制完整提交:${expectedCommit}`)
if (!existsSync(packagedDir) || !statSync(packagedDir).isDirectory()) failUsage(`--packaged 目录不存在:${packagedDir}`)

const sourceRoot = sourceRootArg !== null ? resolve(sourceRootArg) : resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagedResources = join(packagedDir, 'resources')
const asarPath = join(packagedResources, 'app.asar')

// 三个只读资源树:build-info 键 = 源相对路径;包内落位见 extraResources 契约
const RESOURCE_TREES = [
  { infoKey: 'evals/datasets', sourceRel: 'evals/datasets', packagedRel: 'evals/datasets' },
  { infoKey: 'fixtures/research', sourceRel: 'fixtures/research', packagedRel: 'evals/fixtures/research' },
  { infoKey: 'evals/prompts', sourceRel: 'evals/prompts', packagedRel: 'evals/prompts' }
]

// out/ 六个关键入口(main/preload/三 renderer/CLI)——在整体 out/** 对比之外单列核对
const KEY_OUT_FILES = [
  'out/main/index.js',
  'out/main/eval-cli.js',
  'out/preload/index.js',
  'out/renderer/workbench.html',
  'out/renderer/pet.html',
  'out/renderer/panel.html'
]

/** 汇总容器:checks 逐项布尔,diffs 累积差异 */
const checks = []
const diffs = []
function addCheck(id, ok, detail) {
  checks.push({ id, ok, ...(detail !== undefined ? { detail } : {}) })
  return ok
}

// ---- (a) 打包 build-info 与身份字段 ----
const buildInfoPath = join(packagedResources, 'build-info.json')
let buildInfo = null
if (existsSync(buildInfoPath)) {
  try {
    buildInfo = JSON.parse(readFileSync(buildInfoPath, 'utf8'))
  } catch (err) {
    diffs.push({ kind: 'buildinfo_unreadable', path: 'resources/build-info.json', detail: String(err) })
  }
}
addCheck(
  'buildinfo',
  buildInfo !== null && typeof buildInfo === 'object',
  buildInfo === null ? `无法读取打包 build-info:${buildInfoPath}` : `gitCommit=${buildInfo.gitCommit} gitDirty=${buildInfo.gitDirty} appVersion=${buildInfo.appVersion}`
)

// ---- asar 存在性与文件清单 ----
let asarFiles = []
let asarOk = false
if (existsSync(asarPath)) {
  try {
    asarFiles = walkAsarFiles(asarPath)
    asarOk = true
  } catch (err) {
    diffs.push({ kind: 'asar_unreadable', path: 'resources/app.asar', detail: String(err) })
  }
} else {
  diffs.push({ kind: 'missing_in_packaged', path: 'resources/app.asar', detail: 'app.asar 缺失' })
}
addCheck('asar', asarOk, `${asarFiles.length} 个文件`)
const asarIndex = new Map(asarFiles.map((f) => [f.rel, f]))

// ---- commit / dirty / version ----
if (buildInfo !== null) {
  addCheck(
    'commit',
    buildInfo.gitCommit === expectedCommit,
    `expected=${expectedCommit} buildInfo=${buildInfo.gitCommit}(不一致即构建期间 HEAD 变化或包与候选不符)`
  )
  addCheck('dirty', buildInfo.gitDirty === false, `gitDirty=${buildInfo.gitDirty}(必须为 false 纯提交构建)`)
}

// 三方版本一致:源 package.json ↔ build-info ↔ asar package.json
const sourcePkgPath = join(sourceRoot, 'package.json')
const sourceVersion = existsSync(sourcePkgPath) ? JSON.parse(readFileSync(sourcePkgPath, 'utf8')).version : null
let asarVersion = null
if (asarOk && asarIndex.has('package.json')) {
  try {
    asarVersion = JSON.parse(asarReadFile(asarPath, 'package.json').toString('utf8')).version
  } catch {
    asarVersion = null
  }
}
const versionOk =
  buildInfo !== null && sourceVersion !== null && asarVersion !== null &&
  sourceVersion === buildInfo.appVersion && asarVersion === buildInfo.appVersion
addCheck(
  'version',
  versionOk,
  `source=${sourceVersion} buildInfo=${buildInfo?.appVersion ?? null} asar=${asarVersion}`
)

// asar 内若也有 build-info.json(非当前打包契约的必需落位),与 resources 版交叉核对
if (asarOk && asarIndex.has('build-info.json')) {
  try {
    const asarInfo = JSON.parse(asarReadFile(asarPath, 'build-info.json').toString('utf8'))
    const same = JSON.stringify(asarInfo) === JSON.stringify(buildInfo)
    addCheck('asar-buildinfo', same, 'asar 内 build-info.json 与 resources/build-info.json 一致性')
    if (!same) diffs.push({ kind: 'buildinfo_mismatch', path: 'app.asar:build-info.json', detail: 'asar 内与 resources/ 下 build-info 不一致' })
  } catch (err) {
    addCheck('asar-buildinfo', false, `asar 内 build-info.json 不可读:${String(err)}`)
  }
}

// ---- (b) 三棵资源树:源 ↔ 包 ↔ build-info 预构建身份 ----
const treeHashes = { source: {}, packaged: {}, buildInfo: {} }
for (const t of RESOURCE_TREES) {
  const sourceAbs = join(sourceRoot, t.sourceRel)
  const packagedAbs = join(packagedResources, t.packagedRel)
  const sourceTree = hashTreeDir(sourceAbs)
  const packagedTree = hashTreeDir(packagedAbs)
  if (sourceTree === null || packagedTree === null) {
    addCheck(`resource:${t.infoKey}`, false, sourceTree === null ? `源目录不存在:${t.sourceRel}` : `包目录不存在:${t.packagedRel}`)
    if (sourceTree === null) diffs.push({ kind: 'missing_in_source', tree: t.infoKey, path: t.sourceRel })
    if (packagedTree === null) diffs.push({ kind: 'missing_in_packaged', tree: t.infoKey, path: t.packagedRel })
    continue
  }
  treeHashes.source[t.infoKey] = sourceTree.treeSha256
  treeHashes.packaged[t.infoKey] = packagedTree.treeSha256

  // 路径集合 + 逐文件内容
  let treeOk = true
  for (const diff of collectTreeDiffs(sourceAbs, packagedAbs)) {
    treeOk = false
    diffs.push({ ...diff, tree: t.infoKey })
  }
  // 与 build-info 预构建记录核对(树 hash + 逐文件清单)
  const recorded = buildInfo?.resources?.[t.infoKey] ?? null
  if (recorded === null) {
    treeOk = false
    diffs.push({ kind: 'manifest_missing', tree: t.infoKey, detail: 'build-info.resources 缺少该树记录' })
  } else {
    treeHashes.buildInfo[t.infoKey] = recorded.treeSha256 ?? null
    if (recorded.treeSha256 !== sourceTree.treeSha256 || recorded.treeSha256 !== packagedTree.treeSha256) {
      treeOk = false
      diffs.push({
        kind: 'tree_hash_mismatch',
        tree: t.infoKey,
        sourceSha256: sourceTree.treeSha256,
        packagedSha256: packagedTree.treeSha256,
        buildInfoSha256: recorded.treeSha256
      })
    }
    const recordedFiles = recorded.files ?? {}
    for (const [rel, hash] of Object.entries(sourceTree.files)) {
      if (recordedFiles[rel] !== hash) {
        treeOk = false
        diffs.push({ kind: 'manifest_mismatch', tree: t.infoKey, path: rel, buildInfoSha256: recordedFiles[rel] ?? null, sourceSha256: hash })
      }
    }
  }
  addCheck(
    `resource:${t.infoKey}`,
    treeOk,
    `源 ${sourceTree.fileCount} 文件 ↔ 包 ${packagedTree.fileCount} 文件,tree=${sourceTree.treeSha256.slice(0, 12)}…`
  )
}

// ---- (c) 源 out/** ↔ asar out/**:路径集合 + 逐文件字节 hash ----
let outOk = asarOk
const sourceOutAbs = join(sourceRoot, 'out')
const sourceOut = hashTreeDir(sourceOutAbs)
const asarOut = asarFiles.filter((f) => f.rel === 'out' || f.rel.startsWith('out/'))
if (sourceOut === null) {
  outOk = false
  diffs.push({ kind: 'missing_in_source', tree: 'out', path: 'out(源 out/ 不存在,请先构建)' })
  addCheck('out', false, '源 out/ 不存在')
} else if (!asarOk) {
  addCheck('out', false, 'app.asar 不可读,无法对比 out/**')
} else {
  const asarOutMap = new Map()
  for (const f of asarOut) {
    if (f.unpacked) continue // out/** 无 unpacked 约定;真出现则按缺失处理
    asarOutMap.set(f.rel, asarReadFile(asarPath, f.rel, false))
  }
  // 源 out 树的 hashTreeDir 相对路径不含 out/ 前缀,统一补齐到与 asar 相同的路径空间
  const sourceOutMap = new Map(Object.entries(sourceOut.files).map(([rel, hash]) => [`out/${rel}`, hash]))
  const allRel = [...new Set([...sourceOutMap.keys(), ...asarOutMap.keys()])].sort()
  for (const rel of allRel) {
    const src = sourceOutMap.get(rel)
    const pkgBuf = asarOutMap.get(rel)
    if (src !== undefined && pkgBuf === undefined) {
      outOk = false
      diffs.push({ kind: 'missing_in_packaged', tree: 'out', path: rel })
    } else if (src === undefined && pkgBuf !== undefined) {
      outOk = false
      diffs.push({ kind: 'missing_in_source', tree: 'out', path: rel })
    } else {
      const pkgSha = createHash('sha256').update(pkgBuf).digest('hex')
      if (pkgSha !== src) {
        outOk = false
        diffs.push({ kind: 'content_mismatch', tree: 'out', path: rel, sourceSha256: src, packagedSha256: pkgSha })
      }
    }
  }
  // 六个关键入口(main/preload/三 renderer/CLI)必须全部在两侧出现
  const keyMissing = KEY_OUT_FILES.filter((rel) => !sourceOutMap.has(rel) || !asarOutMap.has(rel))
  if (keyMissing.length > 0) {
    outOk = false
    diffs.push({ kind: 'missing_in_packaged', tree: 'out', path: keyMissing.join(', '), detail: '关键入口缺失' })
  }
  addCheck('out', outOk, `源 ${sourceOut.fileCount} 文件 ↔ asar ${asarOutMap.size} 文件`)
}

// ---- ZIP hash 引用(同目录发行产物;信息项,不作为身份判定条件) ----
const zipReferences = []
const distDir = dirname(packagedDir)
if (existsSync(distDir)) {
  for (const name of readdirSync(distDir)) {
    if (name.toLowerCase().endsWith('.zip')) {
      const zipPath = join(distDir, name)
      const bytes = statSync(zipPath).size
      const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
      zipReferences.push({ path: zipPath, bytes, sha256 })
    }
  }
}

// ---- 汇总输出 ----
const verdict = diffs.length === 0 && checks.every((c) => c.ok) ? 'PASS' : 'FAIL'
const output = {
  schemaVersion: 1,
  tool: 'verify-package-identity',
  verdict,
  checkedAtUtc: new Date().toISOString(),
  sourceRoot,
  packagedDir,
  expectedCommit,
  buildInfo: buildInfo === null ? null : {
    gitCommit: buildInfo.gitCommit,
    gitDirty: buildInfo.gitDirty,
    builtAtUtc: buildInfo.builtAtUtc,
    appVersion: buildInfo.appVersion
  },
  appVersions: { source: sourceVersion, buildInfo: buildInfo?.appVersion ?? null, asarPackage: asarVersion },
  checks,
  diffs,
  treeHashes,
  outTree: { sourceFileCount: sourceOut?.fileCount ?? 0, asarFileCount: asarOut.length - asarOut.filter((f) => f.unpacked).length },
  zipReferences,
  environment: { node: process.version, platform: process.platform, arch: process.arch }
}
writeFileSync(outputFile, `${JSON.stringify(output, null, 2)}\n`, 'utf-8')

if (verdict === 'PASS') {
  console.log(`[verify-package-identity] PASS:身份零差异(commit=${expectedCommit},${checks.length} 项检查)`)
  console.log(`[verify-package-identity] 身份 JSON:${outputFile}`)
  process.exit(0)
}
console.error(`[verify-package-identity] FAIL:身份差异 ${diffs.length} 项:`)
for (const diff of diffs) console.error(`  - ${JSON.stringify(diff)}`)
console.error(`[verify-package-identity] 身份 JSON(含差异清单):${outputFile}`)
process.exit(1)
