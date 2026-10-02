// 预加载:通过 contextBridge 向渲染进程暴露类型化 API
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { Channels } from '../shared/api'
import type { AppearanceBridge, RendererApi } from '../shared/api'
import { AppearanceChannels } from '../shared/appearance'
import type { AppearanceSnapshot } from '../shared/appearance'
import type { MailApi, MailSubscribe, MailEventMap } from '../shared/mail'
import { isAllowedAppPageUrl } from '../main/security/ipcPolicy'

/**
 * 文档合格性(R3):preload 仅对合格应用文档暴露 api。
 * 生产 file: 精确页面 / 开发 dev server 精确页面路径;devUrl 不可读时按精确页面路径兜底,
 * 主进程 authorizeIpc 仍按登记窗口做最终校验。
 */
export function isQualifiedRendererDocument(href: string | null | undefined, devUrl?: string): boolean {
  if (!href) return false
  const env = typeof process !== 'undefined' && process.env ? process.env.ELECTRON_RENDERER_URL : undefined
  return isAllowedAppPageUrl(href, devUrl ?? env)
}

function currentDocumentHref(): string | null {
  try {
    return typeof window !== 'undefined' && window.location ? window.location.href : null
  } catch {
    return null
  }
}

const invoke =
  <A extends unknown[], R>(channel: string) =>
  async (...args: A): Promise<R> =>
    (await ipcRenderer.invoke(channel, ...args)) as R

const mail: MailApi = {
  accounts: invoke(Channels.MailAccounts),
  test: invoke(Channels.MailTest),
  save: invoke(Channels.MailSave),
  setEnabled: invoke(Channels.MailSetEnabled),
  remove: invoke(Channels.MailRemove),
  sync: invoke(Channels.MailSync),
  earlier: invoke(Channels.MailEarlier),
  list: invoke(Channels.MailList),
  detail: invoke(Channels.MailDetail),
  markRead: invoke(Channels.MailMarkRead),
  download: invoke(Channels.MailDownload),
  saveAttachment: invoke(Channels.MailSaveAttachment),
  openLink: invoke(Channels.MailOpenLink),
  openWebmail: invoke(Channels.MailOpenWebmail),
  analyze: invoke(Channels.MailAnalyze),
  analysisStatus: invoke(Channels.MailAnalysisStatus),
  cancelAnalysis: invoke(Channels.MailCancelAnalysis),
  source: invoke(Channels.MailSource)
}

const MAIL_EVENT_CHANNELS: ReadonlyArray<keyof MailEventMap> = [
  'evt:mail-sync',
  'evt:mail-changed',
  'evt:mail-analysis'
]

// 通用事件订阅白名单:仅开放 evt: 前缀(主进程 → 渲染层广播的命名空间)。
// R8 会话运行契约的 evt:chat-started 走此前缀放行,与 evt:chat-delta/done/error 同属聊天流事件;
// 桌宠气泡/状态/动作等直发事件(evt:pet-bubble / evt:pet-state / evt:pet-action)未收录进
// Channels 常量,故用前缀校验而非精确枚举;invoke 类通道与任意自定义通道一律拒绝。
const EVENT_CHANNEL_PREFIX = 'evt:'

const subscribeMail: MailSubscribe = ((channel, listener) => {
  if (!MAIL_EVENT_CHANNELS.includes(channel)) {
    throw new Error(`不允许订阅通道:${String(channel)}`)
  }
  const wrapped = (_event: unknown, ...args: unknown[]): void => {
    listener(...(args as Parameters<typeof listener>))
  }
  ipcRenderer.on(channel, wrapped as never)
  return () => {
    ipcRenderer.removeListener(channel, wrapped as never)
  }
}) as MailSubscribe

const appearance: AppearanceBridge = {
  get: invoke(AppearanceChannels.get),
  set: invoke(AppearanceChannels.set),
  subscribe: (listener) => {
    const wrapped = (_event: unknown, snapshot: AppearanceSnapshot): void => {
      listener(snapshot)
    }
    ipcRenderer.on(AppearanceChannels.changed, wrapped)
    return () => {
      ipcRenderer.removeListener(AppearanceChannels.changed, wrapped)
    }
  }
}

const api: RendererApi = {
  getAppInfo: invoke(Channels.AppInfo),
  getWorkspaceEpoch: invoke(Channels.WorkspaceEpoch),
  pathForFile: (file: unknown) => webUtils.getPathForFile(file as File),
  mail,
  subscribeMail,
  appearance,

  listProviders: invoke(Channels.ProvidersList),
  saveProvider: invoke(Channels.ProvidersSave),
  deleteProvider: invoke(Channels.ProvidersDelete),
  setDefaultProvider: invoke(Channels.ProvidersSetDefault),
  testProvider: invoke(Channels.ProvidersTest),
  fetchModels: invoke(Channels.ProvidersFetchModels),

  listConversations: invoke(Channels.ConversationsList),
  createConversation: invoke(Channels.ConversationsCreate),
  renameConversation: invoke(Channels.ConversationsRename),
  deleteConversation: invoke(Channels.ConversationsDelete),
  listMessages: invoke(Channels.MessagesList),
  sendChat: invoke(Channels.ChatSend),
  stopChat: invoke(Channels.ChatStop),
  retryChat: invoke(Channels.ChatRetry),
  // R8 活动运行快照:主进程 handler 注册在 ipc.ts(集成任务接线)
  getActiveChatRun: invoke(Channels.ChatActiveRun),
  addMaterials: invoke(Channels.MaterialsAdd),
  fetchUrlText: invoke(Channels.UrlFetch),
  petGetScale: invoke(Channels.PetGetScale),
  petSetScale: invoke(Channels.PetSetScale),

  getLatestAnalysis: invoke(Channels.AnalysesLatest),
  rerunAnalysis: invoke(Channels.AnalysesRerun),
  confirmAnalysisItem: invoke(Channels.AnalysisConfirmItem),
  deferAnalysisItem: invoke(Channels.AnalysisDeferItem),

  listEvents: invoke(Channels.EventsRange),
  createEvent: invoke(Channels.EventsCreate),
  updateEvent: invoke(Channels.EventsUpdate),
  deleteEvent: invoke(Channels.EventsDelete),
  listTodos: invoke(Channels.TodosList),
  createTodo: invoke(Channels.TodosCreate),
  updateTodo: invoke(Channels.TodosUpdate),
  deleteTodo: invoke(Channels.TodosDelete),
  linkTodoEvent: invoke(Channels.TodosLinkEvent),

  listPending: invoke(Channels.PendingList),
  updatePending: invoke(Channels.PendingUpdate),
  deletePending: invoke(Channels.PendingDelete),
  // 原子转换(Task 8/R7):主进程 handler 注册在 ipc.ts(集成任务接线)
  resolveExistingPending: invoke(Channels.PendingResolve),

  listSemesters: invoke(Channels.SemestersList),
  saveSemester: invoke(Channels.SemestersSave),
  deleteSemester: invoke(Channels.SemestersDelete),
  listCourses: invoke(Channels.CoursesList),
  saveCourse: invoke(Channels.CoursesSave),
  deleteCourse: invoke(Channels.CoursesDelete),
  saveCourseOverride: invoke(Channels.CourseOverridesSave),
  deleteCourseOverride: invoke(Channels.CourseOverridesDelete),
  listCourseOverrides: invoke(Channels.CourseOverridesList),
  listSchoolEvents: invoke(Channels.SchoolEventsList),
  saveSchoolEvent: invoke(Channels.SchoolEventsSave),
  deleteSchoolEvent: invoke(Channels.SchoolEventsDelete),
  importTimetable: invoke(Channels.ImportTimetable),
  importSchoolCalendar: invoke(Channels.ImportSchoolCalendar),
  listPendingImports: invoke(Channels.PendingImports),
  markImportHandled: invoke(Channels.ImportHandled),

  listProfile: invoke(Channels.ProfileList),
  saveProfile: invoke(Channels.ProfileSave),
  deleteProfile: invoke(Channels.ProfileDelete),
  resolveProfile: invoke(Channels.ProfileResolve),

  getDayAgenda: invoke(Channels.PanelToday),
  setPanelPinned: invoke(Channels.PanelSetPinned),
  getPanelPinned: invoke(Channels.PanelGetPinned),
  petDragStart: invoke(Channels.PetDragStart),
  petDragMove: invoke(Channels.PetDragMove),
  petDragEnd: invoke(Channels.PetDragEnd),
  petOpenMenu: invoke(Channels.PetOpenMenu),
  petAction: invoke(Channels.PetAction),
  getPetActivitySnapshot: invoke(Channels.PetActivitySnapshot),

  exportBackup: invoke(Channels.BackupExport),
  importBackup: invoke(Channels.BackupImport),
  // agent(个人事务 Agent):薄 invoke 包装,渲染层不持有任何业务状态
  createAgentRun: invoke(Channels.AgentRunCreate),
  getAgentRun: invoke(Channels.AgentRunGet),
  listAgentRuns: invoke(Channels.AgentRunList),
  getAgentRunEvents: invoke(Channels.AgentRunEvents),
  getAgentRunApprovals: invoke(Channels.AgentRunApprovals),
  submitAgentAnswers: invoke(Channels.AgentRunAnswers),
  cancelAgentRun: invoke(Channels.AgentRunCancel),
  decideAgentApproval: invoke(Channels.AgentApprovalDecide),
  listEvalDatasets: invoke(Channels.EvalListDatasets),
  startEvalBatch: invoke(Channels.EvalStartBatch),
  getEvalRun: invoke(Channels.EvalGetRun),
  getEvalReport: invoke(Channels.EvalGetReport),
  // evals(EVAL-05):取消 / 配置发现 / case 产物查询 / 人工审阅读写
  cancelEvalRun: invoke(Channels.EvalCancelRun),
  listEvalConfigs: invoke(Channels.EvalListConfigs),
  freezeEvalExperiment: invoke(Channels.EvalFreeze),
  getEvalCaseArtifacts: invoke(Channels.EvalCaseArtifacts),
  saveEvalReview: invoke(Channels.EvalReviewSave),
  getEvalReviewOverview: invoke(Channels.EvalReviewList),

  // research(R-06):薄 invoke 包装;错误码与幂等语义在主进程 handler 实现
  createResearchRun: invoke(Channels.ResearchRunCreate),
  getResearchReport: invoke(Channels.ResearchReportGet),
  getResearchSnapshot: invoke(Channels.ResearchSnapshotGet),
  importResearchDocuments: invoke(Channels.ResearchImportDocuments),

  on: (channel, listener) => {
    if (!channel.startsWith(EVENT_CHANNEL_PREFIX)) {
      throw new Error(`不允许订阅通道:${String(channel)}`)
    }
    const wrapped = (_event: unknown, ...args: unknown[]): void => {
      listener(...args)
    }
    ipcRenderer.on(channel, wrapped as never)
    return () => {
      ipcRenderer.removeListener(channel, wrapped as never)
    }
  }
}

// 仅对合格应用文档暴露完整 api;非应用文档(外源页面/任意本地文件)不暴露任何接口
if (isQualifiedRendererDocument(currentDocumentHref())) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  console.warn('[preload] 当前文档不是已登记的应用页面,已拒绝暴露 api')
}
