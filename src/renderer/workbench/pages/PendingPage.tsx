import { useCallback, useEffect, useState } from 'react'
import type { PendingItem } from '../../../shared/types'
import type { ResolvePendingCommand } from '../../../shared/api'
import { Toast, useSubscribe, useToast } from '../../shared/util'

interface Props {
  refreshKey: number
}

/** 操作 ID:用户开始一次确定操作(打开预览)时生成;失败重试复用同一 ID(契约第 7 节) */
function newOperationId(): string {
  const c = typeof crypto !== 'undefined' ? (crypto as { randomUUID?: () => string }) : undefined
  return c?.randomUUID?.() ?? 'op-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

interface HourSlot {
  start: string
  end: string
}

/** 最近空闲整点:一次计算,开始取下一个整点,结束建议 30 分钟(缺结束时间只在预览建议) */
function nextHourSlot(): HourSlot {
  const d = new Date()
  d.setMinutes(0, 0, 0)
  d.setHours(d.getHours() + 1)
  const pad = (n: number): string => (n < 10 ? '0' + n : String(n))
  const start = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`
  const endDate = new Date(start)
  endDate.setMinutes(endDate.getMinutes() + 30)
  const end = `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())}T${pad(endDate.getHours())}:${pad(endDate.getMinutes())}`
  return { start, end }
}

export function PendingPage({ refreshKey }: Props): JSX.Element {
  const [items, setItems] = useState<PendingItem[]>([])
  const [toast, showToast] = useToast()
  // 转为日程的编辑预览;operationId 在打开预览时生成
  const [preview, setPreview] = useState<PendingItem | null>(null)
  const [operationId, setOperationId] = useState('')

  const reload = useCallback((): void => {
    void window.api.listPending().then(setItems)
  }, [])

  useEffect(() => {
    reload()
  }, [reload, refreshKey])

  useSubscribe('evt:data-changed', useCallback(() => reload(), [reload]))

  const toTodo = async (p: PendingItem): Promise<void> => {
    try {
      const epoch = await window.api.getWorkspaceEpoch()
      const result = await window.api.resolveExistingPending?.({
        context: { operationId: newOperationId(), expectedRevision: p.revision, workspaceEpoch: epoch },
        pendingId: p.id,
        decision: 'create_todo',
        todo: { title: p.title, notes: p.notes ?? null }
      })
      if (!result) {
        showToast('当前版本尚未接入转换命令,请更新应用')
        return
      }
      if (!result.ok) {
        showToast('转换失败:' + result.error.message)
        return
      }
      reload()
      showToast('已转为待办')
    } catch (err) {
      showToast('转换失败:' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const openEventPreview = (p: PendingItem): void => {
    setOperationId(newOperationId())
    setPreview(p)
  }

  return (
    <div className="page" style={{ flexDirection: 'column' }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>📥 待处理</h3>
        <span className="muted">暂未决定的事项:读完通知后先放一放,之后可以补充材料继续讨论</span>
      </div>
      <div className="card" style={{ flex: 1 }}>
        {items.length === 0 && <div className="empty">没有待处理事项。分析结果中点"暂不处理"的事项会出现在这里。</div>}
        {items.map((p) => (
          <div key={p.id} className="todo-item">
            <div style={{ flex: 1 }}>
              <div>{p.title}</div>
              {p.notes && <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>{p.notes}</div>}
            </div>
            <button onClick={() => void toTodo(p)}>转为待办</button>
            <button onClick={() => openEventPreview(p)}>转为日程</button>
            <button
              className="ghost danger"
              onClick={async () => {
                await window.api.deletePending(p.id)
                reload()
              }}
            >
              删除
            </button>
          </div>
        ))}
      </div>
      {preview && (
        <ConvertEventDialog
          pending={preview}
          operationId={operationId}
          onClose={() => setPreview(null)}
          onSuccess={() => {
            setPreview(null)
            reload()
            showToast('已按最近空闲整点加入日历,可在日历中调整时间')
          }}
        />
      )}
      <Toast text={toast} />
    </div>
  )
}

/**
 * "转换为日程"预览对话框:确认才调用一次原子命令,取消不落库。
 * 命令失败时保留编辑内容与错误原因,可复用同一 operationId 重试。
 */
function ConvertEventDialog({
  pending,
  operationId,
  onClose,
  onSuccess
}: {
  pending: PendingItem
  operationId: string
  onClose: () => void
  onSuccess: () => void
}): JSX.Element {
  // 时段一次性计算:开始为最近空闲整点,结束建议 30 分钟
  const [slot] = useState<HourSlot>(nextHourSlot)
  const [title, setTitle] = useState(pending.title)
  const [startAt, setStartAt] = useState(slot.start)
  const [endAt, setEndAt] = useState(slot.end)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const confirm = async (): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const epoch = await window.api.getWorkspaceEpoch()
      const command: ResolvePendingCommand = {
        context: { operationId, expectedRevision: pending.revision, workspaceEpoch: epoch },
        pendingId: pending.id,
        decision: 'create_event',
        event: { title: title.trim(), startAt, endAt, notes: pending.notes ?? null }
      }
      const result = await window.api.resolveExistingPending?.(command)
      if (!result) {
        setError('当前版本尚未接入转换命令,请更新应用')
        return
      }
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="转换为日程" onClick={(e) => e.stopPropagation()}>
        <h3>转换为日程</h3>
        <div className="form-grid">
          <label htmlFor="convert-title">标题</label>
          <input id="convert-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          <label htmlFor="convert-start">开始时间</label>
          <input id="convert-start" type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
          <label htmlFor="convert-end">结束时间</label>
          <input id="convert-end" type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} />
        </div>
        <div className="muted" style={{ marginTop: 6 }}>
          待处理条目没有结束时间,这里建议 30 分钟,可自行调整;确认后加入日历。
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          {error && (
            <span role="alert" style={{ color: '#e5534b', marginRight: 'auto', alignSelf: 'center' }}>
              {error}
            </span>
          )}
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => void confirm()} disabled={submitting}>
            确认加入日历
          </button>
        </div>
      </div>
    </div>
  )
}
