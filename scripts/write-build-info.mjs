// PKG-01:生成构建信息 artifacts/build/build-info.json,供打包与分发记录绑定。
//
// 内容契约(delivery.md PKG-01):
// - git 提交、dirty 标记(有未提交修改如实 dirty,不冒充纯提交构建)、
//   构建 UTC 时间、应用版本;
// - 资源 hash:evals/datasets、fixtures/research、evals/prompts 三个只读资源目录
//   的树 hash,并列出每个文件的单文件 SHA-256(资源 manifest)。
//
// 树 hash 定义(确定性):对目录递归收集全部文件,按 POSIX 风格相对路径排序,
// 拼接 "<path>\n<fileSha256>\n" 后取整体 SHA-256。任何内容或路径集合变化都会
// 改变树 hash,与平台文件系统顺序无关。
//
// 在 dist 链路最前执行(package.json 的 dist 脚本),electron-builder 的
// extraResources 随后把本文件打包为资源根下的 build-info.json。

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`[write-build-info] ${message}`)
  process.exit(1)
}

function sha256OfBuffer(data) {
  return createHash('sha256').update(data).digest('hex')
}

function git(args, what) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf-8', windowsHide: true }).trim()
  } catch (err) {
    fail(`git ${what} 失败:${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 递归收集目录下全部文件的相对路径(POSIX 风格 / 分隔),排序后返回 */
function listFilesRelative(dir) {
  if (!existsSync(dir)) fail(`资源目录不存在:${dir}`)
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const p = join(current, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) out.push(relative(dir, p).split(sep).join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

/** 单个资源目录的 manifest:每个文件 SHA-256 + 确定性树 hash */
function hashResourceDir(relativeDir) {
  const abs = join(root, relativeDir)
  const files = {}
  for (const rel of listFilesRelative(abs)) {
    files[rel] = sha256OfBuffer(readFileSync(join(abs, rel)))
  }
  const treeInput = Object.entries(files)
    .map(([path, hash]) => `${path}\n${hash}\n`)
    .join('')
  return {
    fileCount: Object.keys(files).length,
    treeSha256: sha256OfBuffer(Buffer.from(treeInput, 'utf-8')),
    files
  }
}

// ---- git 状态:提交与 dirty 标记(工作树/暂存区有任何未提交修改即 dirty) ----
const gitCommit = git(['rev-parse', 'HEAD'], 'rev-parse HEAD')
const gitStatus = git(['status', '--porcelain'], 'status')
const gitDirty = gitStatus.length > 0

// ---- 应用版本:读取 package.json(不 import,避免 ESM 缓存与路径假设) ----
const pkgFile = join(root, 'package.json')
const appVersion = JSON.parse(readFileSync(pkgFile, 'utf-8')).version
if (typeof appVersion !== 'string' || appVersion.length === 0) fail('package.json 缺少 version')

// ---- 只读资源 hash:与 extraResources 打包清单一一对应 ----
const RESOURCE_DIRS = ['evals/datasets', 'fixtures/research', 'evals/prompts']
const resources = {}
for (const dir of RESOURCE_DIRS) {
  resources[dir] = hashResourceDir(dir)
}

const buildInfo = {
  schemaVersion: 1,
  gitCommit,
  gitDirty,
  builtAtUtc: new Date().toISOString(),
  appVersion,
  resources
}

const outFile = join(root, 'artifacts', 'build', 'build-info.json')
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, `${JSON.stringify(buildInfo, null, 2)}\n`, 'utf-8')

const dirtyNote = gitDirty ? `dirty(${gitStatus.split('\n').length} 项未提交修改)` : 'clean'
console.log(
  `[write-build-info] ${outFile}\n` +
    `[write-build-info] commit=${gitCommit} ${dirtyNote} version=${appVersion} ` +
    `resources=${RESOURCE_DIRS.map((d) => `${d}:${resources[d].fileCount} 文件`).join(', ')}`
)
