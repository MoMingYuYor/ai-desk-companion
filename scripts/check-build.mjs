// 检查 out/ 构建产物是否比 src/ 源码新:过期或缺失返回退出码 1,最新返回 0
// 供启动脚本决定是否需要重新构建,避免每次启动都全量构建
import { existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const entry = join(root, 'out', 'main', 'index.js')
const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

if (!existsSync(entry) || !existsSync(electronExe)) process.exit(1)

const builtAt = statSync(entry).mtimeMs

function newestMtimeMs(dir) {
  let newest = 0
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name)
    const m = name.isDirectory() ? newestMtimeMs(p) : statSync(p).mtimeMs
    if (m > newest) newest = m
  }
  return newest
}

const srcNewest = Math.max(newestMtimeMs(join(root, 'src')), newestMtimeMs(join(root, 'resources')))
process.exit(srcNewest > builtAt ? 1 : 0)
