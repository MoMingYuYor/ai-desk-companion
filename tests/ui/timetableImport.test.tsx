// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { TimetablePage } from '../../src/renderer/workbench/pages/TimetablePage'

afterEach(cleanup)

function installApi(over: Record<string, unknown> = {}): {
  saveSemester: ReturnType<typeof vi.fn>
  saveCourse: ReturnType<typeof vi.fn>
  markImportHandled: ReturnType<typeof vi.fn>
} {
  const saveSemester = vi.fn(async (input: { id?: string; name: string; startDate: string; weeks: number }) => ({
    id: input.id ?? 's-new',
    name: input.name,
    startDate: input.startDate,
    weeks: input.weeks
  }))
  const saveCourse = vi.fn(async () => 'course-1')
  const markImportHandled = vi.fn(async () => {})
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    listSemesters: vi.fn(async () => []),
    listPendingImports: vi.fn(async () => []),
    listCourses: vi.fn(async () => []),
    listSchoolEvents: vi.fn(async () => []),
    listCourseOverrides: vi.fn(async () => []),
    saveSemester,
    saveCourse,
    markImportHandled,
    pathForFile: vi.fn(() => ''),
    on: vi.fn(() => () => {}),
    ...over
  }
  return { saveSemester, saveCourse, markImportHandled }
}

function pendingImport() {
  return {
    analysisId: 'a1',
    conversationId: 'c1',
    kind: 'timetable' as const,
    title: '高等数学课表',
    createdAt: '2026-09-18T10:00:00',
    payload: {
      semester: { name: '2026-2027-1', startDate: '2026-09-07', weeks: 20 },
      courses: [
        { name: '高等数学', weekday: 1, startTime: '08:00', endTime: '09:35', weeks: [[1, 17]], location: 'A-302', teacher: null }
      ],
      questions: []
    }
  }
}

describe('课表页导入', () => {
  it('无学期时点击导入课表也能打开向导(此前按钮无响应)', async () => {
    installApi()
    render(<TimetablePage refreshKey={0} />)
    fireEvent.click(await screen.findByRole('button', { name: '导入课表' }))
    expect(await screen.findByText(/把课表图片 \/ PDF \/ 文本文件拖到这里/)).toBeTruthy()
  })

  it('待确认清单:查看并导入 → 自动建学期 → 保存课程 → 标记已处理', async () => {
    const { saveSemester, saveCourse, markImportHandled } = installApi({
      listPendingImports: vi.fn(async () => [pendingImport()])
    })
    render(<TimetablePage refreshKey={0} />)

    fireEvent.click(await screen.findByRole('button', { name: '查看并导入' }))
    // 预览表格直接展示提取结果
    expect(await screen.findByText('高等数学')).toBeTruthy()
    expect(screen.getByText('周一')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /确认导入 1 门课程/ }))
    expect(await screen.findByText(/已导入 1 门课程/)).toBeTruthy()

    // 无学期 → 自动创建;课程挂到新学期;提取结果标记已处理
    await waitFor(() => expect(saveSemester).toHaveBeenCalledWith(expect.objectContaining({ name: '2026-2027-1', startDate: '2026-09-07', weeks: 20 })))
    expect(saveCourse).toHaveBeenCalledWith(expect.objectContaining({ semesterId: 's-new', name: '高等数学', weekday: 1 }))
    expect(markImportHandled).toHaveBeenCalledWith('a1')
  })

  it('忽略待确认项会调用标记并刷新清单', async () => {
    const listPendingImports = vi.fn(async () => [pendingImport()]).mockResolvedValueOnce([pendingImport()]).mockResolvedValue([])
    const { markImportHandled } = installApi({ listPendingImports })
    render(<TimetablePage refreshKey={0} />)

    fireEvent.click(await screen.findByRole('button', { name: '忽略' }))
    await waitFor(() => expect(markImportHandled).toHaveBeenCalledWith('a1'))
    // 标记后清单刷新,卡片消失
    await waitFor(() => expect(screen.queryByRole('button', { name: '查看并导入' })).toBeNull())
  })

  it('开始提取后向导立即关闭(后台提取),不阻塞任何操作', async () => {
    // 提取请求永不返回:验证向导不被阻塞,直接关闭并提示
    installApi({
      importTimetable: vi.fn(
        () => new Promise<{ conversationId: string; analysisId: string; payload: unknown }>(() => {})
      )
    })
    render(<TimetablePage refreshKey={0} />)
    fireEvent.click(await screen.findByRole('button', { name: '导入课表' }))

    fireEvent.change(screen.getByPlaceholderText(/也可以直接粘贴课表\/校历文本/), {
      target: { value: '星期一 08:00-09:35 高等数学' }
    })
    fireEvent.click(screen.getByRole('button', { name: '开始提取' }))

    // 向导立即关闭,出现后台提取提示
    expect(await screen.findByText(/正在后台提取/)).toBeTruthy()
    expect(screen.queryByPlaceholderText(/也可以直接粘贴课表\/校历文本/)).toBeNull()
    // 空态页面重新可见,可继续其他操作
    expect(await screen.findByText(/还没有设置学期/)).toBeTruthy()
  })

  it('没有待确认项时不渲染卡片,页面空态提示可用导入', async () => {
    installApi()
    render(<TimetablePage refreshKey={0} />)
    expect(await screen.findByText(/还没有设置学期/)).toBeTruthy()
    expect(screen.queryByText('待确认导入(来自拖拽分析)')).toBeNull()
  })
})
