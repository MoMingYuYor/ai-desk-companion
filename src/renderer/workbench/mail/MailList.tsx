// 统一收件列表:邮件行/分页/拉取更早;搜索与未读筛选的控件在页面工具行
import type { MailSummary } from '../../../shared/mail'
import { formatMailTime } from './format'

interface Props {
  items: MailSummary[]
  activeId: string | null
  onSelect: (id: string) => void
  hasMore: boolean
  onLoadMore: () => void
  /** 拉取服务器上更早的邮件(需选定具体账号) */
  onLoadEarlier?: () => void
  loadEarlierDisabled?: boolean
  /** 仅用于空态文案,控件在页面工具行 */
  unreadOnly: boolean
  search: string
  loading: boolean
  /** 账号筛选为"全部账号"时,行内显示账号 label 徽标 */
  showAccountLabel?: boolean
}

export function MailList({
  items,
  activeId,
  onSelect,
  hasMore,
  onLoadMore,
  onLoadEarlier,
  loadEarlierDisabled,
  unreadOnly,
  search,
  loading,
  showAccountLabel
}: Props): JSX.Element {
  const emptyText = loading
    ? '加载中…'
    : search.trim()
      ? '没有匹配的邮件'
      : unreadOnly
        ? '没有未读邮件'
        : '收件箱为空'

  return (
    <section className="mail-list" aria-label="邮件列表">
      <div className="mail-list-items">
        {items.length === 0 && <div className="empty">{emptyText}</div>}
        {items.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`mail-item ${m.id === activeId ? 'active' : ''} ${m.read ? '' : 'unread'}`}
            onClick={() => onSelect(m.id)}
          >
            <span className="mail-item-line1">
              {!m.read && <span className="mail-unread-dot" title="未读" />}
              <span className="mail-item-from">{m.from}</span>
              <span className="mail-item-time">{formatMailTime(m.receivedAt)}</span>
            </span>
            <span className="mail-item-line2">
              <span className="mail-item-subject">{m.subject || '(无主题)'}</span>
              {m.hasAttachments && (
                <span className="mail-attach-mark" title="含附件">
                  📎
                </span>
              )}
              {showAccountLabel && <span className="tag gray mail-account-badge">{m.accountLabel}</span>}
            </span>
          </button>
        ))}
      </div>
      {(hasMore || onLoadEarlier) && items.length > 0 && (
        <div className="mail-list-footer">
          {hasMore && (
            <button type="button" className="mail-load-more" disabled={loading} onClick={onLoadMore}>
              {loading ? '加载中…' : '加载更多'}
            </button>
          )}
          {onLoadEarlier && (
            <button
              type="button"
              className="mail-load-more"
              disabled={loading || loadEarlierDisabled}
              title={loadEarlierDisabled ? '先在上方选择一个具体账号,再拉取服务器上更早的邮件' : undefined}
              onClick={onLoadEarlier}
            >
              加载更早邮件
            </button>
          )}
        </div>
      )}
    </section>
  )
}
