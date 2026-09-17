// @vitest-environment jsdom
import { it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

it('React UI 测试环境正常工作', () => {
  render(<button>邮箱测试</button>)
  expect(screen.getByRole('button', { name: '邮箱测试' })).toBeTruthy()
})
