import { describe, expect, it } from 'vitest'
import { Engine } from '../src/main/services/engine'
import { createConversation, insertMaterial, listMaterials, saveProvider } from '../src/main/db/dao'
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

const GOOD = JSON.stringify({
  title: '综合测评通知',
  summary: 's',
  actionItems: [],
  questions: [],
  conflicts: [],
  changes: []
})

function makeRouterStub(): ModelRouter {
  return {
    call: async (slice: ProviderInfo[], _opts: unknown) => ({
      text: GOOD,
      used: { providerId: slice[0].id, providerName: slice[0].name, model: slice[0].defaultModel }
    })
  } as unknown as ModelRouter
}

async function makeEngine(fetchLink?: (url: string) => Promise<{ title: string; text: string }>) {
  const db = await makeTestDb()
  saveProvider(db, {
    name: '甲',
    baseUrl: 'https://a.example.com/v1',
    protocol: 'chat-completions',
    models: ['m1'],
    defaultModel: 'm1',
    supportsVision: true
  })
  const engine = new Engine({ db, router: makeRouterStub(), broadcast: () => {}, fetchLink })
  const conv = createConversation(db, 'analysis', 't')
  return { engine, db, conversationId: conv.id }
}

describe('分析中的网页链接抓取', () => {
  it('材料含链接:先抓取正文入库,并作为分析输入(不再只分析链接字符串)', async () => {
    const calls: string[] = []
    const { engine, db, conversationId } = await makeEngine(async (url) => {
      calls.push(url)
      return { title: '综合测评细则', text: '截止时间:2026年9月30日17:00,需提交申请表并由班级评议。' }
    })
    insertMaterial(db, {
      conversationId,
      name: '剪贴板通知',
      type: 'text',
      content: '关于开展2025-2026学年本科生综合测评及评优工作的通知 https://dzxy.scau.edu.cn/2026/0916/c9673a445967/page.htm'
    })

    const analysis = await engine.runAnalysis(conversationId)
    expect(analysis?.status).toBe('done')
    expect(calls).toHaveLength(1)

    // 链接正文成为持久化材料(重试/追问可复用)
    const materials = listMaterials(db, conversationId)
    const linkMaterial = materials.find((m) => m.name.startsWith('链接正文'))
    expect(linkMaterial).toBeTruthy()
    expect(linkMaterial?.content).toContain('2026年9月30日')
  })

  it('模型输入包含链接正文内容', async () => {
    let capturedUserContent = ''
    const db = await makeTestDb()
    saveProvider(db, {
      name: '甲',
      baseUrl: 'https://a.example.com/v1',
      protocol: 'chat-completions',
      models: ['m1'],
      defaultModel: 'm1',
      supportsVision: true
    })
    const router = {
      call: async (slice: ProviderInfo[], opts: { messages: Array<{ role: string; content: unknown }> }) => {
        capturedUserContent = String(opts.messages.find((m) => m.role === 'user')?.content ?? '')
        return {
          text: GOOD,
          used: { providerId: slice[0].id, providerName: slice[0].name, model: slice[0].defaultModel }
        }
      }
    } as unknown as ModelRouter
    const engine = new Engine({ db, router, broadcast: () => {}, fetchLink: async () => ({ title: '细则', text: '评优需班级民主评议。' }) })
    const conv = createConversation(db, 'analysis', 't')
    insertMaterial(db, { conversationId: conv.id, name: '通知', type: 'text', content: '详见 https://example.com/rule' })

    await engine.runAnalysis(conv.id)
    expect(capturedUserContent).toContain('评优需班级民主评议')
    expect(capturedUserContent).toContain('链接正文')
  })

  it('链接抓取失败:写入失败说明,分析照常完成而非报错', async () => {
    const { engine, db, conversationId } = await makeEngine(async () => {
      throw new Error('网页抓取超时(15秒)')
    })
    insertMaterial(db, { conversationId, name: '通知', type: 'text', content: '详见 https://example.com/gone' })

    const analysis = await engine.runAnalysis(conversationId)
    expect(analysis?.status).toBe('done')
    const materials = listMaterials(db, conversationId)
    expect(materials.some((m) => m.name.startsWith('链接读取失败') && (m.content ?? '').includes('超时'))).toBe(true)
  })

  it('重试不重复抓取已成功的链接', async () => {
    const calls: string[] = []
    const { engine, db, conversationId } = await makeEngine(async (url) => {
      calls.push(url)
      return { title: '细则', text: '正文内容' }
    })
    insertMaterial(db, { conversationId, name: '通知', type: 'text', content: '见 https://example.com/rule' })

    await engine.runAnalysis(conversationId)
    await engine.runAnalysis(conversationId)
    expect(calls).toHaveLength(1)
  })

  it('无链接的材料不触发任何抓取', async () => {
    let called = false
    const { engine, db, conversationId } = await makeEngine(async () => {
      called = true
      return { title: 'x', text: 'y' }
    })
    insertMaterial(db, { conversationId, name: '通知', type: 'text', content: '明天下午2点班会,请准时参加。' })
    await engine.runAnalysis(conversationId)
    expect(called).toBe(false)
  })
})
