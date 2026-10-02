// EVAL-04 人工审阅持久化测试:追加式 JSONL、先持久写成功再返回、重开目录
// 历史保留、重复审阅保留历史与理由、空理由拒绝、reviewId 随机唯一、
// 损坏行报错保留原文件、subjectKey 六段组合与路径 ID 校验、
// claim-evidence 对枚举与 holdout 覆盖判定(coverage<100% 不判通过)。
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { caseArtifactDir, exportCaseArtifacts, type CaseArtifactPayload } from '../../src/main/evals/artifacts'
import {
  FileReviewStore,
  NO_EVIDENCE_SEGMENT,
  ReviewStoreError,
  enumerateClaimEvidenceSubjects,
  parseReviewSubjectKey,
  reviewHoldoutStatus,
  reviewSubjectKey
} from '../../src/main/evals/reviewStore'

const NOW = '2026-09-28T01:00:00.000Z'

const SUBJECT = reviewSubjectKey({
  evalRunId: 'eval-1',
  configId: 'ops-planning-baseline',
  caseId: 'c1',
  repeatIndex: 0,
  claimId: 'claim-1',
  evidenceId: 'ev-1'
})

function annotationInput(over: Record<string, unknown> = {}) {
  return {
    subjectKey: SUBJECT,
    decision: 'supported' as const,
    reason: '引用逐字支持命题',
    reviewer: '人工',
    rubricVersion: 'rubric-v1',
    reviewedAt: NOW,
    ...over
  }
}

describe('FileReviewStore:追加式 JSONL 持久化', () => {
  it.each(['not-a-date', '2026-02-30T00:00:00.000Z', ''])('T16 reviewedAt=%s 非法时间不能落盘', (reviewedAt) => {
    const root = mkdtempSync(join(tmpdir(), 't16-review-time-'))
    expect(() => new FileReviewStore(root).annotate(annotationInput({ reviewedAt }))).toThrow(/时间|reviewedAt/)
    expect(existsSync(join(root, 'reviews.jsonl'))).toBe(false)
  })
  it('先持久写成功再返回:annotate 返回时记录已在文件中;reviewId 随机唯一', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-review-'))
    const store = new FileReviewStore(root)
    const first = store.annotate(annotationInput())
    // 返回即已持久化:直接读文件可见该记录
    const lines = readFileSync(join(root, 'reviews.jsonl'), 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toEqual(first)
    const second = store.annotate(annotationInput({ subjectKey: reviewSubjectKey({ evalRunId: 'eval-1', configId: 'ops-planning-baseline', caseId: 'c1', repeatIndex: 0, claimId: 'claim-1', evidenceId: 'ev-2' }) }))
    // reviewId 随机唯一(不是序号)
    expect(first.reviewId).not.toBe(second.reviewId)
    expect(first.reviewId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('重开目录:历史与当前判断完整保留', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-review-'))
    const first = new FileReviewStore(root)
    first.annotate(annotationInput())
    const contradict = reviewSubjectKey({ evalRunId: 'eval-1', configId: 'ops-planning-baseline', caseId: 'c1', repeatIndex: 0, claimId: 'claim-2', evidenceId: 'ev-1' })
    first.annotate(annotationInput({ subjectKey: contradict, decision: 'contradicted', reason: '原文与命题矛盾' }))
    // 重开(模拟进程重启)
    const reopened = new FileReviewStore(root)
    expect(reopened.all()).toHaveLength(2)
    expect(reopened.latestFor(SUBJECT)?.decision).toBe('supported')
    expect(reopened.latestFor(contradict)?.decision).toBe('contradicted')
    expect(reopened.latestFor(contradict)?.reason).toBe('原文与命题矛盾')
  })

  it('重复审阅:保留历史与理由,最后一条有效记录为当前判断', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-review-'))
    const store = new FileReviewStore(root)
    store.annotate(annotationInput({ decision: 'supported', reason: '第一遍判支持' }))
    store.annotate(annotationInput({ decision: 'insufficient', reason: '复核后发现片段不完整' }))
    expect(store.historyFor(SUBJECT)).toHaveLength(2)
    const latest = store.latestFor(SUBJECT)
    expect(latest?.decision).toBe('insufficient')
    expect(latest?.reason).toBe('复核后发现片段不完整')
    // 历史记录的理由原样保留
    expect(store.historyFor(SUBJECT)[0]!.reason).toBe('第一遍判支持')
  })

  it('空理由拒绝(有效判定),且不写文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-review-'))
    const store = new FileReviewStore(root)
    store.annotate(annotationInput())
    const before = readFileSync(join(root, 'reviews.jsonl'), 'utf-8')
    expect(() => store.annotate(annotationInput({ reason: '' }))).toThrow(/理由/)
    expect(() => store.annotate(annotationInput({ reason: '   ' }))).toThrow(/理由/)
    // 拒绝的记录不落盘
    expect(readFileSync(join(root, 'reviews.jsonl'), 'utf-8')).toBe(before)
  })

  it('schema 校验:非法判定、缺审阅人/缺 rubric 版本、空 subjectKey 拒绝', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-review-'))
    const store = new FileReviewStore(root)
    expect(() => store.annotate(annotationInput({ decision: 'approved' }))).toThrow(/判定/)
    expect(() => store.annotate(annotationInput({ reviewer: '' }))).toThrow(/rubric 版本与审阅人/)
    expect(() => store.annotate(annotationInput({ rubricVersion: '' }))).toThrow(/rubric 版本与审阅人/)
    expect(() => store.annotate(annotationInput({ subjectKey: '' }))).toThrow(/subjectKey/)
  })

  it('损坏行:抛可诊断错误并保留原文件,不静默重置', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-review-'))
    const file = join(root, 'reviews.jsonl')
    const store = new FileReviewStore(root)
    store.annotate(annotationInput())
    const good = readFileSync(file, 'utf-8')
    // 模拟半写/损坏行
    writeFileSync(file, good + '{"reviewId": "broken', 'utf-8')
    const before = readFileSync(file, 'utf-8')
    expect(() => new FileReviewStore(root)).toThrow(ReviewStoreError)
    expect(() => new FileReviewStore(root)).toThrow(/损坏/)
    expect(readFileSync(file, 'utf-8')).toBe(before)
  })

  it('加载侧 schema 校验:含未知字段或判定非法的行拒绝加载', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-review-'))
    const file = join(root, 'reviews.jsonl')
    const ok = JSON.stringify({ reviewId: 'rv-1', subjectKey: SUBJECT, decision: 'supported', reason: 'r', reviewer: '人', rubricVersion: 'v1', reviewedAt: NOW })
    writeFileSync(file, ok + '\n' + JSON.stringify({ ...JSON.parse(ok), reviewId: 'rv-2', surprise: 1 }) + '\n', 'utf-8')
    expect(() => new FileReviewStore(root)).toThrow(/未知字段/)

    const root2 = mkdtempSync(join(tmpdir(), 'eval-review-'))
    const file2 = join(root2, 'reviews.jsonl')
    writeFileSync(file2, JSON.stringify({ ...JSON.parse(ok), decision: 'maybe' }) + '\n', 'utf-8')
    expect(() => new FileReviewStore(root2)).toThrow(/判定/)
  })

  it('subjectKey 六段组合 eval/config/case/repeat/claim/evidence;不安全段 ID 拒绝', () => {
    const key = reviewSubjectKey({ evalRunId: 'eval-1', configId: 'cfg', caseId: 'case', repeatIndex: 3, claimId: 'claim', evidenceId: 'ev' })
    expect(key).toBe('eval-1::cfg::case::3::claim::ev')
    expect(parseReviewSubjectKey(key)).toEqual({ evalRunId: 'eval-1', configId: 'cfg', caseId: 'case', repeatIndex: 3, claimId: 'claim', evidenceId: 'ev' })
    // 路径 ID 校验:穿越段拒绝
    expect(() => reviewSubjectKey({ evalRunId: 'eval-1', configId: '..', caseId: 'c', repeatIndex: 0, claimId: 'x', evidenceId: 'y' })).toThrow(ReviewStoreError)
    expect(() => reviewSubjectKey({ evalRunId: 'eval-1', configId: 'cfg', caseId: 'c', repeatIndex: -1, claimId: 'x', evidenceId: 'y' })).toThrow(ReviewStoreError)
    // subjectKey 段数不对:解析拒绝
    expect(() => parseReviewSubjectKey('a::b::c')).toThrow(/六段/)
    // annotate 传入拼错的 subjectKey(缺段)拒绝且不写盘
    const root = mkdtempSync(join(tmpdir(), 'eval-review-'))
    const store = new FileReviewStore(root)
    expect(() => store.annotate(annotationInput({ subjectKey: 'a::b' }))).toThrow(ReviewStoreError)
    expect(existsSync(join(root, 'reviews.jsonl'))).toBe(false)
  })
})

describe('T16 审阅绑定已验证产物内容，重开与篡改', () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 't16-review-bound-'))
    const artifactRoot = join(root, 'artifacts')
    const reviewRoot = join(root, 'reviews')
    const ids = { evalRunId: 'eval-1', configId: 'ops-planning-baseline', caseId: 'c1', repeatIndex: 0 }
    const payload: CaseArtifactPayload = {
      run: { runId: 'r1' }, traceEvents: [], observations: [], ruleChecks: [],
      report: { title: '合成报告' },
      evidence: { applicable: true, claims: [{ claim_id: 'claim-1', claim_type: 'fact', text: '原始命题' }], citations: [{ claim_id: 'claim-1', evidence_id: 'ev-1', relation: 'supports' }], spans: [{ evidence_id: 'ev-1', quote: '原始证据', snapshot_id: 'doc-1' }] },
      snapshots: { documents: [{ snapshotId: 'doc-1', normalizedText: '原始证据' }] }, meta: { executionKind: 'fake' }
    }
    exportCaseArtifacts(artifactRoot, ids, payload)
    return { artifactRoot, reviewRoot, ids, payload, dir: caseArtifactDir(artifactRoot, ids.evalRunId, ids.configId, ids.caseId, 0) }
  }

  it('服务端绑定内容hash，重开同一证据读取同一判定；合法重新导出也不能复用旧标签', () => {
    const env = setup()
    const first = new FileReviewStore(env.reviewRoot, 'reviews.jsonl', env.artifactRoot)
    const label = first.annotate(annotationInput())
    expect(label).toMatchObject({ contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const reopened = new FileReviewStore(env.reviewRoot, 'reviews.jsonl', env.artifactRoot)
    expect(reopened.latestFor(SUBJECT)).toEqual(label)
    expect(reviewHoldoutStatus(reopened, [SUBJECT]).holdoutComplete).toBe(true)
    exportCaseArtifacts(env.artifactRoot, env.ids, { ...env.payload, evidence: { ...env.payload.evidence, claims: [{ claim_id: 'claim-1', claim_type: 'fact', text: '替换了命题' }] } })
    expect(reopened.latestFor(SUBJECT)).toBeNull()
    expect(reopened.historyFor(SUBJECT)).toEqual([label])
    expect(reviewHoldoutStatus(reopened, [SUBJECT]).coverage).toEqual({ value: 0, reviewed: 0, expected: 1 })
    expect(reviewHoldoutStatus(reopened, [SUBJECT]).holdoutComplete).toBe(false)
    if (process.env.T16_EVIDENCE_DIR) writeFileSync(join(process.env.T16_EVIDENCE_DIR, 'review-reopen.json'), JSON.stringify({ label, reopenedBeforeChange: label, afterContentChange: reopened.latestFor(SUBJECT), history: reopened.historyFor(SUBJECT), coverage: reviewHoldoutStatus(reopened, [SUBJECT]) }, null, 2))
  })

  it('篡改证据使manifest失效时旧标签不可用，也不能再保存审阅', () => {
    const env = setup()
    const store = new FileReviewStore(env.reviewRoot, 'reviews.jsonl', env.artifactRoot)
    store.annotate(annotationInput())
    writeFileSync(join(env.dir, 'evidence.json'), JSON.stringify({ applicable: true, claims: [] }))
    expect(store.latestFor(SUBJECT)).toBeNull()
    expect(() => store.annotate(annotationInput())).toThrow(/完整性|产物/)
  })

  it('不存在的claim/evidence对不能通过安全ID校验后伪造标签', () => {
    const env = setup()
    const store = new FileReviewStore(env.reviewRoot, 'reviews.jsonl', env.artifactRoot)
    expect(() => store.annotate(annotationInput({ subjectKey: SUBJECT.replace('claim-1', 'other-claim') }))).toThrow(/对象|claim/)
    expect(() => store.annotate(annotationInput({ subjectKey: SUBJECT.replace('ev-1', 'other-evidence') }))).toThrow(/对象|evidence/)
  })
})

describe('claim-evidence 对枚举与 holdout 覆盖判定', () => {
  const caseEvidence = {
    evalRunId: 'eval-1',
    configId: 'ops-planning-baseline',
    caseId: 'r1',
    repeatIndex: 0,
    claims: [
      { claim_id: 'cl-1', claim_type: 'fact' },
      { claim_id: 'cl-2', claim_type: 'recommendation' },
      { claim_id: 'cl-3', claim_type: 'fact' },
      { claim_id: 'cl-4', claim_type: 'context' } // 非可核验类型
    ],
    citations: [
      { claim_id: 'cl-1', evidence_id: 'ev-1', relation: 'supports' },
      { claim_id: 'cl-1', evidence_id: 'ev-2', relation: 'context' },
      { claim_id: 'cl-3', evidence_id: 'ev-3', relation: 'supports' }
    ]
  }

  it('枚举:每条 citation 一对;可核验无引用单列 none;非可核验无引用跳过', () => {
    const subjects = enumerateClaimEvidenceSubjects(caseEvidence)
    expect(subjects).toEqual([
      reviewSubjectKey({ evalRunId: 'eval-1', configId: 'ops-planning-baseline', caseId: 'r1', repeatIndex: 0, claimId: 'cl-1', evidenceId: 'ev-1' }),
      reviewSubjectKey({ evalRunId: 'eval-1', configId: 'ops-planning-baseline', caseId: 'r1', repeatIndex: 0, claimId: 'cl-1', evidenceId: 'ev-2' }),
      reviewSubjectKey({ evalRunId: 'eval-1', configId: 'ops-planning-baseline', caseId: 'r1', repeatIndex: 0, claimId: 'cl-2', evidenceId: NO_EVIDENCE_SEGMENT }),
      reviewSubjectKey({ evalRunId: 'eval-1', configId: 'ops-planning-baseline', caseId: 'r1', repeatIndex: 0, claimId: 'cl-3', evidenceId: 'ev-3' })
    ])
    expect(subjects).toHaveLength(4)
  })

  it('coverage<100%:holdoutComplete=false,不以少量已审高分判通过;unreviewed 可见', () => {
    const store = new FileReviewStore(mkdtempSync(join(tmpdir(), 'eval-review-')))
    const subjects = enumerateClaimEvidenceSubjects(caseEvidence)
    // 只审 1/4(高分:supported)
    store.annotate(annotationInput({ subjectKey: subjects[0]!, decision: 'supported', reason: '引用支持' }))
    const status = reviewHoldoutStatus(store, subjects)
    expect(status.coverage).toEqual({ value: 0.25, reviewed: 1, expected: 4 })
    expect(status.supportPrecision.value).toBe(1)
    expect(status.holdoutComplete).toBe(false)
    expect(status.unreviewed).toEqual(subjects.slice(1))
  })

  it('全部审完(含 contradicted):holdoutComplete=true,支持精度如实为 0', () => {
    const store = new FileReviewStore(mkdtempSync(join(tmpdir(), 'eval-review-')))
    const subjects = enumerateClaimEvidenceSubjects(caseEvidence)
    store.annotate(annotationInput({ subjectKey: subjects[0]!, decision: 'supported', reason: 'r1' }))
    store.annotate(annotationInput({ subjectKey: subjects[1]!, decision: 'contradicted', reason: 'r2' }))
    store.annotate(annotationInput({ subjectKey: subjects[2]!, decision: 'insufficient', reason: 'r3' }))
    store.annotate(annotationInput({ subjectKey: subjects[3]!, decision: 'supported', reason: 'r4' }))
    const status = reviewHoldoutStatus(store, subjects)
    expect(status.holdoutComplete).toBe(true)
    expect(status.unreviewed).toEqual([])
    expect(status.coverage).toEqual({ value: 1, reviewed: 4, expected: 4 })
    expect(status.supportPrecision).toEqual({ value: 0.5, reviewed: 4, supported: 2 })
  })

  it('重新审阅后 unreviewed 清单收缩:最后一条有效记录决定覆盖', () => {
    const store = new FileReviewStore(mkdtempSync(join(tmpdir(), 'eval-review-')))
    const subjects = enumerateClaimEvidenceSubjects(caseEvidence)
    // 先标 unreviewed(登记在案),后补有效判定
    store.annotate(annotationInput({ subjectKey: subjects[0]!, decision: 'unreviewed', reason: '待复核' }))
    expect(reviewHoldoutStatus(store, subjects).unreviewed).toEqual(subjects)
    store.annotate(annotationInput({ subjectKey: subjects[0]!, decision: 'supported', reason: '补审完成' }))
    const status = reviewHoldoutStatus(store, subjects)
    expect(status.coverage.reviewed).toBe(1)
    expect(status.unreviewed).toEqual(subjects.slice(1))
  })
})
