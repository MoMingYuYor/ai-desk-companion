// SHOW-01 媒体清单生成器行为测试:参数反例、递归收集与哈希、可选身份字段、符号链接排除。
// 全部夹具使用自建临时目录;媒体内容为合成字节,不依赖任何真实截图或录屏。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/acceptance/media-manifest.mjs')

const BUILD_COMMIT = 'a'.repeat(40)
const ZIP_SHA256 = 'b'.repeat(64)

const createdDirs: string[] = []

function makeTempRoot(prefix = 'media-manifest-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

function runScript(args: string[]): RunResult {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8' })
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

function baseArgs(dir: string, output: string): string[] {
  return ['--dir', dir, '--output', output, '--build-commit', BUILD_COMMIT, '--zip-sha256', ZIP_SHA256]
}

function sha256Of(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('media-manifest 命令接口反例', () => {
  it('拒绝非绝对路径 --dir（DIR_NOT_ABSOLUTE, exit 2）', () => {
    const tmp = makeTempRoot()
    const run = runScript(baseArgs('relative/dir', join(tmp, 'out.json')))
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('DIR_NOT_ABSOLUTE')
  })

  it('拒绝非法 --build-commit（BUILD_COMMIT_INVALID, exit 2）', () => {
    const tmp = makeTempRoot()
    const run = runScript(baseArgs(tmp, join(tmp, 'out.json')).map((v) => (v === BUILD_COMMIT ? 'short-commit' : v)))
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('BUILD_COMMIT_INVALID')
  })

  it('拒绝非法 --zip-sha256（ZIP_SHA256_INVALID, exit 2）', () => {
    const tmp = makeTempRoot()
    const run = runScript(baseArgs(tmp, join(tmp, 'out.json')).map((v) => (v === ZIP_SHA256 ? 'abc123' : v)))
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('ZIP_SHA256_INVALID')
  })

  it('拒绝非法 --execution-mode（EXECUTION_MODE_INVALID, exit 2）', () => {
    const tmp = makeTempRoot()
    const run = runScript([...baseArgs(tmp, join(tmp, 'out.json')), '--execution-mode', 'live'])
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('EXECUTION_MODE_INVALID')
  })

  it('拒绝不存在目录（DIR_NOT_FOUND, exit 1）', () => {
    const tmp = makeTempRoot()
    const run = runScript(baseArgs(join(tmp, 'missing'), join(tmp, 'out.json')))
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('DIR_NOT_FOUND')
  })

  it('拒绝输出写入扫描目录内（OUTPUT_INSIDE_DIR, exit 2）', () => {
    const tmp = makeTempRoot()
    writeFileSync(join(tmp, 'a.png'), 'x')
    const run = runScript(baseArgs(tmp, join(tmp, 'out.json')))
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('OUTPUT_INSIDE_DIR')
  })

  it('目录内无媒体文件时拒绝成功（NO_MEDIA_FILES, exit 1）', () => {
    const tmp = makeTempRoot()
    writeFileSync(join(tmp, 'notes.txt'), '不是媒体')
    const output = join(tmpdir(), `media-manifest-out-${Date.now()}.json`)
    createdDirs.push(output)
    const run = runScript(baseArgs(tmp, output))
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('NO_MEDIA_FILES')
  })
})

describe('media-manifest 清单生成', () => {
  it('递归收集 png/mp4、忽略其他扩展名,哈希与字节数正确,按路径排序', () => {
    const tmp = makeTempRoot()
    mkdirSync(join(tmp, 'GUI-01'), { recursive: true })
    mkdirSync(join(tmp, 'videos'), { recursive: true })
    const pngA = Buffer.from('png-alpha-bytes')
    const pngB = Buffer.from('png-beta-bytes')
    const mp4 = Buffer.from('mp4-gamma-bytes')
    writeFileSync(join(tmp, 'GUI-01', 'gui-01-01-overview.png'), pngB)
    writeFileSync(join(tmp, 'videos', 'demo-ops.mp4'), mp4)
    writeFileSync(join(tmp, 'a-root.png'), pngA)
    writeFileSync(join(tmp, 'ignored.txt'), '非媒体文件')
    const output = join(tmpdir(), `media-manifest-out-${Date.now()}.json`)
    createdDirs.push(output)

    const run = runScript(baseArgs(tmp, output))
    expect(run.status).toBe(0)

    const manifest = JSON.parse(readFileSync(output, 'utf-8'))
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.tool).toBe('media-manifest')
    expect(manifest.buildCommit).toBe(BUILD_COMMIT)
    expect(manifest.zipSha256).toBe(ZIP_SHA256)
    expect(manifest.fileCount).toBe(3)
    expect(manifest.entries.map((e: { fileName: string }) => e.fileName)).toEqual([
      'GUI-01/gui-01-01-overview.png',
      'a-root.png',
      'videos/demo-ops.mp4'
    ])
    expect(manifest.entries[0].sha256).toBe(sha256Of(pngB))
    expect(manifest.entries[1].sha256).toBe(sha256Of(pngA))
    expect(manifest.entries[2].sha256).toBe(sha256Of(mp4))
    expect(manifest.entries[2].bytes).toBe(mp4.length)
    // 未提供的可选字段落 null,不编造
    expect(manifest.entries[0].operator).toBeNull()
    expect(manifest.entries[0].capturedAt).toBeNull()
    expect(manifest.entries[0].executionMode).toBeNull()
    expect(manifest.entries[0].caseId).toBeNull()
    expect(manifest.entries[0].runId).toBeNull()
    expect(manifest.entries[0].relatedEvidence).toBeNull()
    expect(manifest.errors).toEqual([])
  })

  it('可选身份字段与关联证据写入每个条目', () => {
    const tmp = makeTempRoot()
    writeFileSync(join(tmp, 'gui-03-01-clarify.png'), Buffer.from('clarify-bytes'))
    const output = join(tmpdir(), `media-manifest-out-${Date.now()}.json`)
    createdDirs.push(output)

    const run = runScript([
      ...baseArgs(tmp, output),
      '--operator', '测试操作者',
      '--execution-mode', 'fake',
      '--captured-at', '2026-10-08T18:00:00+08:00',
      '--case-id', 'GUI-03',
      '--run-id', 'run-sample-001',
      '--evidence', 'docs/acceptance/rc-improvements-20261008.md',
      '--evidence', 'DEL-02/gui-checks.csv'
    ])
    expect(run.status).toBe(0)

    const manifest = JSON.parse(readFileSync(output, 'utf-8'))
    const [entry] = manifest.entries
    expect(entry.operator).toBe('测试操作者')
    expect(entry.executionMode).toBe('fake')
    expect(entry.capturedAt).toBe('2026-10-08T18:00:00+08:00')
    expect(entry.caseId).toBe('GUI-03')
    expect(entry.runId).toBe('run-sample-001')
    expect(entry.relatedEvidence).toEqual([
      'docs/acceptance/rc-improvements-20261008.md',
      'DEL-02/gui-checks.csv'
    ])
  })

  it('符号链接不跟随:记录 LINK_NOT_FOLLOWED 错误并以退出码 1 失败', () => {
    const tmp = makeTempRoot()
    writeFileSync(join(tmp, 'real.png'), Buffer.from('real-bytes'))
    const link = join(tmp, 'linked.png')
    let canSymlink = true
    try {
      symlinkSync(join(tmp, 'real.png'), link, 'file')
    } catch {
      canSymlink = false
    }
    if (!canSymlink) {
      // 环境不支持文件符号链接时跳过本反例(不视为失败)
      return
    }
    const output = join(tmpdir(), `media-manifest-out-${Date.now()}.json`)
    createdDirs.push(output)

    const run = runScript(baseArgs(tmp, output))
    expect(run.status).toBe(1)
    const manifest = JSON.parse(readFileSync(output, 'utf-8'))
    expect(manifest.entries.map((e: { fileName: string }) => e.fileName)).toEqual(['real.png'])
    expect(manifest.errors).toEqual([expect.objectContaining({ code: 'LINK_NOT_FOLLOWED' })])
  })
})
