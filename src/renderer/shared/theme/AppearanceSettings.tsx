// 外观偏好控件:浅色/深色/跟随系统;保存失败保留已确认选项并给出可重试错误
import { useEffect, useRef, useState } from 'react'
import type { AppearanceSnapshot, ThemeMode } from '../../../shared/appearance'
import {
  createAppearanceController,
  type AppearanceClientPort,
  type AppearanceController
} from './controller'

const OPTIONS: Array<{ value: ThemeMode; label: string; hint: string }> = [
  { value: 'light', label: '浅色', hint: '奶油纸面的日间手账' },
  { value: 'dark', label: '深色', hint: '暖炭灰的夜间手账' },
  { value: 'system', label: '跟随系统', hint: '随 Windows 外观自动切换' }
]

const RESOLVED_LABEL: Record<AppearanceSnapshot['resolved'], string> = {
  light: '浅色',
  dark: '深色'
}

export function AppearanceSettings({ api }: { api: AppearanceClientPort }): JSX.Element {
  const [snapshot, setSnapshot] = useState<AppearanceSnapshot | null>(null)
  const [pending, setPending] = useState<ThemeMode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const controllerRef = useRef<AppearanceController | null>(null)

  useEffect(() => {
    const controller = createAppearanceController({
      api,
      apply: (next) => {
        setSnapshot(next)
        setPending(null)
      },
      unavailable: () => setError('外观服务暂不可用,正在按系统外观显示;可稍后重试')
    })
    controllerRef.current = controller
    void controller.start()
    return () => {
      controllerRef.current = null
      controller.dispose()
    }
  }, [api])

  const choose = async (mode: ThemeMode): Promise<void> => {
    const controller = controllerRef.current
    if (!controller || pending !== null) return
    setPending(mode)
    setError(null)
    const result = await controller.set(mode)
    if (!result.ok) {
      // 保存失败:不改当前已确认选项,错误可重试
      setError(result.message)
      setPending(null)
    }
  }

  const checked = pending ?? snapshot?.mode ?? 'system'

  return (
    <div role="radiogroup" aria-label="外观" className="column" style={{ gap: 8 }}>
      {OPTIONS.map((option) => (
        <label key={option.value} className="row" style={{ alignItems: 'flex-start', cursor: 'pointer' }}>
          <input
            type="radio"
            name="appearance-mode"
            value={option.value}
            aria-label={option.label}
            checked={checked === option.value}
            disabled={pending !== null}
            onChange={() => void choose(option.value)}
            style={{ marginTop: 3 }}
          />
          <span className="column" style={{ gap: 2 }} aria-hidden="true">
            <span>
              {option.label}
              {option.value === 'system' && snapshot?.mode === 'system' && (
                <span className="muted">(当前实际:{RESOLVED_LABEL[snapshot.resolved]})</span>
              )}
            </span>
            <span className="muted">{option.hint}</span>
          </span>
        </label>
      ))}
      {pending !== null && <div className="muted">正在保存外观设置…</div>}
      {error && (
        <div role="alert" className="appearance-error">
          {error}
        </div>
      )}
    </div>
  )
}
