// 研究报告响应契约(R-06,渲染层可见形态)。
// 字段清单按研究模块规格第 7 节;主进程侧由 src/main/research/reports.ts 的
// assembleReportResponse 组装,本文件是该结构的共享投影(src/shared 不得 import 主进程模块)。

export interface ResearchReportSection {
  section: string
  title: string
  markdown: string
}

export interface ResearchReportClaim {
  claim_id: string
  text: string
  claim_type: string
  support_status: string
  subquestion_id: string
}

export interface ResearchReportCitation {
  citation_id: string
  claim_id: string
  evidence_id: string
  relation: string
  evidence_group_id: string | null
  group_operator: string | null
  /**
   * 证据抽屉定位字段(R-06 富化):来自 EvidenceSpan 的快照与码点 offset
   * (Array.from(normalized_text) 坐标系);未富化时抽屉退化为只读全文。
   */
  snapshot_id?: string
  start_offset?: number
  end_offset?: number
  quote?: string
}

export interface ResearchReportSource {
  source_id: string
  source_name: string
  source_type: string
  text_sha256: string
  source_identity?: string
  provenance_group_id?: string
  collection_time_basis?: string
}

export interface ResearchUnansweredSubquestion {
  subquestion_id: string
  question: string
  insufficiency_reason: string | null
}

/** 报告响应(§7):引用跳转使用结构化字段,展示编号 [n] 只是当前版本的呈现 */
export interface ResearchReportResponse {
  run_id: string
  report_id: string
  version: number
  /** final / partial / draft;partial 不伪装成完整成功 */
  report_state: string
  run_status: string
  manifest_sha256: string
  scope_verification: 'verified' | 'legacy_unverified'
  scope_warning: string | null
  sections: ResearchReportSection[]
  claims: ResearchReportClaim[]
  citations: ResearchReportCitation[]
  sources: ResearchReportSource[]
  unanswered_subquestions: ResearchUnansweredSubquestion[]
  budget_usage: {
    max_subqueries: number
    max_chunks_per_subquery: number
    max_model_calls: number
    max_active_seconds: number
  }
  markdown: string
}
