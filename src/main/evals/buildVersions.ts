import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EvalFreezeVersions } from '../../shared/evals'

/** 版本来源固定到已提交工程代码；打包使用随包构建信息，禁止用应用版本号代替提交。 */
export function currentEvalVersions(sourceRoot: string, packagedResources?: string): EvalFreezeVersions {
  let codeCommit: string
  if (packagedResources) {
    const info = JSON.parse(readFileSync(join(packagedResources, 'build-info.json'), 'utf8')) as { gitCommit?: unknown; gitDirty?: unknown }
    if (info.gitDirty !== false || typeof info.gitCommit !== 'string') throw new Error('正式评测冻结要求干净构建信息')
    codeCommit = info.gitCommit
  } else {
    const codeStatus = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts', 'evals', 'fixtures', 'package.json', 'package-lock.json', 'electron.vite.config.ts'], { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).trim()
    if (codeStatus) throw new Error('正式评测冻结前请提交当前工程代码和数据，避免代码版本漂移')
    codeCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).trim()
  }
  return { codeCommit, toolsVersion: 'ops-tools-v1', rubricVersion: 'rubric-v1' }
}
