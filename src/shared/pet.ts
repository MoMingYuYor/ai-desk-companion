export type PetActivityOutcome = 'done' | 'failed' | 'cancelled'

export type PetActivityChange =
  | { phase: 'start'; taskId: string }
  | { phase: 'finish'; taskId: string; outcome: PetActivityOutcome }

export interface PetActivitySnapshot {
  revision: number
  activeIds: string[]
}

export interface PetActivityNotice extends PetActivitySnapshot {
  finished?: { taskId: string; outcome: PetActivityOutcome }
}

export const PET_LAYOUT = {
  width: 320,
  height: 400,
  characterSize: 200,
  top: 12,
  bubbleHeight: 180,
  bottom: 8,
  bubbleWidth: 288
} as const
