// 应用入口:数据库、引擎、提醒、窗口、托盘与单实例锁
import { app, BrowserWindow, Notification, powerMonitor } from 'electron'
import { join } from 'node:path'
import { openDatabase } from './db/connection'
import { getProviderApiKey, initSchema } from './db/dao'
import { decryptApiKey } from './keys'
import { Engine } from './services/engine'
import { ModelRouter } from './services/modelRouter'
import { ReminderService } from './services/reminder'
import { registerIpcHandlers, setDataChangedListener } from './ipc'
import { createPetWindow, createWorkbenchWindow, broadcastToAll, isQuitting, markQuitting } from './windows'
import { createTray, destroyTray } from './tray'
import { markPetBubble, markPetState } from './petBridge'

// 单实例锁:避免重复启动造成多份托盘/桌宠
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  bootstrap()
}

function bootstrap(): void {
  let reminders: ReminderService | null = null
  let dbRef: Awaited<ReturnType<typeof openDatabase>> | null = null

  app.on('second-instance', () => {
    createWorkbenchWindow(dbRef!.db)
  })

  app.whenReady().then(async () => {
    const sqlJsDistDir = app.isPackaged
      ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist')
      : join(app.getAppPath(), 'node_modules', 'sql.js', 'dist')

    const { db, flush } = await openDatabase(join(app.getPath('userData'), 'data.sqlite'), sqlJsDistDir)
    dbRef = { db, flush, raw: null as never }

    initSchema(db)

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
      }
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

    registerIpcHandlers({ db, engine, router, reminders })
    setDataChangedListener(() => {
      broadcastToAll('evt:data-changed', { at: Date.now() })
    })

    createWorkbenchWindow(db)
    createPetWindow(db)
    createTray(db, () => {
      markQuitting()
      app.quit()
    })
    reminders.start()

    powerMonitor.on('resume', () => reminders?.tick())

    app.on('before-quit', () => {
      markQuitting()
    })
    app.on('will-quit', () => {
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
