// IPC 注册:渲染进程可见 API 的全部处理入口。
// Task 12 集成:统一来源授权(R3)、恢复排他窗口(R1)、
// 修改型命令 runOperation/commitCritical(R2/T2/T3)、公共 AppError 边界(O4)。
import { BrowserWindow, Menu, app, clipboard, dialog, ipcMain } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import type { SqliteDb } from './db/connection'
import {
  assertRevision,
  getWorkspaceEpoch,
  runOperation,
  OperationError
} from './db/operations'
import { appError, assertCurrentEpoch, toIpcError } from '../shared/operations'
import type { AppError } from '../shared/operations'
import { createUrlFetcher } from './services/urlFetch'
import {
  createConversation,
  createEvent,
  createTodo,
  deleteConversation,
  deleteCourse,
  deleteCourseOverride,
  deleteEventInner,
  deletePending,
  deleteProfileFact,
  deleteProvider,
  deleteSchoolEvent,
  deleteSemester,
  deleteTodo,
  getEvent,
  getMeta,
  getPending,
  getProviderApiKey,
  getTodo,
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
import { ensureNotRestoring, restoreBackup } from './services/backup'
import { validateEventInput } from './planning/eventValidation'
import { resolveExistingPendingInDb } from './planning/resolveExistingPending'
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
import type { ResolvePendingCommand } from '../shared/api'
import type { Engine } from './services/engine'
import type { ModelRouter } from './services/modelRouter'
import type { ReminderService } from './services/reminder'
import type { PersistenceCoordinator } from './db/operations'
import { buildDayAgenda } from './services/context'
import { exportBackup } from './services/backup'
import { decryptApiKey, encryptApiKey } from './keys'
import {
  createWorkbenchWindow,
  getPanelWindow,
  getPetWindow,
  getWorkbenchWindow,
  broadcastToAll,
  markQuitting,
  petScaleOf,
  savePetPosition,
  setPanelPinnedMeta,
  setPetScale,
  togglePet,
  createPanelWindow,
  getWindowRegistry
} from './windows'
import { authorizeIpc } from './security/ipcPolicy'
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
  /** 持久化协调器:存在时向全部窗口广播保存状态(evt:persist-state) */
  persistCoordinator?: PersistenceCoordinator
}

let depsRef: IpcDeps | null = null
let dataChangedListener: (() => void) | null = null

export function setDataChangedListener(fn: (() => void) | null): void {
  dataChangedListener = fn
}

function broadcastDataChanged(): void {
  dataChangedListener?.()
}

/** 数据变更后通知全部窗口刷新(侧栏角标/概览聚合等监听方) */
function notifyChange<T>(value: T): T {
  broadcastDataChanged()
  return value
}

/** 恢复成功后通知各窗口重读 revision/workspaceEpoch(evt: 前缀白名单放行) */
const EVT_WORKSPACE_EPOCH_CHANGED = 'evt:workspace-epoch-changed'

/**
 * 修改型 IPC 通道清单(R1):统一包装在入口调用 ensureNotRestoring(),
 * 恢复排他窗口内以 BUSY(可重试)拒绝新写入;只读与救援导出不受限。
 */
const WRITE_CHANNELS: ReadonlySet<string> = new Set([
  Channels.ProvidersSave,
  Channels.ProvidersDelete,
  Channels.ProvidersSetDefault,
  Channels.ConversationsCreate,
  Channels.ConversationsRename,
  Channels.ConversationsDelete,
  Channels.ChatSend,
  Channels.ChatRetry,
  Channels.MaterialsAdd,
  Channels.AnalysisConfirmItem,
  Channels.AnalysisDeferItem,
  Channels.EventsCreate,
  Channels.EventsUpdate,
  Channels.EventsDelete,
  Channels.TodosCreate,
  Channels.TodosUpdate,
  Channels.TodosDelete,
  Channels.TodosLinkEvent,
  Channels.PendingUpdate,
  Channels.PendingDelete,
  Channels.PendingResolve,
  Channels.SemestersSave,
  Channels.SemestersDelete,
  Channels.CoursesSave,
  Channels.CoursesDelete,
  Channels.CourseOverridesSave,
  Channels.CourseOverridesDelete,
  Channels.SchoolEventsSave,
  Channels.SchoolEventsDelete,
  Channels.ImportTimetable,
  Channels.ImportSchoolCalendar,
  Channels.ImportHandled,
  Channels.ProfileSave,
  Channels.ProfileDelete,
  Channels.ProfileResolve,
  Channels.PanelSetPinned,
  Channels.BackupImport,
  Channels.MailSave,
  Channels.MailSetEnabled,
  Channels.MailRemove,
  Channels.MailSync,
  Channels.MailEarlier,
  Channels.MailMarkRead,
  Channels.MailDownload,
  Channels.MailSaveAttachment,
  Channels.MailAnalyze,
  Channels.MailCancelAnalysis
])

/** IPC 失败日志与错误透传:只含通道、错误分类、操作 ID 与面向用户的消息(脱敏,不含参数/正文/凭据) */
function failIpc(channel: string, err: unknown): Error {
  const out = toIpcError(err)
  const code = out.appError?.code ?? 'INTERNAL'
  const opId = out.appError?.operationId
  console.error(`[ipc:${channel}] code=${code}${opId ? ` op=${opId}` : ''} msg=${out.message}`)
  return out
}

/** 把未知异常归一为公共 AppError(Result 命令用);未知内部错误按可重试的持久层失败兜底 */
function appErrorOf(err: unknown): AppError {
  const carried = toIpcError(err)
  return carried.appError ?? appError('PERSIST_FAILED', carried.message, { retryable: true })
}

/** 渲染层渐进提供 MutationContext;缺省由主进程注入当前 epoch 与新 operationId */
interface MutationEnvelopeInput {
  context?: { workspaceEpoch?: unknown; operationId?: unknown }
}

async function writeMutation<T>(db: SqliteDb, deps: IpcDeps, command: string, payload: unknown, apply: () => T): Promise<T> {
  const current = getWorkspaceEpoch()
  const ctx = (payload as MutationEnvelopeInput | null | undefined)?.context
  // 旧窗口/旧异步任务携带旧 epoch:按 STALE_PREVIEW 拒绝,UI 重读 revision/epoch 后恢复可用
  assertCurrentEpoch(typeof ctx?.workspaceEpoch === 'string' ? ctx.workspaceEpoch : null, current)
  const operationId =
    typeof ctx?.operationId === 'string' && ctx.operationId !== '' ? ctx.operationId : randomUUID()
  const requestHash = createHash('sha1').update(JSON.stringify(payload ?? null)).digest('hex')
  const { value } = runOperation(
    db,
    { operationId, command, requestHash, workspaceEpoch: current },
    apply
  )
  // 关键命令只有事务提交且落盘成功才返回成功(T3)
  if (deps.persistCoordinator) {
    return deps.persistCoordinator.commitCritical(operationId, value)
  }
  return value
}

function writeNotify<T>(db: SqliteDb, deps: IpcDeps, command: string, payload: unknown, apply: () => T): Promise<T> {
  return writeMutation(db, deps, command, payload, apply).then((value) => notifyChange(value))
}

export function registerIpcHandlers(deps: IpcDeps): void {
  depsRef = deps
  const { db, engine, router, reminders, mail } = deps
  const fetchUrlText = createUrlFetcher()

  // 保存状态变化统一广播;UI 据此展示"未保存"状态,不依赖各命令自行上报
  if (deps.persistCoordinator) {
    deps.persistCoordinator.subscribePersistState((state) => {
      broadcastToAll(Channels.EventPersistStateChanged, state)
    })
  }

  // 统一注册包装(R3 + R1):先来源/能力授权(未授权零业务副作用),
  // 修改型通道再检查恢复排他窗口;失败按公共 AppError 边界透传与记录
  const handle = (channel: string, fn: (...args: never[]) => unknown): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        if (!authorizeIpc(event, channel, getWindowRegistry())) {
          throw new OperationError(appError('FORBIDDEN', '来源未授权,请求被拒绝', { retryable: false }))
        }
        if (WRITE_CHANNELS.has(channel)) ensureNotRestoring()
        return await fn(...(args as never[]))
      } catch (err) {
        throw failIpc(channel, err)
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
  // 只读:可信窗口初始化与恢复后刷新使用;旧代数的写请求由各命令在边界拒绝
  handle(Channels.WorkspaceEpoch, () => getWorkspaceEpoch())

  // ---- providers ----
  handle(Channels.ProvidersList, (): ProviderInfo[] => listProviders(db))
  handle(Channels.ProvidersSave, (input: ProviderInput) => {
    // undefined=不修改密钥;''=用户清空,删除已存密钥;非空=更换密文
    const apiKeyEnc =
      input.apiKey === undefined ? undefined : input.apiKey === '' ? '' : encryptApiKey(input.apiKey)
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
  // R8:当前活动运行快照(视图切回);恢复 epoch 后由 invalidateAllRuns 清空
  handle(Channels.ChatActiveRun, (conversationId: string) => engine.getActiveChatRun(conversationId))
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

  // ---- events / todos / pending(R2/T2/T3:runOperation 唯一事务 + 回执 + 落盘确认) ----
  handle(Channels.EventsRange, (from: string, to: string) => listEventsRange(db, from, to))
  handle(Channels.EventsCreate, (input: EventInput) =>
    writeNotify(db, deps, 'events:create', input, () => {
      // 集中校验(R7):空标题/不可解析日期/倒置区间在开事务前拒绝
      validateEventInput(input)
      return createEvent(db, input)
    })
  )
  handle(Channels.EventsUpdate, (id: string, patch: Partial<EventInput>) =>
    writeNotify(db, deps, 'events:update', { id, patch }, () => {
      const existing = getEvent(db, id)
      if (!existing) {
        throw new OperationError(appError('TARGET_UNAVAILABLE', '日程不存在或已被删除', { retryable: false }))
      }
      // Partial 更新以当前值为基合并后集中校验;修订号条件检查在同一事务内
      validateEventInput({ ...existing, ...patch } as EventInput)
      assertRevision(db, 'events', id, existing.revision)
      updateEvent(db, id, patch)
      return getEvent(db, id) ?? null
    })
  )
  handle(Channels.EventsDelete, (id: string) =>
    writeNotify(db, deps, 'events:delete', { id }, () => {
      const existing = getEvent(db, id)
      if (!existing) {
        throw new OperationError(appError('TARGET_UNAVAILABLE', '日程不存在或已被删除', { retryable: false }))
      }
      assertRevision(db, 'events', id, existing.revision)
      deleteEventInner(db, id) // 无独立事务:唯一事务所有权在 runOperation
      return { id, deleted: true }
    })
  )
  handle(Channels.TodosList, () => listTodos(db))
  handle(Channels.TodosCreate, (input: TodoInput) =>
    writeNotify(db, deps, 'todos:create', input, () => createTodo(db, input))
  )
  handle(Channels.TodosUpdate, (id: string, patch: Partial<TodoInput>) =>
    writeNotify(db, deps, 'todos:update', { id, patch }, () => {
      const existing = getTodo(db, id)
      if (!existing) {
        throw new OperationError(appError('TARGET_UNAVAILABLE', '待办不存在或已被删除', { retryable: false }))
      }
      assertRevision(db, 'todos', id, existing.revision)
      updateTodo(db, id, patch)
      return getTodo(db, id) ?? null
    })
  )
  handle(Channels.TodosDelete, (id: string) =>
    writeNotify(db, deps, 'todos:delete', { id }, () => {
      const existing = getTodo(db, id)
      if (!existing) {
        throw new OperationError(appError('TARGET_UNAVAILABLE', '待办不存在或已被删除', { retryable: false }))
      }
      assertRevision(db, 'todos', id, existing.revision)
      deleteTodo(db, id)
      return { id, deleted: true }
    })
  )
  handle(Channels.TodosLinkEvent, (todoId: string, eventId: string | null) =>
    writeNotify(db, deps, 'todos:link-event', { todoId, eventId }, () => {
      const existing = getTodo(db, todoId)
      if (!existing) {
        throw new OperationError(appError('TARGET_UNAVAILABLE', '待办不存在或已被删除', { retryable: false }))
      }
      assertRevision(db, 'todos', todoId, existing.revision)
      updateTodo(db, todoId, { linkedEventId: eventId })
      return { todoId, eventId }
    })
  )

  // ---- pending ----
  handle(Channels.PendingList, () => listPending(db))
  handle(Channels.PendingUpdate, (id: string, patch: { status?: 'open' | 'handled' | 'dismissed'; title?: string; notes?: string }) =>
    writeNotify(db, deps, 'pending:update', { id, patch }, () => {
      // getPending 不按状态过滤:置 handled/dismissed 的条目仍可被后续命令定位
      const existing = getPending(db, id)
      if (!existing) {
        throw new OperationError(appError('TARGET_UNAVAILABLE', '条目不存在或已被删除', { retryable: false }))
      }
      assertRevision(db, 'pending_items', id, existing.revision)
      updatePending(db, id, patch)
      return { id }
    })
  )
  handle(Channels.PendingDelete, (id: string) =>
    writeNotify(db, deps, 'pending:delete', { id }, () => {
      const existing = getPending(db, id)
      if (!existing) {
        throw new OperationError(appError('TARGET_UNAVAILABLE', '条目不存在或已被删除', { retryable: false }))
      }
      assertRevision(db, 'pending_items', id, existing.revision)
      deletePending(db, id)
      return { id, deleted: true }
    })
  )
  // 原子转换(Task 8/R7):入口 epoch 校验,错误以公共 Result 返回而非抛异常
  handle(Channels.PendingResolve, (command: ResolvePendingCommand) => {
    try {
      const current = getWorkspaceEpoch()
      assertCurrentEpoch(command?.context?.workspaceEpoch ?? null, current)
      const value = resolveExistingPendingInDb(db, command)
      const committed = deps.persistCoordinator
        ? deps.persistCoordinator.commitCritical(command.context.operationId, value)
        : Promise.resolve(value)
      return committed.then((v) => ({ ok: true as const, value: v }))
    } catch (err) {
      return Promise.resolve({ ok: false as const, error: appErrorOf(err) })
    }
  })

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
  // 桌宠通道的来源/能力限制由 authorizeIpc 的 PET_CHANNELS 能力表统一覆盖(R3)
  handle(Channels.PetDragStart, () => {
    const pet = getPetWindow()
    if (pet) petDrag.start(pet)
  })
  handle(Channels.PetDragMove, () => movePetDrag())
  handle(Channels.PetDragEnd, () => {
    petDrag.end()
    savePetPosition(db)
  })
  handle(Channels.PetOpenMenu, () => openPetMenu())
  handle(Channels.PetGetScale, () => petScaleOf(db))
  handle(Channels.PetSetScale, (scale: number) => setPetScale(db, scale))
  handle(Channels.PetAction, (action: string) => runPetAction(action))
  handle(Channels.PetActivitySnapshot, () => deps.petActivity.snapshot())

  // ---- backup(T4/R1:先验校验 + 排他窗口 + 失败回滚) ----
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
    // 排他窗口:先验(坏文件零写入) → 阻止新写入 → 排空在途邮箱任务并落盘 →
    // 提升 workspaceEpoch → 门控后快照 → 单事务替换 → 落盘确认(失败回滚)
    await restoreBackup(db, r.filePaths[0], {
      quiesceExternal: () => mail.quiesceExternal(),
      onRestored: () => {
        // 旧会话运行全部失效;提醒按新库重扫;各窗口重读 revision/epoch
        engine.invalidateAllRuns()
        reminders.tick()
        broadcastDataChanged()
        broadcastToAll(EVT_WORKSPACE_EPOCH_CHANGED, { epoch: getWorkspaceEpoch() })
        markPetBubble('备份已恢复,数据已更新')
      }
    })
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
      // electron 44:clipboard.readText() 由同步变更为返回 Promise<string>,改异步获取;
      // 气泡提示与分析失败的兜底链路保持原语义(失败必须兜底,避免 unhandledrejection)
      void clipboard
        .readText()
        .then((text) => {
          if (!text.trim()) {
            markPetBubble('剪贴板没有文本内容')
            return
          }
          void engine
            .intakeMaterials({ texts: [{ name: '剪贴板通知', content: text }], autoRun: true })
            .catch((err: unknown) => {
              console.error('[pet:analyze-clipboard]', err instanceof Error ? err.message : String(err))
              markPetBubble('剪贴板分析失败,请重试')
            })
          markPetBubble('已开始分析剪贴板通知…')
        })
        .catch((err: unknown) => {
          console.error('[pet:analyze-clipboard]', err instanceof Error ? err.message : String(err))
          markPetBubble('剪贴板分析失败,请重试')
        })
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
