// 邮箱候选确认幂等服务(C 区):同一 (analysisId, candidateIndex) 只创建一次事项。
// confirmItem 由 R 区注入 Engine.confirmItem 的包装,本服务只负责幂等映射与透传。
import type { SqliteDb } from '../db/connection'
import type { ActionCandidate, ConfirmResult } from '../../shared/types'
import {
  findConfirmationByCandidate,
  getSourceKeyByAnalysis,
  recordConfirmation
} from './analysisRepository'

export type ConfirmItemFn = (analysisId: string, item: unknown) => ConfirmResult

export interface MailConfirmationDeps {
  db: SqliteDb
  confirmItem: ConfirmItemFn
}

export class MailConfirmationService {
  constructor(private readonly deps: MailConfirmationDeps) {}

  /**
   * 确认候选:
   * 1) analysisId 有邮箱版本记录时,先查 mail_confirmations 是否已有
   *    (analysisId, candidateIndex) 映射,命中直接返回 duplicate,不重复建事项;
   * 2) 否则调用 confirmItem;成功且拿到真实 refId 后记录幂等映射。
   * 普通分析(无邮箱版本记录)原样透传,由全局指纹去重兜底。
   */
  confirm(
    analysisId: string,
    candidateIndex: number,
    item: ActionCandidate & { candidateId?: string }
  ): ConfirmResult {
    const sourceKey = getSourceKeyByAnalysis(this.deps.db, analysisId)
    if (sourceKey) {
      // 邮箱候选 ID 固定为 `${analysisId}:${index}`
      const existing = findConfirmationByCandidate(
        this.deps.db,
        sourceKey,
        `${analysisId}:${candidateIndex}`
      )
      if (existing) {
        return { result: 'duplicate', refType: existing.refType, refId: existing.refId }
      }
    }
    const created = this.deps.confirmItem(analysisId, item)
    if (sourceKey && created.refId) {
      recordConfirmation(this.deps.db, {
        analysisId,
        candidateIndex,
        sourceKey,
        refType: created.refType,
        refId: created.refId
      })
    }
    return created
  }
}
