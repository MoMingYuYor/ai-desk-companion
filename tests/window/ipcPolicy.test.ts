import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authorizeIpc,
  isAllowedAppPageUrl,
  type IpcPolicyEvent,
  type IpcPolicyWindow
} from '../../src/main/security/ipcPolicy'

// R3(Task 5):authorizeIpc 模块级测试。用假窗口/假 frame 表达"登记窗口 + 精确页面 + 能力表"策略。

function win(role: IpcPolicyWindow['role'], webContentsId: number, pageUrl: string): IpcPolicyWindow {
  return { role, webContentsId, pageUrl, isDestroyed: () => false }
}

function evt(senderId: number, url: string, child = false): IpcPolicyEvent {
  return {
    sender: { id: senderId },
    senderFrame: { url, parent: child ? ({ url, parent: null } as const) : null }
  }
}

const PROD = {
  workbench: 'file:///D:/app/out/renderer/workbench.html',
  pet: 'file:///D:/app/out/renderer/pet.html',
  panel: 'file:///D:/app/out/renderer/panel.html'
}
const DEV_WORKBENCH = 'http://localhost:5173/workbench.html'
const DEV_PET = 'http://localhost:5173/pet.html'
const DEV_PANEL = 'http://localhost:5173/panel.html'

const prodRegistry = [
  win('workbench', 1, PROD.workbench),
  win('pet', 2, PROD.pet),
  win('panel', 3, PROD.panel)
]
const devRegistry = [
  win('workbench', 1, DEV_WORKBENCH),
  win('pet', 2, DEV_PET),
  win('panel', 3, DEV_PANEL)
]

describe('authorizeIpc 登记窗口与主 frame 校验', () => {
  it('已登记工作台主 frame + 精确页面放行业务命令', () => {
    expect(authorizeIpc(evt(1, PROD.workbench), 'events:create', prodRegistry)).toBe(true)
  })

  it('外部 file: 页面(即便 sender 是已登记窗口)调用 events:create / backup:import 均拒绝', () => {
    expect(authorizeIpc(evt(1, 'file:///C:/Users/x/evil.html'), 'events:create', prodRegistry)).toBe(false)
    expect(authorizeIpc(evt(1, 'file:///C:/Users/x/evil.html'), 'backup:import', prodRegistry)).toBe(false)
  })

  it('开发态同前缀恶意主机被拒绝(5173.evil.com ≠ 5173)', () => {
    expect(
      authorizeIpc(evt(1, 'http://localhost:5173.evil.com/workbench.html'), 'events:create', devRegistry)
    ).toBe(false)
  })

  it('开发态登记的精确 dev URL 放行', () => {
    expect(authorizeIpc(evt(1, DEV_WORKBENCH), 'events:create', devRegistry)).toBe(true)
    expect(authorizeIpc(evt(2, DEV_PET), 'pet:action', devRegistry)).toBe(true)
  })

  it('子 frame 即便页面 URL 合法也一律拒绝', () => {
    expect(authorizeIpc(evt(1, PROD.workbench, true), 'events:range', prodRegistry)).toBe(false)
    expect(authorizeIpc(evt(1, PROD.workbench, true), 'todos:list', prodRegistry)).toBe(false)
  })

  it('未登记窗口调用任何通道都拒绝', () => {
    expect(authorizeIpc(evt(99, PROD.workbench), 'events:create', prodRegistry)).toBe(false)
    expect(authorizeIpc(evt(99, PROD.workbench), 'backup:import', prodRegistry)).toBe(false)
  })

  it('senderFrame 缺失(已销毁 frame)拒绝', () => {
    expect(authorizeIpc({ sender: { id: 1 }, senderFrame: null }, 'events:create', prodRegistry)).toBe(false)
  })

  it('已销毁的登记窗口拒绝', () => {
    const registry = [{ ...prodRegistry[0]!, isDestroyed: () => true }]
    expect(authorizeIpc(evt(1, PROD.workbench), 'todos:list', registry)).toBe(false)
  })

  it('登记页面带查询/哈希差异视为页面不匹配', () => {
    expect(authorizeIpc(evt(1, PROD.workbench + '?x=1'), 'events:create', prodRegistry)).toBe(false)
  })
})

describe('authorizeIpc 窗口能力表', () => {
  it('桌宠:材料接收/今日显示/拖动/缩放/动作/外观读取放行', () => {
    for (const channel of [
      'materials:add',
      'panel:today',
      'pet:drag-start',
      'pet:drag-move',
      'pet:drag-end',
      'pet:open-menu',
      'pet:get-scale',
      'pet:set-scale',
      'pet:action',
      'pet:activity-snapshot',
      'appearance:get'
    ]) {
      expect(authorizeIpc(evt(2, PROD.pet), channel, prodRegistry), channel).toBe(true)
    }
  })

  it('桌宠:业务修改与备份命令拒绝', () => {
    for (const channel of ['events:create', 'backup:import', 'providers:save', 'mail:remove']) {
      expect(authorizeIpc(evt(2, PROD.pet), channel, prodRegistry), channel).toBe(false)
    }
  })

  it('面板:只读日程、固定偏好、打开菜单/工作台放行', () => {
    for (const channel of ['panel:today', 'panel:get-pinned', 'panel:set-pinned', 'pet:open-menu', 'pet:action', 'appearance:get']) {
      expect(authorizeIpc(evt(3, PROD.panel), channel, prodRegistry), channel).toBe(true)
    }
  })

  it('面板:业务修改、备份、外观写入拒绝', () => {
    for (const channel of ['events:create', 'backup:import', 'appearance:set', 'materials:add']) {
      expect(authorizeIpc(evt(3, PROD.panel), channel, prodRegistry), channel).toBe(false)
    }
  })

  it('工作台全能力:备份导入与业务修改放行', () => {
    expect(authorizeIpc(evt(1, PROD.workbench), 'backup:import', prodRegistry)).toBe(true)
    expect(authorizeIpc(evt(1, PROD.workbench), 'appearance:set', prodRegistry)).toBe(true)
  })
})

describe('拒绝日志脱敏', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('拒绝日志只含通道与原因,不含页面 URL/请求参数', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    authorizeIpc(evt(1, 'file:///C:/Users/x/evil.html?token=secret'), 'backup:import', prodRegistry)
    expect(warn).toHaveBeenCalledTimes(1)
    const text = warn.mock.calls.map((c) => c.join(' ')).join(' ')
    expect(text).toContain('backup:import')
    expect(text).not.toContain('evil.html')
    expect(text).not.toContain('token')
    expect(text).not.toContain('file:')
  })
})

describe('isAllowedAppPageUrl 页面白名单', () => {
  it('生产 file: 只放行精确 workbench/pet/panel 页面', () => {
    expect(isAllowedAppPageUrl('file:///D:/app/out/renderer/workbench.html')).toBe(true)
    expect(isAllowedAppPageUrl('file:///D:/app/out/renderer/pet.html')).toBe(true)
    expect(isAllowedAppPageUrl('file:///D:/app/out/renderer/panel.html')).toBe(true)
    expect(isAllowedAppPageUrl('file:///D:/app/out/renderer/evil.html')).toBe(false)
    expect(isAllowedAppPageUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedAppPageUrl('file:///D:/app/out/renderer/notworkbench.html')).toBe(false)
    expect(isAllowedAppPageUrl('file:///D:/app/out/renderer/workbench.html.evil')).toBe(false)
  })

  it('开发态比较协议/主机/端口/路径:同前缀恶意主机与带查询的页面拒绝', () => {
    const dev = 'http://localhost:5173'
    expect(isAllowedAppPageUrl(`${dev}/workbench.html`, dev)).toBe(true)
    expect(isAllowedAppPageUrl('http://localhost:5173.evil.com/workbench.html', dev)).toBe(false)
    expect(isAllowedAppPageUrl('http://127.0.0.1:5173/workbench.html', dev)).toBe(false)
    expect(isAllowedAppPageUrl(`${dev}/workbench.html?x=1`, dev)).toBe(false)
    expect(isAllowedAppPageUrl(`${dev}/evil/workbench.html`, dev)).toBe(false)
  })

  it('非 http(s)/file: 协议与带凭据的 URL 拒绝', () => {
    expect(isAllowedAppPageUrl('ftp://example.com/workbench.html')).toBe(false)
    expect(isAllowedAppPageUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedAppPageUrl('file:///D:/x/workbench.html', undefined)).toBe(true)
    expect(isAllowedAppPageUrl('http://user:pass@example.com/workbench.html')).toBe(false)
    expect(isAllowedAppPageUrl('not a url')).toBe(false)
  })

  it('无 devUrl 时 http(s) 仅放行精确页面路径(preload 场景)', () => {
    expect(isAllowedAppPageUrl('http://localhost:5173/pet.html')).toBe(true)
    expect(isAllowedAppPageUrl('https://evil.example.com/workbench.html.evil')).toBe(false)
  })
})
