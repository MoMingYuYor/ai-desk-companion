export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export interface AppearanceSnapshot {
  revision: number
  mode: ThemeMode
  resolved: ResolvedTheme
}

export type AppearanceResult =
  | { ok: true; value: AppearanceSnapshot }
  | { ok: false; code: 'INVALID_MODE' | 'STORAGE' | 'UNAVAILABLE'; message: string }

export interface AppearanceApi {
  get(): Promise<AppearanceSnapshot>
  set(mode: ThemeMode): Promise<AppearanceResult>
}

export const AppearanceChannels = {
  get: 'appearance:get',
  set: 'appearance:set',
  changed: 'evt:appearance-changed'
} as const

export function parseThemeMode(value: unknown): ThemeMode | null {
  return value === 'light' || value === 'dark' || value === 'system' ? value : null
}
