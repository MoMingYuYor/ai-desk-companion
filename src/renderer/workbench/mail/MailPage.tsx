// 邮箱工作台顶层布局:账号区 / 列表区 / 详情区,数据全部经 useMailbox
import { useEffect, useState } from 'react'
import type { Analysis } from '../../../shared/types'
import type { MailApi, MailAnalysisHistoryApi, MailSubscribe } from '../../../shared/mail'
import { useMailbox } from './useMailbox'
import { MailAccountPanel } from './MailAccountPanel'
import { MailList } from './MailList'
import { MailDetailView } from './MailDetailView'
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

export function MailPage({ api, subscribe, onOpenConversation, historyApi, onOpenSource }: Props): JSX.Element {
  const mb = useMailbox(api, subscribe)
  const [history, setHistory] = useState<Analysis[]>([])

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

  const handleAccountsChanged = (): void => {
    void mb.refreshAccounts()
    void mb.refreshList()
  }

  const openLink = (url: string): void => {
    if (!mb.activeId) return
    void api.openLink(mb.activeId, url)
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
      <div className="mail-columns">
        <MailAccountPanel
          api={api}
          accounts={mb.accounts}
          loading={mb.accountsLoading}
          activeAccountId={mb.accountIdFilter}
          onSelectAccount={mb.setAccountFilter}
          onAccountsChanged={handleAccountsChanged}
        />
        <MailList
          items={mb.items}
          activeId={mb.activeId}
          onSelect={(id) => void mb.selectMessage(id)}
          hasMore={mb.hasMore}
          onLoadMore={() => void mb.loadMore()}
          unreadOnly={mb.unreadOnly}
          onToggleUnread={mb.toggleUnreadOnly}
          search={mb.search}
          onSearch={mb.setSearch}
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
    </div>
  )
}
