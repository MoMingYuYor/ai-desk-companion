import React, { useState } from 'react'
import type { PetMode } from './contracts'
import { FallbackPet } from './FallbackPet'
import chibiImage from './assets/chibi-seated-v1.png'

export interface PetCharacterProps {
  mode: PetMode
  pressed: boolean
  dragging: boolean
  releaseKey: number
  alertKey: number
}

export function PetCharacter({
  mode,
  pressed,
  dragging,
  releaseKey,
  alertKey
}: PetCharacterProps): JSX.Element {
  const [failed, setFailed] = useState(false)

  return (
    <div className="pet-motion" data-mode={mode} data-dragging={dragging}>
      <div
        className={`pet-alert-motion ${alertKey > 0 && !dragging ? 'animating' : ''}`}
        key={alertKey}
      >
        <div
          className={`pet-release ${releaseKey > 0 && !dragging ? 'animating' : ''}`}
          key={releaseKey}
        >
          <div className="pet-press" data-pressed={pressed}>
            {failed ? (
              <FallbackPet mode={mode} />
            ) : (
              <img
                src={chibiImage}
                alt="坐姿桌宠"
                draggable={false}
                onError={() => setFailed(true)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
