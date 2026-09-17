import type { PetActivityNotice } from '../../shared/pet'
import type { PetBubble, PetMode, PetViewState } from './contracts'

export function initialPetState(): PetViewState {
  return {
    activity: { revision: -1, activeIds: [] },
    pendingIntakes: 0,
    alertUntil: 0,
    alertSequence: 0,
    bubbles: []
  }
}

export function selectMode(s: PetViewState, now: number): PetMode {
  if (s.alertUntil > now) return 'alert'
  return s.pendingIntakes > 0 || s.activity.activeIds.length > 0 ? 'busy' : 'idle'
}

export function applyActivity(s: PetViewState, n: PetActivityNotice): PetViewState {
  if (n.revision <= s.activity.revision) return s
  return {
    ...s,
    activity: {
      revision: n.revision,
      activeIds: [...new Set(n.activeIds)]
    }
  }
}

export function addBubble(s: PetViewState, text: string, now: number, ttl = 5000): PetViewState {
  const trimmed = text.trim().slice(0, 500)
  if (!trimmed) return s
  const lastId = s.bubbles.length > 0 ? s.bubbles[s.bubbles.length - 1].id : 0
  const bubble: PetBubble = {
    id: lastId + 1,
    text: trimmed,
    expiresAt: now + ttl
  }
  const nextBubbles = [...s.bubbles, bubble].slice(-3)
  return {
    ...s,
    bubbles: nextBubbles
  }
}

export function setAlert(s: PetViewState, now: number, ttl: number): PetViewState {
  return {
    ...s,
    alertSequence: s.alertSequence + 1,
    alertUntil: Math.max(s.alertUntil, now + ttl)
  }
}

export function expire(s: PetViewState, now: number): PetViewState {
  const unexpiredBubbles = s.bubbles.filter((b) => b.expiresAt > now)
  const alertUntil = s.alertUntil <= now ? 0 : s.alertUntil
  if (unexpiredBubbles.length === s.bubbles.length && alertUntil === s.alertUntil) {
    return s
  }
  return {
    ...s,
    alertUntil,
    bubbles: unexpiredBubbles
  }
}
