// 应用入口:数据库、引擎、提醒、窗口、托盘与单实例锁
import { app, BrowserWindow, Notification, nativeTheme, dialog } from 'electron'
import { join } from 'node:path'
import { openDatabase } from './db/connection'
import { getProviderApiKey, initSchema } from './db/dao'
import { decryptApiKey } from './keys'
import { Engine } from './services/engine'
import { ModelRouter } from './services/modelRouter'
import { ReminderService } from './services/reminder'
import { registerIpcHandlers, setDataChangedListener } from './ipc'
import {
  createPetWindow,
  createWorkbenchWindow,
  broadcastToAll,
  getPanelWindow,
  getPetWindow,
  getWorkbenchWindow,
  isQuitting,
  markQuitting
} from './windows'
import { createTray, destroyTray } from './tray'
import { markPetBubble, markPetState } from './petBridge'
import { createPetActivityRegistry } from './pet/activity'
import type { PetActivityNotice } from '../shared/pet'
import { MailService } from './mail/service'
import type { CredentialStorage } from './mail/credentials'
import { safeStorage, powerMonitor } from 'electron'
import { createAppearanceStore } from './appearance/store'
import { createAppearanceService, type AppearanceService, type NativeThemePort } from './appearance/service'
import { registerAppearanceIpc } from './appearance/ipc'
import { AppearanceChannels } from '../shared/appearance'

const safeStorageAdapter: CredentialStorage = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (value: string) => safeStorage.encryptString(value),
  decryptString: (value: Buffer) => safeStorage.decryptString(value)
}

// 单实例锁:避免重复启动造成多份托盘/桌宠
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  bootstrap()
}

function broadcastPetActivity(notice: PetActivityNotice): void {
  broadcastToAll('evt:pet-activity', notice)
}

function bootstrap(): void {
  let reminders: ReminderService | null = null
  let dbRef: Awaited<ReturnType<typeof openDatabase>> | null = null
  let appearanceService: AppearanceService | null = null
  let unregisterAppearance: (() => void) | null = null

  app.on('second-instance', () => {
    // 数据库尚未就绪时不创建半初始化窗口,仅忽略本次唤起
    if (dbRef) createWorkbenchWindow(dbRef.db)
  })

  app.whenReady().then(async () => {
    // 外观服务必须先于任何窗口创建:nativeTheme.themeSource 决定窗口初始配色
    const appearanceWarnings: string[] = []
    const store = createAppearanceStore(join(app.getPath('userData'), 'appearance.json'), (message) => {
      appearanceWarnings.push(message)
      console.warn('[appearance]', message)
    })
    const native: NativeThemePort = {
      get themeSource() {
        return nativeTheme.themeSource
      },
      set themeSource(value) {
        nativeTheme.themeSource = value
      },
      get shouldUseDarkColors() {
        return nativeTheme.shouldUseDarkColors
      },
      onUpdated: (listener) => {
        nativeTheme.on('updated', listener)
        return () => nativeTheme.removeListener('updated', listener)
      }
    }
    appearanceService = createAppearanceService({
      store,
      native,
      emit: (snapshot) => broadcastToAll(AppearanceChannels.changed, snapshot)
    })
    unregisterAppearance = registerAppearanceIpc(appearanceService, (event, write) => {
      // 只接受本应用三个窗口的主 frame;写权限仅工作台
      const frame = event.senderFrame
      if (frame && frame.parent) return false
      const senderId = event.sender.id
      const workbench = getWorkbenchWindow()
      const owned = [workbench, getPetWindow(), getPanelWindow()].some(
        (win) => win && !win.isDestroyed() && win.webContents.id === senderId
      )
      if (!owned) return false
      return write ? workbench !== null && workbench.webContents.id === senderId : true
    })

    const sqlJsDistDir = app.isPackaged
      ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist')
      : join(app.getAppPath(), 'node_modules', 'sql.js', 'dist')

    const { db, flush } = await openDatabase(join(app.getPath('userData'), 'data.sqlite'), sqlJsDistDir)
    dbRef = { db, flush, raw: null as never }

    initSchema(db)

    const petActivity = createPetActivityRegistry(broadcastPetActivity)

    const router = new ModelRouter({
      apiKeyOf: (providerId) => {
        const enc = getProviderApiKey(db, providerId)
        return enc ? decryptApiKey(enc) : null
      }
    })

    const engine = new Engine({
      db,
      router,
      broadcast: (channel, payload) => broadcastToAll(channel, payload),
      notifyModelSwitch: (n) => {
        markPetBubble(`${n.reason}:${n.from} → ${n.to}`)
        markPetState('alert')
        setTimeout(() => markPetState('idle'), 6000)
      },
      onPetActivity: (change) => petActivity.apply(change)
    })

    reminders = new ReminderService({
      db,
      broadcast: (channel, payload) => broadcastToAll(channel, payload),
      showNotification: (n) => {
        if (!Notification.isSupported()) return
        const notification = new Notification({ title: n.title, body: n.body })
        notification.show()
      },
      onFired: (n) => {
        markPetBubble(n.title)
        markPetState('alert')
        setTimeout(() => markPetState('idle'), 8000)
      }
    })

    const mail = new MailService({
      db,
      engine,
      storage: safeStorageAdapter,
      cacheDir: join(app.getPath('userData'), 'mail'),
      broadcast: (channel, payload) => broadcastToAll(channel, payload)
    })

    registerIpcHandlers({ db, engine, router, reminders, petActivity, mail })
    setDataChangedListener(() => {
      broadcastToAll('evt:data-changed', { at: Date.now() })
    })

    createWorkbenchWindow(db)
    createPetWindow(db)

    // 外观偏好读取告警暂存至此,首个工作台就绪后一次性提示,不阻断启动
    if (appearanceWarnings.length > 0) {
      const win = getWorkbenchWindow()
      const showWarnings = (): void => {
        void dialog.showMessageBox({
          type: 'warning',
          title: '外观设置',
          message: '外观偏好已回退为默认值',
          detail: appearanceWarnings.join('\n'),
          buttons: ['知道了']
        })
      }
      if (win && !win.isDestroyed() && win.webContents.isLoading()) {
        win.once('ready-to-show', showWarnings)
      } else {
        showWarnings()
      }
    }
    createTray(db, () => {
      markQuitting()
      app.quit()
    })
    reminders.start()
    mail.start()

    // 开发诊断:渲染进程崩溃转发到终端,便于定位白屏类问题
    if (!app.isPackaged) {
      app.on('render-process-gone', (_event, webContents, details) => {
        console.error('[renderer-gone]', details.reason, 'exitCode=', details.exitCode, 'url=', webContents.getURL())
      })
    }

    powerMonitor.on('resume', () => {
      reminders?.tick()
      // 唤醒后立即补收到期同步
      mail.runDueNow().catch((err) => console.error('[mail] resume sync failed:', err))
    })

    app.on('before-quit', () => {
      markQuitting()
      void mail.stop()
    })
    app.on('will-quit', () => {
      unregisterAppearance?.()
      appearanceService?.dispose()
      try {
        flush()
      } catch (err) {
        console.error('[db] final flush failed:', err)
      }
      destroyTray()
    })
  })

  app.on('window-all-closed', () => {
    // 常驻应用:关闭窗口不退出,交给托盘
    if (isQuitting()) app.quit()
  })

  process.on('uncaughtException', (err) => {
    console.error('[uncaught]', err)
    markPetBubble('发生内部错误,请查看日志')
  })

  // 防止 BrowserWindow GC 提前回收
  void BrowserWindow
}
