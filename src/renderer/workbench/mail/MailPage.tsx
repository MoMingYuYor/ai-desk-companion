// 邮箱工作台:inbox(收件为主,工具行+双栏) / manage(邮箱管理)两个页内视图
import { useEffect, useRef, useState } from 'react'
import type { Analysis } from '../../../shared/types'
import type { MailApi, MailAnalysisHistoryApi, MailSubscribe } from '../../../shared/mail'
import { useMailbox } from './useMailbox'
import { MailManagerView } from './MailManagerView'
import { MailList } from './MailList'
import { MailDetailView } from './MailDetailView'
import { Toast, useToast } from '../../shared/util'
import './mail.css'

interface Props {
  api: MailApi
  subscribe: MailSubscribe
  /** 打开分析会话(跳转到聊天页对应会话) */
  onOpenConversation?: (conversationId: string) => void
  /** 历史分析查询(C 提供 DAO、R 注入桥接);缺省时不展示历史版本下拉 */
  historyApi?: MailAnalysisHistoryApi
  /** 来源定位(待办/日历页 MailSourceCard 反向导航) */
  onOpenSource?: (sourceKey: string) => void
}

type MailView = 'inbox' | 'manage'

export function MailPage({ api, subscribe, onOpenConversation, historyApi, onOpenSource }: Props): JSX.Element {
  const mb = useMailbox(api, subscribe)
  const [view, setView] = useState<MailView>('inbox')
  const [history, setHistory] = useState<Analysis[]>([])
  const [toast, showToast] = useToast()

  // 历史分析版本:会话确定或新一轮分析完成后加载
  useEffect(() => {
    setHistory([])
    const conversationId = mb.conversationId
    if (!historyApi || !conversationId) return
    let cancelled = false
    historyApi
      .listAnalyses(conversationId)
      .then((list) => {
        if (!cancelled) setHistory(list)
      })
      .catch(() => {
        // 历史加载失败不阻塞详情展示
      })
    return () => {
      cancelled = true
    }
  }, [historyApi, mb.conversationId, mb.analysisStatus?.analysisId])

// 还没有账号时直接落在管理视图,完成首次添加;只在首次加载判断一次,
// 避免保存后刷新的中间态(账号仍为空)把刚切回的收件箱又覆盖掉
const bootstrappedRef = useRef(false)
useEffect(() => {
  if (mb.accountsLoading || bootstrappedRef.current) return
  bootstrappedRef.current = true
  if (mb.accounts.length === 0) setView('manage')
}, [mb.accountsLoading, mb.accounts.length])

  const handleAccountsChanged = (): void => {
    void mb.refreshAccounts()
    void mb.refreshList()
  }

  const handleSaved = (): void => {
    handleAccountsChanged()
    setView('inbox')
  }

  const openLink = (url: string): void => {
    if (!mb.activeId) return
    void api.openLink(mb.activeId, url)
  }

  // 发件走网页版:跟随当前选中的账号
  const openWebmail = (): void => {
    const account = mb.accounts.find((a) => a.id === mb.accountIdFilter)
    if (!account) return
    void api.openWebmail(account.email)
  }

  const loadEarlier = async (): Promise<void> => {
    if (mb.accountIdFilter === 'all') return
    // 加载更早邮件失败要给出提示,不能裸 await 静默吞掉
    try {
      const res = await api.earlier(mb.accountIdFilter)
      if (res.ok) handleAccountsChanged()
      else showToast(`加载更早邮件失败:${res.message}`)
    } catch (err) {
      showToast(`加载更早邮件失败:${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const selectedAccount = mb.accounts.find((a) => a.id === mb.accountIdFilter) ?? null

  if (view === 'manage') {
    return (
      <div className="mail-page">
        {mb.error && (
          <div className="mail-error" role="alert">
            <span>{mb.error}</span>
            <span className="spacer" />
            <button type="button" onClick={mb.clearError}>
              知道了
            </button>
          </div>
        )}
        <div className="mail-manager-header">
          <button type="button" onClick={() => setView('inbox')}>
            ← 返回收件箱
          </button>
          <h3>邮箱管理</h3>
        </div>
        <MailManagerView
          api={api}
          accounts={mb.accounts}
          loading={mb.accountsLoading}
          onAccountsChanged={handleAccountsChanged}
          onSaved={handleSaved}
        />
      </div>
    )
  }

  return (
    <div className="mail-page">
      {mb.error && (
        <div className="mail-error" role="alert">
          <span>{mb.error}</span>
          <span className="spacer" />
          <button type="button" onClick={mb.clearError}>
            知道了
          </button>
        </div>
      )}
      <div className="mail-toolbar">
        <select
          aria-label="账号筛选"
          value={mb.accountIdFilter}
          onChange={(e) => mb.setAccountFilter(e.target.value)}
        >
          <option value="all">全部账号</option>
          {mb.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}({a.email})
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!selectedAccount}
          title={selectedAccount ? `在浏览器打开 ${selectedAccount.email} 的网页版发件` : '先在左侧下拉选择一个具体账号'}
          onClick={openWebmail}
        >
          🔗 网页版邮箱
        </button>
        <input
          className="mail-search"
          type="search"
          placeholder="搜索邮件…"
          aria-label="搜索邮件"
          value={mb.search}
          onChange={(e) => mb.setSearch(e.target.value)}
        />
        <label className="mail-unread-toggle">
          <input type="checkbox" checked={mb.unreadOnly} onChange={mb.toggleUnreadOnly} />
          只看未读
        </label>
        <span className="spacer" />
        <button type="button" onClick={() => setView('manage')}>
          管理邮箱
        </button>
      </div>
      <div className="mail-columns">
        <MailList
          items={mb.items}
          activeId={mb.activeId}
          onSelect={(id) => void mb.selectMessage(id)}
          hasMore={mb.hasMore}
          onLoadMore={() => void mb.loadMore()}
          onLoadEarlier={() => void loadEarlier()}
          loadEarlierDisabled={mb.accountIdFilter === 'all'}
          unreadOnly={mb.unreadOnly}
          search={mb.search}
          loading={mb.listLoading}
          showAccountLabel={mb.accountIdFilter === 'all'}
        />
        <MailDetailView
          detail={mb.detail}
          loading={mb.detailLoading}
          conversationId={mb.conversationId}
          analysisStatus={mb.analysisStatus}
          analysisHistory={history}
          onAnalyze={(ids) => void mb.analyze(ids)}
          onCancelAnalysis={() => void mb.cancelAnalysis()}
          onMarkRead={(read) => void mb.markRead(read)}
          onOpenLink={openLink}
          onDownload={(attachmentId) => void api.download(attachmentId)}
          onSaveAttachment={(attachmentId) => void api.saveAttachment(attachmentId)}
          onOpenConversation={(conversationId) => onOpenConversation?.(conversationId)}
          onOpenSource={(sourceKey) => onOpenSource?.(sourceKey)}
        />
      </div>
      <Toast text={toast} />
    </div>
  )
}
