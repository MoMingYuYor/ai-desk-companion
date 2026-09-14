// 窗口管理:工作台主窗口 / 桌宠悬浮窗 / 桌面信息面板
import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import type { SqliteDb } from './db/connection'
import { getMeta, setMeta } from './db/dao'

let workbenchWindow: BrowserWindow | null = null
let petWindow: BrowserWindow | null = null
let panelWindow: BrowserWindow | null = null

let quitting = false
export function markQuitting(): void {
  quitting = true
}
export function isQuitting(): boolean {
  return quitting
}

function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

function rendererUrl(page: string): string {
  if (process.env.ELECTRON_RENDERER_URL) {
    return `${process.env.ELECTRON_RENDERER_URL}/${page}.html`
  }
  return join(__dirname, '../renderer/', `${page}.html`)
}

// ---------- 工作台 ----------

export function createWorkbenchWindow(db: SqliteDb): BrowserWindow {
  if (workbenchWindow && !workbenchWindow.isDestroyed()) {
    workbenchWindow.show()
    workbenchWindow.focus()
    return workbenchWindow
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: '事务助手',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.on('ready-to-show', () => win.show())
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    workbenchWindow = null
  })
  win.loadURL(rendererUrl('workbench'))
  if (getMeta(db, 'ui:workbench-maximized') === '1') win.maximize()
  workbenchWindow = win
  return win
}

export function getWorkbenchWindow(): BrowserWindow | null {
  return workbenchWindow && !workbenchWindow.isDestroyed() ? workbenchWindow : null
}

export function showWorkbench(db: SqliteDb): BrowserWindow {
  return createWorkbenchWindow(db)
}

// ---------- 桌宠 ----------

export function createPetWindow(db: SqliteDb): BrowserWindow {
  if (petWindow && !petWindow.isDestroyed()) return petWindow
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  const savedX = getMeta(db, 'pet:x')
  const savedY = getMeta(db, 'pet:y')
  const petW = 150
  const petH = 170
  const x = savedX ? Number(savedX) : sw - petW - 24
  const y = savedY ? Number(savedY) : sh - petH - 24
  const win = new BrowserWindow({
    width: petW,
    height: petH,
    x,
    y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true)
  win.loadURL(rendererUrl('pet'))
  petWindow = win
  return win
}

export function getPetWindow(): BrowserWindow | null {
  return petWindow && !petWindow.isDestroyed() ? petWindow : null
}

export function togglePet(db: SqliteDb): void {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.isVisible() ? petWindow.hide() : petWindow.show()
  } else {
    createPetWindow(db)
  }
}

export function savePetPosition(db: SqliteDb): void {
  if (!petWindow || petWindow.isDestroyed()) return
  const [x, y] = petWindow.getPosition()
  setMeta(db, 'pet:x', String(x))
  setMeta(db, 'pet:y', String(y))
}

// ---------- 信息面板 ----------

export function createPanelWindow(db: SqliteDb): BrowserWindow {
  if (panelWindow && !panelWindow.isDestroyed()) {
    if (panelWindow.isVisible()) {
      panelWindow.hide()
      return panelWindow
    }
    positionPanelNearPet(panelWindow)
    panelWindow.show()
    return panelWindow
  }
  const pinned = getMeta(db, 'panel:pinned') === '1'
  const win = new BrowserWindow({
    width: 340,
    height: 560,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: pinned,
    show: false,
    transparent: false,
    backgroundColor: '#f6f7fb',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.on('blur', () => {
    if (getMeta(db, 'panel:pinned') !== '1' && win.isVisible()) win.hide()
  })
  win.loadURL(rendererUrl('panel'))
  positionPanelNearPet(win)
  win.show()
  panelWindow = win
  return win
}

function positionPanelNearPet(win: BrowserWindow): void {
  const pet = getPetWindow()
  if (!pet || pet.isDestroyed()) return
  const [px, py] = pet.getPosition()
  const panelBounds = win.getBounds()
  let x = px - panelBounds.width - 12
  let y = py
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  if (x < 8) x = px + 160
  if (y + panelBounds.height > sh) y = sh - panelBounds.height - 8
  win.setPosition(Math.max(8, x), Math.max(8, y))
}

export function getPanelWindow(): BrowserWindow | null {
  return panelWindow && !panelWindow.isDestroyed() ? panelWindow : null
}

export function setPanelPinnedMeta(db: SqliteDb, pinned: boolean): void {
  setMeta(db, 'panel:pinned', pinned ? '1' : '0')
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.setAlwaysOnTop(pinned)
  }
}

export function broadcastToAll(channel: string, payload: unknown): void {
  for (const win of [workbenchWindow, petWindow, panelWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}
