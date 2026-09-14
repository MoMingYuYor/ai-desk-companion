import { useCallback, useEffect, useState } from 'react'
import type { ProfileFact } from '../../../shared/types'
import { Toast, useSubscribe, useToast } from '../../shared/util'

interface Props {
  refreshKey: number
}

const CATEGORIES: Array<{ key: ProfileFact['category']; label: string; hint: string }> = [
  { key: 'basic', label: '基本资料', hint: '身份、院系、职责、参与的项目等' },
  { key: 'schedule', label: '作息与安排习惯', hint: '常用工作时段、预留准备时间等' },
  { key: 'preference', label: '偏好', hint: '如何处理各类事项的倾向' }
]

export function ProfilePage({ refreshKey }: Props): JSX.Element {
  const [facts, setFacts] = useState<ProfileFact[]>([])
  const [category, setCategory] = useState<ProfileFact['category']>('basic')
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [toast, showToast] = useToast()

  const reload = useCallback((): void => {
    void window.api.listProfile().then(setFacts)
  }, [])

  useEffect(() => {
    reload()
  }, [reload, refreshKey])

  useSubscribe('evt:data-changed', useCallback(() => reload(), [reload]))

  const add = async (): Promise<void> => {
    if (!key.trim() || !value.trim()) return
    await window.api.saveProfile({ category, key: key.trim(), value: value.trim() })
    setKey('')
    setValue('')
    reload()
    showToast('已保存,之后的分析会使用这些信息')
  }

  const suggestions = facts.filter((f) => f.source === 'suggested' && f.status === 'pending')

  return (
    <div className="page" style={{ flexDirection: 'column' }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>👤 个人画像</h3>
        <span className="muted">明确填写的资料直接生效;从聊天中推测的偏好需要你确认</span>
      </div>

      {/* 偏好更新建议 */}
      {suggestions.length > 0 && (
        <div className="card" style={{ marginBottom: 10 }}>
          <h3>🔔 待确认的偏好建议</h3>
          {suggestions.map((f) => (
            <div key={f.id} className="list-row">
              <span className="tag warn">建议</span>
              <span style={{ flex: 1 }}>
                {f.key}:{f.value}
              </span>
              <button
                className="primary"
                onClick={async () => {
                  await window.api.resolveProfile(f.id, true)
                  reload()
                }}
              >
                采纳
              </button>
              <button
                onClick={async () => {
                  await window.api.resolveProfile(f.id, false)
                  reload()
                }}
              >
                忽略
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 14, flex: 1, minHeight: 0 }}>
        {CATEGORIES.map((c) => (
          <div key={c.key} className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <h3>{c.label}</h3>
            <div className="muted" style={{ marginBottom: 8 }}>
              {c.hint}
            </div>
            <div style={{ flex: 1, overflow: 'auto' }}>
              {facts.filter((f) => f.category === c.key && f.status === 'confirmed' && f.source === 'explicit').length === 0 && (
                <div className="muted">暂无资料</div>
              )}
              {facts
                .filter((f) => f.category === c.key && f.status === 'confirmed' && f.source === 'explicit')
                .map((f) => (
                  <div key={f.id} className="list-row">
                    <div style={{ flex: 1 }}>
                      <b>{f.key}</b>:{f.value}
                    </div>
                    <button
                      className="ghost danger"
                      onClick={async () => {
                        await window.api.deleteProfile(f.id)
                        reload()
                      }}
                    >
                      删除
                    </button>
                  </div>
                ))}
              {facts
                .filter((f) => f.category === c.key && f.source === 'suggested' && f.status === 'confirmed')
                .map((f) => (
                  <div key={f.id} className="list-row">
                    <div style={{ flex: 1 }}>
                      <span className="tag" title="由 AI 建议并经你确认">
                        学习
                      </span>{' '}
                      <b>{f.key}</b>:{f.value}
                    </div>
                    <button
                      className="ghost danger"
                      onClick={async () => {
                        await window.api.deleteProfile(f.id)
                        reload()
                      }}
                    >
                      删除
                    </button>
                  </div>
                ))}
            </div>
            {c.key === category && (
              <div className="column" style={{ marginTop: 8 }}>
                <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="名称,如:院系" />
                <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="内容,如:计算机学院 2023 级" />
                <button className="primary" onClick={() => void add()}>
                  + 添加资料
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      <Toast text={toast} />
    </div>
  )
}
