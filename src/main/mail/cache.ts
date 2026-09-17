import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import type { MailErrorCode } from '../../shared/mail'

/**
 * 携带 MailErrorCode 的业务错误，供上层 IPC 统一映射为 MailResult。
 * B 区不得修改 A 区的 errors.ts，因此在本文件内定义最小实现。
 */
export class MailCodedError extends Error {
  readonly code: MailErrorCode

  constructor(code: MailErrorCode, message: string) {
    super(message)
    this.name = 'MailCodedError'
    this.code = code
  }
}

export function isMailCodedError(err: unknown): err is MailCodedError {
  return err instanceof MailCodedError
}

export function cancelledError(): MailCodedError {
  return new MailCodedError('CANCELLED', '操作已取消')
}

/**
 * 把解码后的字节按指定字符集转为文本；未知字符集回退 UTF-8。
 */
export function decodeBytes(bytes: Buffer, charset?: string): string {
  if (!charset) return new TextDecoder('utf-8').decode(bytes)
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/**
 * 有限流读取：累计实际字节数，超过 max 立即销毁流并抛 LIMIT（服务器谎报大小也按实际字节拒绝）；
 * signal 中止时销毁流并抛 CANCELLED。无论成败都移除 abort 监听。
 */
export function readLimited(stream: Readable, max: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise<Buffer>((resolvePromise, rejectPromise) => {
    if (signal.aborted) {
      stream.destroy()
      rejectPromise(cancelledError())
      return
    }
    const chunks: Buffer[] = []
    let total = 0
    let settled = false

    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
      stream.off('data', onData)
      stream.off('end', onEnd)
      stream.off('error', onError)
    }
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const onAbort = (): void => {
      stream.destroy()
      settle(() => rejectPromise(cancelledError()))
    }
    const onData = (chunk: Buffer): void => {
      total += chunk.length
      if (total > max) {
        stream.destroy()
        settle(() => rejectPromise(new MailCodedError('LIMIT', `下载内容超过大小限制（上限 ${max} 字节）`)))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => {
      settle(() => resolvePromise(Buffer.concat(chunks)))
    }
    const onError = (err: Error): void => {
      settle(() => rejectPromise(err))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    stream.on('data', onData)
    stream.on('end', onEnd)
    stream.on('error', onError)
  })
}

/**
 * 邮件本地缓存：路径全部由 sha1 哈希派生，杜绝路径穿越；
 * 写入先落 .tmp 再 rename，保证原子性；读取不存在时返回 null（离线可判定）。
 */
export class MailCacheService {
  private readonly baseDir: string

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir)
  }

  /** 归一化正文缓存路径：<base>/<账号哈希>/<邮件哈希>/body-<哈希>.html */
  bodyPath(accountId: string, messageId: string): string {
    return this.ensureInside(
      join(
        this.baseDir,
        this.hash('account', accountId),
        this.hash('message', messageId),
        `body-${this.hash('body', accountId, messageId)}.html`
      )
    )
  }

  /** 归一化附件缓存路径：<base>/<账号哈希>/<邮件哈希>/att-<part 哈希>.bin */
  attachmentPath(accountId: string, messageId: string, part: string): string {
    return this.ensureInside(
      join(
        this.baseDir,
        this.hash('account', accountId),
        this.hash('message', messageId),
        `att-${this.hash('part', part)}.bin`
      )
    )
  }

  /**
   * 原子写入：数据（Buffer 或流）超过 maxBytes 抛 LIMIT 且不留任何文件；
   * 先写 .tmp 临时文件，成功后 rename 到目标路径；失败清理临时文件。
   */
  async writeAtomic(path: string, data: Buffer | Readable, maxBytes: number): Promise<void> {
    const target = this.ensureInside(path)
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.${Date.now()}-${randomBytes(6).toString('hex')}.tmp`
    try {
      const bytes = Buffer.isBuffer(data)
        ? data
        : await readLimited(data, maxBytes, new AbortController().signal)
      if (bytes.length > maxBytes) {
        throw new MailCodedError('LIMIT', `缓存写入超过大小限制（上限 ${maxBytes} 字节）`)
      }
      await writeFile(tmp, bytes)
      await rename(tmp, target)
    } catch (err) {
      await unlink(tmp).catch(() => {
        // 清理失败不掩盖原始错误
      })
      throw err
    }
  }

  /** 读取缓存文件；不存在返回 null，其他读取错误归为 STORAGE。 */
  async readIfExists(path: string): Promise<Buffer | null> {
    const target = this.ensureInside(path)
    try {
      return await readFile(target)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') return null
      throw new MailCodedError('STORAGE', `读取缓存失败：${String(code ?? err)}`)
    }
  }

  /** 轻量存在性检查（用于校正 downloaded 标志）。 */
  async exists(path: string): Promise<boolean> {
    try {
      await readFile(this.ensureInside(path))
      return true
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') return false
      throw new MailCodedError('STORAGE', `检查缓存失败：${String(code ?? err)}`)
    }
  }

  /** 删除整个账号的缓存子目录；目录不存在视为成功，删除失败归为 STORAGE。 */
  async removeAccount(accountId: string): Promise<void> {
    const dir = this.ensureInside(join(this.baseDir, this.hash('account', accountId)))
    try {
      await rm(dir, { recursive: true, force: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      throw new MailCodedError('STORAGE', `清理账号缓存失败：${String(code ?? err)}`)
    }
  }

  private hash(...parts: string[]): string {
    return createHash('sha1').update(parts.join('\u0000')).digest('hex')
  }

  /** 防御性校验：所有对外路径必须仍位于 baseDir 之下。 */
  private ensureInside(path: string): string {
    const resolved = resolve(path)
    if (resolved !== this.baseDir && !resolved.startsWith(this.baseDir + sep)) {
      throw new MailCodedError('STORAGE', '缓存路径越界，已拒绝访问')
    }
    return resolved
  }
}
