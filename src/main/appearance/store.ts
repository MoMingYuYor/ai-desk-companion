import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { parseThemeMode, type ThemeMode } from '../../shared/appearance'

const SCHEMA_VERSION = 1

export interface AppearanceStore {
  read(): ThemeMode | null
  write(mode: ThemeMode): Promise<void>
}

export function createAppearanceStore(filePath: string, warn: (message: string) => void): AppearanceStore {
  const unreadable = () => `外观偏好文件 ${basename(filePath)} 无法读取或内容无效，已改用默认外观，原文件保留。`

  function read(): ThemeMode | null {
    if (!existsSync(filePath)) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch {
      warn(unreadable())
      return null
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warn(unreadable())
      return null
    }
    const { version, mode } = parsed as { version?: unknown; mode?: unknown }
    const validMode = version === SCHEMA_VERSION ? parseThemeMode(mode) : null
    if (validMode === null) {
      warn(unreadable())
      return null
    }
    return validMode
  }

  async function write(mode: ThemeMode): Promise<void> {
    if (parseThemeMode(mode) === null) {
      throw new Error(`拒绝保存未知外观偏好值: ${String(mode)}`)
    }
    const tmpPath = join(dirname(filePath), `.appearance-${randomBytes(6).toString('hex')}.tmp`)
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(tmpPath, JSON.stringify({ version: SCHEMA_VERSION, mode }))
      renameSync(tmpPath, filePath)
    } finally {
      if (existsSync(tmpPath)) rmSync(tmpPath, { force: true })
    }
  }

  return { read, write }
}
