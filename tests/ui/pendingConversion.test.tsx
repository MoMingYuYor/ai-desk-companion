// @vitest-environment jsdom
// R7:待处理条目"转为日程"走一次原子命令,先在"转换为日程"预览中确认,不再连续调用两条旧 IPC
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import React from 'react'
import { PendingPage } from '../../src/renderer/workbench/pages/PendingPage'

afterEach(cleanup)

function installPendingApi(over: Record<string, unknown> = {}): {
  resolveExistingPending: ReturnType<typeof vi.fn>
  createEvent: ReturnType<typeof vi.fn>
  updatePending: ReturnType<typeof vi.fn>
} {
  const resolveExistingPending = vi.fn(async (_input: unknown) => ({
    ok: true, value: { pendingId: 'p1', targetId: 'e1' }
  }))
  const createEvent = vi.fn()
  const updatePending = vi.fn()
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    listPending: vi.fn(async () => [{
      id: 'p1', title: '整理材料', notes: null, status: 'open', revision: 1,
      createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z'
    }]),
    getWorkspaceEpoch: vi.fn(async () => 'epoch-1'),
    resolveExistingPending, createEvent, updatePending, on: vi.fn(() => () => {}),
    ...over
  }
  // over 可能整体替换 mock:返回实际生效的那个,避免断言到未被调用的替身
  return {
    resolveExistingPending: (over.resolveExistingPending as typeof resolveExistingPending) ?? resolveExistingPending,
    createEvent, updatePending
  }
}

it('R7: 待处理转日程使用一次原子命令且结束晚于开始', async () => {
  const { resolveExistingPending, createEvent, updatePending } = installPendingApi()
  render(<PendingPage refreshKey={0} />)
  fireEvent.click(await screen.findByRole('button', { name: '转为日程' }))
  const preview = await screen.findByRole('dialog', { name: '转换为日程' })
  expect(resolveExistingPending).not.toHaveBeenCalled()
  fireEvent.click(within(preview).getByRole('button', { name: '确认加入日历' }))
  await vi.waitFor(() => expect(resolveExistingPending).toHaveBeenCalledTimes(1))
  const command = resolveExistingPending.mock.calls[0][0] as { event: { startAt: string; endAt: string } }
  expect(new Date(command.event.endAt).getTime()).toBeGreaterThan(new Date(command.event.startAt).getTime())
  expect(createEvent).not.toHaveBeenCalled()
  expect(updatePending).not.toHaveBeenCalled()
})

it('R7: 预览一次计算时段并建议 30 分钟;取消不调用命令、不落库', async () => {
  const { resolveExistingPending, createEvent, updatePending } = installPendingApi()
  render(<PendingPage refreshKey={0} />)
  fireEvent.click(await screen.findByRole('button', { name: '转为日程' }))
  const preview = await screen.findByRole('dialog', { name: '转换为日程' })
  // 带标签的开始/结束字段,建议时长 30 分钟
  const start = (within(preview).getByLabelText('开始时间') as HTMLInputElement).value
  const end = (within(preview).getByLabelText('结束时间') as HTMLInputElement).value
  expect(new Date(end).getTime() - new Date(start).getTime()).toBe(30 * 60_000)
  fireEvent.click(within(preview).getByRole('button', { name: '取消' }))
  expect(resolveExistingPending).not.toHaveBeenCalled()
  expect(createEvent).not.toHaveBeenCalled()
  expect(updatePending).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('R7: 命令失败时预览保留编辑内容与错误原因,条目保持 open', async () => {
  const { resolveExistingPending } = installPendingApi({
    resolveExistingPending: vi.fn(async () => ({
      ok: false, error: { code: 'CONFLICT', message: '该条目已被其他修改更新,请刷新后重试', retryable: true }
    }))
  })
  render(<PendingPage refreshKey={0} />)
  fireEvent.click(await screen.findByRole('button', { name: '转为日程' }))
  const preview = await screen.findByRole('dialog', { name: '转换为日程' })
  fireEvent.change(within(preview).getByLabelText('标题'), { target: { value: '整理材料(改)' } })
  fireEvent.click(within(preview).getByRole('button', { name: '确认加入日历' }))
  expect(await screen.findByText('该条目已被其他修改更新,请刷新后重试')).toBeTruthy()
  // 编辑内容保留,可原样重试;列表条目仍为 open
  expect((within(preview).getByLabelText('标题') as HTMLInputElement).value).toBe('整理材料(改)')
  expect(screen.getByText('整理材料')).toBeTruthy()
  resolveExistingPending.mockClear()
  fireEvent.click(within(preview).getByRole('button', { name: '确认加入日历' }))
  await vi.waitFor(() => expect(resolveExistingPending).toHaveBeenCalledTimes(1))
})
