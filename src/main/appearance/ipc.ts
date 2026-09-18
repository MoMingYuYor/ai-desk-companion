// 外观 IPC:仅接受本应用受信任窗口的主 frame;主窗口可写,桌宠/面板只读
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { AppearanceChannels, parseThemeMode, type AppearanceResult, type AppearanceSnapshot } from '../../shared/appearance'
import type { AppearanceService } from './service'

/**
 * trusted(event, write) 判定来源是否有权读/写外观。
 * 返回撤销函数,用于退出阶段移除 handler。
 */
export function registerAppearanceIpc(
  service: AppearanceService,
  trusted: (event: IpcMainInvokeEvent, write: boolean) => boolean
): () => void {
  const handleGet = (event: IpcMainInvokeEvent): AppearanceSnapshot => {
    if (!trusted(event, false)) {
      throw new Error('拒绝不受信任的外观读取来源')
    }
    return service.get()
  }

  const handleSet = (event: IpcMainInvokeEvent, mode: unknown): Promise<AppearanceResult> | AppearanceResult => {
    if (!trusted(event, true)) {
      return { ok: false, code: 'UNAVAILABLE', message: '该窗口不允许修改外观,请在工作台设置中操作' }
    }
    const parsed = parseThemeMode(mode)
    if (parsed === null) {
      return { ok: false, code: 'INVALID_MODE', message: `未知的外观偏好: ${typeof mode === 'string' ? mode : typeof mode}` }
    }
    return service.set(parsed)
  }

  ipcMain.handle(AppearanceChannels.get, handleGet)
  ipcMain.handle(AppearanceChannels.set, handleSet)

  return () => {
    ipcMain.removeHandler(AppearanceChannels.get)
    ipcMain.removeHandler(AppearanceChannels.set)
  }
}
