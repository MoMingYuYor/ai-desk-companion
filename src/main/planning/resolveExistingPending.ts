// 原子转换命令(Task 8 R7):待处理条目 → 日程/待办,仅供现有 PendingPage 转换使用。
// 事务所有权在 runOperation:先创建目标,再把 pending 置为 handled;
// 任一步失败(如触发器/约束)由唯一业务事务整体回滚,不留下孤立目标或半状态。
// 完整 F2 的候选身份、来源快照与工作台 API 留待 S2,不建 action_candidates 表。
import { createHash } from 'node:crypto'
import type { SqliteDb } from '../db/connection'
import { createEvent, createTodo, getPending, updatePending } from '../db/dao'
import { assertRevision, OperationError, runOperation } from '../db/operations'
import { appError } from '../../shared/operations'
import type { ResolvePendingCommand } from '../../shared/api'
import { validateEventInput } from './eventValidation'
import { ensureNotRestoring } from '../services/backup'

/** 规范化请求摘要:只含业务输入,排除 epoch、operationId 等瞬时窗口状态 */
function requestHashOf(command: ResolvePendingCommand): string {
  const normalized = {
    pendingId: command.pendingId,
    decision: command.decision,
    event: command.event ?? null,
    todo: command.todo ?? null
  }
  return createHash('sha1').update(JSON.stringify(normalized)).digest('hex')
}

export function resolveExistingPendingInDb(
  db: SqliteDb,
  command: ResolvePendingCommand
): { pendingId: string; targetId: string } {
  // 恢复排他窗口内以 BUSY(可重试)拒绝新写入
  ensureNotRestoring()
  if (!command.pendingId) {
    throw new OperationError(appError('VALIDATION', '缺少 pendingId', { retryable: false }))
  }
  if (command.decision !== 'create_event' && command.decision !== 'create_todo') {
    throw new OperationError(appError('VALIDATION', `不支持的转换类型:${String(command.decision)}`, { retryable: false }))
  }
  // 结构校验集中在主进程入口:无效输入在开事务前拒绝
  const action =
    command.decision === 'create_event'
      ? (() => {
          if (!command.event) {
            throw new OperationError(appError('VALIDATION', '转换为日程需要提供 event 输入', { retryable: false }))
          }
          validateEventInput(command.event)
          return { kind: 'event' as const, input: command.event }
        })()
      : (() => {
          if (!command.todo || !command.todo.title?.trim()) {
            throw new OperationError(appError('VALIDATION', '转换为待办需要提供非空标题', { retryable: false }))
          }
          return { kind: 'todo' as const, input: command.todo }
        })()

  return runOperation(
    db,
    {
      operationId: command.context.operationId,
      command: 'pending:resolve',
      requestHash: requestHashOf(command),
      expectedRevision: command.context.expectedRevision,
      workspaceEpoch: command.context.workspaceEpoch
    },
    () => {
      // 修订号条件检查在同一事务内:过期提交以 CONFLICT 失败并整体回滚
      assertRevision(db, 'pending_items', command.pendingId, command.context.expectedRevision)
      // 已处理条目不重复产生目标(S1 无 resolution_ref,以冲突代替"返回同一目标")
      const current = getPending(db, command.pendingId)
      if (!current || current.status !== 'open') {
        throw new OperationError(
          appError('CONFLICT', '该条目已处理或已关闭,请刷新后查看', { retryable: false })
        )
      }
      // 先创建目标
      const targetId =
        action.kind === 'event' ? createEvent(db, action.input).id : createTodo(db, action.input).id
      // 再更新该 pending 为 handled;失败由唯一事务整体回滚
      updatePending(db, command.pendingId, { status: 'handled' })
      return { pendingId: command.pendingId, targetId }
    }
  ).value
}
