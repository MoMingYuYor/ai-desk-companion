import { describe, expect, it } from 'vitest'
import { authorizeIpc, type IpcPolicyEvent, type IpcPolicyWindow } from '../../src/main/security/ipcPolicy'
import { Channels } from '../../src/shared/api'

// C-02:Agent 通道授权。核心安全属性:运行生命周期与审批通道只对工作台开放,
// 桌宠与面板窗口不得触达(桌宠只做材料入口与状态反馈,面板只读)。

const PROD = {
  workbench: 'file:///D:/app/out/renderer/workbench.html',
  pet: 'file:///D:/app/out/renderer/pet.html',
  panel: 'file:///D:/app/out/renderer/panel.html'
}

function win(role: IpcPolicyWindow['role'], webContentsId: number, pageUrl: string): IpcPolicyWindow {
  return { role, webContentsId, pageUrl, isDestroyed: () => false }
}

function evt(senderId: number, url: string, child = false): IpcPolicyEvent {
  return {
    sender: { id: senderId },
    senderFrame: { url, parent: child ? ({ url, parent: null } as const) : null }
  }
}

const registry = [
  win('workbench', 1, PROD.workbench),
  win('pet', 2, PROD.pet),
  win('panel', 3, PROD.panel)
]

/** Agent 运行契约的全部通道(C-02 登记) */
const AGENT_CHANNELS: readonly string[] = [
  Channels.AgentRunCreate,
  Channels.AgentRunGet,
  Channels.AgentRunEvents,
  Channels.AgentRunAnswers,
  Channels.AgentRunCancel,
  Channels.AgentApprovalDecide
]

describe('Agent 通道名契约', () => {
  it('六个运行通道与两个事件名均为 agent 前缀', () => {
    for (const channel of AGENT_CHANNELS) {
      expect(channel.startsWith('agent:')).toBe(true)
    }
    expect(Channels.EventAgentRunUpdated.startsWith('evt:agent-run-')).toBe(true)
    expect(Channels.EventAgentRunFinished.startsWith('evt:agent-run-')).toBe(true)
  })

  it('通道名互不重复', () => {
    const all = [...AGENT_CHANNELS, Channels.EventAgentRunUpdated, Channels.EventAgentRunFinished]
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('工作台可触达 Agent 通道', () => {
  it.each(AGENT_CHANNELS)('workbench 放行 %s', (channel) => {
    expect(authorizeIpc(evt(1, PROD.workbench), channel, registry)).toBe(true)
  })

  it('workbench 可订阅 Agent 运行事件', () => {
    expect(authorizeIpc(evt(1, PROD.workbench), Channels.EventAgentRunUpdated, registry)).toBe(true)
    expect(authorizeIpc(evt(1, PROD.workbench), Channels.EventAgentRunFinished, registry)).toBe(true)
  })
})

describe('桌宠与面板不得触达 Agent 通道', () => {
  it.each(AGENT_CHANNELS)('pet 拒绝 %s', (channel) => {
    expect(authorizeIpc(evt(2, PROD.pet), channel, registry)).toBe(false)
  })

  it.each(AGENT_CHANNELS)('panel 拒绝 %s', (channel) => {
    expect(authorizeIpc(evt(3, PROD.panel), channel, registry)).toBe(false)
  })

  it('桌宠不能批准写操作(审批通道是 Agent 契约里权限最高的一个)', () => {
    expect(authorizeIpc(evt(2, PROD.pet), Channels.AgentApprovalDecide, registry)).toBe(false)
  })
})

describe('来源与 frame 校验先于能力表', () => {
  it('未登记 webContents 一律拒绝', () => {
    expect(authorizeIpc(evt(99, PROD.workbench), Channels.AgentRunCreate, registry)).toBe(false)
  })

  it('子 frame 调用被拒绝', () => {
    expect(authorizeIpc(evt(1, PROD.workbench, true), Channels.AgentRunCreate, registry)).toBe(false)
  })

  it('页面被导航到别处后拒绝(即便 sender 仍是已登记窗口)', () => {
    expect(authorizeIpc(evt(1, 'file:///C:/Users/x/evil.html'), Channels.AgentRunCreate, registry)).toBe(false)
  })

  it('缺少 senderFrame 拒绝', () => {
    const broken = { sender: { id: 1 }, senderFrame: null } as IpcPolicyEvent
    expect(authorizeIpc(broken, Channels.AgentRunCreate, registry)).toBe(false)
  })
})
