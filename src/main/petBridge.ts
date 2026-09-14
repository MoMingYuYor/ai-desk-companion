// 桌宠轻提示桥:主进程任何位置可调用,向桌宠窗口推送气泡文本
import { getPetWindow } from './windows'

export function markPetBubble(text: string): void {
  const pet = getPetWindow()
  if (pet && !pet.isDestroyed()) {
    pet.webContents.send('evt:pet-bubble', { text })
  }
}

export function markPetState(state: 'idle' | 'busy' | 'alert'): void {
  const pet = getPetWindow()
  if (pet && !pet.isDestroyed()) {
    pet.webContents.send('evt:pet-state', { state })
  }
}
