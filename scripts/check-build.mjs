// 构建产物与资源检查(PKG-01):
// 1) 既有语义保留——out/main/index.js 必须比 src/ 与 resources/ 源码新,过期返回 1
//    (供启动脚本决定是否需要重新构建,避免每次启动都全量构建);
// 2) PKG-01 新增——main/preload/renderer/CLI 四产物、sql.js wasm、pdf.js cmaps/fonts、
//    评测只读数据资源(evals/datasets、fixtures/research、evals/prompts)与
//    build-info.json 的存在性检查,任何缺失返回非零;
// 3) 可选 --packaged <dir>:追加打包形态(electron-builder win-unpacked 或解压后的
//    便携目录)检查——app.asar、asar.unpacked 的 wasm、cmaps/standard_fonts、
//    resources/evals 下的数据资源与 resources/build-info.json。
//
// 退出码:0 全部通过;1 过期或缺失(缺失清单逐项打印到 stderr)。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
// SEC-01:生产 CSP 常量单一来源(node 24 原生类型剥离,直接导入 .ts)
import { extractCspMeta, PRODUCTION_RENDERER_CSP } from './lib/renderer-csp.ts'

const root = process.cwd()

// ---- 参数解析:--packaged <dir>(打包形态根目录) ----
const argv = process.argv.slice(2)
let packagedDir = null
{
  const i = argv.indexOf('--packaged')
  if (i !== -1) packagedDir = argv[i + 1] ?? null
  if (packagedDir != null && !existsSync(packagedDir)) {
    console.error(`[check-build] --packaged 目录不存在:${packagedDir}`)
    process.exit(1)
  }
}

const missing = []
function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) missing.push(`${label} 缺失文件:${path}`)
}
function dirHasFileDeep(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) return true
    if (entry.isDirectory() && dirHasFileDeep(join(dir, entry.name))) return true
  }
  return false
}
function requireDirWithFiles(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    missing.push(`${label} 缺失目录:${path}`)
    return
  }
  // 数据资源目录普遍按子目录组织(fixtures/<id>/、annotations/),须递归判断非空
  if (!dirHasFileDeep(path)) missing.push(`${label} 目录为空(递归无文件):${path}`)
}

// ---------- 1) 既有检查:out 相对 src/resources 是否最新 ----------
const entry = join(root, 'out', 'main', 'index.js')
const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

function newestMtimeMs(dir) {
  let newest = 0
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name)
    const m = name.isDirectory() ? newestMtimeMs(p) : statSync(p).mtimeMs
    if (m > newest) newest = m
  }
  return newest
}

let outdated = false
if (!existsSync(entry) || !existsSync(electronExe)) {
  outdated = true
} else {
  const builtAt = statSync(entry).mtimeMs
  const srcNewest = Math.max(newestMtimeMs(join(root, 'src')), newestMtimeMs(join(root, 'resources')))
  outdated = srcNewest > builtAt
}

// ---------- 2) 构建态(开发/CI)存在性检查 ----------
const out = join(root, 'out')
requireFile(join(out, 'main', 'index.js'), 'main 产物')
requireFile(join(out, 'main', 'eval-cli.js'), 'CLI 产物')
requireFile(join(out, 'preload', 'index.js'), 'preload 产物')
for (const html of ['workbench.html', 'pet.html', 'panel.html']) {
  requireFile(join(out, 'renderer', html), 'renderer 产物')
}

// ---------- 2.5) SEC-01:renderer CSP 静态出口 ----------
// 三个产物 HTML 的 CSP meta 必须存在、唯一,且与生产常量逐字一致。
// 注意:静态检查不能替代 scripts/acceptance/csp-smoke.mjs 的实际 Chromium 执行验证。
for (const html of ['workbench.html', 'pet.html', 'panel.html']) {
  const p = join(out, 'renderer', html)
  if (!existsSync(p) || !statSync(p).isFile()) continue // 缺失已由 requireFile 记录
  const text = readFileSync(p, 'utf8')
  const metas = text.match(/<meta\s[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi) ?? []
  if (metas.length !== 1) {
    missing.push(`renderer CSP meta 数量应为 1,实际 ${metas.length}:${p}`)
    continue
  }
  const meta = extractCspMeta(text)
  if (!meta || meta.content !== PRODUCTION_RENDERER_CSP) {
    missing.push(`renderer CSP meta 与生产常量不一致:${p}`)
  }
}
requireDirWithFiles(join(out, 'renderer', 'assets'), 'renderer 静态资源')

requireFile(join(root, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'), 'sql.js wasm')
requireDirWithFiles(join(root, 'node_modules', 'pdfjs-dist', 'standard_fonts'), 'pdf.js 字体')
requireDirWithFiles(join(root, 'node_modules', 'pdfjs-dist', 'cmaps'), 'pdf.js cmaps')

// 评测只读资源(源根形态)与 build-info
requireDirWithFiles(join(root, 'evals', 'datasets', 'personal_ops_v1'), '数据集 personal_ops_v1')
requireFile(join(root, 'evals', 'datasets', 'personal_ops_v2', 'manifest.json'), '数据集 personal_ops_v2 manifest')
requireFile(join(root, 'evals', 'datasets', 'personal_ops_v2', 'cases.jsonl'), '数据集 personal_ops_v2 cases')
requireDirWithFiles(join(root, 'evals', 'datasets', 'research_v1'), '数据集 research_v1')
requireDirWithFiles(join(root, 'fixtures', 'research'), '研究 fixtures')
requireFile(join(root, 'evals', 'prompts', 'manifest.json'), '冻结提示词 manifest')
requireFile(join(root, 'artifacts', 'build', 'build-info.json'), 'build-info')

// ---------- 3) 打包形态检查(--packaged 传入时) ----------
if (packagedDir != null) {
  const res = join(packagedDir, 'resources')
  const hasExe = readdirSync(packagedDir, { withFileTypes: true }).some(
    (e) => e.isFile() && e.name.toLowerCase().endsWith('.exe')
  )
  if (!hasExe) missing.push(`打包目录缺少 .exe:${packagedDir}`)
  requireFile(join(res, 'app.asar'), '打包 app.asar')
  requireFile(join(res, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'), '打包 sql.js wasm')
  requireDirWithFiles(join(res, 'standard_fonts'), '打包 pdf.js 字体')
  requireDirWithFiles(join(res, 'cmaps'), '打包 pdf.js cmaps')
  // 打包态资源契约与 src/main/evals/resources.ts 的 resolveEvalPaths 一一对应
  requireDirWithFiles(join(res, 'evals', 'datasets', 'personal_ops_v1'), '打包数据集 personal_ops_v1')
  requireFile(join(res, 'evals', 'datasets', 'personal_ops_v2', 'manifest.json'), '打包数据集 personal_ops_v2 manifest')
  requireFile(join(res, 'evals', 'datasets', 'personal_ops_v2', 'cases.jsonl'), '打包数据集 personal_ops_v2 cases')
  requireDirWithFiles(join(res, 'evals', 'datasets', 'research_v1'), '打包数据集 research_v1')
  requireDirWithFiles(join(res, 'evals', 'fixtures', 'research'), '打包研究 fixtures')
  requireFile(join(res, 'evals', 'prompts', 'manifest.json'), '打包冻结提示词 manifest')
  requireFile(join(res, 'build-info.json'), '打包 build-info')
}

// ---------- 汇总输出 ----------
if (missing.length > 0) {
  for (const item of missing) console.error(`[check-build] 缺失:${item}`)
  process.exit(1)
}
if (outdated) {
  console.error('[check-build] out/ 产物过期(源码比产物新),请重新构建')
  process.exit(1)
}
console.log(
  `[check-build] OK:构建产物与资源完整${packagedDir != null ? `;打包形态(${packagedDir})资源完整` : ''}`
)
process.exit(0)
