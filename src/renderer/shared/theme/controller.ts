// 渲染端主题控制器:订阅优先于快照读取,低 revision 响应不覆盖较新事件
import type {
  AppearanceApi,
  AppearanceResult,
  AppearanceSnapshot,
  ThemeMode
} from '../../../shared/appearance'

export interface AppearanceClientPort extends AppearanceApi {
  subscribe(listener: (snapshot: AppearanceSnapshot) => void): () => void
}

export interface AppearanceController {
  start(): Promise<void>
  set(mode: ThemeMode): Promise<AppearanceResult>
  dispose(): void
}

export function createAppearanceController(deps: {
  api: AppearanceClientPort
  apply: (snapshot: AppearanceSnapshot) => void
  unavailable: () => void
}): AppearanceController {
  const { api, apply, unavailable } = deps
  let started = false
  let disposed = false
  let unsubscribe: (() => void) | null = null
  let lastRevision = -1

  function applyIfNewer(snapshot: AppearanceSnapshot): void {
    if (disposed) return
    if (snapshot.revision < lastRevision) return
    lastRevision = snapshot.revision
    apply(snapshot)
  }

  async function start(): Promise<void> {
    if (started || disposed) return
    started = true
    // 先订阅再读取:保证 get 飞行期间到达的广播不丢失
    unsubscribe = api.subscribe(applyIfNewer)
    try {
      applyIfNewer(await api.get())
    } catch {
      if (!disposed) unavailable()
    }
  }

  async function set(mode: ThemeMode): Promise<AppearanceResult> {
    if (disposed) {
      return { ok: false, code: 'UNAVAILABLE', message: '主题控制器已卸载' }
    }
    let result: AppearanceResult
    try {
      result = await api.set(mode)
    } catch (error) {
      return {
        ok: false,
        code: 'UNAVAILABLE',
        message: `外观服务不可用: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    // 成功快照与广播事件走同一条应用路径;失败不改当前已确认偏好
    if (result.ok) applyIfNewer(result.value)
    return result
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    unsubscribe?.()
    unsubscribe = null
  }

  return { start, set, dispose }
}
