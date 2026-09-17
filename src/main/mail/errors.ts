import type { MailErrorCode } from '../../shared/mail'

/** 邮箱功能的有限错误类型:code 面向程序分类,message 面向用户展示 */
export class MailError extends Error {
  readonly code: MailErrorCode

  constructor(code: MailErrorCode, message: string) {
    super(message)
    this.name = 'MailError'
    this.code = code
  }
}

export function isMailError(err: unknown): err is MailError {
  return err instanceof MailError
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EACCES',
  'ECONNABORTED'
])

const AUTH_PATTERN =
  /authenticat|authorization|login|log in|password|credential|invalid user|no such user|access denied/i
const TLS_PATTERN =
  /certificate|self[- ]signed|tls|ssl|handshake|cert_|err_tls|unable_to_verify|expired|hostname\/ip/i
const NETWORK_PATTERN =
  /timeout|timed out|econn|socket|network|enotfound|eai_again|hang ?up|offline|connection (closed|lost|error)|not connected|reset/i

/**
 * 把任意抛出的错误归类为 MailError。
 * 认证失败 → AUTH;证书/TLS 问题 → TLS;网络错误与超时 → NETWORK;
 * 其余未知错误按可重试的 NETWORK 处理。已知的 MailError 原样返回。
 */
export function classifyError(err: unknown): MailError {
  if (isMailError(err)) return err
  const raw = err as { code?: string | number; message?: string } | null | undefined
  const message =
    typeof raw?.message === 'string' && raw.message.length > 0 ? raw.message : String(err ?? '未知邮箱错误')
  const sysCode = typeof raw?.code === 'string' ? raw.code : String(raw?.code ?? '')

  if (sysCode) {
    if (sysCode.startsWith('ERR_TLS') || sysCode.startsWith('CERT') || sysCode === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
      return new MailError('TLS', message)
    }
    if (NETWORK_CODES.has(sysCode)) return new MailError('NETWORK', message)
  }
  if (AUTH_PATTERN.test(message)) return new MailError('AUTH', message)
  if (TLS_PATTERN.test(message)) return new MailError('TLS', message)
  return new MailError('NETWORK', message)
}
