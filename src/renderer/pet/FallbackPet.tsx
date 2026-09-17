import React from 'react'
import type { PetMode } from './contracts'

export function FallbackPet({ mode }: { mode: PetMode }): JSX.Element {
  const eyeShift = mode === 'busy' ? 2 : 0
  return (
    <svg
      role="img"
      aria-label="备用桌宠"
      width={130}
      height={130}
      viewBox="0 0 120 120"
      style={{ filter: 'drop-shadow(0 6px 16px rgba(0,0,0,.35))', overflow: 'visible' }}
    >
      <circle cx={35} cy={30} r={14} fill="#e59866" />
      <circle cx={35} cy={30} r={8} fill="#f8c471" />
      <circle cx={85} cy={30} r={14} fill="#e59866" />
      <circle cx={85} cy={30} r={8} fill="#f8c471" />
      <rect x={20} y={26} width={80} height={72} rx={36} fill="#f0b27a" />
      <ellipse cx={60} cy={66} rx={22} ry={16} fill="#fdebd0" />
      <ellipse cx={60} cy={61} rx={6} ry={4} fill="#5d4037" />
      <circle cx={44 + eyeShift} cy={52} r={4.5} fill="#2c3e50" />
      <circle cx={45.5 + eyeShift} cy={50.5} r={1.5} fill="#fff" />
      <circle cx={76 + eyeShift} cy={52} r={4.5} fill="#2c3e50" />
      <circle cx={77.5 + eyeShift} cy={50.5} r={1.5} fill="#fff" />
      <ellipse cx={34} cy={62} rx={5} ry={3} fill="#f1948a" opacity={0.7} />
      <ellipse cx={86} cy={62} rx={5} ry={3} fill="#f1948a" opacity={0.7} />
      {mode === 'busy' && (
        <circle cx={60} cy={71} r={3} fill="none" stroke="#5d4037" strokeWidth={1.5} />
      )}
      {mode === 'alert' && (
        <path d="M 54 70 Q 60 75 66 70" fill="none" stroke="#c0392b" strokeWidth={2} strokeLinecap="round" />
      )}
      {mode === 'idle' && (
        <path d="M 55 69 Q 60 73 65 69" fill="none" stroke="#5d4037" strokeWidth={1.5} strokeLinecap="round" />
      )}
    </svg>
  )
}
