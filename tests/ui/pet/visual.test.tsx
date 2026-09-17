// @vitest-environment jsdom
import React from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { PetCharacter } from '../../../src/renderer/pet/PetCharacter'
import { PetBubbles } from '../../../src/renderer/pet/PetBubbles'

afterEach(cleanup)

it('使用不可原生拖动的角色图，错误时回退到备用桌宠', () => {
  render(<PetCharacter mode="idle" pressed={false} dragging={false} releaseKey={0} alertKey={0} />)
  const img = screen.getByAltText('坐姿桌宠') as HTMLImageElement
  expect(img.draggable).toBe(false)
  fireEvent.error(img)
  expect(screen.getByRole('img', { name: '备用桌宠' })).toBeTruthy()
})

it('气泡列表正确显示', () => {
  render(
    <PetBubbles
      items={[
        { id: 1, text: '第一条气泡', expiresAt: 5000 },
        { id: 2, text: '第二条气泡', expiresAt: 6000 }
      ]}
    />
  )
  expect(screen.getByText('第一条气泡')).toBeTruthy()
  expect(screen.getByText('第二条气泡')).toBeTruthy()
})
