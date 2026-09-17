// 桌宠活动注册器:追踪正在运行的 AI 任务,驱动桌宠忙碌/完成/失败状态
import type { PetActivityChange, PetActivityNotice, PetActivitySnapshot } from '../../shared/pet'

export interface PetActivityRegistry {
  apply(change: PetActivityChange): void
  snapshot(): PetActivitySnapshot
}

export function createPetActivityRegistry(emit: (n: PetActivityNotice) => void): PetActivityRegistry {
  let revision = 0
  const activeIds = new Set<string>()

  return {
    apply(change: PetActivityChange): void {
      if (change.phase === 'start') {
        if (activeIds.has(change.taskId)) return
        activeIds.add(change.taskId)
        revision++
        emit({ revision, activeIds: Array.from(activeIds) })
      } else if (change.phase === 'finish') {
        if (!activeIds.has(change.taskId)) return
        activeIds.delete(change.taskId)
        revision++
        emit({
          revision,
          activeIds: Array.from(activeIds),
          finished: { taskId: change.taskId, outcome: change.outcome }
        })
      }
    },
    snapshot(): PetActivitySnapshot {
      return { revision, activeIds: Array.from(activeIds) }
    }
  }
}
