// 仿真:用真实 userData 数据库副本走一遍初始化迁移
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/main/db/connection'
import { initSchema } from '../src/main/db/dao'

async function main(): Promise<void> {
  const src = 'C:/Users/Administrator/AppData/Roaming/事务助手/data.sqlite'
  const dir = mkdtempSync(join(tmpdir(), 'mig-sim-'))
  const dst = join(dir, 'data.sqlite')
  copyFileSync(src, dst)
  const { db, flush } = await openDatabase(dst, join(process.cwd(), 'node_modules', 'sql.js', 'dist'))
  initSchema(db)
  const ver = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")
  const counts = {
    todos: db.all('SELECT * FROM todos').length,
    events: db.all('SELECT * FROM events').length,
    providers: db.all('SELECT * FROM providers').length,
    mail_accounts: db.all('SELECT * FROM mail_accounts').length
  }
  const cols = db.all<{ name: string }>('PRAGMA table_info(providers)').map((c) => c.name)
  flush()
  console.log('迁移成功 version=', ver?.value)
  console.log('数据:', JSON.stringify(counts))
  console.log('providers 含 supports_json_mode:', cols.includes('supports_json_mode'))
}
main().catch((err) => {
  console.error('迁移失败:', err)
  process.exit(1)
})
