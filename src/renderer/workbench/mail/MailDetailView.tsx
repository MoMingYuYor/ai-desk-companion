// 安全阅读详情:正文(safeHtml 由主进程清理)、附件、手动分析与历史版本导航
import { useEffect, useState } from 'react'
import type { MailAnalysisStatus, MailDetail } from '../../../shared/mail'
import type { Analysis } from '../../../shared/types'
import { formatBytes, formatFullTime } from './format'

interface Props {
  detail: MailDetail | null
  loading: boolean
  /** 当前邮件关联的分析会话 id(来自 useMailbox;MailDetail 本身不含此字段) */
  conversationId: string | null
  analysisStatus: MailAnalysisStatus | null
  analysisHistory: Analysis[]
  onAnalyze: (attachmentIds: string[]) => void
  onCancelAnalysis: () => void
  onMarkRead: (read: boolean) => void
  onOpenLink: (url: string) => void
  onDownload: (attachmentId: string) => void
  onSaveAttachment: (attachmentId: string) => void
  onOpenConversation: (conversationId: string) => void
  /** 预留:来源定位(待办/日历页 MailSourceCard 的反向导航入口) */
  onOpenSource: (sourceKey: string) => void
}

const ANALYSIS_STATE_TEXT: Record<MailAnalysisStatus['state'], string> = {
  preparing: '正在准备分析…',
  running: '正在分析附件…',
  done: '分析完成',
  failed: '分析失败',
  cancelled: '已取消分析'
}

function historyStatusLabel(status: Analysis['status']): string {
  return status === 'done' ? '完成' : status === 'failed' ? '失败' : '进行中'
}

export function MailDetailView({
  detail,
  loading,
  conversationId,
  analysisStatus,
  analysisHistory,
  onAnalyze,
  onCancelAnalysis,
  onMarkRead,
  onOpenLink,
  onDownload,
  onSaveAttachment,
  onOpenConversation,
  onOpenSource
}: Props): JSX.Element {
  const [checked, setChecked] = useState<Set<string>>(() => new Set())
  const [historyIdx, setHistoryIdx] = useState(-1)

  // 切换邮件时重置勾选与历史版本选择
  const messageId = detail?.message.id ?? null
  useEffect(() => {
    setChecked(new Set())
    setHistoryIdx(-1)
  }, [messageId])

  if (!detail) {
    return (
      <section className="mail-detail" aria-label="邮件详情">
        <div className="empty">{loading ? '正在加载邮件…' : '选择一封邮件查看详情'}</div>
      </section>
    )
  }

  const m = detail.message
  const analyzing = analysisStatus?.state === 'preparing' || analysisStatus?.state === 'running'
  const selectedIds = detail.attachments.filter((a) => a.analyzable && checked.has(a.id)).map((a) => a.id)
  const selectedHistory = historyIdx >= 0 && historyIdx < analysisHistory.length ? analysisHistory[historyIdx] : null

  const toggle = (id: string): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <section className="mail-detail" aria-label="邮件详情">
      <div className="mail-detail-head">
        <h2>{m.subject || '(无主题)'}</h2>
        <div className="mail-detail-meta">
          <span>{m.from}</span>
          <span className="muted">{formatFullTime(m.receivedAt)}</span>
          <span className="tag gray">{m.accountLabel}</span>
          <span className="spacer" />
          <button type="button" onClick={() => onMarkRead(!m.read)}>
            {m.read ? '标记为未读' : '标记为已读'}
          </button>
        </div>
      </div>

      {analysisStatus && (
        <div className={`mail-analysis-bubble ${analysisStatus.state}`}>
          {analyzing && (
            <span className="mail-spin" aria-hidden="true">
              ◌
            </span>
          )}
          <span>{ANALYSIS_STATE_TEXT[analysisStatus.state]}</span>
          {analysisStatus.state === 'failed' && analysisStatus.error && <span>{analysisStatus.error}</span>}
          {analyzing && (
            <button type="button" onClick={onCancelAnalysis}>
              取消分析
            </button>
          )}
        </div>
      )}

      {detail.attachments.length > 0 && (
        <div className="mail-attachments">
          <h3>附件({detail.attachments.length})</h3>
          {detail.attachments.map((a) => (
            <div key={a.id} className="mail-attach-row">
              <label
                className="mail-attach-check"
                title={a.analyzable ? '勾选后可进行 AI 分析' : '该附件格式不支持 AI 分析'}
              >
                <input
                  type="checkbox"
                  checked={checked.has(a.id)}
                  disabled={!a.analyzable || analyzing}
                  onChange={() => toggle(a.id)}
                />
                <span className="mail-attach-name">{a.name}</span>
              </label>
              <span className="muted">
                {a.mime}
                {a.size != null ? ` · ${formatBytes(a.size)}` : ''}
                {!a.analyzable ? ' · 不可分析' : ''}
              </span>
              <span className="spacer" />
              <button type="button" onClick={() => onDownload(a.id)}>
                下载
              </button>
              <button type="button" onClick={() => onSaveAttachment(a.id)}>
                保存
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mail-actions">
        <button
          type="button"
          className="primary"
          disabled={selectedIds.length === 0 || analyzing}
          onClick={() => onAnalyze(selectedIds)}
        >
          AI 分析
        </button>
        {selectedIds.length === 0 && <span className="muted">先勾选要分析的附件</span>}
      </div>

      {detail.safeHtml ? (
        // safeHtml 由主进程 sanitize 后提供(契约约定),此处直接注入
        <div className="mail-body-html" dangerouslySetInnerHTML={{ __html: detail.safeHtml }} />
      ) : detail.text ? (
        <div className="mail-body-text">{detail.text}</div>
      ) : (
        <div className="empty">(此邮件没有正文内容)</div>
      )}

      {detail.links.length > 0 && (
        <div className="mail-links">
          <h3>链接({detail.links.length})</h3>
          {detail.links.map((l, i) => (
            <a
              key={i}
              href={l.url}
              onClick={(e) => {
                e.preventDefault()
                onOpenLink(l.url)
              }}
            >
              {l.label || l.url}
            </a>
          ))}
        </div>
      )}

      {(analysisHistory.length > 0 || conversationId) && (
        <div className="mail-history">
          {analysisHistory.length > 0 && (
            <>
              <select
                aria-label="分析历史版本"
                value={String(historyIdx)}
                onChange={(e) => setHistoryIdx(Number(e.target.value))}
              >
                <option value="-1">选择版本查看说明…</option>
                {analysisHistory.map((a, i) => (
                  <option key={a.id} value={String(i)}>
                    v{a.version} · {formatFullTime(a.createdAt)} · {historyStatusLabel(a.status)}
                  </option>
                ))}
              </select>
              {selectedHistory && (
                <div className="mail-history-summary">
                  {selectedHistory.payload.summary ||
                    selectedHistory.payload.title ||
                    '(该版本没有说明文字,请打开分析会话查看)'}
                </div>
              )}
            </>
          )}
          {conversationId && (
            <div>
              <button type="button" onClick={() => onOpenConversation(conversationId)}>
                查看分析会话
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
