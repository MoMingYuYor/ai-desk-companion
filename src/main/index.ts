// 应用入口:数据库、引擎、提醒、窗口、托盘与单实例锁
import { app, BrowserWindow, Notification, nativeTheme, dialog } from 'electron'
import { join, isAbsolute } from 'node:path'
import { mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { openDatabase } from './db/connection'
import { getProviderApiKey, initSchema } from './db/dao'
import { createPersistenceCoordinator, initWorkspaceEpoch } from './db/operations'
import { decryptApiKey, migrateLegacyProviderKeys } from './keys'
import { Engine } from './services/engine'
import { sweepStalePdfTemp } from './services/materials'
import { ModelRouter } from './services/modelRouter'
import { ReminderService } from './services/reminder'
import { registerIpcHandlers, setDataChangedListener } from './ipc'
import {
  createPetWindow,
  createWorkbenchWindow,
  broadcastToAll,
  broadcastToWorkbench,
  getWorkbenchWindow,
  isQuitting,
  markQuitting
} from './windows'
import { AgentEventStream } from './agent/eventStream'
import { RunOrchestrator } from './agent/orchestrator'
import { RunQueue } from './agent/runQueue'
import { RunScheduler } from './agent/runScheduler'
import { createAgentGateway } from './agent/runtime'
import { ModelCompleter } from './agent/completer'
import { startPersonalOpsMcpStdio } from './mcp/server'
import { appendTraceEvent } from './runs/repository'
import { ToolRegistry } from './tools/registry'
import { ToolGateway } from './tools/gateway'
import { registerOpsTools } from './tools/definitions'
import { seedDemoData } from './agent/seed'
import { recoverInterruptedRuns } from './agent/recovery'
import { ResearchWorkflow } from './research/workflow'
import { createTray, destroyTray } from './tray'
import { markPetBubble, markPetState } from './petBridge'
import { createPetActivityRegistry } from './pet/activity'
import type { PetActivityNotice } from '../shared/pet'
import { MailService } from './mail/service'
import type { CredentialStorage } from './mail/credentials'
import { safeStorage, powerMonitor } from 'electron'
import { systemClock } from '../shared/clock'
import { createAppearanceStore } from './appearance/store'
import { createAppearanceService, type AppearanceService, type NativeThemePort } from './appearance/service'
import { registerAppearanceIpc } from './appearance/ipc'
import { AppearanceChannels } from '../shared/appearance'

const safeStorageAdapter: CredentialStorage = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (value: string) => safeStorage.encryptString(value),
  decryptString: (value: Buffer) => safeStorage.decryptString(value)
}

// E2E-01/MCP-01:启动参数——--user-data <绝对目录>(隔离用户目录,测试与验收用)、
// --mcp(以 stdio MCP 服务模式运行,不创建窗口)。必须在 app ready 前 setPath。
const CLI_USER_DATA = (() => {
  const argv = process.argv
  const i = argv.indexOf('--user-data')
  if (i === -1) return null
  const dir = argv[i + 1]
  if (!dir || !isAbsolute(dir)) {
    console.error('[startup] --user-data 需要一个绝对路径参数,收到:', dir ?? '(缺失)')
    app.quit()
    return null
  }
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    console.error('[startup] --user-data 目录创建失败:', err instanceof Error ? err.message : String(err))
    app.quit()
    return null
  }
  return dir
})()
const CLI_MCP_MODE = process.argv.includes('--mcp')
if (CLI_USER_DATA) {
  app.setPath('userData', CLI_USER_DATA)
  console.log(`[startup] 使用隔离用户目录:${CLI_USER_DATA}`)
}

// 单实例锁:避免重复启动造成多份托盘/桌宠;
// MCP 模式与桌面实例争锁时给出可诊断冲突(E2E-01/MCP-01)。
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  if (CLI_MCP_MODE) {
    console.error('[mcp] 无法获取单实例锁:同一 userData 已有运行中的应用;MCP 模式需独占用户目录')
  }
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
    // 后台清理历史扫描件提取的临时目录:fire-and-forget,失败仅记录
    setTimeout(() => {
      try {
        sweepStalePdfTemp()
      } catch (err) {
        console.error('[materials] 清理扫描件临时目录失败:', err)
      }
    }, 0)

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
    // 外观通道走 ipcPolicy 默认策略(登记窗口 + 精确页面 + 能力表:三窗口可读,仅工作台可写)
    unregisterAppearance = registerAppearanceIpc(appearanceService)

    const sqlJsDistDir = app.isPackaged
      ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist')
      : join(app.getAppPath(), 'node_modules', 'sql.js', 'dist')

    const { db, flush } = await openDatabase(join(app.getPath('userData'), 'data.sqlite'), sqlJsDistDir)
    dbRef = { db, flush, raw: null as never, persist: null as never }

    initSchema(db)
    // 版本迁移/初始化必须先持久化成功,再打开业务窗口
    db.flush()
    // R4:历史 plain: 模型密钥迁移——加密可用时事务化替换;不可用时标待处理,
    // 这些记录在迁移完成前不能经模型路由继续使用(decryptApiKey 拒绝 plain:)
    const keyMigration = migrateLegacyProviderKeys(db, safeStorageAdapter)
    if (keyMigration.pending > 0) {
      console.warn(
        `[keys] 历史 plain: 模型密钥待迁移 ${keyMigration.pending} 条(safeStorage 不可用或载荷损坏),迁移前相关服务商不可用`
      )
    }
    // 工作空间代数:每次启动更新,旧窗口写请求随后按 STALE_PREVIEW 拒绝
    initWorkspaceEpoch()
    const persistCoordinator = createPersistenceCoordinator(db)

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

    // C-03:Agent 运行事件只发工作台(桌宠与面板按能力表拒绝 Agent 通道)。
    // 启动恢复(recoverInterruptedRuns)不在此广播:执行时窗口尚不存在,
    // 渲染层加载后经 agent:run-get / agent:run-events 拉取初始状态。
    const agentEvents = new AgentEventStream({ send: broadcastToWorkbench })

    // A 系列:八个本地工具 + 编排器。规划走真实模型(ModelCompleter);
    // 演示种子只在首次启动播种一次(虚拟数据,不触碰用户既有内容)。
    const agentRegistry = new ToolRegistry()
    registerOpsTools(agentRegistry)
    const agentQueue = new RunQueue(db)
    // OPS-01:生产网关必须经工厂创建——关键写入经 persistCoordinator 落盘确认;
    // OPS-03:工具观测单一出口落轨迹(与 makeHarness 同构),只落库不广播,
    // UI 时间线刷新仍走 run-updated 状态事件
    const agentGateway = createAgentGateway({
      db,
      registry: agentRegistry,
      clock: systemClock,
      persistCoordinator,
      onObservation: (record) => {
        appendTraceEvent(db, {
          runId: record.runId,
          eventType: 'tool_call',
          payload: { ...record },
          durationMs: record.durationMs
        })
      }
    })
    seedDemoData(db)
    const interrupted = recoverInterruptedRuns(db)
    if (interrupted.length > 0) {
      console.warn(`[agent] 恢复:${interrupted.length} 个中断运行标记为失败`)
    }
    const scheduler = new RunScheduler(db, agentQueue)
    const orchestrator = new RunOrchestrator({
      db,
      registry: agentRegistry,
      gateway: agentGateway,
      queue: agentQueue,
      events: agentEvents,
      completer: new ModelCompleter({ db, router }),
      scheduler
    })

    // OPS-02:两套工作流共享同一 RunQueue 与 RunScheduler;
    // 执行权接力(等待/失败/取消/批准/重启)统一由调度器唤醒,删除旧双向钩子。
    const researchWorkflow = new ResearchWorkflow({
      db,
      queue: agentQueue,
      completer: new ModelCompleter({ db, router }),
      events: agentEvents,
      scheduler
    })
    scheduler.register('personal_ops', orchestrator.asRunDriver())
    scheduler.register('research', (runId) => researchWorkflow.driveResearch(runId))
    // 重启后已批准未执行审批与排队运行由调度器统一再领取
    scheduler.request()

    // MCP-01:--mcp 模式以 stdio 提供同一网关/审批边界,不创建窗口与 GUI IPC
    if (CLI_MCP_MODE) {
      const stdinReader = createInterface({ input: process.stdin })
      startPersonalOpsMcpStdio(
        { db, registry: agentRegistry, gateway: agentGateway },
        {
          readLine: () => {
            const it = stdinReader[Symbol.asyncIterator]()
            return it.next().then((r) => (r.done ? null : (r.value as string)))
          },
          writeLine: (line) => {
            process.stdout.write(`${line}\n`)
          }
        }
      )
      return
    }

    registerIpcHandlers({
      db,
      engine,
      router,
      reminders,
      petActivity,
      mail,
      persistCoordinator,
      agentEvents,
      orchestrator,
      // IpcResearchWorkflow 适配:创建路径由 api.ts 自己落库,这里只出驱动方法
      researchWorkflow: {
        startDriver: (runId) => void researchWorkflow.driveResearch(runId),
        acceptAnswers: (runId, answers) => researchWorkflow.acceptResearchAnswers(runId, answers as never),
        cancel: (runId) => researchWorkflow.requestCancel(runId)
      }
    })
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
  }).catch((err) => {
    // 数据库/WASM 等启动期致命失败:弹窗告知并退出,避免静默僵尸进程(whenReady 之后 dialog 可用)
    console.error('[bootstrap] 启动失败:', err)
    dialog.showErrorBox('事务助手启动失败', err instanceof Error ? err.message : String(err))
    app.exit(1)
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
