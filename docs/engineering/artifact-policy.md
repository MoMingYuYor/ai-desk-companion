# 工件保留策略与目录清单（ENG-01）

> 依据：`docs/superpowers/plans/2026-10-08-desk-companion-improvements/engineering-showcase.md` ENG-01 节。
> 执行前清单（本策略全部数字的来源，扫描于 2026-10-08，未经任何删除）：
> - 仓库扫描：`D:\Administrator\Documents\ChatGPT\work\artifacts\desk-inventory-20261008.json`
> - 验收工作区扫描：`D:\Administrator\Documents\ChatGPT\work\artifacts\desk-acceptance-inventory-20261008.json`
>
> 本文件只定义规则与候选清单。**任何删除都是需要用户逐项确认的后续操作**，扫描器与本文档均不授权、也不执行删除。

## 1. 目的与范围

明确开发仓库（`D:\Chatgpt\待办`）、验收工作区（`D:\Chatgpt\acceptance\adc-rc1-20261002`）与个人数据目录之间的文件责任：什么长期保留、什么保留当前一份、什么按 run/commit 索引保留、什么属于重复副本可列为待审候选。逻辑字节数来自 `scripts/inventory-artifacts.mjs`（只读扫描，`lstat`/`Dirent` 判定，不跟随符号链接/reparse point，不读文件正文——仅身份清单 `build-info.json`/`manifest.json` 例外）。

## 2. 分类与保留规则

| 类别 | 覆盖范围 | 保留规则 |
|---|---|---|
| 源文件 source | `src` `tests` `docs` `scripts` `evals` `fixtures` `resources` 及仓库根散置文件 | 长期保留，随版本演进 |
| 版本历史 version-history | `.git` | 长期保留；是追溯与回退的唯一权威来源 |
| 开发依赖 dev-dependencies | `node_modules` | **保留当前一份**；可由 `package-lock.json` 重建，不计入可释放收益 |
| 构建 build | `out` `dist` | **发行保留当前验收包及一个回退包**；构建中间产物（`out/`、win-unpacked）可重建，重复形态列为候选 |
| 证据 evidence | 仓库 `artifacts/`（按 run/commit 索引） | **长期保留**；未完成的运行、唯一证据保持原样 |
| 验收副本 acceptance-copy | `D:\Chatgpt\acceptance\` 下各隔离工作区 | 逐项核对 manifest 与独有证据后决定；重复解包/clean-source/临时 runtime 副本列为待审候选 |
| 保护 protected | 个人用户数据目录（见第 4 节） | 仅登记，不遍历、不统计、不删除 |

## 3. 2026-10-08 清单摘要

### 3.1 仓库 `D:\Chatgpt\待办`（28 项，逻辑字节 2,537,738,050；文件 21,839；目录 3,744；错误 0；排除 0）

| 类别 | 项数 | 逻辑字节 |
|---|---:|---:|
| 构建（`dist` 1,075,088,237 + `out` 3,119,258） | 2 | 1,078,207,495 |
| 证据（`artifacts`，其中 `artifacts/acceptance` 约 732.8MB） | 1 | 733,286,828 |
| 开发依赖（`node_modules`） | 1 | 700,102,746 |
| 其他（根散置文件、`.superpowers`、`.eval-user-data` 等） | 16 | 14,299,914 |
| 源文件（7 个目录） | 7 | 6,120,247 |
| 版本历史（`.git`） | 1 | 5,720,820 |

### 3.2 验收工作区 `D:\Chatgpt\acceptance\adc-rc1-20261002`（20 项，逻辑字节 3,423,382,577；文件 75,425；目录 11,715；错误 0；排除 0）

全部条目属验收副本；身份核对结论见第 5、6 节。

## 4. 保护对象（显式列出，不遍历）

- `C:\Users\Administrator\AppData\Roaming\事务助手` —— 个人用户数据目录。扫描器内置该路径为保护根：仅登记 `category=protected`，不遍历、不统计、不做任何删除。**全部个人数据保持 protected，无例外。**
- 仓库内 `.eval-user-data`、`artifacts/eval-user-data*` 为合成评测 userData（非个人数据），按评测数据对待，默认保留。

### 共享文档工作区登记路径（仅本项目明确路径）

- `D:\Administrator\Documents\ChatGPT\work\docs\superpowers\plans\2026-10-08-desk-companion-improvements\engineering-showcase.md`（本任务规范）
- `D:\Administrator\Documents\ChatGPT\work\artifacts\desk-inventory-20261008.json`（仓库执行前清单）
- `D:\Administrator\Documents\ChatGPT\work\artifacts\desk-acceptance-inventory-20261008.json`（验收工作区执行前清单）
- `D:\Administrator\Documents\ChatGPT\work\artifacts\acceptance\adc-improvements-20261008\ENG-01\eng-01.log`（本任务日志）

## 5. 发行包：身份与保留

发行规则：**保留当前验收包 + 一个回退包**，其余历史包/重复形态列为候选。

| 工件 | 逻辑字节 | 构建身份 | 处置 |
|---|---:|---|---|
| `D:\Chatgpt\acceptance\adc-rc1-20261002\unpacked-2a75c25` | 512,914,638 | `2a75c25`（`resources/build-info.json`；与仓库证据 `T21/release.json` 的 LOCAL_PACKAGE_VERIFIED 一致，builtAtUtc 2026-10-02T15:32:39.665Z） | **保留：当前验收包** |
| `D:\Chatgpt\待办\dist\事务助手-0.1.0-portable-x64.zip` | 195,498,305 | `82f44e3`（2026-09-30 构建 / 10-01 打包） | **保留：回退包**（比当前包旧一格的最近可验证构建） |
| `D:\Chatgpt\待办\dist\win-unpacked` | 512,806,827 | `82f44e3` | 候选：回退包 zip 的解包重复形态 |
| `D:\Chatgpt\待办\dist\ai-desk-companion-0.1.0-portable-x64.zip` | 171,457,033 | 早于回退包（2026-09-18） | 候选 |
| `D:\Chatgpt\待办\dist\archive\事务助手-0.1.0-portable-x64.20260921.zip` | 195,206,116 | 早于回退包（2026-09-21） | 候选 |
| `D:\Chatgpt\待办\out` | 3,119,258 | 开发构建中间产物 | 保留（随开发重建，体积可忽略） |

说明：rc2（`adc-rc2-20261003`，R00–R03/R12 有记录、R04+ 未运行）未产生对应包或隔离工作区；rc1 的 `unpacked-2a75c25` 仍是最新已验证发行物。

## 6. 证据：唯一性核对结论

对验收工作区逐项核对了仓库侧 `artifacts/acceptance/adc-rc1-20261002/manifest.json`（run 清单，codeCommit `2a75c25`）、`checks.csv` 与 T00–T23 证据路径，并对工作区内容做了只读核查。结论：

**保留（唯一证据或当前身份绑定）：**

| 路径 | 逻辑字节 | 核对结论 |
|---|---:|---|
| `D:\Chatgpt\acceptance\adc-rc1-20261002\offline-cli-final-2a75c25` | 2,312,756 | 内含 `eval-mur4o*` 原始评测 run 输出，仓库中无副本；按 run/commit 长期保留 |
| `D:\Chatgpt\acceptance\adc-rc1-20261002\offline-cli-0d876ec` | 2,305,084 | 同上（`0d876ec` 那一轮 run 的原始输出，仓库无副本） |
| `D:\Chatgpt\acceptance\adc-rc1-20261002\perf-final-2a75c25` | 14,113,860 | T20 性能原始记录（records-1000/10000）+ owner 绑定 `clean-source-final` 路径；汇总在仓库 `T20/electron-perf-final.json`，原始记录仅此一份 |
| `D:\Chatgpt\acceptance\adc-rc1-20261002\clean-source-final` | 711,447,108 | 当前验收 commit `2a75c25` 的工作副本；HEAD=`2a75c25`、工作树干净、`perf-final` owner 引用其路径、`T20/source-attestation.json` 对其 `out/` 做过哈希核对 |
| `D:\Chatgpt\acceptance\adc-rc1-20261002\package-eval-1790956044061` | 3,220,256 | 打包态评测 userData（两份中较新） |
| `D:\Chatgpt\acceptance\adc-rc1-20261002\packaged-mcp-1790956494906` | 459,242 | 打包 MCP 验证 userData（两份中较新，与 T06 证据对应） |
| `D:\Chatgpt\acceptance\adc-rc1-20261002\package-health-user` | 459,242 | T21 健康检查 userData，证据多处引用 |
| `D:\Chatgpt\acceptance\adc-rc1-20261002\cli-mock-1790954325322` / `-4662036` / `-5555254` | 31,554 / 31,543 / 31,554 | T15 固定目标注入配置（case-ids/target），体积可忽略，保留作溯源 |

仓库侧 `artifacts/`（733,286,828 字节）全部按 run/commit 索引长期保留，不设候选。

## 7. 待审候选清单（删除需用户逐项确认）

核对方法（对每个 clean-source 变体统一执行）：① 该副本 `.git` HEAD 可解析且提交存在于主仓库历史（`git cat-file -t`）；② `git status --porcelain` 工作树干净（无未提交的独有改动）；③ 副本内 `node_modules/out/.git` 之外无日志、数据库或 run 输出等游离文件；④ 副本 `artifacts/research` 与仓库 `artifacts/research` 一致（6,807 字节副本）；⑤ 仓库证据（manifest/checks.csv/T 日志）中引用该路径的条目已知悉。**未发现任何副本承载独有证据**；但仓库证据以路径文字引用了这些目录，删除后引用指向的路径将不存在（引用文本与哈希仍保留在仓库）。

### 7.1 验收工作区（合计 2,176,055,740 逻辑字节）

| # | 准确路径 | 逻辑字节 | 身份核对 | 保留替代 | 风险 |
|---|---|---:|---|---|---|
| 1 | `D:\Chatgpt\acceptance\adc-rc1-20261002\clean-source-9369324` | 711,423,524 | HEAD 与 build-info 均为 `9369324`（中间构建，被 `2a75c25` 取代）；树干净；内含 node_modules 696,964,560 字节（可由 lockfile 重建）、out 3,097,719 字节 | 主仓库 git 历史 @`9369324` 可重建；T21 `clean-build.json` 记录构建过程 | 低。T21 等 15 处证据按路径引用它；删除后复现需重建 |
| 2 | `D:\Chatgpt\acceptance\adc-rc1-20261002\clean-source-lf` | 711,406,999 | HEAD=`0d876ec`（与 offline-cli-0d876ec 对应轮次），无 build-info；树干净；research 为仓库副本 | 主仓库 git 历史 @`0d876ec` 可重建；T21 `clean-lf-install.json` 已记录验证结论 | 低-中。11 处证据按路径引用；无 build-info，身份靠 `.git` HEAD 确认 |
| 3 | `D:\Chatgpt\acceptance\adc-rc1-20261002\clean-source-runtime` | 708,302,356 | HEAD=`5894d4b`，无 build-info、无 artifacts；树干净 | 主仓库 git 历史 @`5894d4b` 可重建 | 低-中。4 处证据按路径引用 |
| 4 | `D:\Chatgpt\acceptance\adc-rc1-20261002\clean-source` | 11,512,787 | HEAD=`2efd395`；最早纯源码副本（无 node_modules/out/build-info）；树干净 | 主仓库 git 历史 @`2efd395` 可重建 | 低 |
| 5 | `D:\Chatgpt\acceptance\adc-rc1-20261002\perf-main-2309` | 1,491,030 | 早期性能探针（仅 records-1000），被 perf-final 取代；仓库 T20 汇总不受影响 | T20 汇总证据 + perf-final 原始记录 | 低 |
| 6 | `D:\Chatgpt\acceptance\adc-rc1-20261002\perf-main-2312` | 14,113,770 | 中间性能 run（records-1000/10000），被 perf-final 取代 | 同上 | 低-中。9 处证据按路径引用；如 SHOW-01 需回放中间对照需先确认 |
| 7 | `D:\Chatgpt\acceptance\adc-rc1-20261002\perf-screens-2315` | 14,113,794 | 截图场景性能 run，被 perf-final 取代 | 同上 | 低-中。同上 |
| 8 | `D:\Chatgpt\acceptance\adc-rc1-20261002\package-eval-1790955448385` | 3,232,238 | 打包态评测 userData 两份中较旧的一份 | 保留较新的 `-6044061` 与仓库 T13/T17 证据 | 低 |
| 9 | `D:\Chatgpt\acceptance\adc-rc1-20261002\packaged-mcp-1790956473564` | 459,242 | 打包 MCP userData 两份中较旧的一份 | 保留较新的 `-6494906` 与 T06 证据 | 低 |

### 7.2 仓库发行目录（合计 879,469,976 逻辑字节）

| # | 准确路径 | 逻辑字节 | 核对结论 | 保留替代 | 风险 |
|---|---|---:|---|---|---|
| 10 | `D:\Chatgpt\待办\dist\win-unpacked` | 512,806,827 | 回退包 zip（`82f44e3`）的解包重复形态 | 需要时解压保留的 zip，或 `npm run dist` 重建 | 低。卸载/复测用得着解包形态时需先重建 |
| 11 | `D:\Chatgpt\待办\dist\ai-desk-companion-0.1.0-portable-x64.zip` | 171,457,033 | 最旧命名的历史打包（09-18），早于回退包 | 当前包 + 回退包已覆盖 | 低 |
| 12 | `D:\Chatgpt\待办\dist\archive\事务助手-0.1.0-portable-x64.20260921.zip` | 195,206,116 | 09-21 归档 zip，早于回退包 | 回退包已选 `82f44e3`（更新且有 build-info 绑定），两者二选一 | 中。若用户更信任 09-21 归档作回退，则应改为删除 `dist\事务助手-0.1.0-portable-x64.zip` 并保留本项 |

### 7.3 收益口径

- 收益以执行前清单（2026-10-08 两份 JSON）为准；上述合计 **3,055,525,716 逻辑字节（约 2.85 GiB）** 为全部候选删除后的上限估计，实际以逐项确认为准。
- **仓库自身 `node_modules`（700,102,746 字节）保留当前一份，不计入可释放收益**；逻辑字节为文件大小之和，不等于磁盘物理占用（簇开销、压缩、硬链接均未计入）。
- 候选 clean-source-* 内的依赖副本（实测 `clean-source-9369324` 为 696,964,560 字节，lf/runtime 同量级）属于重复工件，随目录删除而释放；若只删源码部分保留依赖，收益相应减少且目录不完整。

## 8. 执行边界与复核

1. 本任务（ENG-01）未删除任何文件；扫描器 `scripts/inventory-artifacts.mjs` 不提供删除开关。
2. 任何删除前：逐项向用户确认准确路径 → 执行后重新运行扫描器比对清单。
3. 复核命令：

```powershell
Set-Location -LiteralPath 'D:\Chatgpt\待办'
node node_modules/vitest/vitest.mjs run tests/desktop/artifactInventory.test.ts --reporter=verbose --testTimeout=10000
node scripts/inventory-artifacts.mjs --root D:/Chatgpt/待办 --output D:/Administrator/Documents/ChatGPT/work/artifacts/desk-inventory-20261008.json
node scripts/inventory-artifacts.mjs --root D:/Chatgpt/acceptance/adc-rc1-20261002 --output D:/Administrator/Documents/ChatGPT/work/artifacts/desk-acceptance-inventory-20261008.json
```
