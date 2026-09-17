// 账号管理:列表/添加表单/同步/暂停恢复/移除/加载更早邮件
import { useState } from 'react'
import type { MailAccountInfo, MailAccountInput, MailApi, MailProvider } from '../../../shared/mail'
import { MAIL_LIMITS } from '../../../shared/mail'
import { formatFullTime } from './format'

const PRESETS: Record<MailProvider, { host: string; port: number }> = {
  qq: { host: 'imap.qq.com', port: 993 },
  '163': { host: 'imap.163.com', port: 993 },
  gmail: { host: 'imap.gmail.com', port: 993 },
  custom: { host: '', port: 993 }
}

const PROVIDER_LABEL: Record<MailProvider, string> = {
  qq: 'QQ 邮箱',
  '163': '网易 163',
  gmail: 'Gmail',
  custom: '自定义(IMAP)'
}

const STATUS_LABEL: Record<MailAccountInfo['status'], string> = {
  idle: '空闲',
  syncing: '同步中',
  paused: '已暂停',
  error: '错误'
}

interface Props {
  api: MailApi
  accounts: MailAccountInfo[]
  loading: boolean
  /** 'all' 或具体账号 id;用于"加载更早邮件" */
  activeAccountId: string
  onSelectAccount: (id: string) => void
  /** 保存/移除/暂停恢复/加载更早成功后通知外层刷新 */
  onAccountsChanged: () => void
}

export function MailAccountPanel({
  api,
  accounts,
  loading,
  activeAccountId,
  onSelectAccount,
  onAccountsChanged
}: Props): JSX.Element {
  const [formOpen, setFormOpen] = useState(false)
  const [provider, setProvider] = useState<MailProvider>('qq')
  const [label, setLabel] = useState('')
  const [email, setEmail] = useState('')
  const [credential, setCredential] = useState('')
  const [host, setHost] = useState(PRESETS.qq.host)
  const [port, setPort] = useState(String(PRESETS.qq.port))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const changeProvider = (p: MailProvider): void => {
    setProvider(p)
    setHost(PRESETS[p].host)
    setPort(String(PRESETS[p].port))
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    if (!label.trim() || !email.trim() || !credential.trim() || (provider === 'custom' && !host.trim())) {
      setMessage('请填写完整账号信息')
      return
    }
    setBusy(true)
    setMessage(null)
    const input: MailAccountInput = {
      label: label.trim(),
      email: email.trim(),
      provider,
      host: provider === 'custom' ? host.trim() : PRESETS[provider].host,
      port: provider === 'custom' ? Number(port) || PRESETS.custom.port : PRESETS[provider].port,
      credential
    }
    const testRes = await api.test(input)
    if (!testRes.ok) {
      setBusy(false)
      setMessage(`连接测试失败:${testRes.message}`)
      return
    }
    const saveRes = await api.save(input)
    setBusy(false)
    if (!saveRes.ok) {
      setMessage(`保存失败:${saveRes.message}`)
      return
    }
    setLabel('')
    setEmail('')
    setCredential('')
    setFormOpen(false)
    setMessage(`已添加账号「${saveRes.value.label}」`)
    onAccountsChanged()
  }

  const sync = async (id: string): Promise<void> => {
    setMessage(null)
    const res = await api.sync(id)
    if (!res.ok) setMessage(`同步失败:${res.message}`)
    else onAccountsChanged()
  }

  const toggleEnabled = async (a: MailAccountInfo): Promise<void> => {
    setMessage(null)
    const res = await api.setEnabled(a.id, !a.enabled)
    if (!res.ok) setMessage(`操作失败:${res.message}`)
    else onAccountsChanged()
  }

  const remove = async (a: MailAccountInfo): Promise<void> => {
    const confirmed = window.confirm(
      `确定移除账号「${a.label}(${a.email})」吗?\n` +
        '该账号的本地缓存邮件与待分析附件将被一并清理;已生成的分析结果、待办与日程会保留。'
    )
    if (!confirmed) return
    setMessage(null)
    const res = await api.remove(a.id)
    if (!res.ok) setMessage(`移除失败:${res.message}`)
    else onAccountsChanged()
  }

  const loadEarlier = async (): Promise<void> => {
    setMessage(null)
    if (activeAccountId === 'all') {
      setMessage('请先在上方选择一个具体账号,再加载更早的邮件')
      return
    }
    const res = await api.earlier(activeAccountId)
    if (!res.ok) setMessage(`加载更早邮件失败:${res.message}`)
    else onAccountsChanged()
  }

  return (
    <section className="mail-accounts" aria-label="邮箱账号">
      <div className="row">
        <h3>
          邮箱({accounts.length}/{MAIL_LIMITS.accounts})
        </h3>
        <span className="spacer" />
        <button type="button" onClick={() => setFormOpen((v) => !v)}>
          {formOpen ? '收起' : '+ 添加账号'}
        </button>
      </div>

      <button
        type="button"
        className={`mail-account-all ${activeAccountId === 'all' ? 'active' : ''}`}
        onClick={() => onSelectAccount('all')}
      >
        全部账号
      </button>

      {loading && <div className="muted">正在加载账号…</div>}
      {!loading && accounts.length === 0 && <div className="muted">还没有邮箱账号,点击"添加账号"开始</div>}

      {accounts.map((a) => (
        <div
          key={a.id}
          role="button"
          tabIndex={0}
          className={`mail-account-row ${activeAccountId === a.id ? 'active' : ''}`}
          onClick={() => onSelectAccount(a.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onSelectAccount(a.id)
          }}
        >
          <div className="mail-account-line">
            <span className="mail-account-label">{a.label}</span>
            <span className={`mail-status-badge ${a.status}`}>{STATUS_LABEL[a.status]}</span>
          </div>
          <div className="muted">{a.email}</div>
          <div className="muted">最近同步:{formatFullTime(a.lastSuccessAt)}</div>
          {a.error && <div className="mail-account-error">{a.error.message}</div>}
          <div className="row mail-account-actions">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                void sync(a.id)
              }}
            >
              同步
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                void toggleEnabled(a)
              }}
            >
              {a.enabled ? '暂停' : '恢复'}
            </button>
            <button
              type="button"
              className="danger"
              onClick={(e) => {
                e.stopPropagation()
                void remove(a)
              }}
            >
              移除
            </button>
          </div>
        </div>
      ))}

      <button type="button" className="mail-earlier" onClick={() => void loadEarlier()}>
        加载更早邮件
      </button>
      {message && <div className="mail-panel-message">{message}</div>}

      {formOpen && (
        <div className="mail-account-form">
          <div className="form-grid">
            <label htmlFor="mail-provider">服务商</label>
            <select
              id="mail-provider"
              value={provider}
              onChange={(e) => changeProvider(e.target.value as MailProvider)}
            >
              {(Object.keys(PROVIDER_LABEL) as MailProvider[]).map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABEL[p]}
                </option>
              ))}
            </select>
            <label htmlFor="mail-label">名称</label>
            <input
              id="mail-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="如:学习邮箱"
            />
            <label htmlFor="mail-email">邮箱地址</label>
            <input
              id="mail-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
            />
            <label htmlFor="mail-credential">授权码</label>
            <input
              id="mail-credential"
              type="password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              placeholder="IMAP 授权码,不是登录密码"
            />
            {provider === 'custom' && (
              <>
                <label htmlFor="mail-host">IMAP 服务器</label>
                <input
                  id="mail-host"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="imap.example.com"
                />
                <label htmlFor="mail-port">端口</label>
                <input
                  id="mail-port"
                  inputMode="numeric"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="993"
                />
              </>
            )}
          </div>
          {provider !== 'custom' && (
            <div className="muted">
              服务器 {PRESETS[provider].host}:{PRESETS[provider].port}(SSL)
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setFormOpen(false)}>
              取消
            </button>
            <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
              {busy ? '测试/保存中…' : '测试并保存'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
