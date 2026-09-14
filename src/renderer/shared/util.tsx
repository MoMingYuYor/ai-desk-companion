// 渲染端公共工具:事件订阅与轻提示
import { useEffect, useState } from 'react'

export function useSubscribe(channel: string, handler: (...args: unknown[]) => void): void {
  useEffect(() => {
    const off = window.api.on(channel, handler)
    return off
  }, [channel, handler])
}

export function useToast(): [string | null, (msg: string) => void] {
  const [toast, setToast] = useState<string | null>(null)
  const show = (msg: string): void => {
    setToast(msg)
    setTimeout(() => setToast(null), 2600)
  }
  return [toast, show]
}

export function Toast({ text }: { text: string | null }): JSX.Element | null {
  if (!text) return null
  return <div className="toast">{text}</div>
}

export const COLORS = ['#4f7cff', '#2da44e', '#bf8700', '#e5534b', '#8250df', '#1c6fb8']

export const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
