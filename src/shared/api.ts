// IPC 通道名与渲染进程可见的 API 契约
import type {
  Analysis,
  AppInfo,
  BackupFile,
  CalendarEvent,
  ChatMessage,
  ConfirmResult,
  Conversation,
  Course,
  CourseOverride,
  CourseOccurrence,
  DayAgenda,
  EventInput,
  Material,
  MaterialIntakeInput,
  ModelSwitchNotice,
  ModelProtocol,
  PendingItem,
  ProfileFact,
  ProviderInfo,
  ProviderInput,
  ProviderTestResult,
  ReminderNotice,
  SchoolEvent,
  Semester,
  Todo,
  TodoInput
} from './types'
import type { PetActivitySnapshot } from './pet'
import type { MailApi, MailSubscribe } from './mail'
import type { AppearanceApi, AppearanceSnapshot } from './appearance'

/** preload 暴露的外观桥:在 AppearanceApi 之上增加主进程广播订阅 */
export interface AppearanceBridge extends AppearanceApi {
  subscribe(listener: (snapshot: AppearanceSnapshot) => void): () => void
}

export const Channels = {
  // app
  AppInfo: 'app:info',
  // providers
  ProvidersList: 'providers:list',
  ProvidersSave: 'providers:save',
  ProvidersDelete: 'providers:delete',
  ProvidersSetDefault: 'providers:set-default',
  ProvidersTest: 'providers:test',
  ProvidersFetchModels: 'providers:fetch-models',
  // conversations
  ConversationsList: 'conversations:list',
  ConversationsCreate: 'conversations:create',
  ConversationsRename: 'conversations:rename',
  ConversationsDelete: 'conversations:delete',
  MessagesList: 'messages:list',
  ChatSend: 'chat:send',
  ChatStop: 'chat:stop',
  ChatRetry: 'chat:retry',
  MaterialsAdd: 'materials:add',
  UrlFetch: 'materials:fetch-url',
  // analysis
  AnalysesLatest: 'analyses:latest',
  AnalysesRerun: 'analyses:rerun',
  AnalysisConfirmItem: 'analysis:confirm-item',
  AnalysisDeferItem: 'analysis:defer-item',
  // events / todos
  EventsRange: 'events:range',
  EventsCreate: 'events:create',
  EventsUpdate: 'events:update',
  EventsDelete: 'events:delete',
  TodosList: 'todos:list',
  TodosCreate: 'todos:create',
  TodosUpdate: 'todos:update',
  TodosDelete: 'todos:delete',
  TodosLinkEvent: 'todos:link-event',
  // pending
  PendingList: 'pending:list',
  PendingUpdate: 'pending:update',
  PendingDelete: 'pending:delete',
  // timetable / calendar import
  SemestersList: 'semesters:list',
  SemestersSave: 'semesters:save',
  SemestersDelete: 'semesters:delete',
  CoursesList: 'courses:list',
  CoursesSave: 'courses:save',
  CoursesDelete: 'courses:delete',
  CourseOverridesSave: 'course-overrides:save',
  CourseOverridesDelete: 'course-overrides:delete',
  CourseOverridesList: 'course-overrides:list',
  SchoolEventsList: 'school-events:list',
  SchoolEventsSave: 'school-events:save',
  SchoolEventsDelete: 'school-events:delete',
  ImportTimetable: 'import:timetable',
  ImportSchoolCalendar: 'import:school-calendar',
  // profile
  ProfileList: 'profile:list',
  ProfileSave: 'profile:save',
  ProfileDelete: 'profile:delete',
  ProfileResolve: 'profile:resolve',
  // panel / pet
  PanelToday: 'panel:today',
  PanelSetPinned: 'panel:set-pinned',
  PanelGetPinned: 'panel:get-pinned',
  PetDragStart: 'pet:drag-start',
  PetDragMove: 'pet:drag-move',
  PetDragEnd: 'pet:drag-end',
  PetOpenMenu: 'pet:open-menu',
  PetGetScale: 'pet:get-scale',
  PetSetScale: 'pet:set-scale',
  PetAction: 'pet:action',
  PetActivitySnapshot: 'pet:activity-snapshot',
  // backup
  BackupExport: 'backup:export',
  BackupImport: 'backup:import',
  // mail
  MailAccounts: 'mail:accounts',
  MailTest: 'mail:test',
  MailSave: 'mail:save',
  MailSetEnabled: 'mail:set-enabled',
  MailRemove: 'mail:remove',
  MailSync: 'mail:sync',
  MailEarlier: 'mail:earlier',
  MailList: 'mail:list',
  MailDetail: 'mail:detail',
  MailMarkRead: 'mail:mark-read',
  MailDownload: 'mail:download',
  MailSaveAttachment: 'mail:save-attachment',
  MailOpenLink: 'mail:open-link',
  MailOpenWebmail: 'mail:open-webmail',
  MailAnalyze: 'mail:analyze',
  MailAnalysisStatus: 'mail:analysis-status',
  MailCancelAnalysis: 'mail:cancel-analysis',
  MailSource: 'mail:source',

  // main -> renderer 事件
  EventChatDelta: 'evt:chat-delta',
  EventChatDone: 'evt:chat-done',
  EventChatError: 'evt:chat-error',
  EventConversationChanged: 'evt:conversation-changed',
  EventAnalysisUpdated: 'evt:analysis-updated',
  EventMaterialsAccepted: 'evt:materials-accepted',
  EventReminderFired: 'evt:reminder-fired',
  EventModelSwitched: 'evt:model-switched',
  EventDataChanged: 'evt:data-changed',
  EventPetActivity: 'evt:pet-activity'
} as const

export interface AnalysisDeferResult {
  pendingId: string
}

export interface ImportPreview {
  conversationId: string
  analysisId: string
  payload: unknown
}

export interface RendererApi {
  // app
  getAppInfo(): Promise<AppInfo>
  /** 把拖拽得到的 File 对象转换为磁盘路径(桌面拖入材料用) */
  pathForFile(file: unknown): string
  // providers
  listProviders(): Promise<ProviderInfo[]>
  saveProvider(input: ProviderInput): Promise<ProviderInfo>
  deleteProvider(id: string): Promise<void>
  setDefaultProvider(id: string): Promise<void>
  testProvider(input: ProviderInput): Promise<ProviderTestResult>
  fetchModels(input: { baseUrl: string; apiKey?: string; providerId?: string }): Promise<string[]>
  // conversations / chat
  listConversations(): Promise<Conversation[]>
  createConversation(kind: Conversation['kind'], title?: string): Promise<Conversation>
  renameConversation(id: string, title: string): Promise<void>
  deleteConversation(id: string): Promise<void>
  listMessages(conversationId: string): Promise<ChatMessage[]>
  sendChat(conversationId: string, text: string): Promise<void>
  stopChat(conversationId: string): Promise<void>
  retryChat(conversationId: string): Promise<void>
  addMaterials(input: MaterialIntakeInput): Promise<{ conversationId: string; materials: Material[] }>
  fetchUrlText(url: string): Promise<{ title: string; text: string }>
  // analysis
  getLatestAnalysis(conversationId: string): Promise<Analysis | null>
  rerunAnalysis(conversationId: string): Promise<void>
  confirmAnalysisItem(analysisId: string, item: unknown): Promise<ConfirmResult>
  deferAnalysisItem(analysisId: string, item: unknown): Promise<AnalysisDeferResult>
  // events / todos
  listEvents(from: string, to: string): Promise<CalendarEvent[]>
  createEvent(input: EventInput): Promise<CalendarEvent>
  updateEvent(id: string, patch: Partial<EventInput>): Promise<void>
  deleteEvent(id: string): Promise<void>
  listTodos(): Promise<Todo[]>
  createTodo(input: TodoInput): Promise<Todo>
  updateTodo(id: string, patch: Partial<TodoInput>): Promise<void>
  deleteTodo(id: string): Promise<void>
  linkTodoEvent(todoId: string, eventId: string | null): Promise<void>
  // pending
  listPending(): Promise<PendingItem[]>
  updatePending(id: string, patch: Partial<Pick<PendingItem, 'status' | 'title' | 'notes'>>): Promise<void>
  deletePending(id: string): Promise<void>
  // timetable
  listSemesters(): Promise<Semester[]>
  saveSemester(input: { id?: string; name: string; startDate: string; weeks: number }): Promise<Semester>
  deleteSemester(id: string): Promise<void>
  listCourses(semesterId: string): Promise<Course[]>
  saveCourse(input: Partial<Course> & { semesterId: string; name: string; weekday: number; startTime: string; endTime: string; weeks: Array<[number, number]> }): Promise<Course>
  deleteCourse(id: string): Promise<void>
  saveCourseOverride(input: { id?: string; courseId: string; date: string; kind: 'cancel' | 'edit'; newStartTime?: string | null; newEndTime?: string | null; newLocation?: string | null; note?: string | null }): Promise<CourseOverride>
  deleteCourseOverride(id: string): Promise<void>
  listCourseOverrides(): Promise<Array<{ id: string; courseId: string; date: string; kind: 'cancel' | 'edit'; newStartTime?: string | null; newEndTime?: string | null; newLocation?: string | null; note?: string | null }>>
  listSchoolEvents(semesterId?: string): Promise<SchoolEvent[]>
  saveSchoolEvent(input: Partial<SchoolEvent> & { title: string; startDate: string; type: SchoolEvent['type'] }): Promise<SchoolEvent>
  deleteSchoolEvent(id: string): Promise<void>
  importTimetable(input: MaterialIntakeInput): Promise<ImportPreview>
  importSchoolCalendar(input: MaterialIntakeInput): Promise<ImportPreview>
  // profile
  listProfile(): Promise<ProfileFact[]>
  saveProfile(input: { id?: string; category: ProfileFact['category']; key: string; value: string }): Promise<ProfileFact>
  deleteProfile(id: string): Promise<void>
  resolveProfile(id: string, accept: boolean): Promise<void>
  // panel / pet
  getDayAgenda(date: string): Promise<DayAgenda>
  setPanelPinned(pinned: boolean): Promise<void>
  getPanelPinned(): Promise<boolean>
  petDragStart(): Promise<void>
  petDragMove(): Promise<void>
  petDragEnd(): Promise<void>
  petOpenMenu(): Promise<void>
  petAction(action: string): Promise<void>
  petGetScale(): Promise<number>
  petSetScale(scale: number): Promise<void>
  getPetActivitySnapshot(): Promise<PetActivitySnapshot>
  // backup
  exportBackup(): Promise<string | null>
  importBackup(): Promise<boolean>
  // mail
  mail: MailApi
  subscribeMail: MailSubscribe
  // appearance
  appearance: AppearanceBridge
  // 事件订阅
  on(channel: string, listener: (...args: unknown[]) => void): () => void
}

export type { Analysis, BackupFile, CalendarEvent, ChatMessage, ConfirmResult, Conversation, Course, CourseOverride, CourseOccurrence, DayAgenda, EventInput, Material, ModelProtocol, ModelSwitchNotice, PendingItem, ProfileFact, ProviderInfo, ProviderInput, ProviderTestResult, ReminderNotice, SchoolEvent, Semester, Todo, TodoInput }
