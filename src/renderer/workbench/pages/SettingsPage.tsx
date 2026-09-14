import { useCallback, useEffect, useState } from 'react'
import type { AppInfo, ProviderInfo, ProviderInput, ProviderTestResult } from '../../../shared/types'
import { Toast, useSubscribe, useToast } from '../../shared/util'

interface Props {
  refreshKey: number
}

export function SettingsPage({ refreshKey }: Props): JSX.Element {
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [editor, setEditor] = useState<ProviderInput | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [toast, showToast] = useToast()
  const [notice, setNotice] = useState('')

  const reload = useCallback((): void => {
    void window.api.listProviders().then(setProviders)
    void window.api.getAppInfo().then(setInfo)
  }, [])

  useEffect(() => {
    reload()
  }, [reload, refreshKey])

  useSubscribe('evt:data-changed', useCallback(() => reload(), [reload]))

  const del = async (id: string): Promise<void> => {
    await window.api.deleteProvider(id)
    reload()
    showToast('已删除')
  }

  return (
    <div className="page" style={{ flexDirection: 'column' }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>⚙️ 设置</h3>
        <div className="spacer" />
        <button
          className="primary"
          onClick={() =>
            setEditor({
              name: '',
              baseUrl: '',
              protocol: 'chat-completions',
              models: [],
              defaultModel: '',
              supportsVision: true,
              isDefault: providers.length === 0
            })
          }
        >
          + 添加模型服务
        </button>
      </div>

      <div className="card" style={{ flex: 1 }}>
        <h3>模型服务</h3>
        <div className="muted" style={{ marginBottom: 10 }}>
          配置你自己的模型 API(OpenAI 兼容 / Responses 协议)。默认模型用于日常分析;访问失败时按下方顺序自动切换备用模型,桌宠会弹出提示。
          API Key 通过系统安全存储加密保存。
        </div>
        {providers.length === 0 && <div className="empty">尚未配置模型服务。拖入通知分析前,请先在这里添加一个默认模型。</div>}
        {providers.map((p, idx) => (
          <div key={p.id} className="provider-card">
            <div className="row">
              <b>{p.name}</b>
              {p.isDefault ? <span className="tag ok">默认</span> : <span className="tag gray">备用 {idx}</span>}
              {p.supportsVision ? <span className="tag">多模态</span> : <span className="tag warn">仅文本</span>}
              <div className="spacer" />
              {!p.isDefault && (
                <button onClick={async () => { await window.api.setDefaultProvider(p.id); reload() }}>设为默认</button>
              )}
              <button
                onClick={() =>
                  setEditor({
                    id: p.id,
                    name: p.name,
                    baseUrl: p.baseUrl,
                    protocol: p.protocol,
                    models: p.models,
                    defaultModel: p.defaultModel,
                    supportsVision: p.supportsVision,
                    isDefault: p.isDefault
                  })
                }
              >
                编辑
              </button>
              <button className="ghost danger" onClick={() => void del(p.id)}>
                删除
              </button>
            </div>
            <div className="muted">
              {p.baseUrl || '(未填接口地址)'} · 模型:{p.defaultModel || '(未设置默认模型)'} · 协议:
              {p.protocol === 'responses' ? 'Responses' : 'Chat Completions'} · Key:{p.hasApiKey ? '已保存' : '未设置'}
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3>数据</h3>
        <div className="row">
          <button
            className="primary"
            onClick={async () => {
              const path = await window.api.exportBackup()
              setNotice(path ? `已导出到 ${path}` : '已取消')
            }}
          >
            导出备份
          </button>
          <button
            onClick={async () => {
              const ok = await window.api.importBackup()
              if (ok) setNotice('备份已恢复(密钥与模型配置不受影响)')
            }}
          >
            导入备份(替换数据)
          </button>
        </div>
        {notice && <div className="muted" style={{ marginTop: 8 }}>{notice}</div>}
        {info && (
          <div className="muted" style={{ marginTop: 8 }}>
            数据目录:{info.dataDir} · 版本 {info.version} · Electron {info.electron}
          </div>
        )}
      </div>

      {editor && (
        <ProviderEditor
          initial={editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null)
            reload()
            showToast('已保存')
          }}
        />
      )}
      <Toast text={toast} />
    </div>
  )
}

function ProviderEditor({
  initial,
  onClose,
  onSaved
}: {
  initial: ProviderInput
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const [form, setForm] = useState<ProviderInput>(initial)
  const [apiKey, setApiKey] = useState('')
  const [modelsText, setModelsText] = useState(initial.models.join('\n'))
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null)

  const submit = async (): Promise<void> => {
    const models = modelsText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    await window.api.saveProvider({
      ...form,
      models,
      defaultModel: form.defaultModel || models[0] || '',
      apiKey: apiKey || undefined
    })
    onSaved()
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{initial.id ? '编辑模型服务' : '添加模型服务'}</h3>
        <div className="form-grid">
          <label>名称</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如 DeepSeek / 通义 / 自建网关" autoFocus />
          <label>接口地址</label>
          <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="如 https://api.deepseek.com/v1" />
          <label>API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={initial.id ? '留空则不修改' : 'sk-…'}
          />
          <label>接口协议</label>
          <select value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value as ProviderInput['protocol'] })}>
            <option value="chat-completions">Chat Completions(OpenAI 兼容)</option>
            <option value="responses">Responses</option>
          </select>
          <label>支持图片</label>
          <input
            type="checkbox"
            checked={form.supportsVision}
            onChange={(e) => setForm({ ...form, supportsVision: e.target.checked })}
          />
          <label>模型列表</label>
          <textarea
            rows={4}
            value={modelsText}
            onChange={(e) => setModelsText(e.target.value)}
            placeholder="每行一个模型 ID;或点击右侧自动获取"
          />
          <label />
          <button
            onClick={async () => {
              try {
                const list = await window.api.fetchModels({ baseUrl: form.baseUrl, apiKey: apiKey || undefined, providerId: form.id })
                setModelsText(list.join('\n'))
                if (list.length > 0 && !form.defaultModel) setForm((f) => ({ ...f, defaultModel: list[0] }))
              } catch (err) {
                setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
              }
            }}
            disabled={!form.baseUrl}
          >
            自动获取模型列表
          </button>
          <label>默认模型</label>
          <select value={form.defaultModel} onChange={(e) => setForm({ ...form, defaultModel: e.target.value })}>
            <option value="">(选择)</option>
            {form.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <label>设为默认</label>
          <input type="checkbox" checked={!!form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} />
        </div>
        <div className="row">
          <button
            onClick={async () => {
              setTesting(true)
              setTestResult(null)
              try {
                const models = modelsText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
                const r = await window.api.testProvider({ ...form, models, defaultModel: form.defaultModel || models[0] || '', apiKey: apiKey || undefined })
                setTestResult(r)
              } finally {
                setTesting(false)
              }
            }}
            disabled={testing}
          >
            {testing ? '测试中…' : '测试连接'}
          </button>
          {testResult && (
            <span className={`muted ${testResult.ok ? '' : 'danger'}`} style={{ color: testResult.ok ? 'var(--ok)' : 'var(--danger)' }}>
              {testResult.ok ? `连接成功(${testResult.latencyMs}ms)` : testResult.error}
            </span>
          )}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => void submit()} disabled={!form.name || !form.baseUrl}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
