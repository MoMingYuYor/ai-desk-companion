// S1 写入契约:公共错误码、AppError 与 Result(数据契约细则第 3 节)。
// 本模块只承载类型与纯函数,主进程与渲染层均可引用;具体执行语义在 src/main/db/operations.ts。

export type ErrorCode =
  | 'VALIDATION'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'PERSIST_FAILED'
  | 'BACKUP_INVALID'
  | 'AUTH_REQUIRED'
  | 'NETWORK'
  | 'CANCELLED'
  | 'BUSY'
  | 'STALE_PREVIEW'
  | 'TARGET_UNAVAILABLE'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_OUTPUT_INVALID'

export interface AppError {
  code: ErrorCode
  message: string
  retryable: boolean
  /** 关联的操作 ID:PERSIST_FAILED 必须携带,用于同 ID 重试 */
  operationId?: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError }

/** 修改型命令上下文:创建类不要求 expectedRevision,但仍需 operationId */
export interface MutationContext {
  operationId: string
  expectedRevision: number
  workspaceEpoch: string
}

export interface EntityRef {
  kind: 'event' | 'todo' | 'pending'
  id: string
  revision: number
}

/** 构造稳定错误对象;message 面向用户展示,细因不放公开码 */
export function appError(
  code: ErrorCode,
  message: string,
  opts: { retryable?: boolean; operationId?: string } = {}
): AppError {
  const err: AppError = { code, message, retryable: opts.retryable ?? false }
  if (opts.operationId !== undefined) err.operationId = opts.operationId
  return err
}

/**
 * IPC 写入边界的 epoch 校验(纯函数,主进程调用):
 * 渲染层携带的旧 workspaceEpoch 按 STALE_PREVIEW 拒绝,UI 重读 revision/epoch 后即可恢复可用;
 * 缺省(null/undefined/'')视为当前代数放行,兼容尚未接入 MutationContext 的渲染层调用。
 */
export function assertCurrentEpoch(supplied: string | null | undefined, current: string): void {
  if (supplied != null && supplied !== '' && supplied !== current) {
    const err: IpcCarriedError = new Error('页面数据已过期,请刷新后重试')
    err.appError = appError('STALE_PREVIEW', '页面数据已过期,请刷新后重试', { retryable: true })
    throw err
  }
}

// ---------- IPC 边界错误桥接(Task 12 集成) ----------

/** 携带公共 AppError 的 Error 形态:主进程 IPC 边界输出,渲染层至少收到 message */
export type IpcCarriedError = Error & { appError?: AppError }

/**
 * IPC 边界错误归一(纯函数):
 * - 已携带 appError 的错误(OperationError)原样返回,message 不变;
 * - 具备 toAppError() 的内部错误(如安全存储不可用)映射为公共 AppError 并挂到新 Error 上;
 * - 其余错误保留用户可读 message,不虚构公开码。
 */
export function toIpcError(err: unknown): IpcCarriedError {
  if (err instanceof Error) {
    const carried = err as IpcCarriedError
    if (carried.appError) return carried
    const maybe = err as { toAppError?: () => AppError }
    if (typeof maybe.toAppError === 'function') {
      const out: IpcCarriedError = new Error(err.message)
      out.appError = maybe.toAppError()
      return out
    }
    return err
  }
  return new Error(String(err)) as IpcCarriedError
}
