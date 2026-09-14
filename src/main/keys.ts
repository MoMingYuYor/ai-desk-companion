// API Key 使用系统安全存储(safeStorage);不可用时降级为前缀标记的明文
import { safeStorage } from 'electron'

export function encryptApiKey(plain: string): string {
  if (!plain) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(plain).toString('base64')
    }
  } catch {
    /* fallthrough */
  }
  return 'plain:' + Buffer.from(plain, 'utf-8').toString('base64')
}

export function decryptApiKey(enc: string): string | null {
  if (!enc) return null
  if (enc.startsWith('plain:')) {
    try {
      return Buffer.from(enc.slice(6), 'base64').toString('utf-8')
    } catch {
      return null
    }
  }
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    }
  } catch {
    return null
  }
  return null
}
