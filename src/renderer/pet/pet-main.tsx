import { createRoot } from 'react-dom/client'
import PetApp from './pet'
import '../shared/ui.css'
import './pet.css'
import { bootstrapAppearance } from '../shared/theme/bootstrap'

// 桌宠窗口保持透明;主题只作用于气泡与焦点,不影响角色图
bootstrapAppearance(window.api.appearance, document.documentElement, () => {
  console.warn('[pet] 外观服务不可用,已回退为系统外观')
})

createRoot(document.getElementById('root')!).render(<PetApp />)
