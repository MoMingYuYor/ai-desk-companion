import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { MailError } from './errors'

/**
 * 凭据存储抽象:生产环境由 R 区接 Electron safeStorage 等实现,
 * 测试注入内存替身。本模块在其之上再做一层信封加密。
 */
export interface CredentialStorage {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/** 信封加密的应用侧密钥种子;真实机密性由 storage 层(系统级)提供 */
const SECRET_SEED = 'ai-desk-companion/mail-credentials/v1'
const SALT_BYTES = 16
const IV_BYTES = 12
const KEY_BYTES = 32
const TAG_BYTES = 16
/** salt|iv|tag 的最小合法长度;低于该值的 base64 一律视为旧明文或损坏数据 */
const MIN_PAYLOAD_BYTES = SALT_BYTES + IV_BYTES + TAG_BYTES

function deriveKey(salt: Buffer): Buffer {
  return scryptSync(SECRET_SEED, salt, KEY_BYTES)
}

function cryptoUnavailable(): MailError {
  return new MailError('CRYPTO', '系统加密不可用或凭据为空')
}

/**
 * 加密凭据,输出 base64(salt|iv|cipher) 。
 * 先经 storage 层加密,再用 scrypt 派生密钥做 AES-256-GCM 信封加密;
 * storage 不可用或凭据为空时抛 CRYPTO,绝不回落明文。
 */
export function encryptCredential(value: string, storage: CredentialStorage): string {
  if (!value || !storage.isEncryptionAvailable()) throw cryptoUnavailable()
  try {
    const protectedValue = storage.encryptString(value)
    const salt = randomBytes(SALT_BYTES)
    const iv = randomBytes(IV_BYTES)
    const key = deriveKey(salt)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const sealed = Buffer.concat([cipher.update(protectedValue), cipher.final(), cipher.getAuthTag()])
    return Buffer.concat([salt, iv, sealed]).toString('base64')
  } catch (err) {
    if (err instanceof MailError) throw err
    throw new MailError('CRYPTO', '凭据加密失败')
  }
}

/**
 * 解密 base64(salt|iv|cipher) 格式的凭据。
 * 旧格式明文(无法 base64 解码、长度不足或 GCM 校验失败)一律抛 CRYPTO,不做明文回落。
 */
export function decryptCredential(value: string, storage: CredentialStorage): string {
  if (!value || !storage.isEncryptionAvailable()) throw cryptoUnavailable()
  let raw: Buffer
  try {
    raw = Buffer.from(value, 'base64')
  } catch {
    throw new MailError('CRYPTO', '凭据不是受保护的加密格式')
  }
  // Node 的 base64 解码会忽略非法字符:长度不足即旧明文/损坏数据
  if (raw.length < MIN_PAYLOAD_BYTES) {
    throw new MailError('CRYPTO', '凭据不是受保护的加密格式')
  }
  const salt = raw.subarray(0, SALT_BYTES)
  const iv = raw.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES)
  const sealed = raw.subarray(SALT_BYTES + IV_BYTES)
  const tag = sealed.subarray(sealed.length - TAG_BYTES)
  const body = sealed.subarray(0, sealed.length - TAG_BYTES)

  let protectedValue: Buffer
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(salt), iv)
    decipher.setAuthTag(tag)
    protectedValue = Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new MailError('CRYPTO', '凭据解密失败')
  }
  try {
    return storage.decryptString(protectedValue)
  } catch {
    throw new MailError('CRYPTO', '凭据解密失败')
  }
}
