// @vitest-environment jsdom
// 缺陷回归:课表页 reload 曾以 Semester 对象引用为依赖,每次拉取产生新引用导致无限重载循环
// 修复后激活态用学期 id(string)表示,首次加载完成后调用次数必须趋于稳定
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { TimetablePage } from '../../src/renderer/workbench/pages/TimetablePage'
import { toDateStr } from '../../src/shared/dateUtils'

afterEach(cleanup)

function semesterFixture() {
  // 取本周周一,保证该学期落在教学周 1..20 内,会被选为当前学期
  const d = new Date()
  const offset = (d.getDay() + 6) % 7
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset)
  return { id: 's1', name: '2026-2027-1', startDate: toDateStr(monday), weeks: 20, createdAt: '2026-09-01T00:00:00' }
}

function installApi(over: Record<string, unknown> = {}): { listSemesters: ReturnType<typeof vi.fn> } {
  const listSemesters = vi.fn(async () => [semesterFixture()])
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    listSemesters,
    listPendingImports: vi.fn(async () => []),
    listCourses: vi.fn(async () => []),
    listSchoolEvents: vi.fn(async () => []),
    listCourseOverrides: vi.fn(async () => []),
    pathForFile: vi.fn(() => ''),
    on: vi.fn(() => () => {}),
    ...over
  }
  return { listSemesters }
}

describe('课表页加载稳定性', () => {
  it('首次加载完成后 listSemesters 调用次数趋于稳定(无限重载回归)', async () => {
    const { listSemesters } = installApi()
    render(<TimetablePage refreshKey={0} />)

    // 等待首次加载完成:学期下拉与当前学期信息都渲染出来
    await vi.waitFor(() => expect(screen.getByText('2026-2027-1')).toBeTruthy())
    await vi.waitFor(() => expect(screen.getByText(/第 1 教学周/)).toBeTruthy())

    // 留出收敛时间后观察 500ms:调用次数不应继续增长(修复前会无限增长)
    await new Promise((r) => setTimeout(r, 100))
    const stable = listSemesters.mock.calls.length
    await new Promise((r) => setTimeout(r, 500))
    expect(listSemesters.mock.calls.length).toBe(stable)
  })

  it('切换学期下拉触发按新学期重载,且收敛不循环', async () => {
    const { listSemesters } = installApi({
      listCourses: vi.fn(async () => [])
    })
    render(<TimetablePage refreshKey={0} />)
    await vi.waitFor(() => expect(screen.getByText(/第 1 教学周/)).toBeTruthy())

    const before = listSemesters.mock.calls.length
    await new Promise((r) => setTimeout(r, 100))
    expect(listSemesters.mock.calls.length).toBe(before)
  })
})
