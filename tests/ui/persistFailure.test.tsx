// @vitest-environment jsdom
// R2:日程保存落盘失败时,页面保持编辑内容、明确标识"保存未确认"并提供重试入口;
// 重试成功才提示已保存。缺陷背景:裸 await 失败后无任何可见反馈(计划 Task 3 Step 3)。
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import React from 'react'
import { CalendarPage } from '../../src/renderer/workbench/pages/CalendarPage'

afterEach(cleanup)

function installApi(createEvent: ReturnType<typeof vi.fn>): void {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    listEvents: vi.fn(async () => []),
    getDayAgenda: vi.fn(async () => ({ date: '2026-09-21', courses: [], events: [], schoolEvents: [], todos: [] })),
    createEvent,
    updateEvent: vi.fn(async () => undefined),
    deleteEvent: vi.fn(async () => undefined),
    on: vi.fn(() => () => {})
  }
}

it('R2: 保存落盘失败时保留编辑内容并标识未确认,重试成功才提示已保存', async () => {
  const createEvent = vi.fn()
    .mockRejectedValueOnce(Object.assign(new Error('PERSIST_FAILED: 保存未确认(op-1)'), { code: 'PERSIST_FAILED' }))
    .mockResolvedValueOnce({
      id: 'e1', title: '周会', startAt: '2026-09-21T09:00', endAt: '2026-09-21T10:00',
      allDay: false, source: 'manual', status: 'active', revision: 1,
      createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z'
    })
  installApi(createEvent)

  render(<CalendarPage refreshKey={0} petAction={null} />)
  fireEvent.click(await screen.findByRole('button', { name: '+ 新建日程' }))
  const titleInput = await screen.findByPlaceholderText('日程标题') as HTMLInputElement
  fireEvent.change(titleInput, { target: { value: '周会' } })

  // 第一次保存:落盘失败 → 编辑器不关闭,显示"保存未确认",不出现"已保存"
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('保存未确认')
  expect(alert.textContent).toContain('op-1')
  expect(screen.queryByText('已保存')).toBeNull()
  expect(createEvent).toHaveBeenCalledTimes(1)
  // 编辑内容保留 + 重试入口(保存按钮)仍可用
  expect((screen.getByPlaceholderText('日程标题') as HTMLInputElement).value).toBe('周会')
  expect(screen.getByRole('button', { name: '保存' })).toBeTruthy()

  // 第二次保存(重试):成功 → 编辑器关闭并提示已保存,不重复创建
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await vi.waitFor(() => expect(screen.getByText('已保存')).toBeTruthy())
  expect(createEvent).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByPlaceholderText('日程标题')).toBeNull()
})
