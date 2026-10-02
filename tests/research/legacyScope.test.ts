import { expect, it } from 'vitest'
import { makeTestDb } from '../helpers'
import { initWorkspaceEpoch } from '../../src/main/db/operations'
import { importResearchSources } from '../../src/main/research/snapshots'
import { createResearchRun, createReport } from '../../src/main/research/repository'
import { assembleReportResponse } from '../../src/main/research/reports'

it.each(['normal', 'missing', 'invalid', 'different', 'no-manifest'] as const)('历史报告 %s 范围判定只读且正文不变', async kind => {
  const db = await makeTestDb()
  initWorkspaceEpoch()
  const [source] = importResearchSources(db, { sources: [{ sourceName: 'legacy.txt', bytes: Buffer.from('要求 Python 与 RAG。') }] })
  if (!source?.ok) throw new Error('测试来源导入失败')
  const { value: { run, task, manifest } } = createResearchRun(db, { request: { question: '岗位需要什么技能？', snapshot_ids: [source.documentId] }, contextClock: '2026-09-30T01:00:00Z' }, `legacy-${kind}`)
  const report = createReport(db, run.runId, { version: 1, reportState: 'final', markdown: '## 核心结论\n\n历史正文。' })
  if (kind === 'no-manifest') {
    db.run('PRAGMA foreign_keys = OFF') // 合成损坏旧库：只用于缺失清单的只读回归。
    db.run('UPDATE research_tasks SET snapshot_manifest_id = ? WHERE research_task_id = ?', ['missing', task.researchTaskId])
    db.run('PRAGMA foreign_keys = ON')
  }
  else if (kind !== 'normal') {
    const entries = structuredClone(manifest.entries)
    if (kind === 'missing') delete entries[0]!.record_scope
    if (kind === 'invalid') entries[0]!.record_scope!.endOffset = -1
    if (kind === 'different') entries[0]!.record_scope!.endOffset -= 1
    db.run('UPDATE research_snapshot_manifests SET entries_json = ? WHERE manifest_id = ?', [JSON.stringify(entries), manifest.manifestId])
  }
  const before = JSON.stringify(db.all('SELECT * FROM research_reports'))
  const response = assembleReportResponse(db, run.runId, report, { runStatus: 'succeeded' })
  expect(response.scope_verification).toBe(kind === 'normal' ? 'verified' : 'legacy_unverified')
  expect(response.scope_warning === null).toBe(kind === 'normal')
  expect(response.markdown).toBe(report.markdown)
  expect(JSON.stringify(db.all('SELECT * FROM research_reports'))).toBe(before)
})
