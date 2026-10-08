// DEL-01 包身份校验失败反例(tests/desktop/packageIdentity.test.ts):
//
// 用临时夹具构造「存在性通过但身份错误」的包形态,验证
// scripts/verify-package-identity.mjs 对以下反例必须 FAIL(exit 1)且差异清单
// 指向具体差异;基线夹具全部一致时必须 PASS(exit 0):
//   1) build-info commit 旧(与 expected 不一致 → 构建期间 HEAD 变化同路径)
//   2) gitDirty=true(冒充纯提交构建)
//   3) 版本不一致(build-info appVersion / asar package.json / 源 package.json)
//   4) 打包资源缺失 / 内容变化 / 多出文件
//   5) asar 内 out 内容旧(源 out 在打包后变化)
//   6) build-info 资源清单过期(树 hash 与实际资源不符)
//
// 夹具以 @electron/asar createPackage 生成真实 app.asar;树 hash 在测试内
// 独立实现(与 write-build-info.mjs 同一定义:POSIX 相对路径排序后
// "<path>\n<fileSha256>\n" 串接取 SHA-256),避免被测实现自证。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createPackage } from '@electron/asar'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/verify-package-identity.mjs')
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const COMMIT_CURRENT = 'a'.repeat(40)
const COMMIT_OLD = 'b'.repeat(40)
const APP_VERSION = '0.1.0'

/** 三个只读资源树:源相对路径 → 包内(resources/)相对路径 → build-info 键 */
const RESOURCE_TREES = [
  { sourceRel: 'evals/datasets', packagedRel: 'evals/datasets', infoKey: 'evals/datasets' },
  { sourceRel: 'fixtures/research', packagedRel: 'evals/fixtures/research', infoKey: 'fixtures/research' },
  { sourceRel: 'evals/prompts', packagedRel: 'evals/prompts', infoKey: 'evals/prompts' }
]

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 独立实现的确定性树 hash(与 write-build-info.mjs 定义一致,用于交叉验证) */
function treeHash(dir: string): { fileCount: number; treeSha256: string; files: Record<string, string> } {
  const files: Record<string, string> = {}
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const p = join(current, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) files[p.slice(dir.length + 1).replace(/\\/g, '/')] = sha256(readFileSync(p))
    }
  }
  walk(dir)
  const input = Object.entries(files)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, hash]) => `${path}\n${hash}\n`)
    .join('')
  return { fileCount: Object.keys(files).length, treeSha256: sha256(input), files }
}

interface Fixture {
  root: string
  srcRoot: string
  packaged: string
}

/** 构造一致基线夹具:源根(out/资源/源 package.json)+ 包目录(真实 asar + 资源 + build-info) */
async function buildFixture(opts?: { asarPackageVersion?: string }): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'pkg-identity-'))
  const srcRoot = join(root, 'src')
  const packaged = join(root, 'package', 'win-unpacked')

  // 源根:out 产物树(main/preload/三 renderer/CLI/chunks)+ 只读资源 + 源 package.json
  const outFiles: Record<string, string> = {
    'out/main/index.js': 'MAIN-BYTES-V1\n',
    'out/main/eval-cli.js': 'EVAL-CLI-BYTES-V1\n',
    'out/main/chunks/shared.js': 'CHUNK-BYTES-V1\n',
    'out/preload/index.js': 'PRELOAD-BYTES-V1\n',
    'out/renderer/workbench.html': 'WORKBENCH-V1\n',
    'out/renderer/pet.html': 'PET-V1\n',
    'out/renderer/panel.html': 'PANEL-V1\n',
    'out/renderer/assets/index.js': 'ASSET-V1\n'
  }
  for (const [rel, content] of Object.entries(outFiles)) {
    mkdirSync(join(srcRoot, rel, '..'), { recursive: true })
    writeFileSync(join(srcRoot, rel), content)
  }
  writeFileSync(join(srcRoot, 'package.json'), JSON.stringify({ name: 'fixture', version: APP_VERSION }))
  mkdirSync(join(srcRoot, 'evals', 'datasets', 'ds_v1'), { recursive: true })
  writeFileSync(join(srcRoot, 'evals', 'datasets', 'ds_v1', 'cases.jsonl'), '{"caseId":"c1"}\n')
  writeFileSync(join(srcRoot, 'evals', 'datasets', 'ds_v1', 'manifest.json'), '{"schemaVersion":1}\n')
  mkdirSync(join(srcRoot, 'fixtures', 'research', 'fx-001'), { recursive: true })
  writeFileSync(join(srcRoot, 'fixtures', 'research', 'fx-001', 'jd.txt'), 'FIXTURE-V1\n')
  mkdirSync(join(srcRoot, 'evals', 'prompts'), { recursive: true })
  writeFileSync(join(srcRoot, 'evals', 'prompts', 'manifest.json'), '{"schemaVersion":1}\n')

  // 包目录:asar(out/** + package.json)+ 三资源树副本 + build-info(树 hash 由夹具独立计算)
  const asarSrc = join(root, 'asar-src')
  mkdirSync(asarSrc, { recursive: true })
  cpSync(join(srcRoot, 'out'), join(asarSrc, 'out'), { recursive: true })
  writeFileSync(
    join(asarSrc, 'package.json'),
    JSON.stringify({ name: 'fixture', version: opts?.asarPackageVersion ?? APP_VERSION })
  )
  const res = join(packaged, 'resources')
  mkdirSync(res, { recursive: true })
  await createPackage(asarSrc, join(res, 'app.asar'))
  for (const t of RESOURCE_TREES) {
    cpSync(join(srcRoot, t.sourceRel), join(res, t.packagedRel), { recursive: true })
  }
  const resources: Record<string, ReturnType<typeof treeHash>> = {}
  for (const t of RESOURCE_TREES) resources[t.infoKey] = treeHash(join(srcRoot, t.sourceRel))
  writeFileSync(
    join(res, 'build-info.json'),
    JSON.stringify({
      schemaVersion: 1,
      gitCommit: COMMIT_CURRENT,
      gitDirty: false,
      builtAtUtc: '2026-10-08T00:00:00.000Z',
      appVersion: APP_VERSION,
      resources
    })
  )
  return { root, srcRoot, packaged }
}

interface IdentityOutput {
  schemaVersion: number
  verdict: 'PASS' | 'FAIL'
  diffs: Array<Record<string, unknown>>
  checks: Array<{ id: string; ok: boolean; detail?: string }>
  [key: string]: unknown
}

interface RunResult {
  status: number | null
  json: IdentityOutput | null
  stdout: string
  stderr: string
}

/** 以子进程驱动 CLI 契约(与真实调用形态一致;--source-root 注入夹具源根),输出 JSON 落盘后解析 */
function runIdentity(packaged: string, expectedCommit: string, srcRoot: string): RunResult {
  const output = join(packaged, '..', 'identity.json')
  const res = spawnSync(
    process.execPath,
    [SCRIPT, '--packaged', packaged, '--expected-commit', expectedCommit, '--output', output, '--source-root', srcRoot],
    { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true }
  )
  let json: IdentityOutput | null = null
  if (res.status === 0 || res.status === 1) {
    json = JSON.parse(readFileSync(output, 'utf8')) as IdentityOutput
  }
  return { status: res.status, json, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

function checkOk(json: IdentityOutput | null, id: string): boolean | undefined {
  return json?.checks.find((c) => c.id === id)?.ok
}

let cleanupRoots: string[] = []
afterEach(() => {
  for (const dir of cleanupRoots) rmSync(dir, { recursive: true, force: true })
  cleanupRoots = []
})

async function fresh(opts?: { asarPackageVersion?: string }): Promise<Fixture> {
  const fx = await buildFixture(opts)
  cleanupRoots.push(fx.root)
  return fx
}

describe('包身份校验 verify-package-identity(DEL-01)', () => {
  it('基线:源与包完全一致 → PASS(exit 0,差异清单为空)', async () => {
    const fx = await fresh()
    const res = runIdentity(fx.packaged, COMMIT_CURRENT, fx.srcRoot)
    expect(res.status).toBe(0)
    expect(res.json?.verdict).toBe('PASS')
    expect(res.json?.diffs).toEqual([])
  })

  it('反例:build-info commit 旧于 expected(HEAD 变化)→ FAIL', async () => {
    const fx = await fresh()
    const infoFile = join(fx.packaged, 'resources', 'build-info.json')
    const info = JSON.parse(readFileSync(infoFile, 'utf8')) as { gitCommit: string }
    info.gitCommit = COMMIT_OLD
    writeFileSync(infoFile, JSON.stringify(info))
    const res = runIdentity(fx.packaged, COMMIT_CURRENT, fx.srcRoot)
    expect(res.status).toBe(1)
    expect(res.json?.verdict).toBe('FAIL')
    expect(checkOk(res.json, 'commit')).toBe(false)
  })

  it('反例:gitDirty=true(冒充纯提交构建)→ FAIL', async () => {
    const fx = await fresh()
    const infoFile = join(fx.packaged, 'resources', 'build-info.json')
    const info = JSON.parse(readFileSync(infoFile, 'utf8')) as { gitDirty: boolean }
    info.gitDirty = true
    writeFileSync(infoFile, JSON.stringify(info))
    const res = runIdentity(fx.packaged, COMMIT_CURRENT, fx.srcRoot)
    expect(res.status).toBe(1)
    expect(checkOk(res.json, 'dirty')).toBe(false)
  })

  it('反例:build-info appVersion 与源/asar 版本不一致 → FAIL', async () => {
    const fx = await fresh()
    const infoFile = join(fx.packaged, 'resources', 'build-info.json')
    const info = JSON.parse(readFileSync(infoFile, 'utf8')) as { appVersion: string }
    info.appVersion = '0.2.0'
    writeFileSync(infoFile, JSON.stringify(info))
    const res = runIdentity(fx.packaged, COMMIT_CURRENT, fx.srcRoot)
    expect(res.status).toBe(1)
    expect(checkOk(res.json, 'version')).toBe(false)
  })

  it('反例:asar package.json 版本与源不一致 → FAIL', async () => {
    const fx = await fresh({ asarPackageVersion: '0.2.0' })
    const res = runIdentity(fx.packaged, COMMIT_CURRENT, fx.srcRoot)
    expect(res.status).toBe(1)
    expect(checkOk(res.json, 'version')).toBe(false)
  })

  it('反例:打包资源缺失文件 → FAIL(差异清单指明缺失路径)', async () => {
    const fx = await fresh()
    rmSync(join(fx.packaged, 'resources', 'evals', 'datasets', 'ds_v1', 'cases.jsonl'))
    const res = runIdentity(fx.packaged, COMMIT_CURRENT, fx.srcRoot)
    expect(res.status).toBe(1)
    expect(JSON.stringify(res.json?.diffs)).toContain('ds_v1/cases.jsonl')
  })

  it('反例:打包资源内容变化 → FAIL(内容差异 + 树 hash 不匹配)', async () => {
    const fx = await fresh()
    writeFileSync(join(fx.packaged, 'resources', 'evals', 'fixtures', 'research', 'fx-001', 'jd.txt'), 'TAMPERED\n')
    const res = runIdentity(fx.packaged, COMMIT_CURRENT, fx.srcRoot)
    expect(res.status).toBe(1)
    const text = JSON.stringify(res.json?.diffs)
    expect(text).toContain('fx-001/jd.txt')
    expect(text).toContain('content_mismatch')
  })

  it('反例:打包资源多出文件(路径集合不一致)→ FAIL', async () => {
    const fx = await fresh()
    mkdirSync(join(fx.packaged, 'resources', 'evals', 'prompts', 'extra'), { recursive: true })
    writeFileSync(join(fx.packaged, 'resources', 'evals', 'prompts', 'extra', 'rogue.txt'), 'ROGUE\n')
    const res = runIdentity(fx.packaged, COMMIT_CURRENT, fx.srcRoot)
    expect(res.status).toBe(1)
    expect(JSON.stringify(res.json?.diffs)).toContain('extra/rogue.txt')
  })

  it('反例:asar 内 out 内容旧(源 out 打包后变化)→ FAIL', async () => {
    const fx = await fresh()
    // 打包后源 out 再演进:asar 里仍是 V1 → 身份错必须 FAIL
    writeFileSync(join(fx.srcRoot, 'out', 'main', 'index.js'), 'MAIN-BYTES-V2\n')
    const res = runIdentity(fx.packaged, COMMIT_CURRENT, fx.srcRoot)
    expect(res.status).toBe(1)
    const text = JSON.stringify(res.json?.diffs)
    expect(text).toContain('out/main/index.js')
    expect(text).toContain('content_mismatch')
  })

  it('反例:build-info 资源清单过期(树 hash 与实际资源不符)→ FAIL', async () => {
    const fx = await fresh()
    const infoFile = join(fx.packaged, 'resources', 'build-info.json')
    const info = JSON.parse(readFileSync(infoFile, 'utf8')) as {
      resources: Record<string, { treeSha256: string }>
    }
    info.resources['evals/datasets'].treeSha256 = 'e'.repeat(64)
    writeFileSync(infoFile, JSON.stringify(info))
    const res = runIdentity(fx.packaged, COMMIT_CURRENT, fx.srcRoot)
    expect(res.status).toBe(1)
    expect(checkOk(res.json, 'resource:evals/datasets')).toBe(false)
  })

  it('非法调用:expected-commit 非 40 位十六进制 → 用法错误(exit 2)', async () => {
    const fx = await fresh()
    const res = runIdentity(fx.packaged, 'b58df1a', fx.srcRoot)
    expect(res.status).toBe(2)
  })
})
