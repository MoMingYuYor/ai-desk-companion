// 系统托盘:常驻入口,负责唤回窗口与彻底退出
import { Menu, Tray, app, nativeImage } from 'electron'
import { join } from 'node:path'
import { showWorkbench, togglePet, createPanelWindow } from './windows'
import type { SqliteDb } from './db/connection'

let tray: Tray | null = null

export function createTray(db: SqliteDb, onQuit: () => void): void {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'resources', 'tray.png')
    : join(app.getAppPath(), 'resources', 'tray.png')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('事务助手')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开工作台', click: () => showWorkbench(db) },
      { label: '显示 / 隐藏桌宠', click: () => togglePet(db) },
      { label: '今日面板', click: () => createPanelWindow(db) },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          onQuit()
        }
      }
    ])
  )
  tray.on('click', () => showWorkbench(db))
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
