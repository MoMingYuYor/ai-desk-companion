// 操作回执、条件更新与关键命令持久化协调(计划 Task 2/3 的写入契约底座)。
// runOperation 是关键命令唯一事务拥有者:幂等查重先于 revision 检查,
// 业务写入与回执在同一事务内提交;来源/结构/epoch 的边界校验由 IPC 层在调用前完成。
import type { PersistState, SqliteDb } from './connection'
import { nowTimestamp } from '../../shared/dateUtils'
import { appError, type AppError } from '../../shared/operations'

/** 携带公共 AppError 的操作异常;跨 IPC 后以 message 传递,detail 只留脱敏信息 */
export class OperationError extends Error {
  readonly appError: AppError

  constructor(error: AppError) {
    super(error.message)
    this.name = 'OperationError'
    this.appError = error
  }
}

// ---------- workspaceEpoch(生命周期元数据,主进程持有) ----------

let workspaceEpoch = ''

/** 主进程启动时调用:生成新的工作空间代数,旧窗口/旧异步任务随后按 STALE_PREVIEW 拒绝 */
export function initWorkspaceEpoch(): string {
  workspaceEpoch = `epoch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return workspaceEpoch
}

/** 恢复/替换数据库等边界事件时刷新(任务 4 的恢复排他窗口使用) */
export function bumpWorkspaceEpoch(): string {
  return initWorkspaceEpoch()
}

/** 只读获取当前工作空间代数;未初始化属于接线错误,直接抛出 */
export function getWorkspaceEpoch(): string {
  if (!workspaceEpoch) {
    throw new OperationError(appError('VALIDATION', 'workspace epoch 尚未初始化'))
  }
  return workspaceEpoch
}

// ---------- 操作回执 ----------

export interface OperationReceipt {
  operationId: string
  command: string
  requestHash: string
  /** 可恢复结果引用(JSON);不存请求全文或凭据 */
  resultRef: string
  createdAt: string
}

interface ReceiptRow {
  operation_id: string
  command: string
  request_hash: string
  result_ref: string
  created_at: string
}

function mapReceipt(r: ReceiptRow): OperationReceipt {
  return {
    operationId: r.operation_id,
    command: r.command,
    requestHash: r.request_hash,
    resultRef: r.result_ref,
    createdAt: r.created_at
  }
}

export function getOperationReceipt(db: SqliteDb, operationId: string): OperationReceipt | undefined {
  const row = db.get<ReceiptRow>(
    'SELECT operation_id, command, request_hash, result_ref, created_at FROM operation_receipts WHERE operation_id = ?',
    [operationId]
  )
  return row ? mapReceipt(row) : undefined
}

// ---------- runOperation ----------

export interface OperationInput {
  operationId: string
  command: string
  /** 调用方对规范化业务输入计算的稳定摘要;排除 epoch、密钥及日志字段 */
  requestHash: string
  /** 期望的目标实体修订号:由 apply 内的条件更新/assertRevision 消费,不写入回执 */
  expectedRevision?: number
  /** 主进程边界已校验的工作空间代数;不参与请求摘要 */
  workspaceEpoch: string
}

export interface OperationOutcome<T> {
  value: T
  replayed: boolean
}

function encodeResultRef(value: unknown): string {
  return JSON.stringify({ kind: 'json', value })
}

function decodeResultRef<T>(resultRef: string): T {
  const parsed = JSON.parse(resultRef) as { kind: string; value: T }
  return parsed.value
}

/**
 * 关键命令唯一事务拥有者:
 * 1) 结构校验(operationId/command/requestHash 非空);
 * 2) 先查幂等回执——同 ID 同摘要返回首次结果(replayed:true),此时不检查 revision,
 *    因此原 revision 已过期也返回原结果;同 ID 不同摘要返回 CONFLICT;
 * 3) 否则在一个事务内执行 apply(apply 内不得自行 BEGIN,复合 DAO 用内部方法)并写回执,
 *    任何失败由事务整体回滚,不会留下"业务已写、回执缺失"的半状态。
 */
export function runOperation<T>(db: SqliteDb, input: OperationInput, apply: () => T): OperationOutcome<T> {
  if (!input.operationId) throw new OperationError(appError('VALIDATION', '缺少 operationId'))
  if (!input.command) throw new OperationError(appError('VALIDATION', '缺少 command'))
  if (!input.requestHash) throw new OperationError(appError('VALIDATION', '缺少 requestHash'))

  const existing = getOperationReceipt(db, input.operationId)
  if (existing) {
    if (existing.requestHash !== input.requestHash) {
      throw new OperationError(
        appError('CONFLICT', '相同操作 ID 携带了不同的请求内容', {
          retryable: false,
          operationId: input.operationId
        })
      )
    }
    return { value: decodeResultRef<T>(existing.resultRef), replayed: true }
  }

  let value: T | undefined
  db.transaction(() => {
    value = apply()
    db.run(
      'INSERT INTO operation_receipts (operation_id, command, request_hash, result_ref, created_at) VALUES (?, ?, ?, ?, ?)',
      [input.operationId, input.command, input.requestHash, encodeResultRef(value), nowTimestamp()]
    )
  })
  return { value: value as T, replayed: false }
}

// ---------- 条件更新(乐观锁) ----------

export type RevisionedTable = 'events' | 'todos' | 'pending_items'

/**
 * 事务内的修订号条件检查:目标不存在返回 TARGET_UNAVAILABLE,
 * 修订号不匹配返回 CONFLICT(调用方捕获后应让用户重读现状再重试)。
 */
export function assertRevision(db: SqliteDb, table: RevisionedTable, id: string, expectedRevision: number): void {
  const row = db.get<{ revision: number }>(`SELECT revision FROM ${table} WHERE id = ?`, [id])
  if (!row) {
    throw new OperationError(
      appError('TARGET_UNAVAILABLE', `目标不存在或已被删除:${table}`, { retryable: false })
    )
  }
  if (row.revision !== expectedRevision) {
    throw new OperationError(
      appError('CONFLICT', '目标已被其他修改更新,请刷新后重试', { retryable: true })
    )
  }
}

/** 成功业务更新后递增修订号(每次成功业务更新恰好递增一次) */
export function bumpRevision(db: SqliteDb, table: RevisionedTable, id: string): void {
  db.run(`UPDATE ${table} SET revision = revision + 1 WHERE id = ?`, [id])
}

// ---------- 持久化协调器(Task 3) ----------

export interface PersistenceCoordinator {
  /**
   * 关键命令落盘协调:只对 runOperation 已提交的事务执行原子落盘,不运行业务逻辑、不嵌套 BEGIN。
   * 落盘成功才 resolve;失败以 PERSIST_FAILED(携带原 operationId)拒绝,
   * 进程内同 ID 重试优先重新尝试保存并返回首次已提交的结果。
   */
  commitCritical<T>(operationId: string, result: T): Promise<T>
  getPersistState(): PersistState
  subscribePersistState(listener: (state: PersistState) => void): () => void
}

export function createPersistenceCoordinator(db: SqliteDb): PersistenceCoordinator {
  // 进程内"已提交但未确认落盘"的关键操作:保存成功前保留,避免重复创建
  const pending = new Map<string, { result: unknown }>()

  return {
    async commitCritical<T>(operationId: string, result: T): Promise<T> {
      if (!operationId) {
        throw new OperationError(appError('VALIDATION', 'commitCritical 缺少 operationId'))
      }
      // 同 ID 已有待确认结果:沿用首次已提交的结果(同 ID 同摘要必然同结果)
      const value = (pending.has(operationId) ? pending.get(operationId)!.result : result) as T
      try {
        db.flush()
      } catch {
        pending.set(operationId, { result: value })
        throw new OperationError(
          appError('PERSIST_FAILED', '保存未确认:数据尚未落盘', {
            retryable: true,
            operationId
          })
        )
      }
      pending.delete(operationId)
      return value
    },
    getPersistState: () => db.getPersistState(),
    subscribePersistState: (listener) => db.subscribePersistState(listener)
  }
}
