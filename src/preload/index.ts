// 预加载:通过 contextBridge 向渲染进程暴露类型化 API
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { Channels } from '../shared/api'
import type { RendererApi } from '../shared/api'
import type { MailApi, MailSubscribe, MailEventMap } from '../shared/mail'

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

const api: RendererApi = {
  getAppInfo: invoke(Channels.AppInfo),
  pathForFile: (file: unknown) => webUtils.getPathForFile(file as File),
  mail,
  subscribeMail,

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
  addMaterials: invoke(Channels.MaterialsAdd),

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

  on: (channel, listener) => {
    const wrapped = (_event: unknown, ...args: unknown[]): void => {
      listener(...args)
    }
    ipcRenderer.on(channel, wrapped as never)
    return () => {
      ipcRenderer.removeListener(channel, wrapped as never)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
