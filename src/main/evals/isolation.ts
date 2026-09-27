// 评测隔离执行(E-02):每个 case、配置和重复各得一个全新数据库与临时目录。
//
// 隔离契约(LLM Eval Lab 规格第 6 节):
// - 业务工具全部指向临时实例,证明不能访问用户库或跨 case 污染;
// - 固定时钟只控制领域日期,耗时测量仍走单调钟(C-02 契约);
// - interaction_script 只经测试注入的 EvaluationContext 启用,
//   正常应用不存在"评测模式自动批准"公开开关;
// - 临时目录只在预先创建的评测根目录下清理,不根据 case 输入拼接系统路径。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixedClock, type Clock } from '../../shared/clock'
import { openDatabase, type SqliteDb } from '../db/connection'
import { initSchema } from '../db/dao'
import type { EvalCase } from './types'

export interface EvalFixture {
  /** fixture 初始状态播种(在 initSchema 之后执行) */
  seed(db: SqliteDb): void
  description: string
}

/** fixture 注册表:按 fixture_id 提供初始状态;评测数据集的 fixture_id 必须在此注册 */
const FIXTURE_BY_ID = new Map<string, EvalFixture>()

export function registerFixtureById(id: string, fixture: EvalFixture): void {
  FIXTURE_BY_ID.set(id, fixture)
}

export function getFixtureById(id: string): EvalFixture | undefined {
  return FIXTURE_BY_ID.get(id)
}

// 内置 fixture:空业务库(确认类/创建类案例的起点)
registerFixtureById('ops-empty', {
  description: '空业务库:无待办、无日程',
  seed: () => {
    /* 空状态即所需 */
  }
})

// 内置 fixture:预置固定 ID 的演示待办与日程(更新类案例的起点)。
// 固定 ID 使数据集案例可以引用目标记录;revision 初始为 1。
registerFixtureById('ops-seeded', {
  description: '预置 3 条待办与 2 条日程(固定 ID,供更新类案例引用)',
  seed: (db) => {
    const ts = '2026-09-28T00:00'
    db.run(
      `INSERT INTO todos (id, title, notes, due_at, priority, completed_at, linked_event_id, source, source_ref, fingerprint, revision, created_at, updated_at)
       VALUES ('seed-todo-1', '完成作品集简介页面', NULL, '2026-09-30', 'high', NULL, NULL, 'manual', NULL, NULL, 1, ?, ?)`,
      [ts, ts]
    )
    db.run(
      `INSERT INTO todos (id, title, notes, due_at, priority, completed_at, linked_event_id, source, source_ref, fingerprint, revision, created_at, updated_at)
       VALUES ('seed-todo-2', '整理实习 JD 清单', '从收藏的招聘页摘录', '2026-10-05', 'normal', NULL, NULL, 'manual', NULL, NULL, 1, ?, ?)`,
      [ts, ts]
    )
    db.run(
      `INSERT INTO todos (id, title, notes, due_at, priority, completed_at, linked_event_id, source, source_ref, fingerprint, revision, created_at, updated_at)
       VALUES ('seed-todo-3', '配置本地模型服务', NULL, NULL, 'normal', '2026-09-27T18:00', NULL, 'manual', NULL, NULL, 1, ?, ?)`,
      [ts, ts]
    )
    db.run(
      `INSERT INTO events (id, title, start_at, end_at, all_day, location, notes, status, revision, created_at, updated_at)
       VALUES ('seed-event-1', '项目周会', '2026-09-29T10:00', '2026-09-29T11:00', 0, '线上', NULL, 'active', 1, ?, ?)`,
      [ts, ts]
    )
    db.run(
      `INSERT INTO events (id, title, start_at, end_at, all_day, location, notes, status, revision, created_at, updated_at)
       VALUES ('seed-event-2', '简历投递截止', '2026-10-03T09:00', '2026-10-03T09:00', 1, NULL, NULL, 'active', 1, ?, ?)`,
      [ts, ts]
    )
  }
})

/** 已隔离的 case 执行环境 */
export interface IsolatedCaseEnv {
  db: SqliteDb
  clock: Clock
  /** 案例预定脚本(仅供测试注入的 runner 读取;正常应用无此入口) */
  caseDef: EvalCase
  /** 临时目录(评测根目录之下) */
  dir: string
  dispose(): void
}

/**
 * 为单个 case 创建隔离环境:临时目录 + 全新数据库 + fixture 播种。
 * rootDir 必须是评测根目录(调用方创建),临时子目录建立在其下,
 * dispose 只删除该子目录,绝不根据 case 输入拼接系统路径。
 */
export async function createIsolatedCaseEnv(
  rootDir: string,
  caseDef: EvalCase,
  sqlJsDistDir: string
): Promise<IsolatedCaseEnv> {
  const dir = mkdtempSync(join(rootDir, 'case-'))
  const { db } = await openDatabase(join(dir, 'case.sqlite'), sqlJsDistDir)
  initSchema(db)

  const fixture = getFixtureById(caseDef.fixture_id)
  if (!fixture) {
    db.close()
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`未注册的评测 fixture:${caseDef.fixture_id}(案例 ${caseDef.case_id})`)
  }
  fixture.seed(db)

  return {
    db,
    // 固定时钟冻结领域时间;monotonicMs 始终真实(C-02 契约)
    clock: fixedClock(caseDef.clock),
    caseDef,
    dir,
    dispose: () => {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
