// 人工复核(E-06):支持度标注与 rubric 版本。
//
// 规则(LLM Eval Lab 规格第 5 节与总体规格第 9 节):
// - 判定四态:supported / contradicted / insufficient / unreviewed;
// - 未审不能视作通过;unreviewed 不计入支持精度分母(但展示复核覆盖率);
// - 修改产生新记录,保留审阅历史(不可变追加);
// - 主观评分独立字段,不覆盖原始规则成绩。

export type ReviewDecision = 'supported' | 'contradicted' | 'insufficient' | 'unreviewed'

export interface ReviewAnnotation {
  reviewId: string
  /** 复核对象:案例与运行的组合(claim 级复核由 R 系列扩展) */
  subjectKey: string
  decision: ReviewDecision
  reason: string
  reviewer: string
  rubricVersion: string
  reviewedAt: string
}

export interface ReviewCompliance {
  /** 引用支持精度:人工判 supported 的对数 / 已人工复核的对数;零复核为 N/A */
  supportPrecision: { value: number | null; reviewed: number; supported: number }
  /** 复核覆盖率:已复核 / 应复核 */
  coverage: { value: number | null; reviewed: number; expected: number }
}

/** 追加式审阅历史:同一对象的新审阅追加在后,旧记录保留 */
export class ReviewStore {
  private readonly records: ReviewAnnotation[] = []

  /** 记录一次审阅;rubric 版本与审阅人必填 */
  annotate(annotation: Omit<ReviewAnnotation, 'reviewId'>): ReviewAnnotation {
    if (annotation.decision !== 'unreviewed' && annotation.reason.trim() === '') {
      throw new Error('人工复核必须给出理由')
    }
    if (annotation.rubricVersion.trim() === '' || annotation.reviewer.trim() === '') {
      throw new Error('复核必须记录 rubric 版本与审阅人')
    }
    const record: ReviewAnnotation = {
      reviewId: `rv-${this.records.length + 1}`,
      ...annotation
    }
    this.records.push(record)
    return record
  }

  /** 对象的最新审阅(无则视为 unreviewed) */
  latestFor(subjectKey: string): ReviewAnnotation | null {
    const all = this.records.filter((r) => r.subjectKey === subjectKey)
    return all.length > 0 ? all[all.length - 1]! : null
  }

  historyFor(subjectKey: string): ReviewAnnotation[] {
    return this.records.filter((r) => r.subjectKey === subjectKey)
  }

  all(): readonly ReviewAnnotation[] {
    return this.records
  }
}

/**
 * 复核合规度量:
 * - 引用支持精度 = supported / 已复核(supported+contradicted+insufficient);
 * - 复核覆盖率 = 已复核 / 应复核总数;零分母 N/A。
 */
export function reviewCompliance(
  store: ReviewStore,
  expectedSubjects: readonly string[]
): ReviewCompliance {
  const latest = new Map<string, ReviewAnnotation>()
  for (const record of store.all()) latest.set(record.subjectKey, record)
  const expected = new Set(expectedSubjects)
  let reviewed = 0
  let supported = 0
  for (const subject of expected) {
    const record = latest.get(subject)
    if (!record || record.decision === 'unreviewed') continue
    reviewed += 1
    if (record.decision === 'supported') supported += 1
  }
  return {
    supportPrecision: {
      value: reviewed === 0 ? null : supported / reviewed,
      reviewed,
      supported
    },
    coverage: {
      value: expected.size === 0 ? null : reviewed / expected.size,
      reviewed,
      expected: expected.size
    }
  }
}
