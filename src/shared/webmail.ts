// 邮箱地址 → 网页版邮箱 URL:发件走浏览器时使用
const WEBMAIL_MAP: Record<string, string> = {
  'qq.com': 'https://mail.qq.com',
  'foxmail.com': 'https://mail.qq.com',
  '163.com': 'https://mail.163.com',
  '126.com': 'https://mail.126.com',
  'gmail.com': 'https://mail.google.com',
  'outlook.com': 'https://outlook.live.com',
  'hotmail.com': 'https://outlook.live.com',
  'live.com': 'https://outlook.live.com'
}

export function webmailUrlFor(email: string): string | null {
  const [local, domain] = email.trim().toLowerCase().split('@')
  if (!local || !domain || !domain.includes('.')) return null
  return WEBMAIL_MAP[domain] ?? `https://mail.${domain}`
}
