// IPC 来源与窗口能力策略(R3):纯函数模块,不依赖 electron 运行时,主进程与 preload 均可引用。
// 策略:未知 frame 一律拒绝;生产页面限定精确 workbench/pet/panel;开发态比较协议/主机/端口/路径;
// 窗口能力表显式登记桌宠/面板可用通道,工作台为全能力业务面。

import { Channels } from '../../shared/api'
import { AppearanceChannels } from '../../shared/appearance'

export type WindowRole = 'workbench' | 'pet' | 'panel'

/** 登记窗口:创建时固化的角色、webContents id 与页面 URL */
export interface IpcPolicyWindow {
  role: WindowRole
  webContentsId: number
  /** 该窗口被允许加载的精确页面 URL(生产为 file: URL,开发为 dev server URL) */
  pageUrl: string
  isDestroyed(): boolean
}

/** 策略所需的最小 frame 形状(Electron WebFrame 结构上兼容) */
export interface IpcPolicyFrame {
  url: string
  parent: IpcPolicyFrame | null
}

/** 策略所需的最小 invoke 事件形状(Electron IpcMainInvokeEvent 结构上兼容) */
export interface IpcPolicyEvent {
  sender: { id: number }
  senderFrame: IpcPolicyFrame | null
}

/** 生产/开发态允许的精确页面路径(应用目录内) */
export const ALLOWED_PAGE_PATHS: readonly string[] = ['/workbench.html', '/pet.html', '/panel.html']

/** 桌宠能力:材料接收、今日显示、拖动、缩放、菜单、动作、活动快照、外观读取(显式登记) */
const PET_CHANNELS: ReadonlySet<string> = new Set([
  Channels.MaterialsAdd,
  Channels.PanelToday,
  Channels.PetDragStart,
  Channels.PetDragMove,
  Channels.PetDragEnd,
  Channels.PetOpenMenu,
  Channels.PetGetScale,
  Channels.PetSetScale,
  Channels.PetAction,
  Channels.PetActivitySnapshot,
  AppearanceChannels.get
])

/** 面板能力(默认只读):今日日程、自身固定偏好、打开桌宠菜单/工作台、外观读取(显式登记) */
const PANEL_CHANNELS: ReadonlySet<string> = new Set([
  Channels.PanelToday,
  Channels.PanelGetPinned,
  Channels.PanelSetPinned,
  Channels.PetOpenMenu,
  Channels.PetAction,
  AppearanceChannels.get
])

/** 拒绝日志:只记通道与原因分类,不含请求参数/页面 URL/查询串 */
function logRejection(channel: string, reason: string): void {
  console.warn(`[ipc-policy] 拒绝 channel=${channel} 原因=${reason}`)
}

function safeParse(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

function safeOrigin(raw: string): string | null {
  const u = safeParse(raw)
  return u ? u.origin : null
}

function exactAllowedPage(u: URL): boolean {
  return u.search === '' && u.hash === '' && (ALLOWED_PAGE_PATHS as readonly string[]).includes(u.pathname)
}

/**
 * 页面白名单:生产 file: 协议下仅允许精确 workbench/pet/panel 页面;
 * 开发态(devUrl 已知)比较解析后的协议/主机/端口与精确页面路径;
 * devUrl 未知时(preload 沙箱可能读不到 env)对 http(s) 仅按精确页面路径放行,
 * 主进程 authorizeIpc 仍按登记窗口做最终校验。
 */
export function isAllowedAppPageUrl(rawUrl: string, devUrl?: string): boolean {
  const u = safeParse(rawUrl)
  if (!u) return false
  if (u.username || u.password) return false
  if (u.protocol === 'file:') {
    return u.search === '' && u.hash === '' && ALLOWED_PAGE_PATHS.some((p) => u.pathname.endsWith(p))
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    if (devUrl) return u.origin === safeOrigin(devUrl) && exactAllowedPage(u)
    return exactAllowedPage(u)
  }
  return false
}

/** frame 页面是否与登记页面精确一致(协议/主机含端口/路径/查询/哈希) */
function pageMatchesRegistration(frameUrl: string, pageUrl: string): boolean {
  const frame = safeParse(frameUrl)
  const page = safeParse(pageUrl)
  if (!frame || !page) return false
  return (
    frame.protocol === page.protocol &&
    frame.host === page.host &&
    frame.pathname === page.pathname &&
    frame.search === page.search &&
    frame.hash === page.hash
  )
}

/**
 * IPC 调用授权:校验登记窗口、senderFrame 存在且为主 frame、
 * 解析后的精确页面 URL 与窗口能力表。任何不满足都拒绝并记录脱敏日志。
 */
export function authorizeIpc(event: IpcPolicyEvent, channel: string, windows: readonly IpcPolicyWindow[]): boolean {
  const frame = event?.senderFrame
  if (!frame) {
    logRejection(channel, 'missing-sender-frame')
    return false
  }
  if (frame.parent) {
    logRejection(channel, 'child-frame')
    return false
  }
  const win = event.sender ? windows.find((w) => w.webContentsId === event.sender.id) : undefined
  if (!win) {
    logRejection(channel, 'unregistered-sender')
    return false
  }
  if (win.isDestroyed()) {
    logRejection(channel, 'destroyed-window')
    return false
  }
  if (!pageMatchesRegistration(frame.url, win.pageUrl)) {
    logRejection(channel, 'page-not-registered')
    return false
  }
  if (win.role === 'workbench') return true
  if (win.role === 'pet' && PET_CHANNELS.has(channel)) return true
  if (win.role === 'panel' && PANEL_CHANNELS.has(channel)) return true
  logRejection(channel, `capability:${win.role}`)
  return false
}
