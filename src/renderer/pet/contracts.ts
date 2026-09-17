import type { RendererApi } from '../../shared/api'
import type { PetActivitySnapshot } from '../../shared/pet'

export type PetPort = Pick<
  RendererApi,
  'getDayAgenda' | 'addMaterials' | 'pathForFile' | 'petDragStart' | 'petDragEnd' | 'petOpenMenu' | 'on'
> & {
  getPetActivitySnapshot(): Promise<PetActivitySnapshot>
}

export interface PetClock {
  now(): number
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(id: number): void
}

export type PetMode = 'idle' | 'busy' | 'alert'

export interface PetBubble {
  id: number
  text: string
  expiresAt: number
}

export interface PetViewState {
  activity: PetActivitySnapshot
  pendingIntakes: number
  alertUntil: number
  alertSequence: number
  bubbles: PetBubble[]
}

export interface Point {
  x: number
  y: number
}
