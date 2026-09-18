import { describe, expect, it } from 'vitest'
import { Engine } from '../src/main/services/engine'
import { createConversation, insertMaterial, saveProvider } from '../src/main/db/dao'
import { makeTestDb } from './helpers'
import type { ProviderInfo } from '../src/shared/types'
import type { ModelRouter } from '../src/main/services/modelRouter'

function provider(id: string, name: string): ProviderInfo {
  return {
    id,
    name,
    baseUrl: `https://${id}.example.com/v1`,
    protocol: 'chat-completions',
    models: ['m1'],
    defaultModel: 'm1',
    supportsVision: true,
    supportsJsonMode: false,
    isDefault: false,
    sortOrder: 0,
    hasApiKey: true,
    createdAt: '',
    updatedAt: ''
  }
}

interface Call {
  messages: Array<{ role: string; content: unknown }>
  providerIds: string[]
}

const GOOD_TIMETABLE = JSON.stringify({
  semester: { name: '2026-2027-1', startDate: '2026-09-07', weeks: 20 },
  courses: [{ name: '高等数学', weekday: '1', startTime: '8:00', endTime: '9:35', weeks: '1-17' }],
  questions: []
})

function makeRouterStub(
  saved: ProviderInfo[],
  script: Array<(call: Call) => string>
): { router: ModelRouter; calls: Call[] } {
  const calls: Call[] = []
  let i = 0
  const router = {
    call: async (slice: ProviderInfo[], opts: { messages: Array<{ role: string; content: unknown }> }) => {
      const step = script[Math.min(i, script.length - 1)]
      i++
      const used = slice[0]
      return {
        text: step({
          messages: opts.messages,
          providerIds: slice.map((p) => p.id)
        }),
        used: { providerId: used.id, providerName: used.name, model: used.defaultModel }
      }
    }
  } as unknown as ModelRouter
  return { router, calls }
}

async function makeEngineWith(
  providers: ProviderInfo[],
  script: Array<(call: Call) => string>,
  routerOverride?: ModelRouter
): Promise<{ engine: Engine; db: Awaited<ReturnType<typeof makeTestDb>>; notices: Array<{ channel: string; payload: unknown }> }> {
  const db = await makeTestDb()
  for (const p of providers) {
    saveProvider(db, {
      name: p.name,
      baseUrl: p.baseUrl,
      protocol: 'chat-completions',
      models: ['m1'],
      defaultModel: 'm1',
      supportsVision: true
    })
  }
  const notices: Array<{ channel: string; payload: unknown }> = []
  const { router } = routerOverride
    ? { router: routerOverride }
    : makeRouterStub(providers, script)
  const engine = new Engine({
    db,
    router,
    broadcast: (channel, payload) => notices.push({ channel, payload })
  })
  return { engine, db, notices }
}

describe('课表导入三级自愈', () => {
  it('首次输出带脏字段:归一化后导入成功,不触发修复调用', async () => {
    const calls: Call[] = []
    const { engine, db, notices } = await makeEngineWith([provider('a', '甲')], [
      (c) => {
        calls.push(c)
        return GOOD_TIMETABLE
      }
    ])
    const conv = createConversation(db, 'timetable', '课表')
    insertMaterial(db, { conversationId: conv.id, name: '课表文本', type: 'text', content: '星期一 08:00-09:35 高等数学 1-17周' })
    const analysis = await engine.runImport(conv.id, 'timetable')
    expect(analysis?.status).toBe('done')
    expect(calls).toHaveLength(1)
    expect(analysis?.payload.courses).toEqual([
      { name: '高等数学', weekday: 1, startTime: '08:00', endTime: '09:35', weeks: [[1, 17]], location: null, teacher: null }
    ])
    // 开始与完成都有桌宠气泡提醒(后台提取的进度感知)
    const bubbles = notices
      .filter((n) => n.channel === 'evt:pet-bubble')
      .map((n) => (n.payload as { text: string }).text)
    expect(bubbles.some((t) => t.includes('正在提取课表'))).toBe(true)
    expect(bubbles.some((t) => t.includes('课表提取完成'))).toBe(true)
  })

  it('首次输出无法解析:同模型修复一次后成功', async () => {
    const calls: Call[] = []
    const { engine, db } = await makeEngineWith([provider('a', '甲')], [
      (c) => {
        calls.push(c)
        return '提取结果如下 {"courses": 看不懂}'
      },
      (c) => {
        calls.push(c)
        return GOOD_TIMETABLE
      }
    ])
    const conv = createConversation(db, 'timetable', '课表')
    insertMaterial(db, { conversationId: conv.id, name: 'n', type: 'text', content: '材料' })
    const analysis = await engine.runImport(conv.id, 'timetable')
    expect(analysis?.status).toBe('done')
    expect(calls).toHaveLength(2)
    // 修复消息 = 基础2条 + assistant 原始输出 + user 修复反馈
    expect(calls[1].messages).toHaveLength(4)
    expect(String(calls[1].messages[3].content)).toContain('只输出')
  })

  it('修复仍失败:切换备用模型,成功后广播桌宠气泡', async () => {
    const calls: Call[] = []
    const { engine, db, notices } = await makeEngineWith([provider('a', '甲'), provider('b', '乙')], [
      (c) => {
        calls.push(c)
        return '坏输出'
      },
      (c) => {
        calls.push(c)
        return '还是坏输出'
      },
      (c) => {
        calls.push(c)
        return GOOD_TIMETABLE
      }
    ])
    const conv = createConversation(db, 'timetable', '课表')
    insertMaterial(db, { conversationId: conv.id, name: 'n', type: 'text', content: '材料' })
    const analysis = await engine.runImport(conv.id, 'timetable')
    expect(analysis?.status).toBe('done')
    // 第三次调用只发给乙
    expect(calls[2].providerIds).toHaveLength(1)
    expect(calls[2].providerIds[0]).not.toBe('a')
    const bubbles = notices
      .filter((n) => n.channel === 'evt:pet-bubble')
      .map((n) => (n.payload as { text: string }).text)
    expect(bubbles.some((t) => t.includes('正在提取课表'))).toBe(true)
    expect(bubbles.some((t) => t.includes('课表提取完成'))).toBe(true)
  })

  it('全部模型耗尽:failed 且错误包含失败原因', async () => {
    const { engine, db } = await makeEngineWith([provider('a', '甲'), provider('b', '乙')], [
      () => '坏A',
      () => '坏B',
      () => '坏C',
      () => '坏D'
    ])
    const conv = createConversation(db, 'timetable', '课表')
    insertMaterial(db, { conversationId: conv.id, name: 'n', type: 'text', content: '材料' })
    const analysis = await engine.runImport(conv.id, 'timetable')
    expect(analysis?.status).toBe('failed')
    expect(analysis?.error).toContain('所有模型输出均不合格')
  })

  it('全部材料不可读:快速失败并给出真实原因,不浪费模型调用', async () => {
    const calls: Call[] = []
    const { engine, db } = await makeEngineWith([provider('a', '甲')], [
      (c) => {
        calls.push(c)
        return GOOD_TIMETABLE
      }
    ])
    const conv = createConversation(db, 'timetable', '课表')
    insertMaterial(db, {
      conversationId: conv.id,
      name: '课表.xlsx',
      type: 'file',
      parseError: '暂不支持直接读取 .xlsx 文件'
    })
    const analysis = await engine.runImport(conv.id, 'timetable')
    expect(analysis?.status).toBe('failed')
    expect(analysis?.error).toContain('材料无法读取')
    expect(analysis?.error).toContain('课表.xlsx')
    expect(calls).toHaveLength(0)
  })
})

describe('桌宠拖放材料类型侦测', () => {
  it('文件名含"课表"→ 自动路由 timetable;文件不存在时快速失败且不调用模型', async () => {
    const calls: Call[] = []
    const { engine, db } = await makeEngineWith([provider('a', '甲')], [
      (c) => {
        calls.push(c)
        return GOOD_TIMETABLE
      }
    ])
    const r = await engine.intakeMaterials({ files: ['D:\\tmp\\高等数学课表.png'], autoRun: true })
    const { getConversation, latestAnalysis } = await import('../src/main/db/dao')
    expect(getConversation(db, r.conversationId)?.kind).toBe('timetable')
    expect(r.materials[0].parseError).toBeTruthy() // 文件不必真实存在,侦测只看文件名
    // 全部材料不可读 → 快速失败给出原因,不浪费模型调用
    const analysis = latestAnalysis(db, r.conversationId)
    expect(analysis?.status).toBe('failed')
    expect(analysis?.error).toContain('材料无法读取')
    expect(calls).toHaveLength(0)
  })

  it('文本含课表特征(星期+时间区间+周次)→ 自动路由 timetable', async () => {
    const { engine, db } = await makeEngineWith([provider('a', '甲')], [() => GOOD_TIMETABLE])
    const r = await engine.intakeMaterials({
      texts: [
        {
          name: '粘贴内容',
          content: '课程安排如下:\n星期一 第1节 08:00-09:35 高等数学(第1-17周)\n星期三 第3节 10:00-11:35 大学英语(第1-16周)'
        }
      ],
      autoRun: true
    })
    const { getConversation } = await import('../src/main/db/dao')
    expect(getConversation(db, r.conversationId)?.kind).toBe('timetable')
  })

  it('普通通知文本不误判:仍走通用分析', async () => {
    const GOOD_ANALYSIS = JSON.stringify({
      title: '班会通知',
      summary: '明天下午班会',
      actionItems: [{ title: '参加班会', type: 'event', start: '2026-09-19T14:00' }],
      questions: [],
      conflicts: [],
      changes: []
    })
    const { engine, db } = await makeEngineWith([provider('a', '甲')], [() => GOOD_ANALYSIS])
    const r = await engine.intakeMaterials({
      texts: [{ name: '通知', content: '各位同学:明天 14:00 在教学楼 A-302 召开班会,请准时参加。' }],
      autoRun: true
    })
    const { getConversation } = await import('../src/main/db/dao')
    expect(getConversation(db, r.conversationId)?.kind).toBe('analysis')
  })

  it('无特征图片且视觉分类不可用 → 回退通用分析', async () => {
    const GOOD_ANALYSIS = JSON.stringify({
      title: '图片材料',
      summary: 's',
      actionItems: [],
      questions: [],
      conflicts: [],
      changes: []
    })
    const { engine, db } = await makeEngineWith([provider('a', '甲')], [() => GOOD_ANALYSIS])
    const r = await engine.intakeMaterials({ files: ['D:\\tmp\\微信图片_20260918.png'], autoRun: true })
    const { getConversation } = await import('../src/main/db/dao')
    expect(getConversation(db, r.conversationId)?.kind).toBe('analysis')
  })

  it('显式传入 conversationId 的材料不改变既有会话类型', async () => {
    const GOOD_ANALYSIS = JSON.stringify({
      title: '补充',
      summary: 's',
      actionItems: [],
      questions: [],
      conflicts: [],
      changes: []
    })
    const { engine, db } = await makeEngineWith([provider('a', '甲')], [() => GOOD_ANALYSIS])
    const conv = createConversation(db, 'chat', '聊天')
    const r = await engine.intakeMaterials({
      conversationId: conv.id,
      files: ['D:\\tmp\\我的课表.png'],
      autoRun: false
    })
    const { getConversation } = await import('../src/main/db/dao')
    expect(getConversation(db, r.conversationId)?.kind).toBe('chat')
  })
})
