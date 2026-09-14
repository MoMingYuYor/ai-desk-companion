// 全局共享类型:主进程 / 预加载 / 渲染进程统一使用

// ---------- 模型服务 ----------

export type ModelProtocol = 'chat-completions' | 'responses'

export interface ProviderInfo {
  id: string
  name: string
  baseUrl: string
  protocol: ModelProtocol
  models: string[]
  defaultModel: string
  supportsVision: boolean
  isDefault: boolean
  sortOrder: number
  hasApiKey: boolean
  createdAt: string
  updatedAt: string
}

/** 保存/测试时提交的配置;apiKey 传空字符串表示不修改 */
export interface ProviderInput {
  id?: string
  name: string
  baseUrl: string
  protocol: ModelProtocol
  models: string[]
  defaultModel: string
  supportsVision: boolean
  apiKey?: string
  isDefault?: boolean
  sortOrder?: number
}

export interface ProviderTestResult {
  ok: boolean
  latencyMs?: number
  error?: string
}

// ---------- 会话 / 消息 / 材料 ----------

export type ConversationKind = 'chat' | 'analysis' | 'timetable' | 'school-calendar'

export interface Conversation {
  id: string
  title: string
  kind: ConversationKind
  status: 'active' | 'archived'
  createdAt: string
  updatedAt: string
}

export type MessageRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: string
  conversationId: string
  role: MessageRole
  content: string
  modelLabel?: string | null
  meta?: string | null
  createdAt: string
  /** 仅发送中由事件附带 */
  streaming?: boolean
}

export type MaterialType = 'text' | 'file' | 'image'

export interface Material {
  id: string
  conversationId: string
  name: string
  type: MaterialType
  mime?: string | null
  size?: number | null
  /** 提取出的文本内容(文本类) */
  content?: string | null
  /** 图片/原文件的磁盘路径 */
  path?: string | null
  /** 解析失败的说明 */
  parseError?: string | null
  createdAt: string
}

export interface MaterialIntakeInput {
  conversationId?: string
  texts?: Array<{ name: string; content: string }>
  files?: string[]
  /** 自动触发分析/导入 */
  autoRun?: boolean
}

// ---------- 分析结果 ----------

export type CandidateType = 'todo' | 'event'

export interface ActionCandidate {
  title: string
  type: CandidateType
  /** 截止时间(待办) */
  deadline?: string | null
  /** 开始时间(日程) */
  start?: string | null
  /** 预计耗时(分钟) */
  durationMinutes?: number | null
  notes?: string
  location?: string
  sourceRef?: string
  confidence?: 'high' | 'medium' | 'low'
}

export interface AnalysisChange {
  ref?: string
  change?: string
}

export interface AnalysisPayload {
  title?: string
  summary?: string
  keyPoints?: string[]
  actionItems?: ActionCandidate[]
  questions?: string[]
  conflicts?: string[]
  changes?: AnalysisChange[]
  // 课表/校历导入时使用
  semester?: { name?: string; startDate?: string | null; weeks?: number | null }
  courses?: ExtractedCourse[]
  schoolEvents?: ExtractedSchoolEvent[]
}

export interface ExtractedCourse {
  name: string
  weekday: number // 1=周一 ... 7=周日
  startTime: string // HH:MM
  endTime: string
  weeks: Array<[number, number]>
  location?: string
  teacher?: string
}

export interface ExtractedSchoolEvent {
  type: 'holiday' | 'exam' | 'registration' | 'adjust' | 'other'
  title: string
  startDate: string
  endDate?: string | null
  note?: string
}

export interface Analysis {
  id: string
  conversationId: string
  version: number
  payload: AnalysisPayload
  rawResponse?: string | null
  modelLabel?: string | null
  status: 'pending' | 'done' | 'failed'
  error?: string | null
  createdAt: string
}

// ---------- 日程 / 待办 / 待处理 ----------

export interface CalendarEvent {
  id: string
  title: string
  startAt: string
  endAt: string
  allDay: boolean
  color?: string | null
  location?: string | null
  notes?: string | null
  source: 'manual' | 'analysis' | 'course'
  sourceRef?: string | null
  reminderMinutes?: number | null
  status: 'active' | 'cancelled'
  fingerprint?: string | null
  createdAt: string
  updatedAt: string
}

export interface Todo {
  id: string
  title: string
  notes?: string | null
  dueAt?: string | null
  priority: 'low' | 'normal' | 'high'
  completedAt?: string | null
  linkedEventId?: string | null
  linkedEvent?: CalendarEvent | null
  source: 'manual' | 'analysis'
  sourceRef?: string | null
  fingerprint?: string | null
  createdAt: string
  updatedAt: string
}

export interface PendingItem {
  id: string
  conversationId?: string | null
  title: string
  notes?: string | null
  status: 'open' | 'handled' | 'dismissed'
  createdAt: string
  updatedAt: string
}

export type EventInput = Partial<Omit<CalendarEvent, 'id' | 'createdAt' | 'updatedAt'>> & { title: string }
export type TodoInput = Partial<Omit<Todo, 'id' | 'createdAt' | 'updatedAt' | 'linkedEvent'>> & { title: string }

export interface ConfirmResult {
  result: 'created' | 'duplicate'
  refType: CandidateType
  refId: string
}

// ---------- 课表 / 校历 ----------

export interface Semester {
  id: string
  name: string
  startDate: string // 第一教学周周一,YYYY-MM-DD
  weeks: number
  createdAt: string
}

export interface Course {
  id: string
  semesterId: string
  name: string
  weekday: number
  startTime: string
  endTime: string
  weeks: Array<[number, number]>
  location?: string | null
  teacher?: string | null
  createdAt: string
}

export interface CourseOverride {
  id: string
  courseId: string
  date: string
  kind: 'cancel' | 'edit'
  newStartTime?: string | null
  newEndTime?: string | null
  newLocation?: string | null
  note?: string | null
  createdAt: string
}

export interface SchoolEvent {
  id: string
  semesterId?: string | null
  type: ExtractedSchoolEvent['type']
  title: string
  startDate: string
  endDate?: string | null
  note?: string | null
  createdAt: string
}

export interface CourseOccurrence {
  course: Course
  date: string
  startTime: string
  endTime: string
  location?: string | null
  cancelled: boolean
}

// ---------- 个人画像 ----------

export type ProfileCategory = 'basic' | 'preference' | 'schedule'
export type ProfileStatus = 'confirmed' | 'pending' | 'rejected'

export interface ProfileFact {
  id: string
  category: ProfileCategory
  key: string
  value: string
  source: 'explicit' | 'suggested'
  status: ProfileStatus
  createdAt: string
  updatedAt: string
}

// ---------- 提醒 / 通知 ----------

export interface ReminderNotice {
  key: string
  kind: 'event' | 'todo' | 'missed-event' | 'missed-todo' | 'info'
  title: string
  body: string
  at: string
}

export interface ModelSwitchNotice {
  from: string
  to: string
  reason: string
}

// ---------- 备份 ----------

export interface BackupFile {
  app: string
  schemaVersion: number
  exportedAt: string
  tables: Record<string, unknown[]>
}

// ---------- 其他 ----------

export interface DayAgenda {
  date: string
  courses: CourseOccurrence[]
  events: CalendarEvent[]
  todos: Todo[]
  schoolEvents: SchoolEvent[]
}

export interface AppInfo {
  version: string
  electron: string
  dataDir: string
  dbPath: string
  platform: string
}
