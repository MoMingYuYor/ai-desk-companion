// 评测独立固定路由：只构造冻结 target 的唯一 provider，不改变业务模型默认配置。
import type { EvalTargetProfile, FrozenEvalConfig } from '../../shared/evals'
import type { ProviderInfo } from '../../shared/types'
import type { StructuredCompleter } from '../agent/llm'
import { ModelCompleter } from '../agent/completer'
import { ModelRouter } from '../services/modelRouter'
import { normalizeTargetProfile, targetProfileSha256 } from './freeze'

export type RealCompleterFor = (config: FrozenEvalConfig, target: EvalTargetProfile) => StructuredCompleter
type FetchLike = NonNullable<ConstructorParameters<typeof ModelRouter>[0]['fetchImpl']>

export function createRealCompleterFor(options: {
  credentialOf: (providerId: string) => string | null
  fetchImpl?: FetchLike
}): RealCompleterFor {
  return (config, rawTarget) => {
    const target = normalizeTargetProfile(rawTarget)
    if (config.schemaVersion !== 2 || config.executionKind !== 'real' ||
      config.targetSha256 !== targetProfileSha256('real', target) ||
      config.providerId !== target.providerId || config.model !== target.model) {
      throw new Error('真实适配器与冻结 target 不一致，拒绝发送')
    }
    const credential = options.credentialOf(target.providerId)
    if (!credential?.trim()) throw new Error('冻结 provider 的运行时凭据不可用，拒绝发送')
    const provider: ProviderInfo = {
      id: target.providerId, name: target.providerId, protocol: target.protocol as ProviderInfo['protocol'],
      baseUrl: target.baseUrl, models: [target.model], defaultModel: target.model,
      supportsVision: false, supportsJsonMode: true, isDefault: true, sortOrder: 0, hasApiKey: true,
      createdAt: '', updatedAt: ''
    }
    const router = new ModelRouter({ apiKeyOf: id => id === target.providerId ? credential : null, fetchImpl: options.fetchImpl })
    return new ModelCompleter({ providers: () => [provider], router })
  }
}
