import React from 'react'
import type { PetBubble } from './contracts'

export function PetBubbles({ items }: { items: PetBubble[] }): JSX.Element {
  return (
    <div className="pet-bubbles-container" aria-live="polite">
      {items.map((b) => (
        <div key={b.id} className="pet-bubble-item" title={b.text}>
          {b.text}
        </div>
      ))}
    </div>
  )
}
