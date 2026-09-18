// sweepStalePdfTemp 行为测试:只清理 pdf-scan- 前缀且 mtime 超龄的临时目录,不碰其他内容
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sweepStalePdfTemp } from '../../src/main/services/materials'

const kept: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  // 写一个文件模拟 extractEmbeddedImages 的页面图片产物
  writeFileSync(join(dir, 'page-1.png'), Buffer.from([0x89, 0x50]))
  return dir
}

afterEach(() => {
  while (kept.length > 0) {
    const dir = kept.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('扫描件临时目录清理', () => {
  it('删除 mtime 超过 7 天的 pdf-scan- 目录', () => {
    const stale = makeTempDir('pdf-scan-vitest-stale-')
    // 把 mtime 拨回 8 天前
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    utimesSync(stale, old, old)
    sweepStalePdfTemp()
    expect(() => statDir(stale)).toThrow()
  })

  it('保留 7 天内的 pdf-scan- 目录(近期会话可能仍引用图片路径)', () => {
    const fresh = makeTempDir('pdf-scan-vitest-fresh-')
    kept.push(fresh)
    sweepStalePdfTemp()
    expect(statDir(fresh)).toBeTruthy()
  })

  it('不碰非 pdf-scan- 前缀的临时目录', () => {
    const other = makeTempDir('vitest-other-')
    kept.push(other)
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    utimesSync(other, old, old)
    sweepStalePdfTemp()
    expect(statDir(other)).toBeTruthy()
  })
})

function statDir(path: string): boolean {
  // 目录已删除时 statSync 抛错,供 toThrow 断言
  return statSync(path).isDirectory()
}
