// 主题启动:渲染前先启动控制器;IPC 超时/拒绝时回退系统外观并非阻断提示
import type { AppearanceSnapshot } from '../../../shared/appearance'
import { createAppearanceController, type AppearanceClientPort } from './controller'

const FALLBACK_TIMEOUT_MS = 3000

/** 把最终生效主题写到根元素:data-theme 是 palettes.css 的唯一开关 */
export function applyAppearance(root: HTMLElement, snapshot: AppearanceSnapshot): void {
  root.dataset.theme = snapshot.resolved
  root.style.colorScheme = snapshot.resolved
  root.dataset.themeReady = 'true'
}

function systemFallbackSnapshot(): AppearanceSnapshot {
  const dark = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
  // revision 取 -1:任何来自主进程的真实快照都允许覆盖回退值
  return { revision: -1, mode: 'system', resolved: dark ? 'dark' : 'light' }
}

function showFallbackNotice(root: HTMLElement, message: string): void {
  if (root.querySelector('.theme-fallback-notice')) return
  const notice = root.ownerDocument.createElement('div')
  notice.className = 'theme-fallback-notice'
  notice.setAttribute('role', 'status')
  notice.textContent = message
  notice.addEventListener('click', () => notice.remove())
  root.ownerDocument.body.appendChild(notice)
}

/**
 * 在 createRoot/render 之前调用。返回清理函数。
 * - 正常:本地 IPC 迅速返回快照,期间内容暂不可见但窗口背景与默认色板一致
 * - 异常:3 秒超时或 IPC 拒绝后按系统外观回退并显示可关闭提示,不会永久白屏
 * - 回退后真实快照到达仍可覆盖;dispose 后不再触碰 DOM
 */
export function bootstrapAppearance(
  api: AppearanceClientPort,
  root: HTMLElement,
  unavailable: () => void
): () => void {
  let cleaned = false
  root.dataset.themeBoot = 'pending'

  const finish = (snapshot: AppearanceSnapshot): void => {
    delete root.dataset.themeBoot
    applyAppearance(root, snapshot)
  }

  const fallback = (message: string): void => {
    if (cleaned) return
    finish(systemFallbackSnapshot())
    showFallbackNotice(root, message)
    unavailable()
  }

  const timer = setTimeout(() => {
    fallback('外观服务响应超时,已按系统外观显示')
  }, FALLBACK_TIMEOUT_MS)

  const controller = createAppearanceController({
    api,
    apply: (snapshot) => {
      clearTimeout(timer)
      finish(snapshot)
    },
    unavailable: () => {
      clearTimeout(timer)
      fallback('外观服务暂不可用,已按系统外观显示')
    }
  })
  void controller.start()

  return () => {
    cleaned = true
    clearTimeout(timer)
    controller.dispose()
  }
}
