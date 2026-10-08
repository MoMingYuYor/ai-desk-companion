# 依赖风险核对与最小处置清单(2026-10-08)

> 任务来源:2026-10-08 六项改进计划 SEC-02。本清单为交付物本身,不执行任何依赖升级或强制修复。
> 性质声明:除 npm audit 元数据查询外,本文未做其他联网核验;advisory 数据的扫描时间为
> **2026-10-08T07:32:09Z(UTC)**,来源 `npm audit --json`(registry.npmjs.org)。此后 registry 状态可能变化。

## 1. 基线记录

| 项 | 值 |
| --- | --- |
| 仓库 | `D:/Chatgpt/待办`(feat/agent-portfolio,基线 HEAD `e66840c`) |
| package-lock.json SHA-256 | `a3b297ab634c925d8835b59523e67a57733204d2ccfde7e4b3da46323b2300a1` |
| lockfileVersion | 3(625 个 packages 条目,含根) |
| 安装树 | `npm ls --all --json` 退出码 0,无 extraneous/invalid;顶层 30 项,展开 941 节点(存档:npm-ls.json) |
| 生产依赖 | html-to-text、imapflow、mailparser、mammoth、pdfjs-dist、sanitize-html、solarlunar、sql.js、word-extractor、xlsx |
| 来源说明 | 全部来自 registry.npmjs.org;**例外**:`xlsx` 固定取自 `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`(SheetJS 官方 CDN,非 npm registry;供应链来源变更需单独确认) |

### 本轮 package.json 变更与锁文件状态

本轮为 DEL-01 预置,在 devDependencies 追加了 `"@electron/asar": "^3.4.1"`(当前是
app-builder-lib → electron-builder 的传递依赖,3.4.1 已在 node_modules)。**按要求未运行 npm install**,
因此 package-lock.json 尚未把该包登记为根直接依赖:在整合者执行 `npm install` 同步锁文件之前,
`npm ci` 会因 lock 与 package.json 不一致而失败。这是已知且预期的过渡状态,须在 DEL-01 落地时消除。

## 2. 历史告警线索复核结论

- **brace-expansion**:历史线索,本次扫描确认为**当前真实存在**(非历史残留),详见 §3 条目 B-1。
- **fast-uri**:历史线索,本次扫描确认为**当前真实存在**,详见 §3 条目 M-4。
- 除上述两项外,未在本文记录其他"需复核线索";如后续翻出旧告警,按同样方式先复核再入表。

## 3. 风险条目与逐项处置

共 14 条审计命中(3 high / 11 moderate / 0 critical),按依赖链归并为 6 组。
「生产可达性」区分两层:**是否随产物分发**(打进 app.asar)与**触发条件是否可达**(运行时能否把恶意输入送进漏洞路径)。

### B-1 brace-expansion — HIGH

- 安装实例:6 处,全部 `dev`(electron-builder 工具链):
  根 `5.0.9`(经 minimatch@10);`@electron/asar`、`dir-compare`、`glob` 内 `1.1.18`;
  `@electron/universal`、`filelist` 内 `2.1.4`。
- Advisory(GHSA-q2hr-2g5m-vwhr / qhr7-859c-m2p7 / 6j4f-fj2g-mc7p):花括号展开二次复杂度与递归栈耗尽 DoS,
  漏洞范围 `<1.1.21`、`>=2.0.0 <2.1.7`、`>=4.0.0 <5.0.12`,三实例全部命中。
- 最小修复版本(按 advisory 范围推得):`1.1.21` / `2.1.7` / `5.0.12`。
- 生产可达性:**不随产物分发**(仅 electron-builder 打包工具链);触发需把不受控花括号模式送进 minimatch,
  构建期 glob 均为仓库内自有脚本,无外部输入面。
- 触发条件:构建期不受控 glob 展开(现无此路径)。
- **处置:暂缓(最小锁文件补丁预案)**——后续以 package.json `overrides` 强制三版本下限,回归范围:
  `npm run dist` 便携 ZIP 打包、`check-build --packaged` asar 结构、electron-builder 全链。
- 阻塞判定:仅构建期,不进运行时;若按"未解决 HIGH 一律阻塞签发"口径执行,本项为阻塞点,
  豁免依据即本条生产可达性结论。

### B-2 http-cache-semantics — HIGH

- 安装实例:根 `4.2.0`(dev),经 `cacheable-request@7.0.4` ← `got@11.8.6` ← `@electron/get@4.x(嵌于 app-builder-lib)`,
  仅在 **electron / 二进制资源下载**(安装、electron-builder 拉取)时使用。
- Advisory(GHSA-ch52-4w7c-c8xp):max-stale 处理可泄露跨用户缓存响应,漏洞范围 `<=4.2.0`。
- 最小修复版本:按 advisory 范围推得 `>4.2.0`;**实际已发布补丁版本 UNKNOWN**(未联网核验)。
- 生产可达性:**不随产物分发**(运行时无 got/cacheable-request);本机应用不使用 HTTP 缓存共享场景。
- 触发条件:多用户共享缓存代理下的响应串扰;本项目构建环境为单用户。
- **处置:暂缓**——随 electron-builder 链升级或 overrides 一并处理,回归范围:electron 安装与
  electron-builder 资源下载流程(含代理环境)。
- 阻塞判定:同 B-1 口径说明。

### B-3 source-map-js — HIGH(随产物分发,但触发不可达)

- 安装实例:根 `1.2.1`,消费方 `postcss@8.5.28`;postcss 有两条依赖路径:
  `vite`(dev,构建期)与 **`sanitize-html`(生产依赖)**。
- Advisory(GHSA-68fv-2mgg-jv7q):解析带恶意 indexed section 偏移的 source map 可造成事件循环 DoS,
  漏洞范围 `>=1.0.0 <1.2.2`。最小修复版本 `1.2.2`。
- 生产可达性:**代码随产物分发**(sanitize-html → postcss → source-map-js 会打进 app.asar),
  但**触发条件不可达**:漏洞入口是"解析不受控 source map 文件",运行时唯一使用 postcss 的路径是
  sanitize-html 解析邮件内联 style 属性(`src/main/mail/sanitize.ts`),该路径不解析、不生成 source map。
- **处置:暂缓(建议下一轮最小补丁优先项)**——overrides `source-map-js@>=1.2.2`(postcss 声明 `^1.2.1`,
  minor 兼容),回归范围:邮件 sanitizer 单测(`tests/mail/security.test.ts`)、邮件正文渲染、vite 构建。
- 阻塞判定:HIGH 且在产物内;即便触发不可达,建议在签发前用 overrides 消除以获得干净审计,
  所需成本极低(minor 版本)。

### M-1 mammoth → argparse → sprintf-js — moderate(随产物分发,但触发不可达)

- 安装实例:`mammoth@1.12.3`(生产)→ `mammoth/node_modules/argparse@1.0.10` → `mammoth/node_modules/sprintf-js@1.0.x`;
  根 `sprintf-js@1.1.3` 另有 dev 侧实例(经 roarr,见 M-3)。
- Advisory(GHSA-hp3w-g68c-fv3c):sprintf-js 无界精度说明符 DoS,漏洞范围 `<=1.1.3`(即全部版本);
  argparse 1.0.0–1.0.10 经由它被标记。
- 修复版本:**sprintf-js 无已发布修复(UNKNOWN)**;npm audit 给出的 fixAvailable 是把 mammoth 降到
  `0.3.29`(semver-major **降级**),不可取,视为"无可行自动修复"。
- 生产可达性:**代码随产物分发**(mammoth 是 docx 导入的生产依赖),但触发不可达:
  argparse/sprintf-js 只服务于 mammoth 的 CLI 入口,应用走库 API(`mammoth.convertToHtml`,docx 材料导入),
  不经过 argparse;且漏洞需把不受控格式串喂给 sprintf,库路径不存在该调用。
- **处置:保留现版本,暂缓**——等待上游 mammoth 更新其 argparse/sprintf-js 依赖后随 minor 升级,
  禁止按审计建议降级;回归范围:docx 导入单测(`tests/retrieval/*`、材料导入链)。

### M-2 @electron/get / global-agent / roarr 链 — moderate

- 安装实例:`app-builder-lib/node_modules/@electron/get@4.x` → `global-agent@3.0.0` → `roarr@2.15.4` → 根 `sprintf-js@1.1.3`,全部 dev;
  根 `@electron/get@5.1.0` 不在漏洞范围。
- Advisory:global-agent(≤3.0.0)、roarr(≤2.15.4)经 sprintf-js 关联(M-1 同源),`@electron/get`(1.6.0–4.0.3)经 global-agent 关联。
- 生产可达性:**不随产物分发**;仅 electron 二进制下载时的代理环境变量处理路径。
- **处置:暂缓**——随 electron-builder 26.x 上游版本线统一升级(属核心工具链升级,另行取得确认),
  回归范围:打包全流程与 electron 安装。

### M-3 app-builder-lib / dmg-builder / electron-builder / electron-builder-squirrel-windows — moderate

- 安装实例:`app-builder-lib@26.15.3`、`electron-builder@26.x` 全家,全部 dev;
  被标记因其依赖 B-2/M-2 链(M-3 本体无独立 advisory,为链式命中)。
- 生产可达性:**不随产物分发**(构建工具)。
- **处置:暂缓**——与 B-2/M-2 同一处置批次:升级 electron-builder 或以 overrides 掐断末端漏洞包;
  回归范围:`npm run dist` 便携 ZIP、check-build --packaged、asar/extraResources 契约。
- 说明:electron-builder 是核心工具链,升级属"核心依赖升级",须另行取得具体确认,本清单不代行。

### M-4 fast-uri — moderate

- 安装实例:根 `3.1.7`(dev),经 `ajv@8.20.0` ← `app-builder-lib@26.15.3`。
- Advisory(GHSA-hrr3-gc8f-f4qj):百分号编码八位组导致主机名大小写归一化不一致(潜在 SSRF 绕过),
  漏洞范围 `>=3.0.0 <3.1.8`。最小修复版本 `3.1.8`。
- 生产可达性:**不随产物分发**(ajv 仅服务 electron-builder 的配置校验);本机渲染层 URL 策略
  (`src/main/security/ipcPolicy.ts`)自有一套解析,不经 fast-uri。
- **处置:暂缓**——overrides `fast-uri@>=3.1.8` 或随 electron-builder 升级;回归范围:打包流程。
- 与历史线索的关系:2026-10-08 之前的历史告警线索,本次已复核为当前存在。

## 4. 汇总

| 条目 | 严重度 | 随产物分发 | 触发可达 | 处置 | 需要的回归 |
| --- | --- | --- | --- | --- | --- |
| B-1 brace-expansion | HIGH | 否 | 否(构建期) | 暂缓,overrides 预案 1.1.21/2.1.7/5.0.12 | electron-builder 打包链 |
| B-2 http-cache-semantics | HIGH | 否 | 否 | 暂缓,修复版本 UNKNOWN 待复核 | electron/electron-builder 下载流程 |
| B-3 source-map-js | HIGH | 是(sanitize-html 链) | 否(无 source map 解析路径) | **建议下一轮 overrides ≥1.2.2(低成本)** | 邮件 sanitizer 单测、vite 构建 |
| M-1 mammoth/argparse/sprintf-js | moderate | 是(docx 导入链) | 否(仅 mammoth CLI 路径) | 保留,禁降级,等上游 | docx 导入单测 |
| M-2 @electron/get/global-agent/roarr | moderate | 否 | 否 | 暂缓,随 electron-builder 升级 | 打包与下载流程 |
| M-3 electron-builder 全家 | moderate | 否 | 否 | 暂缓,同上 | 打包全流程 |
| M-4 fast-uri | moderate | 否 | 否 | 暂缓,overrides ≥3.1.8 | 打包流程 |

### 签发阻塞口径

按"需要修复的未解决高风险条目显式阻塞相应发行"的完成标准:

- 3 项 HIGH 中,B-1/B-2 仅存在于构建工具链,不进运行时产物;B-3 的代码随产物分发但触发路径不存在。
- 若整合者采用严格口径(未解决 HIGH 一律阻塞便携 ZIP 签发),则 B-1、B-2、B-3 为阻塞点;
  豁免依据即上表"触发可达=否"及触发条件分析,应随验收记录存档。
- 本清单推荐:B-3 以 overrides(minor 版本)在下一轮直接修复;B-1/B-2 随 electron-builder
  工具链升级批次处理,期间保持暂缓并留档。修复通过后需重新冻结评测并重新打包。

### 约束遵守声明

- 未运行 `npm audit fix`、`npm audit fix --force` 或任何依赖升级/降级。
- npm audit 仅作只读元数据查询(任务已授权),未发送除包名/版本外的任何数据。
- 核心依赖升级、全局安装、供应链来源变更均未发生;xlsx 的非 registry 来源维持原状并在案。
