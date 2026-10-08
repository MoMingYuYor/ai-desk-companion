# 六项改进交付验收(adc-improvements-20261008)

执行日期为 2026-10-08,发布标识 adc-improvements-20261008,源码仓库 `D:/Chatgpt/待办`。本文档由 DEL-01 建立并登记候选包与身份验证;DEL-02(十项真人 GUI 记录)在同一文档续写。全部证据属本地产物,不假定随源码克隆存在。

## DEL-01:候选集成、身份校验与新包

### 0. 环境与版本

| 项 | 值 |
| --- | --- |
| 操作系统 | Windows 10.0.26200 x64 |
| Node.js | v24.19.0 |
| Electron | 44.4.3(构建复用项目本地 `node_modules/electron/dist`,runtime 预检通过,未触发安装链路) |
| electron-builder | 26.15.3 |
| 分支 / 候选提交 | `feat/agent-portfolio` / `b58df1aabb67f579ad2f1c5581c517dd7f7bb376` |
| 真实模型调用 | 0 次(全流程 fake/离线) |

### 1. 改动文件清单(本任务写入责任范围)

| 文件 | 类型 | 内容 |
| --- | --- | --- |
| `scripts/lib/build-identity.mjs` | 新增 | 共享逻辑:与 write-build-info.mjs 契约一致的确定性树 hash、目录树逐文件对比、asar 文件树遍历与按 Windows 路径语义取字节(@electron/asar 3.4 的 `getFile` 在 Windows 按 `path.sep` 切分,须用平台分隔符) |
| `scripts/verify-package-identity.mjs` | 新增 | 包身份校验器 CLI:`--packaged <绝对包目录> --expected-commit <完整commit> --output <绝对JSON>`,可选 `--source-root`(测试夹具注入,默认仓库根);输出 PASS/FAIL、checks、差异清单、树 hash、ZIP hash 引用、环境;退出码 0/1/2 |
| `tests/desktop/packageIdentity.test.ts` | 新增 | 11 项测试:基线 PASS + 十类「存在性通过但身份错」反例,临时夹具内用 @electron/asar 生成真实 app.asar,树 hash 在测试内独立实现避免被测实现自证 |
| `scripts/check-build.mjs` | 未修改 | 前置任务已具备 `--packaged` 与 CSP 静态出口;本轮核对后确认无需增强,保持原样 |

未触碰:`src/` 全部、renderer、`package.json` scripts 既有语义、`evals/` 数据;未执行 git commit(改动以未跟踪文件存在,由主代理统一提交)。

### 2. 失败反例(红→绿)

- 红:实现前 `npx vitest run tests/desktop/packageIdentity.test.ts` → **11/11 失败**(被测脚本不存在)。
- 绿:实现后同命令 → **11/11 通过**。反例覆盖(均为临时夹具,验证身份错必须 FAIL/exit 1):
  build-info commit 旧于 expected(构建期间 HEAD 变化同路径)、gitDirty=true、build-info appVersion 与源/asar 不一致、asar package.json 版本不一致、打包资源缺失文件、资源内容变化、资源多出文件、asar 内 out 内容旧、build-info 资源清单过期(树 hash 与实际不符)、expected-commit 非 40 位十六进制(exit 2)。
- 真实包负例:对候选包以错误 expected-commit 运行校验器 → exit 1、FAIL(`identity-negative.json`)。

### 3. 候选集成

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 候选记录 | `git rev-parse HEAD` | `b58df1aabb67f579ad2f1c5581c517dd7f7bb376`,跟踪文件零改动 |
| 类型检查 | `npm run typecheck` | exit 0(node + web 双工程) |
| 全量测试 | `npm test -- --reporter=dot` | **152 文件 / 1817 项全部通过,0 失败 0 跳过**,9.13 秒(上限 180 秒) |
| 构建 | `npm run dist -- --config.directories.output=D:/Chatgpt/待办/artifacts/acceptance/adc-improvements-20261008/DEL-01/package --config.win.signAndEditExecutable=false` | exit 0,远低于 240 秒上限;exe 图标与版本资源编辑关闭(未签名,与 rc1 口径一致) |

**干净构建说明**:本任务 3 个新文件在构建前以 `git stash push -u` 暂存(构建后立即 `git stash pop` 恢复),使打包时工作树与 HEAD b58df1a 逐字节一致,build-info 如实记录 `gitDirty:false`;构建前后 HEAD 核对一致。发行目录为本轮新建 `artifacts/acceptance/adc-improvements-20261008/DEL-01/package`(原为不存在),既有 `dist/` 归档未移动未覆盖。

### 4. 包身份

| 项 | 值 |
| --- | --- |
| 文件名 | `事务助手-0.1.0-portable-x64.zip` |
| 字节数 | 195,529,216 |
| SHA-256 | `bffe4643d0a7050b981b1d4449f1ed504ea46e5ebd7a8e69507afcd82544e1e1` |
| 打包 build-info | commit `b58df1a…`、gitDirty **false**、builtAtUtc 2026-10-08T15:37:28.744Z、appVersion 0.1.0(源 package.json ↔ build-info ↔ asar package.json 三方一致) |
| 资源树 hash | evals/datasets `0756c1bd…`、fixtures/research `3dfd5b25…`、evals/prompts `f127b034…`(源 ↔ 包 ↔ build-info 预构建记录逐文件一致) |
| out/** | 源 ↔ asar 内 20 个文件路径与逐字节 SHA-256 零差异,main/preload/三 renderer/CLI 六关键入口齐备 |

`node scripts/check-build.mjs --packaged <win-unpacked>` → exit 0(资源完整)。
`node scripts/verify-package-identity.mjs --packaged <win-unpacked> --expected-commit b58df1a… --output identity.json` → **PASS,9 项检查全部通过,零差异**。身份 JSON:[DEL-01/identity.json](D:/Chatgpt/待办/artifacts/acceptance/adc-improvements-20261008/DEL-01/identity.json);release 绑定:[DEL-01/release.json](D:/Chatgpt/待办/artifacts/acceptance/adc-improvements-20261008/DEL-01/release.json)。

### 5. 离线运行验证

ZIP 解压到 `D:/Chatgpt/adc-improvements-20261008/offline/app`(与源码、cwd 均不同),启动 cwd 为 `D:/Chatgpt/adc-improvements-20261008/offline`。每个场景使用全新绝对 userData。

**(a) 健康检查**:exit 0、迁移到最新 v9、同一 userData 第二次启动 exit 0 报告形态一致(无重复播种)。**异常如实登记**:报告 `readOnlyTool` 字段为「非法状态转移:failed → cancelled」而非 rc1 时代的 `{tool:'todo.list',count:2}`——todo.list 网关调用本身成功(轨迹 persistence 相 `outcome=success, committed=true`),但工具完成触发的调度器唤醒把仍处 queued 的自检 run 走 planning,全新目录无模型配置 → `MODEL_OUTPUT_INVALID` 转 failed;healthcheck 收尾 cancelled 撞非法转移被 catch 写入该字段。两次启动均确定性复现。属 HEAD 既有回归(rc1 之后引入,与调度器接力接线相关),与 DEL-01 改动无关;修复需动 src/,超出本任务写入责任,见第 7 节未解决点。

**(b) 窗口冒烟**:`--remote-debugging-port` 经 CDP `/json/list` 只读观察(无自动点击):workbench(`事务助手`)与 pet 两窗口从 `app.asar` 内加载并稳定 ≥4 秒;隔离 userData-b 的 `data.sqlite` 已创建;panel 未在观察时刻出现(按需创建);进程由验收方 taskkill 结束。真人 GUI 流程归 DEL-02。

**(c) 桌面 Evals(四项 fake)**:经任务授权的等价链路 `node out/main/eval-cli.js` 执行(身份校验已证明源 out/** 与 asar 内 out/** 逐字节一致、三棵资源树与包内逐字节一致;差异如实声明:纯 Node 而非 Electron 主进程运行、资源经源根定位、versionsOf 要求源仓库 git 干净故在 stash 窗口执行)。Ops(personal_ops_v2)与 Research(research_v1)两模板 baseline/candidate 共四项,`--split dev --repeats 1 --max-cases 2`:四项全部 exit 0、每项 passed 2 / failed 0(runId:`eval-muzplj13-a3af5180`、`eval-muzplw5d-254e1d75`、`eval-muzplwg4-242410af`、`eval-muzpm07q-7825ecec`;每项执行 2 案例后按批次预算收尾,余量 not_run 属预算内)。

**(d) MCP 入口**:两次独立全新 userData 启动 `事务助手.exe --mcp --user-data <新目录>`,initialize 均返回 `personal-ops-mcp@0.1.0`(protocolVersion 2024-11-05),关闭 stdin 后两进程均以退出码 0 正常结束。

### 6. 验收项自查(对照 delivery.md DEL-01 勾选项)

| 规范要求 | 状态 | 证据 |
| --- | --- | --- |
| 失败反例:commit 旧、dirty、版本、资源缺失/新增/变化、asar out 旧、HEAD 变化 | 完成 | 第 2 节 11 项测试 红 11 失败 → 绿 11 通过 + 真实包负例 |
| 三棵资源树逐文件 SHA-256 + tree hash + build-info 匹配 | 完成 | 第 4 节;identity.json checks `resource:*` 全 ok |
| out/** 与 asar 内 out/** 路径与字节 hash(含六关键入口) | 完成 | 第 4 节;check `out` ok(20 文件零差异) |
| 新发行目录构建、超时上限声明 | 完成 | 全新目录;构建 <240 秒、测试 <180 秒,均未触发重试 |
| 构建后 HEAD/输入未变、ZIP 字节与 SHA-256、release.json 绑定 | 完成 | HEAD 前后一致;第 4 节;DEL-01/release.json |
| 解压独立目录、源码/解压之外 cwd、两个全新 userData、健康检查、窗口启动 | 完成 | 第 5 节(a)(b);healthcheck readOnlyTool 回归如实登记 |
| 桌面 Evals Ops/Research 两模板共四项 fake | 完成(等价链路 + 差异声明) | 第 5 节(c) |
| MCP 两次 stdin EOF 正常退出 | 完成 | 第 5 节(d),两次 exit 0 |
| 旧包不覆盖 | 完成 | dist/ 归档未动,输出在 artifacts 新目录 |
| @electron/asar 显式 devDependencies | 前置已就绪 | package.json `devDependencies.@electron/asar: ^3.4.1`(前置任务完成,本轮核对) |

### 7. 未解决点(交整合者/DEL-02)

1. **healthcheck readOnlyTool 回归(HEALTHCHECK-READONLYTOOL-REGRESSION)**:机制与证据见第 5 节(a) 与 release.json knownIssues。影响为证据字段降级(ok/exit code/迁移语义未受影响),建议在 healthcheck 模式隔离调度器或让自检 run 不入队;需 src/ 改动,超出 DEL-01 写入责任。DEL-02 真人验收前建议先修复,避免 GUI-01 基础证据被该字段干扰。
2. **打包态 Evals 直接驱动**:本轮以等价链路完成并逐项声明差异;若整合者要求打包 exe 内直接驱动 EvalsService,需应用侧提供打包态 CLI 入口(现 eval-cli 的 versionsOf 依赖源仓库 git)。
3. **窗口冒烟为进程/CDP 级证据**:无真人屏幕确认;完整真人 GUI 归 DEL-02,`docs/acceptance/rc-improvements-20261002.md` 后续沿用本包。

### DEL-02:十项真人 GUI 记录(待续)

消费本轮包(`事务助手-0.1.0-portable-x64.zip`,SHA-256 `bffe4643…`)与 `artifacts/acceptance/adc-rc1-20261002/T19/gui-checks.csv` 十行模板,记录至本节。当前状态:未执行。
