import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ActionCandidate,
  Analysis,
  ChatMessage,
  Conversation,
  Material
} from '../../../shared/types'
import { fmtTime, nowLocalIso } from '../../../shared/dateUtils'
import { extractUrls } from '../../../shared/urlText'
import { Toast, useSubscribe, useToast } from '../../shared/util'

interface Props {
  refreshKey: number
  petAction: { action: string; at: number } | null
  /** 邮箱页等外部入口定位到指定分析会话 */
  locateConversationId?: { id: string; at: number } | null
}

export function ChatPage({ refreshKey, petAction, locateConversationId }: Props): JSX.Element {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [materials, setMaterials] = useState<Material[]>([])
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [toast, showToast] = useToast()
  const messagesRef = useRef<HTMLDivElement>(null)

  const reloadConversations = useCallback((): void => {
    void window.api.listConversations().then(setConversations)
  }, [])

  const reloadActive = useCallback((): void => {
    if (!activeId) return
    void window.api.listMessages(activeId).then(setMessages)
    void window.api.getLatestAnalysis(activeId).then((a) => setAnalysis(a ?? null))
  }, [activeId])

  useEffect(() => {
    reloadConversations()
  }, [reloadConversations, refreshKey])

  useEffect(() => {
    if (!activeId && conversations.length > 0) setActiveId(conversations[0].id)
  }, [activeId, conversations])

  // 外部定位(邮箱页"查看分析会话"):按时间戳去重,只响应最新一次请求
  useEffect(() => {
    if (locateConversationId?.id) setActiveId(locateConversationId.id)
  }, [locateConversationId?.at, locateConversationId?.id])

  useEffect(() => {
    if (!activeId) {
      setMessages([])
      setAnalysis(null)
      setMaterials([])
      return
    }
    void window.api.listMessages(activeId).then(setMessages)
    void window.api.getLatestAnalysis(activeId).then((a) => setAnalysis(a ?? null))
    const conv = conversations.find((c) => c.id === activeId)
    void conv
    // 材料列表通过消息列表附带展示,不单独拉取(简化)
  }, [activeId, conversations])

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight })
  }, [messages, streamText])

  // 流式事件
  useSubscribe(
    'evt:chat-delta',
    useCallback((payload: unknown) => {
      const { conversationId, delta } = payload as { conversationId: string; delta: string }
      if (conversationId !== activeId) return
      setStreamText((prev) => prev + delta)
      setStreaming(true)
    }, [activeId])
  )
  useSubscribe(
    'evt:chat-done',
    useCallback(
      (payload: unknown) => {
        const { conversationId } = payload as { conversationId: string }
        setStreaming(false)
        setStreamText('')
        if (conversationId === activeId) {
          reloadActive()
          reloadConversations()
        }
      },
      [activeId, reloadActive, reloadConversations]
    )
  )
  useSubscribe(
    'evt:chat-error',
    useCallback(
      (payload: unknown) => {
        const { conversationId, error } = payload as { conversationId: string; error?: string }
        setStreaming(false)
        setStreamText('')
        if (conversationId === activeId) {
          reloadActive()
          if (error) showToast('分析失败:' + error)
        }
      },
      [activeId, reloadActive, showToast]
    )
  )
  useSubscribe(
    'evt:analysis-updated',
    useCallback(
      (payload: unknown) => {
        const { conversationId } = payload as { conversationId: string }
        setStreaming(false)
        setStreamText('')
        if (conversationId === activeId) {
          reloadActive()
          reloadConversations()
        }
      },
      [activeId, reloadActive, reloadConversations]
    )
  )
  useSubscribe(
    'evt:conversation-changed',
    useCallback(
      (payload: unknown) => {
        const { conversationId } = payload as { conversationId: string }
        if (conversationId === activeId) reloadActive()
        reloadConversations()
      },
      [activeId, reloadActive, reloadConversations]
    )
  )

  const activeConv = conversations.find((c) => c.id === activeId) ?? null

  const newConversation = async (kind: Conversation['kind']): Promise<void> => {
    const conv = await window.api.createConversation(kind, kind === 'chat' ? '新对话' : '新分析')
    reloadConversations()
    setActiveId(conv.id)
  }

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || !activeId || streaming) return
    setInput('')
    // 输入中带网页链接时,先抓取正文存为材料(如公众号推文),再带着原文发送
    const urls = extractUrls(text).slice(0, 3)
    let fetched = 0
    for (const url of urls) {
      try {
        const page = await window.api.fetchUrlText(url)
        await window.api.addMaterials({
          conversationId: activeId,
          texts: [{ name: page.title || url, content: page.text }],
          autoRun: false
        })
        fetched++
      } catch (err) {
        showToast(`链接抓取失败:${err instanceof Error ? err.message : err}`)
      }
    }
    if (fetched > 0) showToast(`已抓取 ${fetched} 个链接的正文,开始分析`)
    setStreaming(true)
    setStreamText('')
    try {
      await window.api.sendChat(activeId, text)
    } catch (err) {
      showToast(String(err instanceof Error ? err.message : err))
      setStreaming(false)
    }
  }

  const stop = async (): Promise<void> => {
    if (activeId) await window.api.stopChat(activeId)
  }

  const retry = async (): Promise<void> => {
    if (activeId) await window.api.retryChat(activeId)
  }

  const addFiles = async (files: FileList): Promise<void> => {
    if (!activeId || files.length === 0) return
    const paths = Array.from(files).map((f) => window.api.pathForFile(f))
    setStreaming(true)
    try {
      await window.api.addMaterials({ conversationId: activeId, files: paths, autoRun: activeConv?.kind !== 'chat' })
      showToast('材料已加入,开始更新分析')
    } catch (err) {
      showToast(String(err instanceof Error ? err.message : err))
    } finally {
      setStreaming(false)
    }
  }

  return (
    <div className="page">
      {/* 会话列表 */}
      <div className="conv-list">
        <div className="row">
          <button className="primary" style={{ flex: 1 }} onClick={() => void newConversation('analysis')}>
            + 通知分析
          </button>
          <button title="新建自由聊天" onClick={() => void newConversation('chat')}>
            💬
          </button>
        </div>
        <div className="card" style={{ flex: 1, padding: 6 }}>
          {conversations.length === 0 && <div className="empty">暂无会话</div>}
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`conv-item ${c.id === activeId ? 'active' : ''}`}
              onClick={() => setActiveId(c.id)}
            >
              <div className="title">{c.title}</div>
              <div className="muted">
                {kindLabel(c.kind)} · {fmtTime(c.updatedAt.replace('Z', '')) || c.updatedAt.slice(11, 16)}
                <button
                  className="ghost danger"
                  style={{ float: 'right', padding: '0 4px', fontSize: 11 }}
                  onClick={async (e) => {
                    e.stopPropagation()
                    await window.api.deleteConversation(c.id)
                    if (activeId === c.id) setActiveId(null)
                    reloadConversations()
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 聊天区 */}
      <div className="chat-area">
        <div className="messages" ref={messagesRef}>
          {!activeConv && <div className="empty">新建"通知分析"会话,或把材料拖给桌宠开始</div>}
          {activeConv && messages.length === 0 && (
            <div className="empty">
              {activeConv.kind === 'chat' ? '开始自由聊天,可随时安排事项' : '在下方粘贴通知文本或添加材料文件'}
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.content}
              {m.role === 'assistant' && m.modelLabel && <span className="model">{m.modelLabel}</span>}
            </div>
          ))}
          {streaming && streamText && <div className="msg assistant">{streamText}</div>}
          {streaming && !streamText && (
            <div className="msg assistant">
              <span className="muted">正在分析材料…(首次可先配置"设置 → 模型服务")</span>
            </div>
          )}
        </div>
        <div className="chat-input">
          <label style={{ cursor: 'pointer' }} title="添加材料文件">
            <input
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files)
                e.target.value = ''
              }}
            />
            📎
          </label>
          <textarea
            placeholder={
              activeConv?.kind === 'chat'
                ? '输入消息…(Enter 发送,Shift+Enter 换行)'
                : '补充通知内容或追问…(Enter 发送)'
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          {streaming ? (
            <button className="danger" onClick={() => void stop()}>
              停止
            </button>
          ) : (
            <>
              <button onClick={() => void retry()} disabled={!activeId}>
                重试
              </button>
              <button className="primary" onClick={() => void send()} disabled={!activeId || !input.trim()}>
                发送
              </button>
            </>
          )}
        </div>
      </div>

      {/* 事项区 */}
      {activeConv && activeConv.kind !== 'chat' && (
        <div className="items-panel">
          <AnalysisItems analysis={analysis} convId={activeConv.id} onToast={showToast} refresh={reloadActive} />
        </div>
      )}
      {activeConv && activeConv.kind === 'chat' && (
        <div className="items-panel">
          <div className="card">
            <h3>💡 提示</h3>
            <div className="muted">
              自由聊天中提到需要安排的事项时,可以把对应文本转为"通知分析"会话:新建分析会话后粘贴即可生成候选日程/待办。
            </div>
          </div>
        </div>
      )}
      <Toast text={toast} />
    </div>
  )
}

function kindLabel(kind: Conversation['kind']): string {
  return { chat: '聊天', analysis: '通知分析', timetable: '课表', 'school-calendar': '校历' }[kind]
}

// ---------- 分析结果与候选卡片 ----------

function AnalysisItems({
  analysis,
  convId,
  onToast,
  refresh
}: {
  analysis: Analysis | null
  convId: string
  onToast: (s: string) => void
  refresh: () => void
}): JSX.Element {
  if (!analysis) return <div className="card"><div className="empty">尚无分析结果</div></div>
  if (analysis.status === 'failed') {
    return (
      <div className="card">
        <h3>分析失败</h3>
        <div className="muted">{analysis.error ?? '未知错误'}</div>
        <div style={{ marginTop: 8 }}>
          <button className="primary" onClick={() => void window.api.rerunAnalysis(convId)}>
            重新分析
          </button>
        </div>
      </div>
    )
  }
  const p = analysis.payload
  return (
    <>
      <div className="card">
        <div className="row">
          <h3>📋 分析结果</h3>
          <div className="spacer" />
          <span className="tag gray">v{analysis.version}</span>
        </div>
        {p.summary && <div style={{ lineHeight: 1.6 }}>{p.summary}</div>}
        {analysis.modelLabel && <div className="muted">模型:{analysis.modelLabel}</div>}
        {p.keyPoints && p.keyPoints.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {p.keyPoints.map((k, i) => (
              <div key={i} style={{ fontSize: 13, lineHeight: 1.7 }}>
                • {k}
              </div>
            ))}
          </div>
        )}
        {p.questions && p.questions.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <span className="tag warn">待确认</span>
            {p.questions.map((q, i) => (
              <div key={i} className="muted" style={{ marginTop: 4, lineHeight: 1.5 }}>
                ❓ {q}
              </div>
            ))}
          </div>
        )}
        {p.conflicts && p.conflicts.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <span className="tag warn">冲突</span>
            {p.conflicts.map((q, i) => (
              <div key={i} className="muted" style={{ marginTop: 4 }}>
                ⚠ {q}
              </div>
            ))}
          </div>
        )}
        {p.changes && p.changes.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <span className="tag warn">变更</span>
            {p.changes.map((c, i) => (
              <div key={i} className="muted" style={{ marginTop: 4 }}>
                ↻ {c.ref}: {c.change}
              </div>
            ))}
          </div>
        )}
      </div>
      {(p.actionItems ?? []).length > 0 && (
        <div className="card">
          <h3>📌 候选事项(确认后才会加入)</h3>
          <div className="column">
            {(p.actionItems ?? []).map((item, i) => (
              <CandidateCard
                key={i}
                item={item}
                candidateIndex={i}
                analysisId={analysis.id}
                onToast={onToast}
                refresh={refresh}
              />
            ))}
          </div>
        </div>
      )}
      {(p.actionItems ?? []).length === 0 && (
        <div className="card">
          <h3>📌 候选事项</h3>
          <div className="empty">本次分析没有识别出需要安排的事项</div>
        </div>
      )}
    </>
  )
}

function CandidateCard({
  item: initial,
  candidateIndex,
  analysisId,
  onToast,
  refresh
}: {
  item: ActionCandidate
  candidateIndex: number
  analysisId: string
  onToast: (s: string) => void
  refresh: () => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [item, setItem] = useState<ActionCandidate>(initial)
  const [done, setDone] = useState<null | 'created' | 'duplicate'>(null)

  const confirm = async (): Promise<void> => {
    // candidateIndex 供邮箱分析确认幂等映射使用;普通分析不受影响
    const r = await window.api.confirmAnalysisItem(analysisId, { ...item, candidateIndex })
    setDone(r.result)
    onToast(r.result === 'duplicate' ? '该事项已存在,未重复添加' : r.refType === 'event' ? '已加入日历' : '已加入待办')
    refresh()
  }

  const defer = async (): Promise<void> => {
    await window.api.deferAnalysisItem(analysisId, item)
    setDone('created')
    onToast('已放入"待处理"列表')
    refresh()
  }

  if (done) {
    return (
      <div className="candidate" style={{ opacity: 0.65 }}>
        <div className="title-line">
          {item.title} <span className="tag ok">{done === 'duplicate' ? '已存在' : '已保存'}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="candidate">
      <div className="title-line">
        {item.title} <span className="tag">{item.type === 'event' ? '日程' : '待办'}</span>
        {item.confidence === 'low' && <span className="tag warn">低置信</span>}
      </div>
      {item.participants && item.participants.length > 0 && (
        <div className="title-line">
          {item.participants.map((p) => (
            <span key={p} className="tag gray">
              👤 {p}
            </span>
          ))}
        </div>
      )}
      {editing ? (
        <div className="field-grid">
          <label>类型</label>
          <select value={item.type} onChange={(e) => setItem({ ...item, type: e.target.value as 'todo' | 'event' })}>
            <option value="todo">待办</option>
            <option value="event">日程</option>
          </select>
          <label>{item.type === 'event' ? '开始' : '截止'}</label>
          <input
            type="datetime-local"
            value={toInputValue(item.type === 'event' ? item.start : item.deadline)}
            onChange={(e) =>
              setItem(item.type === 'event' ? { ...item, start: e.target.value } : { ...item, deadline: e.target.value })
            }
          />
          {item.type === 'event' && (
            <>
              <label>耗时(分)</label>
              <input
                type="number"
                value={item.durationMinutes ?? ''}
                onChange={(e) => setItem({ ...item, durationMinutes: e.target.value ? Number(e.target.value) : null })}
              />
            </>
          )}
          <label>地点</label>
          <input value={item.location ?? ''} onChange={(e) => setItem({ ...item, location: e.target.value })} />
          <label>备注</label>
          <input value={item.notes ?? ''} onChange={(e) => setItem({ ...item, notes: e.target.value })} />
        </div>
      ) : (
        <div className="muted" style={{ lineHeight: 1.6 }}>
          {item.type === 'event' ? `开始:${item.start ?? '(未定)'}` : `截止:${item.deadline ?? '(未定)'}`}
          {item.durationMinutes ? ` · 约${item.durationMinutes}分钟` : ''}
          {item.location ? ` · @${item.location}` : ''}
          {item.sourceRef ? ` · 出处:${item.sourceRef}` : ''}
          {item.notes ? <div>{item.notes}</div> : null}
        </div>
      )}
      <div className="row">
        {editing ? (
          <>
            <button className="primary" onClick={() => void confirm()}>
              确认加入
            </button>
            <button onClick={() => setEditing(false)}>取消</button>
          </>
        ) : (
          <>
            <button className="primary" onClick={() => void confirm()}>
              ✅ 加入
            </button>
            <button onClick={() => setEditing(true)}>修改 / 自行填写</button>
            <button onClick={() => void defer()}>暂不处理</button>
          </>
        )}
      </div>
    </div>
  )
}

function toInputValue(iso: string | null | undefined): string {
  if (!iso) return nowLocalIso().slice(0, 16)
  return iso.slice(0, 16)
}
