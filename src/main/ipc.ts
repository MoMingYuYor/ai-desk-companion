// IPC 注册:渲染进程可见 API 的全部处理入口
import { BrowserWindow, Menu, app, clipboard, dialog, ipcMain } from 'electron'
import type { SqliteDb } from './db/connection'
import { createUrlFetcher } from './services/urlFetch'
import {
  createConversation,
  createEvent,
  createTodo,
  deleteConversation,
  deleteCourse,
  deleteCourseOverride,
  deleteEvent,
  deletePending,
  deleteProfileFact,
  deleteProvider,
  deleteSchoolEvent,
  deleteSemester,
  deleteTodo,
  getMeta,
  getProviderApiKey,
  latestAnalysis,
  listConversations,
  listCourseOverrides,
  listCourses,
  listEventsRange,
  listMessages,
  listPending,
  listPendingImports,
  listProfileFacts,
  listProviders,
  listSchoolEvents,
  listSemesters,
  listTodos,
  markImportHandled,
  renameConversation,
  saveCourse,
  saveCourseOverride,
  saveProfileFact,
  saveProvider,
  saveSchoolEvent,
  saveSemester,
  setDefaultProvider,
  updateEvent,
  updatePending,
  updateTodo
} from './db/dao'
import type { ProviderInfo } from '../shared/types'
import { Channels } from '../shared/api'
import type {
  Conversation,
  Course,
  CourseOverride,
  EventInput,
  MaterialIntakeInput,
  ProviderInput,
  SchoolEvent,
  TodoInput
} from '../shared/types'
import type { Engine } from './services/engine'
import type { ModelRouter } from './services/modelRouter'
import type { ReminderService } from './services/reminder'
import { buildDayAgenda } from './services/context'
import { exportBackup, importBackup } from './services/backup'
import { decryptApiKey, encryptApiKey } from './keys'
import {
  createWorkbenchWindow,
  getPanelWindow,
  getPetWindow,
  getWorkbenchWindow,
  markQuitting,
  petScaleOf,
  savePetPosition,
  setPanelPinnedMeta,
  setPetScale,
  togglePet,
  createPanelWindow
} from './windows'
import { markPetBubble } from './petBridge'
import { createPetDragService } from './pet/drag'
import type { PetActivityRegistry } from './pet/activity'
import type { MailService } from './mail/service'

export interface IpcDeps {
  db: SqliteDb
  engine: Engine
  router: ModelRouter
  reminders: ReminderService
  petActivity: PetActivityRegistry
  mail: MailService
}

let depsRef: IpcDeps | null = null
let dataChangedListener: (() => void) | null = null

export function setDataChangedListener(fn: () => void): void {
  dataChangedListener = fn
}

function broadcastDataChanged(): void {
  dataChangedListener?.()
}

export function registerIpcHandlers(deps: IpcDeps): void {
  depsRef = deps
  const { db, engine, router, reminders, mail } = deps
  const fetchUrlText = createUrlFetcher()

  const handle = (channel: string, fn: (...args: never[]) => unknown): void => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...(args as never[]))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[ipc:${channel}]`, message)
        throw new Error(message)
      }
    })
  }

  // 桌宠通道:仅接受桌宠窗口主 frame 的调用,防止其他页面/子 frame 调用原生拖动/快照
  const handleFromPet = (channel: string, fn: (...args: never[]) => unknown): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      const pet = getPetWindow()
      const senderValid = !!pet && !pet.isDestroyed() && event.sender.id === pet.webContents.id
      // 主 frame 的 parent 为 null;子 frame(iframe)才有 parent
      const isMainFrame = !event.senderFrame || !event.senderFrame.parent
      if (!senderValid || !isMainFrame) {
        throw new Error('FORBIDDEN: 桌宠通道来源无效')
      }
      try {
        return await fn(...(args as never[]))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[ipc:${channel}]`, message)
        throw new Error(message)
      }
    })
  }

  // ---- app ----
  handle(Channels.AppInfo, () => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    dataDir: app.getPath('userData'),
    dbPath: app.getPath('userData') + '/data.sqlite',
    platform: process.platform
  }))

  // ---- providers ----
  handle(Channels.ProvidersList, (): ProviderInfo[] => listProviders(db))
  handle(Channels.ProvidersSave, (input: ProviderInput) => {
    const apiKeyEnc =
      input.apiKey !== undefined && input.apiKey !== '' ? encryptApiKey(input.apiKey) : undefined
    const id = saveProvider(db, {
      id: input.id,
      name: input.name,
      baseUrl: input.baseUrl,
      protocol: input.protocol,
      models: input.models,
      defaultModel: input.defaultModel,
      supportsVision: input.supportsVision,
      supportsJsonMode: input.supportsJsonMode,
      apiKeyEnc,
      isDefault: input.isDefault,
      sortOrder: input.sortOrder
    })
    if (input.isDefault) setDefaultProvider(db, id)
    return listProviders(db).find((p) => p.id === id)
  })
  handle(Channels.ProvidersDelete, (id: string) => deleteProvider(db, id))
  handle(Channels.ProvidersSetDefault, (id: string) => setDefaultProvider(db, id))
  handle(Channels.ProvidersTest, async (input: ProviderInput) => {
    const stored = input.id ? getProviderApiKey(db, input.id) : null
    const apiKey = input.apiKey ? input.apiKey : stored ? decryptApiKey(stored) : null
    const model = input.defaultModel || input.models[0] || ''
    if (!input.baseUrl || !model) return { ok: false, error: '请先填写接口地址和默认模型' }
    return router.testProvider({ baseUrl: input.baseUrl, protocol: input.protocol, apiKey, model })
  })
  handle(Channels.ProvidersFetchModels, (input: { baseUrl: string; apiKey?: string; providerId?: string }) => {
    const stored = input.providerId ? getProviderApiKey(db, input.providerId) : null
    const apiKey = input.apiKey ? input.apiKey : stored ? decryptApiKey(stored) : null
    return router.fetchModelList({ baseUrl: input.baseUrl, apiKey: apiKey ?? null })
  })

  // ---- conversations / chat ----
  handle(Channels.ConversationsList, () => listConversations(db))
  handle(Channels.ConversationsCreate, (kind: Conversation['kind'], title?: string) =>
    createConversation(db, kind ?? 'chat', title ?? '新对话')
  )
  handle(Channels.ConversationsRename, (id: string, title: string) => renameConversation(db, id, title))
  handle(Channels.ConversationsDelete, (id: string) => {
    engine.stop(id)
    deleteConversation(db, id)
  })
  handle(Channels.MessagesList, (conversationId: string) => listMessages(db, conversationId))
  handle(Channels.ChatSend, (conversationId: string, text: string) => engine.sendChat(conversationId, text))
  handle(Channels.ChatStop, (conversationId: string) => engine.stop(conversationId))
  handle(Channels.ChatRetry, (conversationId: string) => engine.retry(conversationId))
  handle(Channels.MaterialsAdd, (input: MaterialIntakeInput) => engine.intakeMaterials(input))
  handle(Channels.UrlFetch, (url: string) => fetchUrlText(url))

  // ---- analysis ----
  handle(Channels.AnalysesLatest, (conversationId: string) => latestAnalysis(db, conversationId) ?? null)
  handle(Channels.AnalysesRerun, (conversationId: string) => engine.retry(conversationId))
  handle(Channels.AnalysisConfirmItem, (analysisId: string, item: unknown) => {
    // 邮箱候选(携带 candidateIndex)走幂等映射;普通分析走原确认流程
    const idx = (item as { candidateIndex?: number } | null)?.candidateIndex
    if (typeof idx === 'number') {
      return mail.confirmation.confirm(analysisId, idx, item as never)
    }
    return engine.confirmItem(analysisId, item)
  })
  handle(Channels.AnalysisDeferItem, (analysisId: string, item: unknown) => ({
    pendingId: engine.deferItem(analysisId, item)
  }))

  // ---- events / todos ----
  handle(Channels.EventsRange, (from: string, to: string) => listEventsRange(db, from, to))
  handle(Channels.EventsCreate, (input: EventInput) => createEvent(db, input))
  handle(Channels.EventsUpdate, (id: string, patch: Partial<EventInput>) => updateEvent(db, id, patch))
  handle(Channels.EventsDelete, (id: string) => deleteEvent(db, id))
  handle(Channels.TodosList, () => listTodos(db))
  handle(Channels.TodosCreate, (input: TodoInput) => createTodo(db, input))
  handle(Channels.TodosUpdate, (id: string, patch: Partial<TodoInput>) => updateTodo(db, id, patch))
  handle(Channels.TodosDelete, (id: string) => deleteTodo(db, id))
  handle(Channels.TodosLinkEvent, (todoId: string, eventId: string | null) =>
    updateTodo(db, todoId, { linkedEventId: eventId })
  )

  // ---- pending ----
  handle(Channels.PendingList, () => listPending(db))
  handle(Channels.PendingUpdate, (id: string, patch: { status?: 'open' | 'handled' | 'dismissed'; title?: string; notes?: string }) =>
    updatePending(db, id, patch)
  )
  handle(Channels.PendingDelete, (id: string) => deletePending(db, id))

  // ---- timetable ----
  handle(Channels.SemestersList, () => listSemesters(db))
  handle(Channels.SemestersSave, (input: { id?: string; name: string; startDate: string; weeks: number }) =>
    saveSemester(db, input)
  )
  handle(Channels.SemestersDelete, (id: string) => deleteSemester(db, id))
  handle(Channels.CoursesList, (semesterId: string) => listCourses(db, semesterId))
  handle(Channels.CoursesSave, (input: Course) => {
    saveCourse(db, input)
    return input
  })
  handle(Channels.CoursesDelete, (id: string) => deleteCourse(db, id))
  handle(Channels.CourseOverridesSave, (input: Omit<CourseOverride, 'createdAt'>) => {
    saveCourseOverride(db, input)
    return input
  })
  handle(Channels.CourseOverridesDelete, (id: string) => deleteCourseOverride(db, id))
  handle(Channels.CourseOverridesList, () => listCourseOverrides(db))
  handle(Channels.SchoolEventsList, (semesterId?: string) => listSchoolEvents(db, semesterId))
  handle(Channels.SchoolEventsSave, (input: Omit<SchoolEvent, 'createdAt'>) => {
    saveSchoolEvent(db, input)
    return input
  })
  handle(Channels.SchoolEventsDelete, (id: string) => deleteSchoolEvent(db, id))

  // ---- 导入:渲染端传入文件路径或文本,主进程统一接收并运行提取;失败原因随结果返回 ----
  handle(Channels.ImportTimetable, async (input: MaterialIntakeInput) => {
    const { conversationId } = await engine.intakeMaterials({ ...input, kind: 'timetable', autoRun: false })
    const analysis = await engine.runImport(conversationId, 'timetable')
    return { conversationId, analysisId: analysis?.id ?? '', payload: analysis?.payload ?? null, error: analysis?.error ?? null }
  })
  handle(Channels.ImportSchoolCalendar, async (input: MaterialIntakeInput) => {
    const { conversationId } = await engine.intakeMaterials({ ...input, kind: 'school-calendar', autoRun: false })
    const analysis = await engine.runImport(conversationId, 'school-calendar')
    return { conversationId, analysisId: analysis?.id ?? '', payload: analysis?.payload ?? null, error: analysis?.error ?? null }
  })
  // 桌宠拖放等自动路由产生的提取结果:课表页展示待确认清单
  handle(Channels.PendingImports, (limit?: number) => listPendingImports(db, limit))
  handle(Channels.ImportHandled, (analysisId: string) => markImportHandled(db, analysisId))

  // ---- profile ----
  handle(Channels.ProfileList, () => listProfileFacts(db))
  handle(Channels.ProfileSave, (input: { id?: string; category: 'basic' | 'preference' | 'schedule'; key: string; value: string }) => {
    const existing = input.id ? listProfileFacts(db).find((f) => f.id === input.id) : undefined
    return saveProfileFact(db, {
      id: input.id,
      category: input.category,
      key: input.key,
      value: input.value,
      source: existing?.source ?? 'explicit',
      status: existing?.status ?? 'confirmed'
    })
  })
  handle(Channels.ProfileDelete, (id: string) => deleteProfileFact(db, id))
  handle(Channels.ProfileResolve, (id: string, accept: boolean) => {
    const fact = listProfileFacts(db).find((f) => f.id === id)
    if (!fact) return
    saveProfileFact(db, { ...fact, status: accept ? 'confirmed' : 'rejected' })
  })

  // ---- panel / pet ----
  handle(Channels.PanelToday, (date?: string) => buildDayAgenda(db, date ?? todayStr()))
  handle(Channels.PanelSetPinned, (pinned: boolean) => {
    setPanelPinnedMeta(db, pinned)
  })
  handle(Channels.PanelGetPinned, () => getMeta(db, 'panel:pinned') === '1')
  handleFromPet(Channels.PetDragStart, () => {
    const pet = getPetWindow()
    if (pet) petDrag.start(pet)
  })
  handleFromPet(Channels.PetDragMove, () => movePetDrag())
  handleFromPet(Channels.PetDragEnd, () => {
    petDrag.end()
    savePetPosition(db)
  })
  handleFromPet(Channels.PetOpenMenu, () => openPetMenu())
  handleFromPet(Channels.PetGetScale, () => petScaleOf(db))
  handleFromPet(Channels.PetSetScale, (scale: number) => setPetScale(db, scale))
  handleFromPet(Channels.PetAction, (action: string) => runPetAction(action))
  handleFromPet(Channels.PetActivitySnapshot, () => deps.petActivity.snapshot())

  // ---- backup ----
  handle(Channels.BackupExport, async () => {
    const win = getWorkbenchWindow() ?? BrowserWindow.getFocusedWindow() ?? undefined
    const r = await dialog.showSaveDialog(win!, {
      title: '导出备份',
      defaultPath: `事务助手备份-${todayStr()}.json`,
      filters: [{ name: 'JSON 备份', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return null
    exportBackup(db, r.filePath)
    return r.filePath
  })
  handle(Channels.BackupImport, async () => {
    const win = getWorkbenchWindow() ?? BrowserWindow.getFocusedWindow() ?? undefined
    const r = await dialog.showOpenDialog(win!, {
      title: '导入备份(将替换当前数据)',
      filters: [{ name: 'JSON 备份', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (r.canceled || r.filePaths.length === 0) return false
    // 阻止在途邮件分析写入,导入完成后恢复
    const resume = await mail.quiesceForBackup()
    try {
      importBackup(db, r.filePaths[0])
    } finally {
      resume()
    }
    reminders.tick()
    broadcastDataChanged()
    markPetBubble('备份已恢复,数据已更新')
    return true
  })

  // ---- mail ----
  handle(Channels.MailAccounts, () => mail.accounts())
  handle(Channels.MailTest, (input: never) => mail.test(input as Parameters<MailService['test']>[0]))
  handle(Channels.MailSave, (input: never) => mail.save(input as Parameters<MailService['save']>[0]))
  handle(Channels.MailSetEnabled, (id: string, enabled: boolean) => mail.setEnabled(id, enabled))
  handle(Channels.MailRemove, (id: string) => mail.remove(id))
  handle(Channels.MailSync, (id: string) => mail.sync(id))
  handle(Channels.MailEarlier, (id: string) => mail.earlier(id))
  handle(Channels.MailList, (query: never) => mail.list(query as Parameters<MailService['list']>[0]))
  handle(Channels.MailDetail, (id: string) => mail.detail(id))
  handle(Channels.MailMarkRead, (id: string, read: boolean) => mail.markRead(id, read))
  handle(Channels.MailDownload, (id: string) => mail.download(id))
  handle(Channels.MailSaveAttachment, (id: string) => mail.saveAttachment(id))
  handle(Channels.MailOpenLink, (messageId: string, url: string) => mail.openLink(messageId, url))
  handle(Channels.MailOpenWebmail, (email: string) => mail.openWebmail(email))
  handle(Channels.MailAnalyze, (input: never) => mail.analyze(input as Parameters<MailService['analyze']>[0]))
  handle(Channels.MailAnalysisStatus, (messageId: string) => mail.analysisStatus(messageId))
  handle(Channels.MailCancelAnalysis, (conversationId: string) => mail.cancelAnalysis(conversationId))
  handle(Channels.MailSource, (sourceKey: string) => mail.source(sourceKey))
}

// ---------- 桌宠拖动(主进程轮询光标) ----------

const petDrag = createPetDragService()

function movePetDrag(): void {
  /* 轮询模式无需处理 */
}

// ---------- 桌宠右键菜单 ----------

export function openPetMenu(): void {
  if (!depsRef) return
  const menu = Menu.buildFromTemplate([
    { label: '分析剪贴板通知', click: () => runPetAction('analyze-clipboard') },
    { label: '新建日程', click: () => runPetAction('new-event') },
    { label: '新建待办', click: () => runPetAction('new-todo') },
    { type: 'separator' },
    { label: '今日面板', click: () => runPetAction('toggle-panel') },
    { label: '打开工作台', click: () => runPetAction('open-workbench') },
    { type: 'separator' },
    { label: '显示 / 隐藏信息面板', click: () => runPetAction('toggle-panel') },
    { label: '隐藏桌宠', click: () => runPetAction('hide-pet') },
    { label: '退出应用', click: () => runPetAction('quit') }
  ])
  menu.popup()
}

export function runPetAction(action: string): void {
  if (!depsRef) return
  const { db, engine } = depsRef
  switch (action) {
    case 'analyze-clipboard': {
      const text = clipboard.readText() ?? ''
      if (text.trim()) {
        void engine.intakeMaterials({ texts: [{ name: '剪贴板通知', content: text }], autoRun: true })
        markPetBubble('已开始分析剪贴板通知…')
      } else {
        markPetBubble('剪贴板没有文本内容')
      }
      break
    }
    case 'new-event':
    case 'new-todo': {
      const win = createWorkbenchWindow(db)
      win.webContents.send('evt:pet-action', { action })
      break
    }
    case 'toggle-panel': {
      const panel = getPanelWindow()
      if (panel && panel.isVisible()) {
        panel.hide()
      } else {
        createPanelWindow(db)
      }
      break
    }
    case 'open-workbench':
      createWorkbenchWindow(db)
      break
    case 'hide-pet':
      getPetWindow()?.hide()
      break
    case 'quit':
      markQuitting()
      app.quit()
      break
  }
}

function todayStr(): string {
  const d = new Date()
  const pad = (n: number): string => (n < 10 ? '0' + n : String(n))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
