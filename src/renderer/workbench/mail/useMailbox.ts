// 邮箱工作台状态 hook:账号/筛选/搜索防抖/分页/详情/分析状态与事件订阅
// 只依赖注入的 MailApi 与 MailSubscribe,不读取全局桥接
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  MailAccountInfo,
  MailAnalysisStatus,
  MailApi,
  MailDetail,
  MailListQuery,
  MailSubscribe,
  MailSummary
} from '../../../shared/mail'

export type MailAccountFilter = 'all' | string

export interface Mailbox {
  accounts: MailAccountInfo[]
  accountsLoading: boolean
  accountIdFilter: MailAccountFilter
  setAccountFilter: (id: MailAccountFilter) => void
  unreadOnly: boolean
  toggleUnreadOnly: () => void
  /** 搜索输入框原始值(受控) */
  search: string
  setSearch: (value: string) => void
  items: MailSummary[]
  hasMore: boolean
  listLoading: boolean
  loadMore: () => Promise<void>
  activeId: string | null
  detail: MailDetail | null
  detailLoading: boolean
  selectMessage: (id: string) => Promise<void>
  /** 当前选中邮件的分析状态(无则 null) */
  analysisStatus: MailAnalysisStatus | null
  /** 当前选中邮件关联的分析会话 id */
  conversationId: string | null
  analyze: (attachmentIds: string[]) => Promise<void>
  cancelAnalysis: () => Promise<void>
  markRead: (read: boolean) => Promise<void>
  refreshAccounts: () => Promise<void>
  refreshList: () => Promise<void>
  error: string | null
  clearError: () => void
}

export function useMailbox(api: MailApi, subscribe: MailSubscribe): Mailbox {
  const [accounts, setAccounts] = useState<MailAccountInfo[]>([])
  const [accountsLoading, setAccountsLoading] = useState(true)
  const [accountIdFilter, setAccountIdFilterState] = useState<MailAccountFilter>('all')
  const [unreadOnly, setUnreadOnlyState] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [items, setItems] = useState<MailSummary[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [listLoading, setListLoading] = useState(true)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [detail, setDetail] = useState<MailDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [analysisStatusMap, setAnalysisStatusMap] = useState<Map<string, MailAnalysisStatus>>(new Map())
  const [error, setError] = useState<string | null>(null)

  // 异步回调里读取最新筛选值,避免闭包捕获旧状态
  const filterRef = useRef<MailAccountFilter>('all')
  const unreadRef = useRef(false)
  const searchQueryRef = useRef('')
  const pageRef = useRef(0)
  const activeIdRef = useRef<string | null>(null)
  const listSeqRef = useRef(0)
  /** conversationId → messageId:evt:mail-analysis 载荷只带 conversationId,靠它映射回邮件 */
  const convToMessageRef = useRef<Map<string, string>>(new Map())
  const statusMapRef = useRef<Map<string, MailAnalysisStatus>>(new Map())

  const setAnalysisStatus = useCallback((messageId: string, status: MailAnalysisStatus): void => {
    convToMessageRef.current.set(status.conversationId, messageId)
    const next = new Map(statusMapRef.current)
    next.set(messageId, status)
    statusMapRef.current = next
    setAnalysisStatusMap(next)
  }, [])

  const loadList = useCallback(
    async (page: number, append: boolean): Promise<void> => {
      const seq = ++listSeqRef.current
      setListLoading(true)
      const query: MailListQuery = {
        accountId: filterRef.current === 'all' ? undefined : filterRef.current,
        unreadOnly: unreadRef.current || undefined,
        search: searchQueryRef.current.trim() || undefined,
        page
      }
      const res = await api.list(query)
      if (seq !== listSeqRef.current) return // 迟到的旧请求,不覆盖当前筛选结果
      setListLoading(false)
      if (!res.ok) {
        setError(res.message)
        return
      }
      setError(null)
      pageRef.current = page
      setHasMore(res.value.hasMore)
      setItems((prev) => (append ? [...prev, ...res.value.items] : res.value.items))
    },
    [api]
  )

  const refreshList = useCallback((): Promise<void> => loadList(0, false), [loadList])
  const loadMore = useCallback((): Promise<void> => loadList(pageRef.current + 1, true), [loadList])

  const refreshAccounts = useCallback(async (): Promise<void> => {
    setAccountsLoading(true)
    const res = await api.accounts()
    setAccountsLoading(false)
    if (res.ok) setAccounts(res.value)
    else setError(res.message)
  }, [api])

  const setAccountFilter = useCallback(
    (id: MailAccountFilter): void => {
      filterRef.current = id
      setAccountIdFilterState(id)
      void loadList(0, false)
    },
    [loadList]
  )

  const toggleUnreadOnly = useCallback((): void => {
    const next = !unreadRef.current
    unreadRef.current = next
    setUnreadOnlyState(next)
    void loadList(0, false)
  }, [loadList])

  // 搜索防抖 300ms;生效后回第 0 页
  useEffect(() => {
    const timer = setTimeout(() => {
      const q = searchInput.trim()
      if (q === searchQueryRef.current) return
      searchQueryRef.current = q
      void loadList(0, false)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchInput, loadList])

  const selectMessage = useCallback(
    async (id: string): Promise<void> => {
      activeIdRef.current = id
      setActiveId(id)
      setDetail(null)
      setDetailLoading(true)
      const res = await api.detail(id)
      if (activeIdRef.current !== id) return
      setDetailLoading(false)
      if (!res.ok) {
        setError(res.message)
        return
      }
      setDetail(res.value)
      setError(null)
      // 顺带取回该邮件当前的分析状态(会话关联)
      const st = await api.analysisStatus(id)
      if (activeIdRef.current !== id) return
      if (st.ok && st.value) setAnalysisStatus(id, st.value)
    },
    [api, setAnalysisStatus]
  )

  const analyze = useCallback(
    async (attachmentIds: string[]): Promise<void> => {
      const id = activeIdRef.current
      if (!id || attachmentIds.length === 0) return
      const res = await api.analyze({ messageId: id, attachmentIds })
      if (activeIdRef.current !== id) return
      if (res.ok) setAnalysisStatus(id, res.value)
      else setError(res.message)
    },
    [api, setAnalysisStatus]
  )

  const cancelAnalysis = useCallback(async (): Promise<void> => {
    const id = activeIdRef.current
    if (!id) return
    const status = statusMapRef.current.get(id)
    if (!status) return
    const res = await api.cancelAnalysis(status.conversationId)
    if (!res.ok) setError(res.message)
  }, [api])

  const markRead = useCallback(
    async (read: boolean): Promise<void> => {
      const id = activeIdRef.current
      if (!id) return
      const res = await api.markRead(id, read)
      if (!res.ok) return
      setDetail((prev) => (prev && prev.message.id === id ? { ...prev, message: { ...prev.message, read } } : prev))
      setItems((prev) => prev.map((m) => (m.id === id ? { ...m, read } : m)))
    },
    [api]
  )

  const clearError = useCallback((): void => setError(null), [])

  // 初始加载
  useEffect(() => {
    void refreshAccounts()
    void loadList(0, false)
  }, [refreshAccounts, loadList])

  // 事件订阅,卸载时全部退订
  useEffect(
    () =>
      subscribe('evt:mail-sync', (notice) => {
        setAccounts((prev) =>
          prev.map((a) =>
            a.id === notice.accountId
              ? { ...a, status: notice.status, lastSuccessAt: notice.lastSuccessAt ?? a.lastSuccessAt, error: notice.error }
              : a
          )
        )
      }),
    [subscribe]
  )

  useEffect(
    () =>
      subscribe('evt:mail-changed', () => {
        void loadList(0, false)
      }),
    [subscribe, loadList]
  )

  useEffect(
    () =>
      subscribe('evt:mail-analysis', (status) => {
        const messageId = convToMessageRef.current.get(status.conversationId)
        if (messageId) setAnalysisStatus(messageId, status)
      }),
    [subscribe, setAnalysisStatus]
  )

  const activeAnalysisStatus = activeId ? analysisStatusMap.get(activeId) ?? null : null
  const conversationId = activeAnalysisStatus?.conversationId ?? null

  return {
    accounts,
    accountsLoading,
    accountIdFilter,
    setAccountFilter,
    unreadOnly,
    toggleUnreadOnly,
    search: searchInput,
    setSearch: setSearchInput,
    items,
    hasMore,
    listLoading,
    loadMore,
    activeId,
    detail,
    detailLoading,
    selectMessage,
    analysisStatus: activeAnalysisStatus,
    conversationId,
    analyze,
    cancelAnalysis,
    markRead,
    refreshAccounts,
    refreshList,
    error,
    clearError
  }
}
