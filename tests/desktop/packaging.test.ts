// 打包配置守卫:防止 sql.js WASM / pdfjs 中文资源漏打包与 NSIS 策略回归(P0 修复的回归测试)
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface ExtraResource {
  from: string
  to: string
}

interface PackageJson {
  build: {
    asarUnpack?: string[]
    extraResources: Array<string | ExtraResource>
    nsis: {
      perMachine?: boolean
      deleteAppDataOnUninstall?: boolean
    }
  }
  dependencies: Record<string, string>
}

const pkg = JSON.parse(
  readFileSync(resolve(fileURLToPath(import.meta.url), '../../../package.json'), 'utf-8')
) as PackageJson

/** 按 to 字段找显式映射项(extraResources 的对象形式) */
const extraTo = (to: string): ExtraResource | undefined =>
  pkg.build.extraResources.filter((r): r is ExtraResource => typeof r === 'object').find((r) => r.to === to)

describe('打包配置(electron-builder)', () => {
  it('sql.js 的 WASM 随 asarUnpack 解包,打包态可从 app.asar.unpacked 读取', () => {
    expect(pkg.build.asarUnpack ?? []).toContain('node_modules/sql.js/dist/**')
  })

  it('extraResources 显式分发 pdfjs 中文 cmaps 与标准字体(落盘不带 node_modules 前缀)', () => {
    expect(extraTo('resources')?.from).toBe('resources')
    expect(extraTo('cmaps')?.from).toBe('node_modules/pdfjs-dist/cmaps')
    expect(extraTo('standard_fonts')?.from).toBe('node_modules/pdfjs-dist/standard_fonts')
  })

  it('NSIS 按用户级(perMachine=false)安装且卸载保留用户数据', () => {
    expect(pkg.build.nsis.perMachine).toBe(false)
    expect(pkg.build.nsis.deleteAppDataOnUninstall).toBe(false)
  })

  it('react/react-dom 不在 dependencies(renderer 由 vite 打包,主进程不引用)', () => {
    expect(pkg.dependencies).not.toHaveProperty('react')
    expect(pkg.dependencies).not.toHaveProperty('react-dom')
  })
})
