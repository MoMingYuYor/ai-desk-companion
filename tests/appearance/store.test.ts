import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAppearanceStore } from '../../src/main/appearance/store'

let dir: string

function newDir(): string {
  dir = join(tmpdir(), `appearance-store-${Date.now()}-${Math.random()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeStore() {
  const warn = vi.fn()
  return { warn, store: createAppearanceStore(join(dir, 'appearance.json'), warn) }
}

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('AppearanceStore.read', () => {
  it('文件不存在时返回 null 且不告警', () => {
    newDir()
    const { warn, store } = makeStore()
    expect(store.read()).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('合法配置返回白名单内的偏好值', () => {
    writeFileSync(join(newDir(), 'appearance.json'), JSON.stringify({ version: 1, mode: 'dark' }))
    const { warn, store } = makeStore()
    expect(store.read()).toBe('dark')
    expect(warn).not.toHaveBeenCalled()
  })

  it('损坏的 JSON 调用固定文案告警、返回 null 并保留原文件', () => {
    const file = join(newDir(), 'appearance.json')
    writeFileSync(file, '{ not valid json')
    const { warn, store } = makeStore()
    expect(store.read()).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('appearance.json'))
    expect(readFileSync(file, 'utf8')).toBe('{ not valid json')
  })

  it('未知 schema 版本回退 null 并保留原文件', () => {
    const file = join(newDir(), 'appearance.json')
    writeFileSync(file, JSON.stringify({ version: 99, mode: 'dark' }))
    const { warn, store } = makeStore()
    expect(store.read()).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify({ version: 99, mode: 'dark' }))
  })

  it('mode 不在白名单内视为损坏内容', () => {
    const file = join(newDir(), 'appearance.json')
    writeFileSync(file, JSON.stringify({ version: 1, mode: 'night' }))
    const { warn, store } = makeStore()
    expect(store.read()).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify({ version: 1, mode: 'night' }))
  })
})

describe('AppearanceStore.write', () => {
  it('自动建立自身目录并写入最小 JSON', async () => {
    const file = join(tmpdir(), `appearance-store-${Date.now()}-${Math.random()}`, 'nested', 'appearance.json')
    const warn = vi.fn()
    const store = createAppearanceStore(file, warn)
    await store.write('dark')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, mode: 'dark' })
    rmSync(join(file, '..'), { recursive: true, force: true })
  })

  it('写入后读回相同值（模拟重启）', async () => {
    newDir()
    const { store } = makeStore()
    await store.write('light')
    expect(store.read()).toBe('light')
    await store.write('system')
    expect(store.read()).toBe('system')
  })

  it('成功写入后不残留临时文件', async () => {
    newDir()
    const { store } = makeStore()
    await store.write('dark')
    const leftovers = readdirSync(dir).filter((f) => f !== 'appearance.json')
    expect(leftovers).toEqual([])
  })

  it('rename 失败时抛错且只清理自身临时文件', async () => {
    newDir()
    // 目标路径被目录占用，rename 必然失败
    mkdirSync(join(dir, 'appearance.json'))
    const warn = vi.fn()
    const store = createAppearanceStore(join(dir, 'appearance.json'), warn)
    await expect(store.write('dark')).rejects.toThrow()
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('目录建立被既有文件阻断时写入失败且不产生临时文件', async () => {
    newDir()
    // 父路径被文件占用，mkdirSync 必然失败
    writeFileSync(join(dir, 'block'), 'occupied')
    const warn = vi.fn()
    const store = createAppearanceStore(join(dir, 'block', 'appearance.json'), warn)
    await expect(store.write('dark')).rejects.toThrow()
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(readFileSync(join(dir, 'block'), 'utf8')).toBe('occupied')
  })

  it('write 不接受白名单之外的值', async () => {
    newDir()
    const { store } = makeStore()
    await expect(store.write('night' as never)).rejects.toThrow()
    expect(existsSync(join(dir, 'appearance.json'))).toBe(false)
  })
})
