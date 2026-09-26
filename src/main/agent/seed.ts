// 演示种子数据(A-01):只含虚拟任务、日程、草稿与样例 JD,不含任何真实个人信息。
// 幂等:meta 标记已播种版本,重复执行零写入;正式演示数据从这里来,
// 真实用户库(课表/材料分析)绝不进入公开演示。

import type { SqliteDb } from '../db/connection'
import { getMeta, setMeta } from '../db/dao'
import { addDays, nowLocalIso } from '../../shared/dateUtils'
import { createTodo, createEvent } from '../db/dao'
import { createMailDraft } from './mailDrafts'
import { importDocument } from '../retrieval/importer'

export const DEMO_SEED_FLAG = 'agent:demo-seed-version'
export const DEMO_SEED_VERSION = 1

const SAMPLE_JD_FRONTEND = `# 前端开发实习生

## 岗位职责
- 参与公司内部工具的前端开发
- 与后端工程师协作完成接口联调

## 任职要求
- 熟悉 TypeScript 与 React
- 了解基本工程化工具链
- 有检索或表单类项目经验优先
`

const SAMPLE_JD_AI = `# AI 应用开发实习生

## 岗位职责
- 参与 Agent 编排与工具调用链路开发
- 构建可核验的检索与引用链路

## 任职要求
- 熟悉 Python 或 TypeScript
- 了解机器学习基础概念
- 有 FastAPI 或 SQLite 经验优先
`

/**
 * 播种演示数据。幂等:同一 seed 版本只执行一次(meta 标记)。
 * 手动数据创建后如需重播,可删除该 meta 键后再次调用(会追加而非替换)。
 */
export function seedDemoData(db: SqliteDb): { seeded: boolean; version: number } {
  const current = getMeta(db, DEMO_SEED_FLAG)
  if (current === String(DEMO_SEED_VERSION)) {
    return { seeded: false, version: DEMO_SEED_VERSION }
  }

  const today = nowLocalIso().slice(0, 10)
  // 任务:一条高优先级未完成、一条普通未完成、一条已完成
  createTodo(db, {
    title: '完成作品集简介页面',
    notes: '包含项目介绍与演示入口',
    dueAt: addDays(today, 3),
    priority: 'high'
  }, 'agent')
  createTodo(db, {
    title: '整理实习 JD 清单',
    notes: '从收藏的招聘页摘录要求',
    dueAt: addDays(today, 7),
    priority: 'normal'
  }, 'agent')
  const done = createTodo(db, { title: '配置本地模型服务', priority: 'normal' }, 'agent')
  db.run('UPDATE todos SET completed_at = ? WHERE id = ?', [nowLocalIso(), done.id])

  // 日程:明日上午周会、五天后简历截止
  const tomorrow = addDays(today, 1)
  createEvent(db, {
    title: '项目周会',
    startAt: `${tomorrow}T10:00`,
    endAt: `${tomorrow}T11:00`,
    allDay: false,
    location: '线上'
  }, 'agent')
  createEvent(db, {
    title: '简历投递截止',
    startAt: `${addDays(today, 5)}T09:00`,
    endAt: `${addDays(today, 5)}T09:00`,
    allDay: true
  }, 'agent')

  // 邮件草稿(不可发送)
  createMailDraft(db, {
    recipients: ['mentor@example.com'],
    subject: '实习材料汇总',
    body: '老师您好,附件是本周整理的实习材料,请查收。'
  })

  // 样例 JD(可检索)
  importDocument(db, { sourceName: '样例JD-前端开发实习生.md', sourceType: 'markdown', bytes: Buffer.from(SAMPLE_JD_FRONTEND, 'utf8') })
  importDocument(db, { sourceName: '样例JD-AI应用开发实习生.md', sourceType: 'markdown', bytes: Buffer.from(SAMPLE_JD_AI, 'utf8') })

  setMeta(db, DEMO_SEED_FLAG, String(DEMO_SEED_VERSION))
  return { seeded: true, version: DEMO_SEED_VERSION }
}
