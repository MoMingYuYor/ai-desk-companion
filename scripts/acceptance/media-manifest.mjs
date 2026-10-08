#!/usr/bin/env node
// 媒体清单生成器（SHOW-01）：对目录内的 png/mp4 现算 SHA-256，并与候选包身份
// （buildCommit / zipSha256）绑定输出 media-manifest.json，供真人采集后一键生成。
//
// 约束（见 docs/superpowers/plans/2026-10-08-desk-companion-improvements/engineering-showcase.md SHOW-01 节）：
// - 全程只读扫描：只计算哈希，不修改、不移动、不上传任何媒体文件；
// - 身份字段必须由调用方显式提供，工具不推断 commit；
// - operator / capturedAt / executionMode / caseId / runId / 关联证据等未提供的字段落 null，不编造；
// - 哈希不可得的文件记入 errors 并整体失败，不得当作成功输出；
// - 输出按相对路径排序，保证同一目录内容产生的 manifest 字节稳定（generatedAtUtc 除外）。
//
// 用法：
//   node scripts/acceptance/media-manifest.mjs --dir <绝对目录> --output <绝对JSON路径> \
//     --build-commit <40位十六进制> --zip-sha256 <64位十六进制> \
//     [--operator <操作者>] [--execution-mode <fake|real>] [--captured-at <ISO8601>] \
//     [--case-id <案例id>] [--run-id <运行id>] [--evidence <路径>]（可重复）
//
// 退出码：0 成功；1 运行期错误（目录不存在、无媒体文件、文件不可读）；2 用法错误。

import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

const SCHEMA_VERSION = 1
const MEDIA_EXTENSIONS = new Set(['.png', '.mp4'])
// 单文件读取上限（500 MB）：录屏可能很大，超过按不可处理记录，避免内存失控
const MAX_FILE_BYTES = 500 * 1024 * 1024

function fail(code, message, exitCode) {
  console.error(`[media-manifest] ${code}: ${message}`)
  process.exit(exitCode)
}

// ---------- 参数解析 ----------
const argv = process.argv.slice(2)
const flags = { evidence: [] }
for (let i = 0; i < argv.length; i += 2) {
  const key = argv[i]
  const value = argv[i + 1]
  if (key === '--evidence') {
    flags.evidence.push(value)
    continue
  }
  if (!key.startsWith('--') || value === undefined) {
    fail('USAGE_INVALID', `无法解析参数:${key ?? '(缺失)'}`, 2)
  }
  flags[key.slice(2)] = value
}

const dir = flags.dir
const output = flags.output
const buildCommit = flags['build-commit']
const zipSha256 = flags['zip-sha256']

if (!dir || !isAbsolute(dir)) fail('DIR_NOT_ABSOLUTE', '--dir 必须是绝对目录路径', 2)
if (!output || !isAbsolute(output)) fail('OUTPUT_NOT_ABSOLUTE', '--output 必须是绝对 JSON 路径', 2)
if (!buildCommit || !/^[0-9a-f]{40}$/.test(buildCommit)) {
  fail('BUILD_COMMIT_INVALID', '--build-commit 必须是 40 位十六进制完整 commit', 2)
}
if (!zipSha256 || !/^[0-9a-f]{64}$/.test(zipSha256)) {
  fail('ZIP_SHA256_INVALID', '--zip-sha256 必须是 64 位十六进制 SHA-256', 2)
}
const executionMode = flags['execution-mode'] ?? null
if (executionMode !== null && executionMode !== 'fake' && executionMode !== 'real') {
  fail('EXECUTION_MODE_INVALID', `--execution-mode 只接受 fake|real,收到:${executionMode}`, 2)
}
const capturedAt = flags['captured-at'] ?? null
if (capturedAt !== null && Number.isNaN(Date.parse(capturedAt))) {
  fail('CAPTURED_AT_INVALID', `--captured-at 必须是可解析的 ISO8601 时间,收到:${capturedAt}`, 2)
}

let dirStat
try {
  dirStat = lstatSync(dir)
} catch {
  fail('DIR_NOT_FOUND', `目录不存在或不可访问:${dir}`, 1)
}
if (!dirStat.isDirectory()) fail('DIR_NOT_DIRECTORY', `--dir 不是目录:${dir}`, 1)

// 防自计数:输出文件不得落在扫描目录内（否则重跑会把旧 manifest 之外的输出当成目录成员）
const relOutput = relative(dir, output)
if (relOutput !== '' && !relOutput.startsWith(`..${sep}`) && !isAbsolute(relOutput)) {
  fail('OUTPUT_INSIDE_DIR', '--output 不得位于 --dir 内(避免自计数)', 2)
}

// ---------- 收集媒体文件（递归,不跟随符号链接） ----------
const errors = []
const mediaFiles = []

function walk(current) {
  let entries
  try {
    entries = readdirSync(current, { withFileTypes: true })
  } catch (err) {
    errors.push({ path: current, code: 'READDIR_FAILED', message: String(err) })
    return
  }
  for (const entry of entries) {
    const full = join(current, entry.name)
    if (entry.isSymbolicLink()) {
      errors.push({ path: full, code: 'LINK_NOT_FOLLOWED', message: '符号链接不跟随' })
      continue
    }
    if (entry.isDirectory()) {
      walk(full)
      continue
    }
    if (!entry.isFile()) continue
    const dot = entry.name.lastIndexOf('.')
    if (dot === -1) continue
    if (!MEDIA_EXTENSIONS.has(entry.name.slice(dot).toLowerCase())) continue
    mediaFiles.push(full)
  }
}

walk(dir)
mediaFiles.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

if (mediaFiles.length === 0) {
  fail('NO_MEDIA_FILES', `目录内未找到 png/mp4 媒体文件:${dir}`, 1)
}

// ---------- 逐文件现算 SHA-256 ----------
const shared = {
  capturedAt: capturedAt,
  operator: flags.operator ?? null,
  executionMode: executionMode,
  caseId: flags['case-id'] ?? null,
  runId: flags['run-id'] ?? null,
  relatedEvidence: flags.evidence.length > 0 ? [...flags.evidence] : null
}

const entries = []
for (const fullPath of mediaFiles) {
  let bytes
  let stat
  try {
    stat = lstatSync(fullPath)
    if (stat.size > MAX_FILE_BYTES) throw new Error(`文件超过 ${MAX_FILE_BYTES} 字节上限`)
    bytes = readFileSync(fullPath)
  } catch (err) {
    errors.push({ path: fullPath, code: 'FILE_UNREADABLE', message: String(err) })
    continue
  }
  entries.push({
    fileName: relative(dir, fullPath).split(sep).join('/'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: stat.size,
    ...shared
  })
}

if (entries.length === 0) {
  fail('ALL_MEDIA_UNREADABLE', '所有媒体文件均不可读,拒绝输出空成功', 1)
}

const manifest = {
  schemaVersion: SCHEMA_VERSION,
  tool: 'media-manifest',
  generatedAtUtc: new Date().toISOString(),
  buildCommit,
  zipSha256,
  sourceDir: dir,
  fileCount: entries.length,
  entries,
  errors
}

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
console.log(`[media-manifest] 已写出 ${entries.length} 个媒体条目 → ${output}`)
if (errors.length > 0) {
  console.error(`[media-manifest] 注意:${errors.length} 个条目被跳过,已记录在 manifest.errors`)
  process.exit(1)
}
process.exit(0)
