# PKG-01 包验收记录：资源完整的新包与干净环境验证

> 任务来源：`docs/superpowers/plans/2026-09-30-project-completion/delivery.md` PKG-01 节。
> 执行日期：2026-10-01（本地时区 UTC+8）。执行分支：`feat/agent-portfolio`（HEAD `04209b5`，工作树含本任务未提交修改，打包时如实标记 dirty）。
> 本记录只覆盖打包与分发验证；窗口 E2E 关键路径与真人交互由 E2E-01/桌面验收承担。

## 0. 环境与版本

| 项 | 值 |
| --- | --- |
| 操作系统 | Windows 10.0.26200 x64（electron-builder 报告 `os=10.0.26200`） |
| Node.js | v24.19.0 |
| npm | 11.17.0 |
| Electron | 44.4.3 |
| electron-builder | 26.15.3（@electron/rebuild buildFromSource=false） |
| electron-vite | 4.0.0（vite 7.3.6） |
| TypeScript | 5.8.x（tsconfig.node / tsconfig.web 双工程 typecheck） |
| vitest | 5.0.1 |

## 1. 改动文件清单（本任务写入责任范围）

| 文件 | 类型 | 内容 |
| --- | --- | --- |
| `scripts/write-build-info.mjs` | 新增 | 生成 `artifacts/build/build-info.json`（git 提交、dirty 标记、构建 UTC 时间、应用版本、三类只读资源的逐文件 SHA-256 与确定性树 hash） |
| `scripts/check-build.mjs` | 修改 | 保留既有「out 相对 src/resources 过期返回 1」语义；新增构建态四产物（main/preload/renderer/CLI）、wasm、fonts/cmaps、数据资源与 build-info 存在性检查（缺失非零退出）；新增 `--packaged <dir>` 打包形态检查 |
| `package.json` | 修改 | `dist` 脚本前置 `node scripts/write-build-info.mjs`；`build.extraResources` 追加 4 项（evals/datasets、fixtures/research→evals/fixtures/research、evals/prompts、artifacts/build/build-info.json→build-info.json），既有 resources/cmaps/standard_fonts 三项原样保留 |
| `.github/workflows/ci.yml` | 修改 | Build 后新增 Write build info、Check build artifacts and resources（tee 留存日志）、Upload build info and check log 三个步骤 |
| `scripts/perf-check.mjs` | 新增 | 性能两场景基准（见第 7 节），输出 `artifacts/build/perf-report.json` |
| `docs/acceptance/package-acceptance.md` | 新增 | 本文件 |

未触碰：`src/` 全部文件、`index.ts`、`evals/datasets` 数据内容、`README.md`、`docs/evaluations`、`tests/`；`eval:run`/`eval:report` 与既有 scripts 语义未变。

## 2. 旧包归档记录

原 `dist/事务助手-0.1.0-portable-x64.zip`（2026-09-21 构建）移动至归档路径，未删除：

| 项 | 值 |
| --- | --- |
| 归档路径 | `dist/archive/事务助手-0.1.0-portable-x64.20260921.zip` |
| 字节数 | 195,206,116 |
| SHA-256 | `5a2f5765d61adc6ac047ab2465ed8199329a14ca85db48f406ac95c74cf31fb1` |

命令：`sha256sum`（移动前计算）→ `mv`。`dist/ai-desk-companion-0.1.0-portable-x64.zip`（2026-09-18，171,457,033 字节）不在本任务指定范围，保持原位未动。

## 3. 打包链路与 build-info

`npm run dist` 实际执行链：`node scripts/write-build-info.mjs && electron-vite build && electron-builder --win`。

本次打包的 `build-info.json`（同时打包为资源根 `resources/build-info.json`）：

```json
{
  "schemaVersion": 1,
  "gitCommit": "04209b5d82cc09293c02fdca1f65d8122dcf1d2e",
  "gitDirty": true,
  "builtAtUtc": "2026-09-30T21:09:42.600Z",
  "appVersion": "0.1.0",
  "resources": {
    "evals/datasets":    { "fileCount": 143, "treeSha256": "17e1d0f750ea415f5274793784fcb262810c91ad8eea9324c57f3c93add2dae7" },
    "fixtures/research": { "fileCount": 65,  "treeSha256": "6411a942f8399e5ce51da77bb94482f9a2622d40ba1abdbd9421d1606292178f" },
    "evals/prompts":     { "fileCount": 5,   "treeSha256": "f127b034a27fd65f487f0d487f73a2ab4199d85fe0971972d1f24a99f1fe166f" }
  }
}
```

- `gitDirty: true` 如实反映打包时工作树含本任务 5 项未提交修改，未冒充纯提交构建；主代理提交后重打，dirty 将如实转 false。
- 树 hash 定义：目录递归收集文件，按 POSIX 相对路径排序，`"<path>\n<fileSha256>\n"` 串接后取整体 SHA-256；单文件 hash 完整清单在 `artifacts/build/build-info.json` 的 `resources.*.files`。

## 4. 新包记录

| 项 | 值 |
| --- | --- |
| 文件名 | `dist/事务助手-0.1.0-portable-x64.zip`（version 仍为 0.1.0，与旧包同名；旧包已先归档后覆盖生成，不存在混淆） |
| 字节数 | 195,498,416 |
| SHA-256 | `5cffbf7a80c6b8eb9e5dcb27698e6ad6742cc920a4d96fb528d95146cfe8cc25` |
| 构建链路退出码 | 0（`npm run dist`，全程约 2 分钟） |
| win zip 签名 | electron-builder signtool 自签名步骤按既有配置执行，未配置可信证书（签名与自动更新不在本轮前置条件内） |

打包态资源落位实测（`dist/win-unpacked/resources/`，与解压包一致）：

- `evals/datasets/{personal_ops_v1,research_v1}`（两套数据集完整）
- `evals/fixtures/research/`（65 文件）
- `evals/prompts/manifest.json`（冻结模板根 5 文件）
- `build-info.json`
- 既有 `resources/`、`cmaps/`、`standard_fonts/`、`app.asar`、`app.asar.unpacked/node_modules/sql.js/dist/sql-wasm.wasm` 均在位。

`node scripts/check-build.mjs --packaged dist/win-unpacked` → 退出码 0，输出 `OK:构建产物与资源完整;打包形态(dist/win-unpacked)资源完整`。

## 5. 干净 checkout 验证

流程：`git clone D:/Chatgpt/待办 /d/Chatgpt/pkg-clean-checkout`（HEAD `04209b5`）→ 依次执行。未在原工作区重装依赖，未升级任何依赖。

| 步骤 | 命令 | 结果 | 耗时 |
| --- | --- | --- | --- |
| npm ci | `npm ci` | PASS（539 包） | 约 3 秒 |
| typecheck | `npm run typecheck` | PASS（node + web 双工程） | 约 4 秒 |
| vitest 全量 | `npx vitest run --reporter=dot` | **2 failed / 1377 passed / 1 skipped**（135 文件中 3 文件受影响），明细见下 | 约 6 秒 |
| build | `npm run build` | PASS（main/preload/renderer 三产物） | 约 1 秒 |

首轮 vitest（build 之前）为 17 failed / 1329 passed：其中 2 个为 `tests/mcp/startup.test.ts` 的进程级测试，该测试自带前置「缺少 out/main/index.js;进程级测试前先运行 npm run build」，build 之后复跑全部通过；其余为下述两类既有环境问题的叠加。

### 干净 checkout 失败明细与归因（均非 PKG-01 改动引入）

同三组测试在源仓库工作树全部通过（基线复跑：`experiment` + `snapshots` 48/48 过，`gold_integrity` 14/14 过）：

1. `tests/evals/experiment.test.ts`：`ENOENT .../artifacts/experiments/experiment-plan.json`。该文件属 `artifacts/`，被 `.gitignore` 排除不入库，测试硬依赖本地产物 → 任何干净 checkout 必然失败。结构性既有问题，测试应自建 fixture 或无产物时跳过。
2. `tests/research/gold_integrity.test.ts`：`locate-006/jd.txt` 的 raw_sha256 与快照 manifest 不一致。
3. `tests/research/snapshots.test.ts`：`fixtures/research/normalization` 的 BOM+CRLF 样例双 hash 不一致。

2 与 3 的根因相同：**仓库工作树行尾混杂**。实测 `fixtures/research/locate-006/jd.txt` 源仓库磁盘为 CRLF（sha256 `2478330c…`）而 git index/HEAD 存 LF（checkout 出 `824b3296…`）；同时 `evals/datasets/research_v1/cases.jsonl` 源仓库磁盘为 LF（与 index 一致，重置后两侧 sha256 均为 `b7d3db70…`）。任何单一 `core.autocrlf` 配置的 clone 都无法同时复现「部分文件磁盘 CRLF、部分磁盘 LF」的工作树，故绑定磁盘字节的冻结 hash 在克隆中必然部分漂移。

**处置与推论**：本任务写入责任不含数据文件与 tests，不擅自改数据或放宽断言。冻结 hash 的基准应绑定 git 内容（提交后重算 manifest）或对 fixtures 统一强制 LF（`.gitattributes`），属 DATA-01/整合者决策。**对远端 CI 的直接推论**：`actions/checkout@v4` 在 Windows runner 上以 `core.autocrlf=false` 检出（等效 LF），上述 hash 类测试在远端 CI 预期同样失败，`experiment.test.ts` 因 artifacts 不入库也预期失败——远端 CI 当前基线即红，与本任务无关，但必须在宣称 CI 通过前修复。

## 6. 包验收（解压 + healthcheck）

- 解压目录：`D:\Chatgpt\pkg-acceptance-20261001\app`（与源码目录、执行 cwd 均不同，通过 PowerShell `Expand-Archive` 解压新 zip）。
- portable exe：`app\事务助手.exe`。
- 测试用户目录（全新，进程自动创建）：`D:\Chatgpt\pkg-acceptance-20261001\userdata`。

命令形态（cwd 为解压目录）：

```
事务助手.exe --user-data D:\Chatgpt\pkg-acceptance-20261001\userdata --healthcheck --healthcheck-output D:\Chatgpt\pkg-acceptance-20261001\healthcheck-1.json
```

**第一次启动**（种子 + 迁移）退出码 0：

```json
{
  "schemaVersion": 1,
  "ok": true,
  "userDataDir": "D:\\Chatgpt\\pkg-acceptance-20261001\\userdata",
  "appliedMigrationVersion": 9,
  "readOnlyTool": { "tool": "todo.list", "count": 2 },
  "checkedAt": "2026-09-30T21:14:48.563Z"
}
```

**第二次启动**（同 userData 重启核对种子不重复）退出码 0，报告与第一次逐字节一致（仅 `checkedAt` 更新为 `2026-09-30T21:14:56.391Z`）：迁移版本保持 9，`todo.list` count 仍为 2 —— 无重复播种。

数据资源在打包态的发现：

- 打包态资源目录契约由 `src/main/evals/resources.ts` 的 `resolveEvalPaths` 定义（`process.resourcesPath/evals/datasets`、`process.resourcesPath/evals/fixtures/research`），有单元测试覆盖；
- 本次以 `check-build --packaged` 逐项验证了打包资源目录中两套数据集、65 个 fixture 文件与冻结模板 manifest 的存在性与完整性；
- healthcheck 不覆盖数据集加载语义，打包 exe 内运行 `eval:run` 不在本轮范围（避免真实模型调用与额外链路风险），**数据集发现与 fixture 加载的端到端语义待真人桌面验收补测**。

## 7. 性能场景（Node 基准，Electron 环境由桌面验收补测）

口径如实声明：`scripts/perf-check.mjs` 在 Node 进程内直连 sql.js（与生产相同的 wasm 加载方式与 `SqliteDb.all` 同形的 prepare/bind/step/getAsObject 行读取），SQL 与生产 `listTodos`（含 20% 行 linked event 回查，对应 `attachLinkedEvent` 负载）和 `search.ts` 无冻结路径（候选 LIMIT 500 → JOIN → 应用层词频计分）同形。**真实 Electron IPC/runtime 环境的暖态查询不在本报告冒充，由桌面验收补测。**

| 场景 | 数据量 | 次数 | p50 | p95 | max | 阈值 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1000 合成任务暖态只读查询 | todos 1000 + events 200 | 暖态 5 + 计时 100 | 8.92 ms | **9.72 ms** | 10.68 ms | ≤500 ms | PASS |
| 200 文档固定 MATCH 查询 | 200 文档 / 2400 chunk（≥2000） | 暖态 5 + 计时 100 | 3.27 ms | **3.61 ms** | 3.89 ms | ≤1 s | PASS |

环境：Node v24.19.0 / win32 x64 / 并行度 16；固定查询词「会议」持续命中候选上限 500。结果 JSON：`artifacts/build/perf-report.json`。研究上限场景（3 子题、每题 8 chunk、6 次请求、active≤120s）需真实模型/驱动，不在本轮（无真实模型调用授权），由 EXP-01/桌面验收承担。

## 8. CI 状态

本地已验证（与本记录同环境）：

- `node scripts/write-build-info.mjs` 退出 0（生成并校验 build-info）；
- `node scripts/check-build.mjs` 退出 0（构建态）；`--packaged dist/win-unpacked` 退出 0（打包态）;
- CI YAML 中三个新步骤（Write build info → Check build artifacts and resources（`tee check-build.log` 留存，`shell: bash` 显式声明时 GitHub Actions 以 `-eo pipefail` 执行，管道不吞退出码）→ Upload artifact）为静态编写，语法经本地等价命令验证。

**远端 CI 状态声明：未验证。** 本任务不推送分支，无法实际查看远端 run 状态，不以 YAML 存在宣称通过。且按第 5 节推论，远端 Windows runner 上上述 3 个既有失败（artifacts 依赖 ×1、行尾 hash ×2）预期复现，远端 CI 在这些问题修复前无法全绿。

## 9. 验收项自查（对照 delivery.md PKG-01 勾选项）

| 规范要求 | 状态 | 证据 |
| --- | --- | --- |
| 打包资源含完整 evals/datasets、fixtures/research、annotations 与 prompts；只读资源位于 process.resourcesPath/evals | 完成（存在性级） | 第 4 节资源落位清单；`resolveEvalPaths` 契约测试 + `check-build --packaged` 退出 0 |
| 资源 manifest 列每个文件 hash | 完成 | build-info `resources.*.files`（143+65+5 项逐文件 SHA-256） |
| build-info 含提交、dirty、构建 UTC 时间、应用版本、资源 hash | 完成 | 第 3 节 JSON；dirty=true 如实 |
| extraResources 追加且保留既有 sql.js/图像/PDF cmaps/字体资源 | 完成 | package.json build 段 7 项；win-unpacked 中 cmaps/standard_fonts/resources 在位 |
| 写入产物仍在独立 userData（不写安装目录） | 完成 | healthcheck userDataDir 为指定临时目录；资源路径契约可写三项均在 userData/evals 下 |
| 干净 checkout 锁文件 npm ci → test、typecheck、build | 完成（含 2 项既有失败，如实归因） | 第 5 节 |
| check-build 覆盖四产物/CLI/wasm/fonts/数据资源，缺失非零 | 完成 | 缺失注入实测：删除 build-info 场景（checkout 中无该文件时退出 1）与 fixtures 空目录场景（首版实现即报错）均复现非零退出 |
| CI 留存日志与 build-info；远端状态实际查看 | 部分 | 本地步骤等价验证通过；远端未推送无法查看，已声明并指出预期红项 |
| npm run dist 生成 zip，记录文件名/字节/SHA-256；旧包明确版本记录 | 完成 | 第 2、4 节 |
| 解压到新目录、源码目录与 cwd 都不同、healthcheck、正常重启 | 完成（healthcheck 形态） | 第 6 节；窗口 E2E 与真人交互归 E2E-01 |
| 性能场景 1000 任务 p95≤500ms、200 文档≥2000 chunk p95≤1s | 完成（Node 基准） | 第 7 节；Electron 环境待桌面验收 |
| 无模型配置引导/配置模型真实请求/报告导出等桌面验收项 | 未执行 | 属 E2E-01 桌面验收与 EXP-01 范围，本轮无真实模型调用授权 |

## 10. 未解决点（交整合者/后续任务）

1. **远端 CI 未验证且预期红**：不推送授权范围内的本轮无法实测；红项为既有问题（第 5 节 3 个失败），修复需 DATA-01/测试归属方处理：`experiment.test.ts` 不应硬依赖 gitignore 掉的 `artifacts/experiments/experiment-plan.json`。
2. **冻结 hash 与行尾混杂**：manifest 的 raw/text sha256 绑定源仓库磁盘字节（部分文件 CRLF），git 无法复现；建议统一 `.gitattributes` 强制 fixtures/datasets LF 并重算冻结 hash（新数据版本），或把 hash 基准改为 git blob 内容。
3. **打包态数据集发现语义**：存在性与路径契约已验证，端到端加载待真人桌面验收补测。
4. **Electron 真实环境性能**：本报告为 Node 基准（p95 余量 >50 倍），真实 IPC/runtime 指标由桌面验收补测。
5. **gitDirty=true**：本包构建时含本任务未提交修改；主代理提交后按同链路重打即可获得 clean 构建（build-info 会如实反映）。
