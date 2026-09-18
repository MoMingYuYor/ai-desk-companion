import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  clipboardReadText: vi.fn((): string => '')
}))

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
  app: {
    getVersion: vi.fn(() => '0.0.0'),
    getPath: vi.fn(() => '/tmp'),
    quit: vi.fn()
  },
  clipboard: { readText: electronMocks.clipboardReadText },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  screen: {
    getAllDisplays: vi.fn(() => []),
    getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }))
  },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) }
}))

// 气泡提示与窗口访问都打桩:仅验证剪贴板动作的失败兜底行为
vi.mock('../../src/main/petBridge', () => ({
  markPetBubble: vi.fn(),
  markPetState: vi.fn()
}))

import { registerIpcHandlers, runPetAction } from '../../src/main/ipc'
import type { Engine } from '../../src/main/services/engine'
import { markPetBubble } from '../../src/main/petBridge'

type IntakeMock = ReturnType<typeof vi.fn>

describe('桌宠"分析剪贴板通知"失败兜底', () => {
  let intake: IntakeMock

  beforeEach(() => {
    vi.mocked(markPetBubble).mockClear()
    electronMocks.clipboardReadText.mockReset()
    electronMocks.clipboardReadText.mockReturnValue('')
    intake = vi.fn()
    registerIpcHandlers({
      db: {} as never,
      engine: { intakeMaterials: intake } as unknown as Engine,
      router: {} as never,
      reminders: {} as never,
      petActivity: {} as never,
      mail: {} as never
    })
  })

  it('剪贴板有文本且分析失败:先提示开始,随后气泡提示失败(不产生 unhandledrejection)', async () => {
    electronMocks.clipboardReadText.mockReturnValue('会议通知全文')
    intake.mockRejectedValue(new Error('模型超时'))

    runPetAction('analyze-clipboard')

    expect(intake).toHaveBeenCalledWith({
      texts: [{ name: '剪贴板通知', content: '会议通知全文' }],
      autoRun: true
    })
    expect(markPetBubble).toHaveBeenCalledWith('已开始分析剪贴板通知…')

    await vi.waitFor(() => {
      expect(markPetBubble).toHaveBeenCalledWith('剪贴板分析失败,请重试')
    })
  })

  it('分析成功:不出现失败气泡', async () => {
    electronMocks.clipboardReadText.mockReturnValue('通知全文')
    intake.mockResolvedValue({ conversationId: 'c1', materials: [] })

    runPetAction('analyze-clipboard')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(markPetBubble).not.toHaveBeenCalledWith('剪贴板分析失败,请重试')
  })

  it('剪贴板无文本:仅提示无内容,不触发分析', () => {
    electronMocks.clipboardReadText.mockReturnValue('   ')

    runPetAction('analyze-clipboard')

    expect(intake).not.toHaveBeenCalled()
    expect(markPetBubble).toHaveBeenCalledWith('剪贴板没有文本内容')
  })
})
