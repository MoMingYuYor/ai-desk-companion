// EVAL-03 产物模块测试(artifacts.test.ts):pathGuard 防穿越、原子导出、
// manifest 完整性(complete 最后写)、hash 篡改检测(不继续评分)。
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ArtifactIntegrityError,
  ArtifactPathError,
  CASE_ARTIFACT_FILES,
  caseArtifactDir,
  evalBatchRoot,
  exportCaseArtifacts,
  loadCaseArtifacts,
  temporaryRoot,
  verifyCaseArtifacts,
  type CaseArtifactPayload
} from '../../src/main/evals/artifacts'

const ROOT = join(tmpdir(), 'eval-artifacts-test')

function makePayload(over: Partial<CaseArtifactPayload> = {}): CaseArtifactPayload {
  return {
    run: {
      evalRunId: 'eval-art-1',
      configId: 'fake_flow',
      caseId: 'ops-read-01',
      repeatIndex: 0,
      runId: 'run-1',
      caseStatus: 'passed'
    },
    traceEvents: [
      { runId: 'run-1', seq: 1, eventType: 'input', payload: { text: 'q' } },
      { runId: 'run-1', seq: 2, eventType: 'output', payload: { status: 'succeeded' } }
    ],
    observations: [{ callIndex: 0, tool: 'todo.list', ok: true }],
    ruleChecks: [{ key: 'args:todo.list', passed: true, expected: {}, actual: {}, reason: null }],
    researchScoring: null,
    report: { report_applicable: false, reason: 'not_applicable' },
    evidence: { applicable: false, reason: 'not_applicable' },
    snapshots: { applicable: false, reason: 'not_applicable' },
    meta: {
      datasetVersion: 'personal_ops_v1',
      datasetSha256: 'abc',
      codeVersion: '0.1.0-test',
      executionKind: 'fake',
      frozenClock: '2026-09-28T01:00:00.000Z',
      timezone: 'Asia/Shanghai',
      startedAt: '2026-09-28T01:00:00.000Z',
      finishedAt: null,
      stopReason: null
    },
    ...over
  }
}

function exportOnce(artifactRoot: string, over: Partial<CaseArtifactPayload> = {}): string {
  exportCaseArtifacts(
    artifactRoot,
    { evalRunId: 'eval-art-1', configId: 'fake_flow', caseId: 'ops-read-01', repeatIndex: 0 },
    makePayload(over)
  )
  return caseArtifactDir(artifactRoot, 'eval-art-1', 'fake_flow', 'ops-read-01', 0)
}

describe('EVAL-03 pathGuard:ID 只允许安全字符,解析后必须在批次根目录内', () => {
  it('合法 ID 产出的案例目录位于批次根目录之下', () => {
    const dir = caseArtifactDir('/tmp/evals', 'eval-abc1', 'fake_flow', 'ops-read-01', 0)
    expect(dir).toContain(join('eval-abc1', 'fake_flow', 'ops-read-01', '0'))
  })

  it('拒绝目录穿越、绝对路径段、空段与非法字符', () => {
    expect(() => caseArtifactDir(ROOT, '..', 'fake_flow', 'c', 0)).toThrow(ArtifactPathError)
    expect(() => caseArtifactDir(ROOT, 'eval-1', '..', 'c', 0)).toThrow(ArtifactPathError)
    expect(() => caseArtifactDir(ROOT, 'eval-1', 'cfg', 'a/b', 0)).toThrow(ArtifactPathError)
    expect(() => caseArtifactDir(ROOT, 'eval-1', 'cfg', 'c:\\abs', 0)).toThrow(ArtifactPathError)
    expect(() => caseArtifactDir(ROOT, 'eval-1', 'cfg', '', 0)).toThrow(ArtifactPathError)
    expect(() => caseArtifactDir(ROOT, 'eval-1', 'cfg', '.', 0)).toThrow(ArtifactPathError)
    expect(() => caseArtifactDir(ROOT, 'eval-1', 'cfg', 'case id 空格', 0)).toThrow(ArtifactPathError)
    expect(() => caseArtifactDir(ROOT, 'eval-1', 'cfg', 'c', -1)).toThrow(ArtifactPathError)
    expect(() => caseArtifactDir(ROOT, 'eval-1', 'cfg', 'c', 1.5)).toThrow(ArtifactPathError)
  })

  it('批次根与临时库根同样受守卫保护', () => {
    expect(() => evalBatchRoot(ROOT, '..')).toThrow(ArtifactPathError)
    expect(() => temporaryRoot(ROOT, 'a/b')).toThrow(ArtifactPathError)
    expect(temporaryRoot(ROOT, 'eval-1')).toContain(join('eval-1', 'temporary'))
  })
})

describe('EVAL-03 导出与完整性:manifest 最后写,hash 齐全才可回放', () => {
  it('导出后 8 个文件齐全,manifest complete:true 且逐文件 hash 一致', () => {
    mkdirSync(ROOT, { recursive: true })
    const dir = exportOnce(ROOT)
    for (const name of [...CASE_ARTIFACT_FILES, 'manifest.json']) {
      expect(existsSync(join(dir, name)), `缺少 ${name}`).toBe(true)
    }
    const verified = verifyCaseArtifacts(dir)
    expect(verified.ok).toBe(true)
    expect(verified.manifest?.complete).toBe(true)
    expect(verified.manifest?.files).toHaveLength(CASE_ARTIFACT_FILES.length)
    expect(verified.manifest?.runId).toBe('run-1')
    expect(verified.manifest?.executionKind).toBe('fake')
  })

  it('trace.jsonl 每行一个事件(时间线可重建),ops 的 report/evidence 明确 not_applicable', () => {
    const dir = exportOnce(ROOT)
    const lines = readFileSync(join(dir, 'trace.jsonl'), 'utf-8')
      .split('\n')
      .filter((l) => l.trim() !== '')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ seq: 1, eventType: 'input' })
    const loaded = loadCaseArtifacts(dir)
    expect(loaded.report).toEqual({ report_applicable: false, reason: 'not_applicable' })
    expect(loaded.observations).toHaveLength(1)
  })

  it('篡改任意一个内容文件:校验失败且 loadCaseArtifacts 拒绝继续评分', () => {
    const dir = exportOnce(ROOT)
    // 故意改动 report.json(保持合法 JSON,只改内容)
    writeFileSync(join(dir, 'report.json'), JSON.stringify({ report_applicable: false, reason: 'tampered' }), 'utf-8')
    const verified = verifyCaseArtifacts(dir)
    expect(verified.ok).toBe(false)
    expect(verified.mismatched).toEqual(['report.json'])
    expect(() => loadCaseArtifacts(dir)).toThrow(ArtifactIntegrityError)
  })

  it('删除 manifest 或内容文件同样不可回放', () => {
    const dir = exportOnce(ROOT, { observations: [] })
    unlinkSync(join(dir, 'manifest.json'))
    const missing = verifyCaseArtifacts(dir)
    expect(missing.ok).toBe(false)
    expect(missing.missing).toContain('manifest.json')
  })

  it('导出中途失败不写 manifest(无完整性标记),已有文件不留半写状态', () => {
    mkdirSync(ROOT, { recursive: true })
    const circular: Record<string, unknown> = { self: null }
    circular.self = circular
    expect(() =>
      exportOnce(ROOT, {
        // 环形引用使 JSON.stringify 抛错 → 导出失败 → manifest 不得写出
        observations: [circular as unknown as Record<string, unknown>]
      })
    ).toThrow()
    const dir = caseArtifactDir(ROOT, 'eval-art-1', 'fake_flow', 'ops-read-01', 0)
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false)
    // 已写出的文件是完整的 rename 产物,不是 .tmp 残留
    expect(existsSync(join(dir, 'report.json.tmp'))).toBe(false)
  })

  it('重复导出覆盖旧内容并刷新 hash(二次导出仍可校验通过)', () => {
    const dir = exportOnce(ROOT)
    exportOnce(ROOT, { researchScoring: { applicable: true } })
    const verified = verifyCaseArtifacts(dir)
    expect(verified.ok).toBe(true)
    const loaded = loadCaseArtifacts(dir)
    expect(loaded.researchScoring).toMatchObject({ applicable: true })
  })
})
