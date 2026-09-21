// 日程输入校验(Task 8 R7):主进程入口集中校验标题、可解析日期与区间有效性。
// 缺结束时间不在此建议——编辑预览建议 30 分钟、用户确认后写入;
// allowZeroLength 仅供候选确认等历史零长度路径使用。
import type { EventInput } from '../../shared/types'
import { parseLocalDateTimeMs } from '../../shared/dateUtils'
import { appError } from '../../shared/operations'
import { OperationError } from '../db/operations'

export interface ValidatedEventInput {
  title: string
  startAt: string
  endAt: string
  allDay: boolean
  location: string | null
  notes: string | null
  reminderMinutes: number | null
  /** 集中转换后的 UTC 毫秒(本地无时区串按本地时区解释) */
  startMs: number
  endMs: number
}

export interface ValidateEventOptions {
  /**
   * 允许零长度区间:缺 endAt 时按 startAt 处理且 endAt === startAt 不报错。
   * 仅用于候选确认等历史路径;面向用户的入口(预览/日历编辑)不放宽,
   * 缺结束时间由预览建议 30 分钟、用户确认后写入。
   */
  allowZeroLength?: boolean
}

function invalid(message: string): OperationError {
  return new OperationError(appError('VALIDATION', message, { retryable: false }))
}

export function validateEventInput(input: EventInput, opts: ValidateEventOptions = {}): ValidatedEventInput {
  const title = (input.title ?? '').trim()
  if (!title) throw invalid('日程标题不能为空')

  const startAt = (input.startAt ?? '').trim()
  const startMs = startAt ? parseLocalDateTimeMs(startAt) : null
  if (startMs == null) throw invalid('开始时间无效或无法解析')

  // 全天按本地日期解析:日期串经集中转换落到本地午夜;排他结束日以毫秒比较表达
  const rawEnd = input.endAt != null ? String(input.endAt).trim() : ''
  const defaultToEnd = !rawEnd && opts.allowZeroLength === true
  const endAt = defaultToEnd ? startAt : rawEnd
  const endMs = defaultToEnd ? startMs : parseLocalDateTimeMs(rawEnd)
  if (endMs == null) {
    throw invalid(rawEnd ? '结束时间无效或无法解析' : '缺少结束时间:请在预览中确认建议时长')
  }
  if (endMs < startMs || (endMs === startMs && opts.allowZeroLength !== true)) {
    throw invalid('结束时间必须晚于开始时间')
  }

  return {
    title,
    startAt,
    endAt,
    allDay: input.allDay === true,
    location: input.location ?? null,
    notes: input.notes ?? null,
    reminderMinutes: input.reminderMinutes ?? null,
    startMs,
    endMs
  }
}
