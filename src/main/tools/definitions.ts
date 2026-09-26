// 八个本地工具(A-02):全部经 ToolGateway 执行,风险等级服务端固定。
// 结构性安全边界:
// - 无任何发送邮件能力(mail.create_draft 只建草稿);
// - update 工具通过 resolveTargetVersion 把参数解析为目标记录版本,
//   引用不存在的记录在 propose 阶段即被拒绝(模型虚构 ID 无法形成提案);
// - 额外字段被 schema 拒绝,模型自报的 riskLevel/needs_confirmation 无法进入。

import type { ToolDefinition, ToolExecutionContext } from './types'
import { toolFailure, toolSuccess } from './types'
import { assertRevision } from '../db/operations'
import {
  createEvent,
  createTodo,
  getEvent,
  getTodo,
  listEventsRange,
  listTodos,
  updateEvent,
  updateTodo
} from '../db/dao'
import { validateEventInput } from '../planning/eventValidation'
import { createMailDraft } from '../agent/mailDrafts'
import { searchDocuments } from '../retrieval/search'
import { appError } from '../../shared/operations'
import { OperationError } from '../db/operations'

const PRIORITY_ENUM = ['low', 'normal', 'high'] as const

function fail(message: string): ReturnType<typeof toolFailure> {
  return toolFailure(appError('VALIDATION', message, { retryable: false }))
}

/** todo.update / calendar.update_event 的目标版本解析:记录不存在即虚构 ID */
function resolveTodoRevision(args: Record<string, unknown>, ctx: ToolExecutionContext): number | null {
  const todo = getTodo(ctx.db, String(args.id))
  return todo ? todo.revision : null
}

function resolveEventRevision(args: Record<string, unknown>, ctx: ToolExecutionContext): number | null {
  const event = getEvent(ctx.db, String(args.id))
  return event ? event.revision : null
}

const TODO_MUTABLE_SCHEMA_FIELDS = [
  { name: 'title', type: 'string' },
  { name: 'notes', type: 'string' },
  { name: 'dueAt', type: 'string' },
  { name: 'priority', type: 'string', enum: PRIORITY_ENUM }
] as const

const EVENT_MUTABLE_SCHEMA_FIELDS = [
  { name: 'title', type: 'string' },
  { name: 'startAt', type: 'string' },
  { name: 'endAt', type: 'string' },
  { name: 'allDay', type: 'boolean' },
  { name: 'location', type: 'string' },
  { name: 'notes', type: 'string' }
] as const

/** 注册八个本地工具;幂等性由调用方控制(重复注册抛错) */
export function registerOpsTools(registry: { register(definition: ToolDefinition): void }): void {
  const defs: ToolDefinition[] = [
    // ---- 读 ----
    {
      name: 'todo.list',
      description: '读取本地待办任务,可按完成状态与优先级过滤',
      riskLevel: 'read',
      timeoutMs: 5000,
      retryable: false,
      inputSchema: {
        fields: [
          { name: 'status', type: 'string', enum: ['open', 'completed'] },
          { name: 'priority', type: 'string', enum: [...PRIORITY_ENUM] }
        ]
      },
      execute: (args, ctx) => {
        let todos = listTodos(ctx.db)
        if (args.status === 'open') todos = todos.filter((t) => t.completedAt == null)
        if (args.status === 'completed') todos = todos.filter((t) => t.completedAt != null)
        if (typeof args.priority === 'string') todos = todos.filter((t) => t.priority === args.priority)
        return toolSuccess({ todos })
      }
    },
    {
      name: 'calendar.list',
      description: '读取本地日程,可指定起止日期(YYYY-MM-DD,含端点)',
      riskLevel: 'read',
      timeoutMs: 5000,
      retryable: false,
      inputSchema: {
        fields: [
          { name: 'from', type: 'string' },
          { name: 'to', type: 'string' }
        ]
      },
      execute: (args, ctx) => {
        const from = typeof args.from === 'string' ? args.from : '0000-01-01'
        const to = typeof args.to === 'string' ? args.to : '9999-12-31'
        return toolSuccess({ events: listEventsRange(ctx.db, from, to) })
      }
    },
    {
      name: 'document.search',
      description: '检索已导入的文档(岗位 JD 等),返回命中片段、来源与得分',
      riskLevel: 'read',
      timeoutMs: 5000,
      retryable: false,
      inputSchema: {
        fields: [
          { name: 'query', type: 'string', required: true },
          { name: 'limit', type: 'number', min: 1, max: 20 }
        ]
      },
      execute: (args, ctx) => {
        const limit = typeof args.limit === 'number' ? args.limit : 8
        return toolSuccess({ hits: searchDocuments(ctx.db, String(args.query), limit) })
      }
    },
    // ---- 写(可撤销) ----
    {
      name: 'todo.create',
      description: '创建一条本地待办任务(经用户确认后写入)',
      riskLevel: 'reversible_write',
      timeoutMs: 5000,
      retryable: false,
      inputSchema: {
        fields: [
          { name: 'title', type: 'string', required: true },
          ...TODO_MUTABLE_SCHEMA_FIELDS.filter((f) => f.name !== 'title')
        ]
      },
      execute: (args, ctx) => {
        const todo = createTodo(
          ctx.db,
          {
            title: String(args.title),
            notes: typeof args.notes === 'string' ? args.notes : undefined,
            dueAt: typeof args.dueAt === 'string' ? args.dueAt : undefined,
            priority: typeof args.priority === 'string' ? (args.priority as 'low' | 'normal' | 'high') : undefined
          },
          'agent'
        )
        return toolSuccess({ todo })
      }
    },
    {
      name: 'todo.update',
      description: '修改一条本地待办任务(经用户确认后写入;需先读取真实任务 ID)',
      riskLevel: 'reversible_write',
      timeoutMs: 5000,
      retryable: false,
      inputSchema: {
        fields: [{ name: 'id', type: 'string', required: true }, ...TODO_MUTABLE_SCHEMA_FIELDS]
      },
      resolveTargetVersion: resolveTodoRevision,
      execute: (args, ctx) => {
        const id = String(args.id)
        if (typeof ctx.targetVersion !== 'number') return fail('缺少目标版本,无法安全更新')
        try {
          assertRevision(ctx.db, 'todos', id, ctx.targetVersion)
        } catch {
          return toolFailure(appError('CONFLICT', '任务已被修改,请重新读取后再试', { retryable: false }))
        }
        updateTodo(ctx.db, id, {
          ...(typeof args.title === 'string' ? { title: String(args.title) } : {}),
          ...(typeof args.notes === 'string' ? { notes: String(args.notes) } : {}),
          ...(typeof args.dueAt === 'string' ? { dueAt: String(args.dueAt) } : {}),
          ...(typeof args.priority === 'string'
            ? { priority: args.priority as 'low' | 'normal' | 'high' }
            : {})
        })
        return toolSuccess({ todo: getTodo(ctx.db, id) })
      }
    },
    {
      name: 'calendar.create_event',
      description: '创建一条本地日程(经用户确认后写入;开始时间必须晚于当前计划时间)',
      riskLevel: 'reversible_write',
      timeoutMs: 5000,
      retryable: false,
      inputSchema: {
        fields: [
          { name: 'title', type: 'string', required: true },
          { name: 'startAt', type: 'string', required: true },
          ...EVENT_MUTABLE_SCHEMA_FIELDS.filter((f) => f.name !== 'title' && f.name !== 'startAt')
        ]
      },
      execute: (args, ctx) => {
        const input = {
          title: String(args.title),
          startAt: String(args.startAt),
          ...(typeof args.endAt === 'string' ? { endAt: String(args.endAt) } : {}),
          ...(typeof args.allDay === 'boolean' ? { allDay: args.allDay } : {}),
          ...(typeof args.location === 'string' ? { location: String(args.location) } : {}),
          ...(typeof args.notes === 'string' ? { notes: String(args.notes) } : {})
        }
        try {
          // 集中校验:空标题/不可解析时间/倒置区间在写入前拒绝
          const { startMs: _s, endMs: _e, ...eventInput } = validateEventInput(input)
          const event = createEvent(ctx.db, eventInput, 'agent')
          return toolSuccess({ event })
        } catch (err) {
          if (err instanceof OperationError) return toolFailure(err.appError ?? appError('VALIDATION', err.message))
          throw err
        }
      }
    },
    {
      name: 'calendar.update_event',
      description: '修改一条本地日程(经用户确认后写入;需先读取真实日程 ID)',
      riskLevel: 'reversible_write',
      timeoutMs: 5000,
      retryable: false,
      inputSchema: {
        fields: [{ name: 'id', type: 'string', required: true }, ...EVENT_MUTABLE_SCHEMA_FIELDS]
      },
      resolveTargetVersion: resolveEventRevision,
      execute: (args, ctx) => {
        const id = String(args.id)
        if (typeof ctx.targetVersion !== 'number') return fail('缺少目标版本,无法安全更新')
        try {
          assertRevision(ctx.db, 'events', id, ctx.targetVersion)
        } catch {
          return toolFailure(appError('CONFLICT', '日程已被修改,请重新读取后再试', { retryable: false }))
        }
        const patch: Record<string, unknown> = {}
        for (const key of ['title', 'startAt', 'endAt', 'allDay', 'location', 'notes'] as const) {
          if (args[key] !== undefined) patch[key] = args[key]
        }
        updateEvent(ctx.db, id, patch)
        return toolSuccess({ event: getEvent(ctx.db, id) })
      }
    },
    {
      name: 'mail.create_draft',
      description: '创建一封邮件草稿(只能创建草稿,本系统没有发送邮件的能力)',
      riskLevel: 'reversible_write',
      timeoutMs: 5000,
      retryable: false,
      inputSchema: {
        fields: [
          { name: 'body', type: 'string', required: true },
          { name: 'subject', type: 'string' },
          { name: 'recipients', type: 'string[]' }
        ]
      },
      execute: (args, ctx) => {
        const draft = createMailDraft(ctx.db, {
          body: String(args.body),
          subject: typeof args.subject === 'string' ? args.subject : undefined,
          recipients: Array.isArray(args.recipients) ? (args.recipients as string[]) : undefined
        })
        return toolSuccess({ draft })
      }
    }
  ]
  for (const definition of defs) registry.register(definition)
}
