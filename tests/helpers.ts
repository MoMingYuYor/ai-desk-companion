import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openDatabase, type SqliteDb } from '../src/main/db/connection'
import { initSchema } from '../src/main/db/dao'

export async function makeTestDb(): Promise<SqliteDb> {
  const dir = mkdtempSync(join(tmpdir(), 'aide-test-'))
  const { db } = await openDatabase(join(dir, 'test.sqlite'), join(process.cwd(), 'node_modules', 'sql.js', 'dist'))
  initSchema(db)
  return db
}
