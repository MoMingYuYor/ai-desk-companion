// 新安装的 Electron 完成解压且可执行后再进入构建/进程测试，不重跑应用断言。
import { spawnSync, execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageDir = join(root, 'node_modules/electron')
const version = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const installedPath = join(packageDir, 'path.txt')
if (!existsSync(installedPath) || !existsSync(join(packageDir, 'dist', readFileSync(installedPath, 'utf8').trim()))) {
  // npm 的脚本策略可能跳过 postinstall；显式运行项目锁定包的官方安装器。
  console.log('[check-runtime] 缺少本地 Electron，执行锁定版本官方安装器（优先缓存）')
  execFileSync(process.execPath, [join(packageDir, 'install.js')], { cwd: root, env, timeout: 90000, stdio: 'inherit', windowsHide: true })
}
const deadline = Date.now() + 45000
let last = 'Electron 安装尚未完成'
for (;;) {
  const pathFile = join(packageDir, 'path.txt')
  if (existsSync(pathFile)) {
    const binary = join(packageDir, 'dist', readFileSync(pathFile, 'utf8').trim())
    if (existsSync(binary)) {
      const result = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000, env })
      if (result.status === 0 && result.stdout.trim() === `v${version}`) {
        console.log(`[check-runtime] Electron ${version} 可执行，耗时上限 45s`)
        break
      }
      last = result.error?.code ?? `退出=${result.status}，版本输出不匹配`
      if (result.error && !['ENOENT', 'EBUSY'].includes(result.error.code)) throw result.error
    }
  }
  if (Date.now() >= deadline) throw new Error(`Electron runtime readiness 超时：${last}。检查本地安装后再运行，未进入测试。`)
  await new Promise(done => setTimeout(done, 250))
}
