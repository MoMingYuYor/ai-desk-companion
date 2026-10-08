// DEL-01 包身份共享逻辑(scripts/lib/build-identity.mjs):
//
// 供 verify-package-identity.mjs 与后续验收工具复用:
// - hashTreeDir:确定性树 hash,与 scripts/write-build-info.mjs 定义逐字一致
//   (递归收集文件 → POSIX 相对路径排序 → "<path>\n<fileSha256>\n" 串接 → SHA-256),
//   任何内容或路径集合变化都会改变树 hash,与平台文件系统顺序无关;
// - collectTreeDiffs:两棵目录树逐文件对比,输出缺失/多出/内容差异清单;
// - walkAsarFiles:遍历 app.asar 头部文件树,返回 POSIX 相对路径清单(含 unpacked 标记);
// - asarReadFile:按 @electron/asar 的 Windows 路径语义(getFile 按 path.sep 切分)
//   读取 asar 内文件字节;unpacked 节点从 app.asar.unpacked 落盘路径读取。
//
// 只读:本模块不做任何写操作,不修改被检查的目录与 asar。

import { createHash } from 'node:crypto'
import { extractFile, getRawHeader } from '@electron/asar'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'

/** 字节级 SHA-256(hex) */
export function sha256Buffer(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** 递归收集目录下全部文件的相对路径(POSIX 风格 / 分隔),排序后返回 */
export function listFilesRelative(dir) {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const p = join(current, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) out.push(p.slice(dir.length + 1).split(sep).join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

/**
 * 目录树 hash manifest(与 write-build-info.mjs 契约一致):
 * { fileCount, treeSha256, files: { <posixRel>: <sha256> } }
 */
export function hashTreeDir(dir) {
  if (!existsSync(dir)) return null
  const files = {}
  for (const rel of listFilesRelative(dir)) {
    files[rel] = sha256Buffer(readFileSync(join(dir, rel)))
  }
  const treeInput = Object.entries(files)
    .map(([path, hash]) => `${path}\n${hash}\n`)
    .join('')
  return {
    fileCount: Object.keys(files).length,
    treeSha256: sha256Buffer(Buffer.from(treeInput, 'utf-8')),
    files
  }
}

/**
 * 两棵目录树逐文件对比(POSIX 相对路径为准):
 * kind ∈ missing_in_packaged(源有包无)/ missing_in_source(包多出)/ content_mismatch
 */
export function collectTreeDiffs(sourceAbs, packagedAbs) {
  const source = hashTreeDir(sourceAbs)
  const packaged = hashTreeDir(packagedAbs)
  const diffs = []
  if (source === null) {
    diffs.push({ kind: 'missing_in_source', tree: sourceAbs, detail: '源目录不存在' })
    return diffs
  }
  if (packaged === null) {
    diffs.push({ kind: 'missing_in_packaged', tree: packagedAbs, detail: '包目录不存在' })
    return diffs
  }
  const allPaths = [...new Set([...Object.keys(source.files), ...Object.keys(packaged.files)])].sort()
  for (const rel of allPaths) {
    const s = source.files[rel]
    const p = packaged.files[rel]
    if (s !== undefined && p === undefined) diffs.push({ kind: 'missing_in_packaged', path: rel })
    else if (s === undefined && p !== undefined) diffs.push({ kind: 'missing_in_source', path: rel })
    else if (s !== p) diffs.push({ kind: 'content_mismatch', path: rel, sourceSha256: s, packagedSha256: p })
  }
  return diffs
}

/** 遍历 asar 头部文件树,返回 [{ rel, size, unpacked }](rel 为无前导分隔符的 POSIX 路径) */
export function walkAsarFiles(archivePath) {
  const raw = getRawHeader(archivePath)
  const out = []
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const rel = prefix === '' ? name : `${prefix}/${name}`
      if ('files' in child) walk(child, rel)
      else out.push({ rel, size: child.size ?? null, unpacked: child.unpacked === true })
    }
  }
  walk(raw.header, '')
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/**
 * 读取 asar 内文件字节。@electron/asar 在 Windows 上按 path.sep(反斜杠)切分
 * 查询路径,故将 POSIX 相对路径经 path.join 归一化为平台分隔符;
 * unpacked 节点的实际字节在 app.asar.unpacked 落盘路径,直接读磁盘。
 * unpacked 标记由调用方从 walkAsarFiles 的清单传入,避免逐文件重遍历文件树。
 */
export function asarReadFile(archivePath, posixRel, unpacked = false) {
  if (unpacked) {
    const unpackedRoot = join(archivePath, '..', 'app.asar.unpacked')
    return readFileSync(join(unpackedRoot, ...posixRel.split('/')))
  }
  return Buffer.from(extractFile(archivePath, join(...posixRel.split('/'))))
}
