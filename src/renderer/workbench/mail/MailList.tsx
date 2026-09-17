// 统一收件列表:搜索/未读筛选/分页与邮件行
import type { MailSummary } from '../../../shared/mail'
import { formatMailTime } from './format'

interface Props {
  items: MailSummary[]
  activeId: string | null
  onSelect: (id: string) => void
  hasMore: boolean
  onLoadMore: () => void
  unreadOnly: boolean
  onToggleUnread: () => void
  search: string
  onSearch: (value: string) => void
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
  unreadOnly,
  onToggleUnread,
  search,
  onSearch,
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
      <div className="mail-list-toolbar">
        <input
          className="mail-search"
          type="search"
          placeholder="搜索邮件…"
          aria-label="搜索邮件"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
        <label className="mail-unread-toggle">
          <input type="checkbox" checked={unreadOnly} onChange={onToggleUnread} />
          只看未读
        </label>
      </div>
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
      {hasMore && items.length > 0 && (
        <button type="button" className="mail-load-more" disabled={loading} onClick={onLoadMore}>
          {loading ? '加载中…' : '加载更多'}
        </button>
      )}
    </section>
  )
}
