// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import PetApp from '../../../src/renderer/pet/pet'
import type { PetPort } from '../../../src/renderer/pet/contracts'

afterEach(cleanup)

function makeApi(over: Partial<PetPort> = {}): PetPort & { petSetScale: ReturnType<typeof vi.fn> } {
  const petSetScale = vi.fn(async () => {})
  return {
    on: (() => () => {}) as PetPort['on'],
    getDayAgenda: vi.fn(async () => ({ events: [], courses: [], todos: [] })),
    addMaterials: vi.fn(async () => {}),
    getPetActivitySnapshot: vi.fn(async () => ({ revision: 0, activeIds: [] })),
    pathForFile: () => null,
    petDragStart: vi.fn(async () => {}),
    petDragEnd: vi.fn(async () => {}),
    petOpenMenu: vi.fn(async () => {}),
    petGetScale: vi.fn(async () => 1),
    petSetScale,
    ...over
  } as unknown as PetPort & { petSetScale: ReturnType<typeof vi.fn> }
}

describe('桌宠缩放', () => {
  it('滚轮向上放大并同步主进程持久化', async () => {
    const api = makeApi()
    const { container } = render(<PetApp api={api} />)
    const root = container.querySelector('.pet-root') as HTMLElement
    await waitFor(() => expect(api.petGetScale).toHaveBeenCalled())

    fireEvent.wheel(root, { deltaY: -150 })
    await waitFor(() => expect(api.petSetScale).toHaveBeenCalledWith(1.1))
    expect(root.style.zoom).toBe('1.1')
  })

  it('滚轮向下缩小,达到下限后不再调用', async () => {
    const api = makeApi({ petGetScale: vi.fn(async () => 0.5) })
    const { container } = render(<PetApp api={api} />)
    const root = container.querySelector('.pet-root') as HTMLElement
    await waitFor(() => expect(api.petGetScale).toHaveBeenCalled())

    fireEvent.wheel(root, { deltaY: 150 })
    expect(api.petSetScale).not.toHaveBeenCalled()
    expect(root.style.zoom).toBe('0.5')
  })
})
