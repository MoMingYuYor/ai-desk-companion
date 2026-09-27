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
  PendingImport,
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
import type { MutationContext, Result } from './operations'

/** S1 写入契约公共类型:渲染层与主进程共用(定义见 shared/operations) */
export type { MutationContext, Result }

/** preload 暴露的外观桥:在 AppearanceApi 之上增加主进程广播订阅 */
export interface AppearanceBridge extends AppearanceApi {
  subscribe(listener: (snapshot: AppearanceSnapshot) => void): () => void
}

export const Channels = {
  // app
  AppInfo: 'app:info',
  // workspace(生命周期元数据)
  WorkspaceEpoch: 'workspace:epoch',
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
  // R8:当前活动运行快照(视图切回);引擎层实现,IPC 暴露由集成任务接线
  ChatActiveRun: 'chat:active-run',
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
  // pending 原子转换(Task 8/R7):一次命令完成"创建目标 + 置 handled"
  PendingResolve: 'pending:resolve',
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
  PendingImports: 'imports:pending',
  ImportHandled: 'imports:handled',
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

  // Agent 运行契约(C-02):运行生命周期、澄清、取消与审批。
  // 这些通道只对 workbench 角色开放;桌宠与面板一律拒绝(见 tests/agent/ipcAuthorization.test.ts)。
  // 执行语义由 C-03 实现,本文件只固定通道名与渲染层可见契约。
  AgentRunCreate: 'agent:run-create',
  AgentRunGet: 'agent:run-get',
  AgentRunEvents: 'agent:run-events',
  AgentRunList: 'agent:run-list',
  AgentRunApprovals: 'agent:run-approvals',
  AgentRunAnswers: 'agent:run-answers',
  AgentRunCancel: 'agent:run-cancel',
  AgentApprovalDecide: 'agent:approval-decide',
  EvalListDatasets: 'eval:list-datasets',
  EvalStartBatch: 'eval:start-batch',
  EvalGetRun: 'eval:get-run',
  EvalGetReport: 'eval:get-report',

  // main -> renderer 事件
  // R8 会话运行契约:started 先于任何流事件;delta/done/error 均携带 runId,
  // 页面只接收与当前运行精确匹配的事件,迟到事件零 UI 副作用
  EventChatStarted: 'evt:chat-started',
  EventChatDelta: 'evt:chat-delta',
  EventChatDone: 'evt:chat-done',
  EventChatError: 'evt:chat-error',
  EventConversationChanged: 'evt:conversation-changed',
  EventAnalysisUpdated: 'evt:analysis-updated',
  EventMaterialsAccepted: 'evt:materials-accepted',
  EventReminderFired: 'evt:reminder-fired',
  EventModelSwitched: 'evt:model-switched',
  EventDataChanged: 'evt:data-changed',
  EventPetActivity: 'evt:pet-activity',
  // 持久化状态广播:dirty/saving/saved/failed + 写入代数(Task 3)
  EventPersistStateChanged: 'evt:persist-state',
  // Agent 运行事件(C-02):按 seq 递增推送,客户端按 seq 补发缺失事件;
  // 断线重连不取消运行;终态发 run.finished
  EventAgentRunUpdated: 'evt:agent-run-updated',
  EventAgentRunFinished: 'evt:agent-run-finished'
} as const

export interface AnalysisDeferResult {
  pendingId: string
}

/** 待处理条目原子转换命令(Task 8/R7);F2 完整候选工作台留 S2 */
export interface ResolvePendingCommand {
  context: MutationContext
  pendingId: string
  decision: 'create_event' | 'create_todo'
  event?: EventInput
  todo?: TodoInput
}

export interface ResolvePendingResult {
  pendingId: string
  targetId: string
}

// ---------- R8 会话运行契约 ----------

/** 任何流事件前广播:页面据此绑定当前运行;runGeneration 单会话递增 */
export interface ChatRunStarted {
  conversationId: string
  runId: string
  runGeneration: number
}

export interface ChatRunDelta {
  conversationId: string
  runId: string
  delta: string
}

export interface ChatRunDone {
  conversationId: string
  runId: string
  messageId: string
}

export interface ChatRunError {
  conversationId: string
  runId: string
  error: string
}

/** 活动运行快照:返回活动运行与引擎侧累计文本,支持视图切回;恢复 workspaceEpoch 后全部失效 */
export interface ActiveChatRun {
  conversationId: string
  runId: string
  runGeneration: number
  text: string
}

// ---------- Agent 运行界面契约(A-06) ----------

/** 最近运行列表条目 */
export interface AgentRunListItem {
  runId: string
  mode: string
  status: string
  input: string
  errorCode: string | null
  startedAt: string
  finishedAt: string | null
}

/** 审批记录的界面形态(含已校验参数) */
export interface AgentApprovalView {
  approvalId: string
  runId: string
  toolName: string
  argumentsHash: string
  arguments: Record<string, unknown> | null
  planVersion: number
  targetVersion: number | null
  expiresAt: string
  decision: string
  decidedAt: string | null
}

export interface ImportPreview {
  conversationId: string
  analysisId: string
  payload: unknown
  /** 提取失败的原因;payload 为空时用于界面诊断 */
  error?: string | null
}

export interface RendererApi {
  // app
  getAppInfo(): Promise<AppInfo>
  /** 当前主进程工作空间代数:可信窗口初始化与恢复后刷新,旧代数写请求拒绝 */
  getWorkspaceEpoch(): Promise<string>
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
  /** 停止当前活动运行;可携带页面绑定的 runId,与活动运行不一致时忽略(防误停新运行) */
  stopChat(conversationId: string, runId?: string): Promise<void>
  retryChat(conversationId: string): Promise<void>
  /** 当前活动运行与累计文本快照;无活动运行返回 null */
  getActiveChatRun(conversationId: string): Promise<ActiveChatRun | null>
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
  /** 原子转换:先创建目标再置 handled,失败整体回滚;错误以 Result 返回而非抛异常 */
  resolveExistingPending(command: ResolvePendingCommand): Promise<Result<ResolvePendingResult>>
  // timetable
  listPendingImports(limit?: number): Promise<PendingImport[]>
  markImportHandled(analysisId: string): Promise<void>
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
  // agent(个人事务 Agent)
  createAgentRun(input: { input: string; mode?: 'personal_ops' | 'research' }): Promise<{ runId: string; status: string }>
  getAgentRun(runId: string): Promise<import('./agent').AgentRunView | null>
  listAgentRuns(): Promise<AgentRunListItem[]>
  getAgentRunEvents(runId: string, afterSeq?: number): Promise<import('./agent').AgentRunEventsResult>
  getAgentRunApprovals(runId: string): Promise<AgentApprovalView[]>
  submitAgentAnswers(runId: string, answers: Array<{ questionId: string; answer: string }>): Promise<{ runId: string; status: string }>
  cancelAgentRun(runId: string): Promise<import('./agent').AgentRunView>
  decideAgentApproval(approvalId: string, decision: 'approved' | 'rejected'): Promise<{ already: boolean }>
  // evals(E-07)
  listEvalDatasets(): Promise<Array<{ version: string; total: number }>>
  startEvalBatch(params: { datasetVersion: string; splits: Array<'dev' | 'holdout'> }): Promise<{ evalRunId: string; status: string }>
  getEvalRun(evalRunId: string): Promise<Record<string, unknown> | null>
  getEvalReport(evalRunId: string): Promise<string | null>
  // mail
  mail: MailApi
  subscribeMail: MailSubscribe
  // appearance
  appearance: AppearanceBridge
  // 事件订阅
  on(channel: string, listener: (...args: unknown[]) => void): () => void
}

export type { Analysis, BackupFile, CalendarEvent, ChatMessage, ConfirmResult, Conversation, Course, CourseOverride, CourseOccurrence, DayAgenda, EventInput, Material, ModelProtocol, ModelSwitchNotice, PendingImport, PendingItem, ProfileFact, ProviderInfo, ProviderInput, ProviderTestResult, ReminderNotice, SchoolEvent, Semester, Todo, TodoInput }
export type { AgentRunView, AgentRunEventPayload, AgentRunFinishedPayload, AgentRunEventsResult, TraceEvent } from './agent'
