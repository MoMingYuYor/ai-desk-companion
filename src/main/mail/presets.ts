import type { MailAccountInput, MailProvider } from '../../shared/mail'
import { MailError } from './errors'

export interface MailPreset {
  host: string
  port: number
}

/** 三家服务商的 IMAP 预设,统一 TLS 993 端口 */
export const MAIL_PRESETS: Record<Exclude<MailProvider, 'custom'>, MailPreset> = {
  qq: { host: 'imap.qq.com', port: 993 },
  '163': { host: 'imap.163.com', port: 993 },
  gmail: { host: 'imap.gmail.com', port: 993 }
}

const PROVIDERS: readonly MailProvider[] = ['qq', '163', 'gmail', 'custom']

/**
 * 解析服务商预设:已知服务商缺省时使用预设 host/port,显式传入时允许覆盖;
 * custom 必须显式提供 host。
 */
export function resolvePreset(
  provider: MailProvider,
  host?: string,
  port?: number
): MailPreset {
  if (!PROVIDERS.includes(provider)) {
    throw new MailError('INVALID_CONFIG', `不支持的服务商类型: ${String(provider)}`)
  }
  if (provider === 'custom') {
    if (!host || host.trim() === '') {
      throw new MailError('INVALID_CONFIG', '自定义服务商必须填写服务器地址')
    }
    return { host: host.trim(), port: port ?? 993 }
  }
  const preset = MAIL_PRESETS[provider]
  return {
    host: host && host.trim() !== '' ? host.trim() : preset.host,
    port: typeof port === 'number' && Number.isFinite(port) ? port : preset.port
  }
}

function invalid(message: string): never {
  throw new MailError('INVALID_CONFIG', message)
}

/** 域名部分归一化为小写,本地部分保持原样 */
function normalizeEmail(email: string): string {
  const trimmed = email.trim()
  const at = trimmed.lastIndexOf('@')
  if (at <= 0 || at === trimmed.length - 1) invalid('邮箱地址格式不正确')
  const local = trimmed.slice(0, at)
  const domain = trimmed.slice(at + 1).toLowerCase()
  return `${local}@${domain}`
}

/** 校验并归一化账号输入;不通过时抛 INVALID_CONFIG,凭据内容不进入任何错误信息 */
export function validateAccountInput(input: MailAccountInput): MailAccountInput {
  if (!input || typeof input !== 'object') invalid('账号输入不能为空')

  const label = typeof input.label === 'string' ? input.label.trim() : ''
  if (label.length < 1 || label.length > 80) invalid('显示名需要为 1-80 个字符')

  if (typeof input.email !== 'string' || input.email.trim() === '') invalid('邮箱地址不能为空')
  const email = normalizeEmail(input.email)
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailPattern.test(email)) invalid('邮箱地址格式不正确')

  if (!PROVIDERS.includes(input.provider)) invalid(`不支持的服务商类型: ${String(input.provider)}`)

  const { host, port } = resolvePreset(input.provider, input.host, input.port)
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) {
    invalid('服务器地址长度不合法')
  }
  // host 必须是裸主机名:拒绝 URL 协议、路径、凭据信息和空白
  if (/[/:@\\\s]/.test(host) || /^[a-z][a-z0-9+.-]*:/i.test(host)) {
    invalid('服务器地址只能是主机名,不能包含协议、路径或凭据')
  }
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host)) {
    invalid('服务器地址格式不正确')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid('端口必须是 1-65535 的整数')

  if (input.credential != null && typeof input.credential !== 'string') {
    invalid('凭据格式不正确')
  }

  return {
    id: input.id,
    label,
    email,
    provider: input.provider,
    host,
    port,
    credential: input.credential
  }
}
