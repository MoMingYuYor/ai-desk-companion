import type { Database, SqlJsStatic, SqlValue } from 'sql.js'

export type SqlParams = Array<SqlValue | undefined> | Record<string, SqlValue | undefined> | undefined

/** 把 undefined 归一为 null(sql.js 绑定不接受 undefined) */
function sanitize(params: SqlParams): SqlParams {
  if (Array.isArray(params)) return params.map((p) => (p === undefined ? null : p))
  if (params && typeof params === 'object') {
    const out: Record<string, SqlValue> = {}
    for (const [k, v] of Object.entries(params)) out[k] = v === undefined ? null : v
    return out
  }
  return params
}

// ---------- 持久化状态(Task 3:可确认落盘) ----------

export type PersistStatus = 'dirty' | 'saving' | 'saved' | 'failed'

export interface PersistState {
  status: PersistStatus
  /** 当前写入代数:每开始一批新的未落盘写入递增一次 */
  generation: number
  /** 最近一次成功落盘的写入代数;成功只清除已落盘代数的脏状态 */
  persistedGeneration: number
  /** 最近一次落盘失败原因(文件操作错误消息,不含业务内容) */
  error?: string
}

export type PersistListener = (state: PersistState) => void

/** 文件操作注入面:测试用它在该实例上拒绝临时文件写入/替换;生产不传,使用真实 fs */
export interface FileOps {
  readFileSync(path: string): Buffer
  writeFileSync(path: string, data: Buffer): void
  renameSync(from: string, to: string): void
  existsSync(path: string): boolean
  mkdirSync(path: string, opts: { recursive: boolean }): void
  unlinkSync(path: string): void
}

export interface OpenDatabaseOptions {
  /** 注入的文件操作;未提供的函数回退到真实 fs */
  fs?: Partial<FileOps>
}

export interface PersistScheduler {
  schedule(): void
  /** 立即落盘;失败抛出并转入 failed 状态安排重试 */
  flush(): void
  state(): PersistState
  subscribe(listener: PersistListener): () => void
}

const DEBOUNCE_MS = 400
const MAX_WAIT_MS = 2000
/** 失败重试间隔:1、5、30 秒,其后每 30 秒 */
const RETRY_DELAYS_MS = [1000, 5000, 30000]
const RETRY_STEADY_MS = 30000

export class SqliteDb {
  constructor(
    private readonly db: Database,
    private readonly persist: PersistScheduler
  ) {}

  all<T = Record<string, unknown>>(sql: string, params: SqlParams = []): T[] {
    const stmt = this.db.prepare(sql)
    try {
      const clean = sanitize(params)
      if (clean && (Array.isArray(clean) ? clean.length > 0 : Object.keys(clean).length > 0)) {
        stmt.bind(clean as never)
      }
      const rows: T[] = []
      while (stmt.step()) rows.push(stmt.getAsObject() as T)
      return rows
    } finally {
      stmt.free()
    }
  }

  get<T = Record<string, unknown>>(sql: string, params: SqlParams = []): T | undefined {
    const rows = this.all<T>(sql, params)
    return rows.length > 0 ? rows[0] : undefined
  }

  run(sql: string, params: SqlParams = []): void {
    // 空参数列表不绑定:sql.js 有 params 时按单语句执行,多语句 SCHEMA 需要走无参路径
    const clean = sanitize(params)
    const hasParams = Array.isArray(clean) ? clean.length > 0 : clean != null && Object.keys(clean).length > 0
    this.db.run(sql, (hasParams ? clean : undefined) as never)
    this.persist.schedule()
  }

  /** 批量写入后手动触发一次持久化 */
  transaction(fn: () => void): void {
    this.db.run('BEGIN')
    try {
      fn()
      this.db.run('COMMIT')
    } catch (err) {
      this.db.run('ROLLBACK')
      throw err
    }
    this.persist.schedule()
  }

  flush(): void {
    this.persist.flush()
  }

  /** 保存原语:读取当前持久化状态(UI 可见) */
  getPersistState(): PersistState {
    return this.persist.state()
  }

  /** 保存原语:订阅持久化状态变化;返回取消订阅函数 */
  subscribePersistState(listener: PersistListener): () => void {
    return this.persist.subscribe(listener)
  }

  close(): void {
    this.persist.flush()
    try {
      this.db.close()
    } catch {
      // ignore
    }
  }
}

const SQLITE_HEADER = 'SQLite format 3\x00'

function openFromBytes(SQL: SqlJsStatic, bytes: Buffer): Database {
  // 零长度文件按 SQLite 语义视为空库;非空内容必须带标准头,损坏文件在此明确失败
  if (bytes.length > 0 && bytes.subarray(0, 15).toString('latin1') !== SQLITE_HEADER.slice(0, 15)) {
    throw new Error('数据库文件损坏或无法识别')
  }
  const raw = new SQL.Database(bytes.length > 0 ? bytes : undefined)
  // 损坏文件的签名可能合法但页损坏:用一次只读探测提前暴露
  raw.exec('SELECT count(*) FROM sqlite_master')
  return raw
}

export async function openDatabase(
  dbPath: string,
  sqlJsDistDir: string,
  options: OpenDatabaseOptions = {}
): Promise<{ db: SqliteDb; flush: () => void; raw: Database; persist: PersistScheduler }> {
  const initSqlJs = (await import('sql.js')).default as unknown as (cfg?: object) => Promise<SqlJsStatic>
  const realFs = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const injected = options.fs ?? {}
  const fs: FileOps = {
    readFileSync: (p) => realFs.readFileSync(p) as Buffer,
    writeFileSync: (p, d) => realFs.writeFileSync(p, d),
    renameSync: (f, t) => realFs.renameSync(f, t),
    existsSync: (p) => realFs.existsSync(p),
    mkdirSync: (p, opts) => {
      realFs.mkdirSync(p, opts)
    },
    unlinkSync: (p) => realFs.unlinkSync(p),
    ...injected
  }

  const wasmBinary = fs.readFileSync(join(sqlJsDistDir, 'sql-wasm.wasm'))
  const SQL = await initSqlJs({ wasmBinary })

  const tmpPath = dbPath + '.tmp'
  fs.mkdirSync(dirname(dbPath), { recursive: true })

  // 打开与恢复规则:
  // - 主文件存在 → 以主文件为准;损坏明确失败(不静默回退空库);残留临时文件清理
  // - 主文件缺失 + 临时文件存在 → 上次替换中断,采用临时文件内容(最后一次成功写入)
  // - 两者都缺失 → 全新空库
  let raw: Database
  if (fs.existsSync(dbPath)) {
    try {
      raw = openFromBytes(SQL, fs.readFileSync(dbPath))
    } catch (err) {
      throw new Error(`数据库文件损坏或无法识别,已停止打开以避免数据丢失:${err instanceof Error ? err.message : String(err)}`)
    }
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath)
      } catch {
        // 残留临时文件无法清理时忽略,主文件为准
      }
    }
  } else if (fs.existsSync(tmpPath)) {
    try {
      const bytes = fs.readFileSync(tmpPath)
      raw = openFromBytes(SQL, bytes)
      fs.renameSync(tmpPath, dbPath)
    } catch (err) {
      throw new Error(`数据库临时文件损坏且主文件缺失,已停止打开:${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    raw = new SQL.Database()
  }

  // ---- 保存状态机:400ms 合并、最长 2 秒尝试落盘、失败按 1/5/30/30 秒重试 ----
  let state: PersistState = { status: 'saved', generation: 0, persistedGeneration: 0 }
  /** 当前未落盘批次的首写时刻:2 秒最长等待的锚点;null 表示没有未落盘写入 */
  let firstDirtyAt: number | null = null
  let retryIndex = 0
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const listeners = new Set<PersistListener>()

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener({ ...state })
      } catch {
        // 监听器异常不影响保存流程
      }
    }
  }

  const setState = (patch: Partial<PersistState>): void => {
    state = { ...state, ...patch }
    emit()
  }

  const doFlushRaw = (): void => {
    const data = Buffer.from(raw.export())
    fs.writeFileSync(tmpPath, data)
    fs.renameSync(tmpPath, dbPath)
  }

  const scheduleRetry = (): void => {
    const delay = retryIndex < RETRY_DELAYS_MS.length ? RETRY_DELAYS_MS[retryIndex] : RETRY_STEADY_MS
    if (retryIndex < RETRY_DELAYS_MS.length) retryIndex += 1
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(performSave, delay)
  }

  const performSave = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    setState({ status: 'saving' })
    try {
      doFlushRaw()
      firstDirtyAt = null
      retryIndex = 0
      // 成功只清除已落盘代数的脏状态
      setState({ status: 'saved', persistedGeneration: state.generation, error: undefined })
    } catch (err) {
      // 失败不静默吞掉:进入 failed 并安排重试;firstDirtyAt 保留(数据仍未落盘)
      setState({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
      scheduleRetry()
    }
  }

  const schedule = (): void => {
    const now = Date.now()
    if (firstDirtyAt === null) {
      // 新的一批未落盘写入:递增写入代数,重置重试节奏
      firstDirtyAt = now
      retryIndex = 0
      setState({ generation: state.generation + 1, status: 'dirty', error: undefined })
    } else if (state.status !== 'dirty') {
      // 保存中/失败期间又有新写入:回到 dirty 继续合并,代数与重试节奏保留
      setState({ status: 'dirty' })
    }
    // 距本批首写最长 2 秒必须尝试落盘;两次写入间隔内合并 400ms
    const deadline = firstDirtyAt + MAX_WAIT_MS
    const delay = Math.max(0, Math.min(DEBOUNCE_MS, deadline - now))
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(performSave, delay)
  }

  const flushNow = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    setState({ status: 'saving' })
    try {
      doFlushRaw()
      firstDirtyAt = null
      retryIndex = 0
      setState({ status: 'saved', persistedGeneration: state.generation, error: undefined })
    } catch (err) {
      setState({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
      scheduleRetry()
      throw err
    }
  }

  const persist: PersistScheduler = {
    schedule,
    flush: flushNow,
    state: () => ({ ...state }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }

  return {
    db: new SqliteDb(raw, persist),
    flush: persist.flush,
    raw,
    persist
  }
}
