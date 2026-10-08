// REL-03 验收专用主进程 fixture(不加入产品启动链与发行权限)。
//
// 职责:用现有生产 IPC 注册器、生产 preload 与生产工作台 renderer(真实 AgentPage),
// 在主进程测试库构造真实 trace(seq 1~1000,经仓库层 appendTraceEvent 逐条落库),
// 再按计划丢弃中段与最后的 updated 广播、只放行 finished,
// 由 renderer 的 finished 尾事件补拉完成 1000 行恢复。
//
// 边界:
// - 不发起任何外部业务请求(不调用 provider/mail/reminders 的启动方法,无 API Key);
// - 事件丢弃计划只存在于本 fixture 的 send 包装内,产品 IPC/preload/AgentPage 零改动;
// - 脚本经 CDP 只读取 DOM 与本 fixture 暴露的状态,不代写 DOM、不伪造恢复。
import { app } from 'electron'
import { isAbsolute, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { openDatabase } from '../../../src/main/db/connection'
import { initSchema } from '../../../src/main/db/dao'
import { createPersistenceCoordinator, initWorkspaceEpoch } from '../../../src/main/db/operations'
import { appendTraceEvent, createRun, getRun, transitionRun } from '../../../src/main/runs/repository'
import { AgentEventStream } from '../../../src/main/agent/eventStream'
import { Engine } from '../../../src/main/services/engine'
import { ModelRouter } from '../../../src/main/services/modelRouter'
import { ReminderService } from '../../../src/main/services/reminder'
import { MailService } from '../../../src/main/mail/service'
import { createPetActivityRegistry } from '../../../src/main/pet/activity'
import { registerIpcHandlers } from '../../../src/main/ipc'
import { broadcastToWorkbench, createWorkbenchWindow, markQuitting } from '../../../src/main/windows'
import { Channels } from '../../../src/shared/api'
import type { TraceEvent } from '../../../src/shared/agent'
import type { CredentialStorage } from '../../../src/main/mail/credentials'

/** 目标轨迹规模:seq 1~1000 */
const TOTAL_SEQ = 1000

interface FixtureState {
  stage: string
  runId: string | null
  /** 按计划放行的 updated 广播 seq(全部经真实 AgentEventStream + broadcastToWorkbench) */
  deliveredUpdatedSeqs: number[]
  /** 按计划丢弃的 updated 广播条数(含中段与最后 updated) */
  droppedUpdatedCount: number
  finishedSentAt: string | null
  dbEventCount: number
  error: string | null
}

const state: FixtureState = {
  stage: 'boot',
  runId: null,
  deliveredUpdatedSeqs: [],
  droppedUpdatedCount: 0,
  finishedSentAt: null,
  dbEventCount: 0,
  error: null
}

// --user-data <绝对目录>:与产品主入口同一契约(隔离用户目录,验收专用)
const USER_DATA = (() => {
  const i = process.argv.indexOf('--user-data')
  const dir = i === -1 ? null : process.argv[i + 1] ?? null
  if (!dir || !isAbsolute(dir)) {
    console.error('[rel03-fixture] --user-data 需要一个绝对路径参数')
    app.quit()
    return null
  }
  mkdirSync(dir, { recursive: true })
  return dir
})()

if (USER_DATA) {
  app.setPath('userData', USER_DATA)
  console.error(`[rel03-fixture] 隔离用户目录:${USER_DATA}`)
}

let dbRef: Awaited<ReturnType<typeof openDatabase>>['db'] | null = null
let flushRef: (() => void) | null = null
let runIdRef: string | null = null
let lastEventRef: TraceEvent | null = null
let stage2Done = false

// 工作台窗口的 close 处理器在 !quitting 时阻止关闭;退出前必须标记,否则 app.quit 挂起
app.on('before-quit', () => markQuitting())
app.on('will-quit', () => {
  try {
    flushRef?.()
  } catch (err) {
    console.error('[rel03-fixture] flush 失败:', err instanceof Error ? err.message : String(err))
  }
})

/**
 * 广播投递计划:updated 仅放行 seq 1(且此时窗口尚未创建,renderer 实际经
 * 打开代 agent:run-events 补发通道拿到 #1);中段与最后 updated 全部丢弃;
 * finished 永远放行——这正是 renderer 必须靠 finished 尾事件补拉恢复的场景。
 */
const agentEvents = new AgentEventStream({
  send: (channel, payload) => {
    if (channel === Channels.EventAgentRunUpdated) {
      const seq = (payload as { event: TraceEvent }).event?.seq
      if (seq === 1) state.deliveredUpdatedSeqs.push(seq)
      else {
        state.droppedUpdatedCount += 1
        return
      }
    } else if (channel === Channels.EventAgentRunFinished) {
      state.finishedSentAt = new Date().toISOString()
    }
    broadcastToWorkbench(channel, payload)
  }
})

/** 阶段 2:逐条落库并广播 seq 2~999(全部被计划丢弃),seq 1000 随终态 emit 只放行 finished。 */
function runStage2(): FixtureState {
  if (stage2Done) return { ...state }
  stage2Done = true
  try {
    if (!dbRef || !runIdRef || !lastEventRef) throw new Error('fixture 未完成初始化')
    state.stage = 'appending'
    let last = lastEventRef
    for (let seq = 2; seq < TOTAL_SEQ; seq++) {
      const eventType: TraceEvent['eventType'] = seq % 3 === 0 ? 'tool_call' : 'plan'
      const payload: Record<string, unknown> =
        seq % 3 === 0 ? { tool: 'todo.list', ok: true } : { goal: `step-${seq}` }
      last = appendTraceEvent(dbRef, { runId: runIdRef, eventType, payload })
      // 与编排器同形态:落库后经真实 AgentEventStream emit;非终态只发 updated,被计划丢弃
      const runNow = getRun(dbRef, runIdRef)
      if (!runNow) throw new Error(`运行读取失败:seq ${seq}`)
      agentEvents.emit(last, runNow)
    }
    // 最后一个事件只落库不广播:其 updated 随终态 emit 发出并被计划丢弃(丢弃"最后 updated")
    last = appendTraceEvent(dbRef, {
      runId: runIdRef,
      eventType: 'output',
      payload: { summary: 'REL-03 恢复完成' }
    })
    const dbCount = dbRef.get<{ n: number }>('SELECT COUNT(*) AS n FROM trace_events WHERE run_id = ?', [runIdRef])?.n ?? 0
    state.dbEventCount = dbCount
    if (dbCount !== TOTAL_SEQ) throw new Error(`落库事件数不符:${dbCount}/${TOTAL_SEQ}`)
    state.stage = 'transitioning'
    // executing → succeeded(终态自动写入 finished_at)
    transitionRun(dbRef, runIdRef, 'succeeded')
    state.stage = 'sending-finished'
    // 终态 emit:先 updated(seq 1000,被计划丢弃),后 finished(放行)
    const terminalRun = getRun(dbRef, runIdRef)
    if (!terminalRun) throw new Error('终态运行读取失败')
    agentEvents.emit(last, terminalRun)
    state.stage = 'finished-sent'
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err)
    state.stage = 'stage2-error'
  }
  return { ...state }
}

async function bootstrap(): Promise<void> {
  if (!USER_DATA) return
  // 与生产入口同形态:窗口创建等必须在 app ready 之后
  await app.whenReady()
  state.stage = 'opening-db'
  // sql.js wasm 与生产同一来源(项目内 node_modules),不涉及网络
  const sqlJsDistDir = join(process.cwd(), 'node_modules', 'sql.js', 'dist')
  const { db, flush } = await openDatabase(join(USER_DATA, 'data.sqlite'), sqlJsDistDir)
  dbRef = db
  flushRef = flush
  initSchema(db)
  initWorkspaceEpoch()

  state.stage = 'seeding'
  const run = createRun(db, {
    mode: 'personal_ops',
    input: 'REL-03 恢复验收:1000 段轨迹',
    contextClock: '2026-10-08T00:00:00.000Z'
  })
  runIdRef = run.runId
  state.runId = run.runId
  // queued → planning → executing(状态机合法路径)
  transitionRun(db, run.runId, 'planning')
  transitionRun(db, run.runId, 'executing')
  lastEventRef = appendTraceEvent(db, {
    runId: run.runId,
    eventType: 'plan',
    payload: { goal: 'step-1' }
  })
  state.dbEventCount = 1
  // seq 1 的 updated 经真实 AgentEventStream 广播(此时窗口未创建,renderer 实际经打开代补发通道拿到 #1)
  agentEvents.emit(lastEventRef, getRun(db, run.runId)!)

  // 生产服务最小装配:仅构造,不启动任何会发外部请求的定时器/连接
  state.stage = 'wiring'
  const router = new ModelRouter({ apiKeyOf: () => null })
  const engine = new Engine({ db, router, broadcast: () => {} })
  const reminders = new ReminderService({ db, broadcast: () => {}, showNotification: () => {} })
  const petActivity = createPetActivityRegistry(() => {})
  const storage: CredentialStorage = {
    isEncryptionAvailable: () => false,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => value.toString('utf8')
  }
  const mail = new MailService({
    db,
    engine,
    storage,
    cacheDir: join(USER_DATA, 'mail'),
    broadcast: () => {}
  })
  const persistCoordinator = createPersistenceCoordinator(db)

  // 生产 IPC 注册器(读侧 + 写侧同一实现)与生产工作台窗口(生产 preload + 生产 renderer)
  registerIpcHandlers({ db, engine, router, reminders, petActivity, mail, persistCoordinator, agentEvents })
  createWorkbenchWindow(db)
  state.stage = 'ready'
}

// 供验收脚本经 CDP 观察状态与推进阶段;脚本不借此写 DOM 或伪造恢复
Object.assign(globalThis, {
  __rel03: {
    state: (): FixtureState => ({ ...state }),
    stage2: runStage2,
    plan: { totalSeq: TOTAL_SEQ, deliveredUpdatedSeqs: [1], finishedOnly: true }
  }
})

void bootstrap().catch((err: unknown) => {
  state.error = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
  state.stage = 'bootstrap-error'
  console.error('[rel03-fixture] bootstrap 失败:', state.error)
})
