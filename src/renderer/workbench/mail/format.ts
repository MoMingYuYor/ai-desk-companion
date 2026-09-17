// 邮件时间/字节格式化纯函数(无副作用,便于单测)

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

/** 邮件 receivedAt → 列表短格式:同年 "MM-DD HH:mm",跨年 "YYYY-MM-DD";非法输入原样返回 */
export function formatMailTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const now = new Date()
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (d.getFullYear() !== now.getFullYear()) return `${d.getFullYear()}-${md}`
  return `${md} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 详情/账号最近同步时间 → "YYYY-MM-DD HH:mm";空值返回 "—" */
export function formatFullTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 字节数 → 人类可读大小;null/非法值返回 "—" */
export function formatBytes(size: number | null): string {
  if (size == null || !Number.isFinite(size) || size < 0) return '—'
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = size
  let i = -1
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const text = v >= 100 ? String(Math.round(v)) : v.toFixed(1)
  return `${text} ${units[i]}`
}
