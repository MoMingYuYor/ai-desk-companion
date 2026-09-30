// EVAL-05 资源路径契约(F-08 修复的第一层):把评测的只读资源与可写目录拆开,
// 消除对 process.cwd() 的隐式依赖。
//
// 纪律(完成计划 eval.md EVAL-05):
// - 只读资源:开发模式定位仓库源根(sourceRoot)——evals/datasets 与 fixtures/research;
//   打包模式定位 process.resourcesPath(resourceRoot)下的 evals/ 副本——
//   resourceRoot/evals/datasets 与 resourceRoot/evals/fixtures/research;
// - 可写三项(产物/冻结配置/人工审阅)一律位于 userData/evals 之下,与业务数据
//   和只读资源彻底分离,业务写目录不承担资源发现;
// - 全部拼接使用 node:path(Windows/POSIX 一致),不由调用方手拼字符串;
// - 路径全部由组合入口(index.ts / eval-cli.ts)以显式参数构造并注入,
//   case 执行器与数据集加载不得自行从 cwd 推导;
// - 纯函数、无 IO:给定相同输入返回相同结果,可在纯 Node 测试中按显式参数验证。

import { join } from 'node:path'

/** 评测资源路径契约(EVAL-05 接口原样):只读两项 + 可写三项 */
export interface EvalResourcePaths {
  /** 数据集根:其下每个子目录是一个版本(cases.jsonl + manifest.json + annotations) */
  datasetRoot: string
  /** 研究 fixture 语料根:其下每个子目录是一个 fixture_id */
  fixtureRoot: string
  /** 评测产物根:<evalRunId>/<configId>/<caseId>/<repeatIndex>/ */
  artifactRoot: string
  /** 冻结实验配置根(configStore 管辖);冻结 prompt 模板在其 templates/ 子目录 */
  configRoot: string
  /** 人工审阅 JSONL 根(FileReviewStore 管辖) */
  reviewRoot: string
}

/** resolveEvalPaths 的显式输入:全部由组合入口提供,不在本模块读取任何环境状态 */
export interface ResolveEvalPathsInput {
  /** 打包运行(app.isPackaged)为 true;开发与 CLI 为 false */
  packaged: boolean
  /** 打包资源根(Electron:process.resourcesPath);开发模式下不使用,传 sourceRoot 即可 */
  resourceRoot: string
  /** 仓库源根(开发与 CLI:仓库根目录) */
  sourceRoot: string
  /** 用户可写目录(Electron:app.getPath('userData');CLI:--user-data 或约定缺省) */
  userData: string
}

/**
 * 解析评测资源路径(纯函数):
 * - 开发:datasetRoot=<sourceRoot>/evals/datasets,fixtureRoot=<sourceRoot>/fixtures/research;
 * - 打包:datasetRoot=<resourceRoot>/evals/datasets,fixtureRoot=<resourceRoot>/evals/fixtures/research;
 * - 可写三项:<userData>/evals/{artifacts,configs,reviews}。
 */
export function resolveEvalPaths(input: ResolveEvalPathsInput): EvalResourcePaths {
  // 只读资源:打包态走资源根下的 evals/ 副本;开发态直接用仓库源根
  const datasetRoot = input.packaged
    ? join(input.resourceRoot, 'evals', 'datasets')
    : join(input.sourceRoot, 'evals', 'datasets')
  const fixtureRoot = input.packaged
    ? join(input.resourceRoot, 'evals', 'fixtures', 'research')
    : join(input.sourceRoot, 'fixtures', 'research')
  // 可写三项:userData/evals 之下,与业务数据和只读资源分离
  const writableBase = join(input.userData, 'evals')
  return {
    datasetRoot,
    fixtureRoot,
    artifactRoot: join(writableBase, 'artifacts'),
    configRoot: join(writableBase, 'configs'),
    reviewRoot: join(writableBase, 'reviews')
  }
}
