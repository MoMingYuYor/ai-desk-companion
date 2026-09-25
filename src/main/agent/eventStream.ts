// Agent 运行事件广播(C-03)。
//
// 职责只有"落库后广播"的广播半边:调用方先持久化轨迹事件,再把事件与运行快照交给 emit。
// 生产者是未来的编排器(A-03);本模块不读库、不写库,发送通道由构造注入,
// 因此不依赖 electron,可直接单测。
//
// 事件顺序契约:updated 先于 finished。终态时两次都发——
// updated 让订阅方拿到带终态事件的最新快照,finished 是"本运行不再有后续事件"的明确信号。
//
// 发送失败只告警不上抛:运行状态已落库,UI 故障不能杀死运行;
// 断线后的缺失事件由渲染层按 seq 经 agent:run-events 补发,不依赖广播可靠性。

import { Channels } from '../../shared/api'
import {
  isTerminalRunStatus,
  type AgentRunEventPayload,
  type AgentRunFinishedPayload,
  type AgentRunView,
  type TraceEvent
} from '../../shared/agent'

export interface AgentEventStreamDeps {
  /** 定向发送函数;生产注入 broadcastToWorkbench(运行数据只发工作台,不发桌宠与面板) */
  send: (channel: string, payload: unknown) => void
}

export class AgentEventStream {
  constructor(private readonly deps: AgentEventStreamDeps) {}

  /** 运行事件的统一出口:先 updated;进入终态时再发 finished */
  emit(event: TraceEvent, run: AgentRunView): void {
    const updated: AgentRunEventPayload = { run, event }
    this.safeSend(Channels.EventAgentRunUpdated, updated)
    if (isTerminalRunStatus(run.status)) {
      const finished: AgentRunFinishedPayload = { run }
      this.safeSend(Channels.EventAgentRunFinished, finished)
    }
  }

  private safeSend(channel: string, payload: unknown): void {
    try {
      this.deps.send(channel, payload)
    } catch (err) {
      console.warn(`[agent-events] 发送失败 channel=${channel}:`, err instanceof Error ? err.message : String(err))
    }
  }
}
