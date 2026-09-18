import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import '../shared/ui.css'
import { bootstrapAppearance } from '../shared/theme/bootstrap'

// 渲染前启动主题控制器:失败时按系统外观回退,不会永久白屏
bootstrapAppearance(window.api.appearance, document.documentElement, () => {
  console.warn('[workbench] 外观服务不可用,已回退为系统外观')
})

/** 全局错误兜底:渲染层任何未捕获异常都不允许白屏,必须留下可见错误信息 */
class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[workbench] 渲染异常:', error, info.componentStack)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'monospace', color: 'var(--ui-error-text)', whiteSpace: 'pre-wrap' }}>
          <h2 style={{ marginTop: 0 }}>页面出现异常(已拦截,不会丢失数据)</h2>
          <div>{this.state.error.message}</div>
          <button type="button" style={{ marginTop: 12 }} onClick={() => this.setState({ error: null })}>
            重试恢复
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

window.addEventListener('error', (e) => {
  console.error('[workbench] 全局错误:', e.message)
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[workbench] 未处理的异步错误:', String(e.reason))
})

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>
)
