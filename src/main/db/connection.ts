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

export interface PersistScheduler {
  schedule(): void
  flush(): void
}

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

  close(): void {
    this.persist.flush()
    try {
      this.db.close()
    } catch {
      // ignore
    }
  }
}

export async function openDatabase(
  dbPath: string,
  sqlJsDistDir: string
): Promise<{ db: SqliteDb; flush: () => void; raw: Database }> {
  const initSqlJs = (await import('sql.js')).default as unknown as (cfg?: object) => Promise<SqlJsStatic>
  const { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')

  const wasmBinary = readFileSync(join(sqlJsDistDir, 'sql-wasm.wasm'))
  const SQL = await initSqlJs({ wasmBinary })

  mkdirSync(dirname(dbPath), { recursive: true })
  const raw = existsSync(dbPath) ? new SQL.Database(readFileSync(dbPath)) : new SQL.Database()

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const doFlush = (): void => {
    const data = Buffer.from(raw.export())
    const tmp = dbPath + '.tmp'
    writeFileSync(tmp, data)
    renameSync(tmp, dbPath)
  }
  const persist: PersistScheduler = {
    schedule: () => {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        saveTimer = null
        try {
          doFlush()
        } catch (err) {
          console.error('[db] persist failed:', err)
        }
      }, 400)
    },
    flush: () => {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      doFlush()
    }
  }

  return { db: new SqliteDb(raw, persist), flush: persist.flush, raw }
}
