// ENG-01 目录清单扫描器行为测试：命令接口反例、固定分类、符号链接排除、权限不足与身份提取。
// 全部夹具使用自建临时目录；不依赖仓库内既有目录，也不修改任何被扫描内容（扫描器本身只读）。
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/inventory-artifacts.mjs')

const createdDirs: string[] = []

function makeTempRoot(prefix = 'inv-artifacts-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}

interface RunResult {
  status: number
  stdout: string
  stderr: string
  outputJson: string
}

/** 以子进程运行扫描器 CLI，返回退出码与输出 JSON 路径 */
function runScan(root: string, output: string, env?: Record<string, string>): RunResult {
  const res = spawnSync(process.execPath, [SCRIPT, '--root', root, '--output', output], {
    encoding: 'utf-8',
    env: env ? { ...process.env, ...env } : process.env,
  })
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    outputJson: output,
  }
}

function readResult(path: string): any {
  // 输出 JSON 由扫描器写出；这里只做反序列化供断言
  return JSON.parse(readFileSync(path, 'utf-8'))
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('inventory-artifacts 命令接口反例', () => {
  it('拒绝非绝对路径的 --root（ROOT_NOT_ABSOLUTE）', () => {
    const tmp = makeTempRoot()
    const out = join(tmp, 'out.json')
    const run = runScan('relative/not/absolute', out)
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('ROOT_NOT_ABSOLUTE')
  })

  it('拒绝非绝对路径的 --output（OUTPUT_NOT_ABSOLUTE）', () => {
    const tmp = makeTempRoot()
    const run = runScan(tmp, 'relative-out.json')
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('OUTPUT_NOT_ABSOLUTE')
  })

  it('拒绝非目录 root（ROOT_NOT_DIRECTORY）', () => {
    const tmp = makeTempRoot()
    const file = join(tmp, 'plain.txt')
    writeFileSync(file, 'x')
    const out = join(tmp, 'out.json')
    const run = runScan(file, out)
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('ROOT_NOT_DIRECTORY')
  })

  it('输出路径落入扫描范围时拒绝（OUTPUT_INSIDE_ROOT）且不产生输出文件', () => {
    const tmp = makeTempRoot()
    const out = join(tmp, 'inside.json')
    const run = runScan(tmp, out)
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('OUTPUT_INSIDE_ROOT')
    expect(readdirSync(tmp).includes('inside.json')).toBe(false)
  })
})

describe('inventory-artifacts 扫描行为', () => {
  it('符号链接记录 excluded（LINK_NOT_FOLLOWED）并停止该分支递归', () => {
    const tmp = makeTempRoot()
    const root = join(tmp, 'root')
    mkdirSync(join(root, 'sub'), { recursive: true })
    mkdirSync(join(root, 'target'), { recursive: true })
    writeFileSync(join(root, 'a.txt'), '0123456789') // 10 字节
    writeFileSync(join(root, 'sub', 'b.txt'), '01234567890123456789') // 20 字节
    writeFileSync(join(root, 'target', 'c.txt'), '01234') // 5 字节，不应被统计
    const link = join(root, 'link')
    try {
      symlinkSync(join(root, 'target'), link, 'dir')
    } catch {
      // 无符号链接权限时退回 junction（同样是 reparse point，lstat 视为符号链接）
      symlinkSync(join(root, 'target'), link, 'junction')
    }
    const out = join(tmp, 'out.json')
    const run = runScan(root, out)
    expect(run.status).toBe(0)
    const result = readResult(out)
    // 链接被排除且未跟随
    expect(result.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ absolutePath: link, reason: 'LINK_NOT_FOLLOWED' }),
      ])
    )
    // 递归在链接处停止：c.txt 只通过 target 条目统计一次（若链接被跟随会重复计为 4 个文件/40 字节）
    expect(result.totals.files).toBe(3)
    expect(result.totals.logicalBytes).toBe(35)
    const targetItem = result.items.find((i: any) => i.absolutePath === join(root, 'target'))
    expect(targetItem.files).toBe(1)
    // items 中不出现链接本身的统计条目
    expect(result.items.map((i: any) => i.absolutePath)).not.toContain(link)
  })

  it('权限不足的目录记入 errors，不当零字节成功', () => {
    const tmp = makeTempRoot()
    const root = join(tmp, 'root')
    const locked = join(root, 'locked')
    mkdirSync(locked, { recursive: true })
    writeFileSync(join(locked, 'secret.txt'), 'private')
    let denied = false
    if (process.platform === 'win32') {
      try {
        execFileSync('icacls', [locked, '/deny', `${process.env.USERNAME}:(RD)`])
      } catch {
        denied = false
      }
    } else {
      chmodSync(locked, 0o000)
    }
    try {
      // 探测：拒绝是否真的生效（Windows 上只读属性不阻止读取，需显式确认）
      try {
        readdirSync(locked)
      } catch {
        denied = true
      }
      if (!denied) {
        // 环境无法制造不可读目录（如以绕过 ACL 的特权运行），跳过断言而非伪造结果
        return
      }
      const out = join(tmp, 'out.json')
      const run = runScan(root, out)
      // 错误是清单的一部分：扫描完成（退出码 0），但错误必须显式可复核
      expect(run.status).toBe(0)
      expect(run.stderr).toContain('不可读项')
      const result = readResult(out)
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ absolutePath: locked }),
        ])
      )
      expect(result.errors[0].code).toMatch(/EPERM|EACCES/)
      const lockedItem = result.items.find((i: any) => i.absolutePath === locked)
      expect(lockedItem).toBeTruthy()
      expect(lockedItem.logicalBytes).toBe(0)
      // secret.txt 未被统计，也没有被静默吞掉（errors 里可复核）
      expect(result.totals.files).toBe(0)
    } finally {
      if (process.platform === 'win32') {
        try {
          execFileSync('icacls', [locked, '/reset', '/q'])
        } catch {
          // 重置失败时由 afterEach 的 rmSync force 兜底
        }
      }
    }
  })

  it('实现固定分类：源文件/版本历史/开发依赖/构建/证据，未匹配项为 other', () => {
    const tmp = makeTempRoot()
    const root = join(tmp, 'root')
    const sourceDirs = ['src', 'tests', 'docs', 'scripts', 'evals', 'fixtures', 'resources']
    for (const d of [...sourceDirs, '.git', 'node_modules', 'out', 'dist', 'artifacts', 'random-dir']) {
      mkdirSync(join(root, d), { recursive: true })
      writeFileSync(join(root, d, 'f.txt'), 'data')
    }
    writeFileSync(join(root, 'file.txt'), 'data')
    const out = join(tmp, 'out.json')
    const run = runScan(root, out)
    expect(run.status).toBe(0)
    const result = readResult(out)
    const byName = new Map<string, any>()
    for (const item of result.items) {
      byName.set(item.absolutePath.split(/[\\/]/).pop() as string, item)
    }
    for (const d of sourceDirs) expect(byName.get(d).category).toBe('source')
    expect(byName.get('.git').category).toBe('version-history')
    expect(byName.get('node_modules').category).toBe('dev-dependencies')
    expect(byName.get('out').category).toBe('build')
    expect(byName.get('dist').category).toBe('build')
    expect(byName.get('artifacts').category).toBe('evidence')
    expect(byName.get('random-dir').category).toBe('other')
    expect(byName.get('file.txt').category).toBe('other')
    // 每个目录条目统计到自己的 1 个文件；文件条目 files=1、directories=0
    expect(byName.get('file.txt').files).toBe(1)
    expect(byName.get('file.txt').directories).toBe(0)
    expect(byName.get('src').files).toBe(1)
    expect(byName.get('src').modifiedAtUtc).toBeTruthy()
  })

  it('身份提取：build-info.json 提供 buildCommit；无提交字段/无清单/node_modules 内清单均给 null 加明确原因', () => {
    const tmp = makeTempRoot()
    const root = join(tmp, 'root')
    const commit = 'a'.repeat(40)
    // 有身份：resources/build-info.json
    mkdirSync(join(root, 'pkgA', 'resources'), { recursive: true })
    writeFileSync(join(root, 'pkgA', 'resources', 'build-info.json'), JSON.stringify({ gitCommit: commit }))
    // 清单存在但无提交字段
    mkdirSync(join(root, 'pkgB'), { recursive: true })
    writeFileSync(join(root, 'pkgB', 'manifest.json'), JSON.stringify({ releaseId: 'x' }))
    // 无任何清单
    mkdirSync(join(root, 'pkgC'), { recursive: true })
    // 清单只存在于 node_modules 内（身份搜索跳过）
    mkdirSync(join(root, 'pkgD', 'node_modules'), { recursive: true })
    writeFileSync(
      join(root, 'pkgD', 'node_modules', 'build-info.json'),
      JSON.stringify({ gitCommit: 'd'.repeat(40) })
    )
    const out = join(tmp, 'out.json')
    const run = runScan(root, out)
    expect(run.status).toBe(0)
    const result = readResult(out)
    const byName = new Map<string, any>()
    for (const item of result.items) {
      byName.set(item.absolutePath.split(/[\\/]/).pop() as string, item)
    }
    expect(byName.get('pkgA').buildCommit).toBe(commit)
    expect(byName.get('pkgA').manifestPath).toBe(join(root, 'pkgA', 'resources', 'build-info.json'))
    expect(byName.get('pkgB').buildCommit).toBeNull()
    expect(byName.get('pkgB').reason).toContain('MANIFEST_WITHOUT_COMMIT')
    expect(byName.get('pkgC').buildCommit).toBeNull()
    expect(byName.get('pkgC').reason).toContain('NO_IDENTITY_MANIFEST')
    expect(byName.get('pkgD').buildCommit).toBeNull()
    expect(byName.get('pkgD').reason).toContain('NO_IDENTITY_MANIFEST')
  })

  it('保护路径仅登记不遍历（INVENTORY_PROTECTED_ROOTS）', () => {
    const tmp = makeTempRoot()
    // 保护根是 tmp/root；输出位于 tmp 下、保护根之外
    const root = join(tmp, 'root')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'secret.txt'), 'private')
    const out = join(tmp, 'out.json')
    const run = runScan(root, out, { INVENTORY_PROTECTED_ROOTS: root })
    expect(run.status).toBe(0)
    const result = readResult(out)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].category).toBe('protected')
    expect(result.items[0].logicalBytes).toBeNull()
    expect(result.items[0].recommendation).toBe('protected')
    expect(result.totals.files).toBeNull()
  })
})
