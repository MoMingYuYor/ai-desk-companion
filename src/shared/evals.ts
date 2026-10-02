/** 无密钥评测路由；凭据仅在运行时按 providerId 解析。 */
export interface EvalTargetProfile {
  providerId: string
  protocol: string
  baseUrl: string
  model: string
}

export type EvalFreezeStage = 'ops-planning' | 'research-extraction'

export interface FreezeInput {
  experimentId: string
  datasetVersion: string
  stage: EvalFreezeStage
  executionKind: 'fake' | 'real'
  target: EvalTargetProfile | null
}

export interface EvalFreezeVersions {
  codeCommit: string
  toolsVersion: string
  rubricVersion: string
}

/** schema 1 用于历史读取；新实验由冻结入口生成 schema 2。 */
export interface FrozenEvalConfig {
  schemaVersion: 1 | 2
  configId: string
  executionKind: 'fake' | 'real'
  model: string
  providerId: string
  pipelineVariant: 'baseline' | 'candidate'
  promptSha256: string
  toolsVersion: string
  codeCommit: string
  datasetSha256: string
  fixtureSha256: string
  budgetSha256: string
  interactionScriptSha256: string
  rubricVersion: string
  targetSha256?: string
  target?: EvalTargetProfile | null
}

export interface Schema2FrozenEvalConfig extends FrozenEvalConfig {
  schemaVersion: 2
  targetSha256: string
  target: EvalTargetProfile | null
}
