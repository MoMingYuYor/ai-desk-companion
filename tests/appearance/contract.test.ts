import { expect, it } from 'vitest'
import { parseThemeMode } from '../../src/shared/appearance'

it('仅接受三个明确偏好值', () => {
  expect(parseThemeMode('dark')).toBe('dark')
  expect(parseThemeMode('system')).toBe('system')
  expect(parseThemeMode('night')).toBeNull()
  expect(parseThemeMode({ mode: 'dark' })).toBeNull()
})
