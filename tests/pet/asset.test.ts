import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'

it('桌宠素材存在且 hash 一致', () => {
  const p = resolve(__dirname, '../../src/renderer/pet/assets/chibi-seated-v1.png')
  expect(existsSync(p)).toBe(true)
  const buf = readFileSync(p)
  expect(buf.length).toBe(1051731)
  const hash = createHash('sha256').update(buf).digest('hex')
  expect(hash).toBe('00e0a0decbb5bc8ffbe252260c5aa47599b674a03ea6ac638314cfe5b644aae8')
})
