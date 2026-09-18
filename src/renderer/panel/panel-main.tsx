import { createRoot } from 'react-dom/client'
import PanelApp from './panel'
import '../shared/ui.css'
import './panel.css'
import { bootstrapAppearance } from '../shared/theme/bootstrap'

// 面板只读主题:跟随工作台偏好,本地修改会被主进程拒绝
bootstrapAppearance(window.api.appearance, document.documentElement, () => {
  console.warn('[panel] 外观服务不可用,已回退为系统外观')
})

createRoot(document.getElementById('root')!).render(<PanelApp />)
