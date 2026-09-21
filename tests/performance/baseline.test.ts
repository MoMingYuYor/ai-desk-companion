// O2 基线采集:运行 scripts/measure-baseline.mjs,验证固定种子合成数据集与报告结构。
// 该基准只覆盖 Node 中 sql.js 的查询耗时,不代表 Electron 主进程延迟或 Windows 主线程阻塞指标;
// 暖态查询 P95 300ms 与交互连续阻塞 100ms 的验收需在真实 Windows/Electron runtime 单独采集。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'

/** 单项查询的耗时统计(毫秒) */
interface MeasurementStat {
  p50Ms: number
  p95Ms: number
  minMs: number
  maxMs: number
  runs: number
}

/** 测量脚本产出的基线报告结构 */
interface BaselineReport {
  reportVersion: number
  generatedAt: string
  environment: {
    node: string
    sqljs: string
    platform: string
    arch: string
    seed: number
  }
  dataset: {
    events: number
    todos: number
    mails: number
    warmupRuns: number
    measuredRuns: number
  }
  measurements: Record<string, MeasurementStat>
  notes: string[]
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const FIXED_SEED = 20260920
const outputDir = mkdtempSync(join(tmpdir(), 'baseline-test-'))
const outputPath = join(outputDir, 'baseline.json')

let report: BaselineReport

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/measure-baseline.mjs', '--output', outputPath], {
    cwd: repoRoot,
    timeout: 150_000
  })
  report = JSON.parse(readFileSync(outputPath, 'utf8')) as BaselineReport
}, 180_000)

afterAll(() => {
  rmSync(outputDir, { recursive: true, force: true })
})

it('O2: 固定种子合成数据集规模精确为 1 万条日程、待办与邮件', () => {
  expect(report.dataset.events).toBe(10_000)
  expect(report.dataset.todos).toBe(10_000)
  expect(report.dataset.mails).toBe(10_000)
})

it('O2: 事件区间查询统计含非负 P50/P95 与测量次数', () => {
  const stat = report.measurements.eventsRange
  expect(stat).toBeTruthy()
  expect(stat.p50Ms).toBeGreaterThanOrEqual(0)
  expect(stat.p95Ms).toBeGreaterThanOrEqual(0)
  expect(stat.runs).toBeGreaterThan(0)
})

it('O2: 报告记录 Node 与 sql.js 版本及固定种子', () => {
  expect(report.environment.node).toBeTruthy()
  expect(report.environment.sqljs).toBeTruthy()
  expect(report.environment.seed).toBe(FIXED_SEED)
})

it('O2: 报告明确声明 Node 基准范围,不冒充 Electron 指标', () => {
  expect(Array.isArray(report.notes) && report.notes.length > 0).toBe(true)
  expect(report.notes.some((note) => note.includes('Electron'))).toBe(true)
})
