import {
  parseThemeMode,
  type AppearanceResult,
  type AppearanceSnapshot,
  type ResolvedTheme,
  type ThemeMode
} from '../../shared/appearance'

export interface AppearanceStore {
  read(): ThemeMode | null
  write(mode: ThemeMode): Promise<void>
}

export interface NativeThemePort {
  themeSource: ThemeMode
  readonly shouldUseDarkColors: boolean
  onUpdated(listener: () => void): () => void
}

export interface AppearanceService {
  get(): AppearanceSnapshot
  set(mode: ThemeMode): Promise<AppearanceResult>
  dispose(): void
}

function resolveTheme(mode: ThemeMode, dark: boolean): ResolvedTheme {
  if (mode === 'system') return dark ? 'dark' : 'light'
  return mode
}

export function createAppearanceService(deps: {
  store: AppearanceStore
  native: NativeThemePort
  emit: (snapshot: AppearanceSnapshot) => void
}): AppearanceService {
  const { store, native, emit } = deps
  let revision = 0
  let mode: ThemeMode = store.read() ?? 'system'
  let snapshot: AppearanceSnapshot = {
    revision,
    mode,
    resolved: resolveTheme(mode, native.shouldUseDarkColors)
  }
  let disposed = false
  let queue: Promise<unknown> = Promise.resolve()

  native.themeSource = mode
  const unsubscribe = native.onUpdated(onNativeUpdated)

  function onNativeUpdated(): void {
    if (disposed) return
    // native setter 自触发 updated 时 resolved 不变，直接忽略，避免一次保存广播两次
    const resolved = resolveTheme(mode, native.shouldUseDarkColors)
    if (resolved === snapshot.resolved) return
    revision += 1
    snapshot = { revision, mode, resolved }
    broadcast()
  }

  function broadcast(): void {
    try {
      emit(snapshot)
    } catch (error) {
      console.error('[appearance] broadcast listener failed:', error)
    }
  }

  function set(nextMode: ThemeMode): Promise<AppearanceResult> {
    if (disposed) {
      return Promise.resolve({ ok: false, code: 'UNAVAILABLE', message: '外观服务已停止' })
    }
    if (parseThemeMode(nextMode) === null) {
      return Promise.resolve({ ok: false, code: 'INVALID_MODE', message: `未知的外观偏好: ${String(nextMode)}` })
    }
    const next = queue.then(() => commitMode(nextMode))
    queue = next.catch(() => undefined)
    return next
  }

  async function commitMode(nextMode: ThemeMode): Promise<AppearanceResult> {
    if (nextMode === mode) return { ok: true, value: snapshot }
    try {
      await store.write(nextMode)
    } catch (error) {
      // 保存失败时保留当前已确认偏好，由界面提示“外观设置未保存”
      return {
        ok: false,
        code: 'STORAGE',
        message: `外观设置未保存: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    try {
      native.themeSource = nextMode
    } catch (error) {
      // 偏好文件已写入但原生主题未切换：进程内维护旧状态，重启后按持久化值恢复
      return {
        ok: false,
        code: 'STORAGE',
        message: `外观设置未保存: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    mode = nextMode
    revision += 1
    snapshot = { revision, mode, resolved: resolveTheme(mode, native.shouldUseDarkColors) }
    broadcast()
    return { ok: true, value: snapshot }
  }

  function get(): AppearanceSnapshot {
    return snapshot
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    unsubscribe()
  }

  return { get, set, dispose }
}
