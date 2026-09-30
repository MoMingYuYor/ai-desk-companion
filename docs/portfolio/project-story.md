# 项目故事：本地优先的 AI 事务助手（Electron + TypeScript）

> 本文档面向求职场景的项目讲述，仅陈述可核对的事实。文中所有源码位置均对应提交 `6bf4808`（分支 `feat/agent-portfolio`）时的实际代码，行号以该提交为准。
>
> **诚实边界（先读这一段）**：本项目当前的全部模型评测均以 FakeProvider 驱动，属于**流程验证**，不构成对真实模型能力的测量。真实模型成功率、成本、延迟等数字尚未产生，本文在相应位置以【待 EXP-01 真实数据】占位，不虚构任何成绩。

## 1. 问题

求职准备过程中，用户需要把散落的岗位描述（JD）、个人材料、日程与待办放在一个地方反复对照：这份岗位要求什么？我的材料里有哪些证据支持或矛盾？哪些结论可以直接变成待办去执行？

通用聊天式 AI 有三个不适配点：

1. **结论无法定位**——模型说"你的简历提到过 X"，用户没法点回到原文那一行；
2. **写操作不可控**——"帮我加个提醒"直接执行，用户失去确认机会，错了也无法防重复；
3. **评测不可信**——改一行提示词后"感觉变好了"，没有固定数据集、隔离环境和可回放证据。

本项目是一个本地优先的桌面应用：资料、检索、模型请求预算、工具执行的审批权都留在本机；模型只做规划与命题，写入数据库的每一步都经人工审批与幂等保护。

## 2. 用户路径

一条可演示的完整路径（对应 `docs/demos/deep-research-agent.md` 的四条路线与桌面验收场景）：

1. **导入资料**：把 JD、简历、项目说明等 JSON/CSV/Markdown 文件导入本地库，生成规范化全文、码点坐标快照与 FTS4 全文索引；
2. **提出研究问题**：例如"这份 JD 要求的测试经验，我的材料里有冲突吗？"
3. **得到带引用的研究报告**：每条事实命题（claim）挂着可点击的证据片段，点击定位到原文码点区间；证据不足时明确说"不足"，不编造；
4. **把建议转成待办**：研究报告的一条建议转成 Ops 待办草稿；
5. **人工审批后写入**：Agent 生成的每一次数据库写操作（新增/修改待办、日程）先成为待批准提案，用户批准后才执行，且只执行一次。

四条演示路线覆盖四种典型结果：`normal`（单文档定位，证据闭包成立）、`conflict`（快照间冲突并列呈现，不投票裁决）、`insufficient`（证据不足，诚实收尾）、`injection`（提示注入不执行，研究照常完成）。复现入口为 `npx vitest run tests/research/demoRun.test.ts`。

## 3. 架构

**技术栈**：Electron + TypeScript + sql.js（WASM SQLite）+ FTS4 + Vitest。无后端服务器；数据库文件在用户目录，主进程是唯一写者。

```
渲染进程（React 页面）
   │  IPC（typed channels）
   ▼
主进程
├─ RunScheduler（src/main/agent/runScheduler.ts）   ← Ops 与 Research 共享的调度接力
├─ Orchestrator / Research Workflow（规划与执行状态机）
├─ ToolGateway（src/main/tools/gateway.ts）          ← 工具执行唯一入口
│    ├─ ToolRegistry（风险等级、输入 schema、resolveTargetVersion）
│    └─ runOperation（src/main/db/operations.ts）     ← 幂等回执 + 事务 + 乐观锁
├─ ModelRouter（src/main/services/modelRouter.ts）    ← 单发送契约、真实 abort
│    └─ ModelRequestControl（src/main/services/modelRequest.ts）← 预算准入/观测回调
├─ Research 链路（src/main/research/）                ← 快照、检索、证据、引用、报告
└─ Eval 基础设施（src/main/evals/）                   ← 隔离环境、判分、产物导出
```

关键结构决策：

- **主进程单写者**：渲染进程不直接触碰数据库；所有写操作经由主进程 `runOperation`（`src/main/db/operations.ts:114`）在一个事务内完成"业务写入 + 回执落库"，失败整体回滚，不留半状态。
- **工具网关 + 审批**：`ToolGateway`（`src/main/tools/gateway.ts`）是工具执行唯一入口。风险等级由注册表决定，调用方传来的任何风险声明只是"未知字段"被 schema 拒绝；写操作必须先经 `propose` 生成 pending 审批（绑定冻结参数 hash、计划版本、目标版本、有效期），`execute` 逐项校验后才能执行。
- **引用闭包**：研究报告的每条命题沿 Claim → Citation → EvidenceSpan → SourceSnapshot → Source 逐项结构校验（`src/main/research/citations.ts:82`），quote 必须与快照码点切片逐字一致，来源必须在冻结清单内。
- **sql.js 落盘确认**：sql.js 是内存库 + 主动 flush 模型。关键写入在事务提交后还要经 `PersistenceCoordinator.commitCritical` 确认真正落盘（`src/main/db/operations.ts:183`），落盘失败返回 `PERSIST_FAILED` 并携带 operationId，可重试且不重复执行。

## 4. 关键取舍（每条连源码）

### 4.1 审批绑定冻结参数，而不是绑定"一句同意"

`src/main/tools/gateway.ts:88-144`（propose）与 `gateway.ts:340-360`（assertApproved）：审批记录保存的是**参数 hash + 参数 JSON + 计划版本 + 目标版本**。批准之后参数变一点、计划换一版、目标被改过，都拒绝执行并要求重新生成提案。目标版本用 `resolveTargetVersion` 在提案时解析一次、执行前重新解析比对（`gateway.ts:367-381`）——批准到执行之间目标被再修改即 CONFLICT（乐观锁 `src/main/db/operations.ts:151`）。

一对容易忽略的细节：信封里出现 `approved` 键（无论值，包括显式 `false`）一律拒绝（`gateway.ts:329-333`）——契约不接受客户端声明批准；目标版本与有效期校验放在 `runOperation` 的 apply 内、只对"新执行"生效——保存重试走回执重放路径，不会被本次执行造成的 revision 增长误拒（`gateway.ts:152-156` 注释）。

### 4.2 共享调度器：一个执行权，两条业务线

Ops 与 Research 共用同一个 `agent_runs` 表、同一个队列与调度出口（`src/main/agent/runScheduler.ts`）。此前两个工作流各自"收尾驱动下一个"，等待/失败/取消/批准路径各自实现，容易出现缺接力；批准更是直接转 executing 与队列状态竞争。调度器提供唯一出口：`register(request/abort)`，合并唤醒（下一微任务挑选就绪项，没有可执行项即停止，不忙轮询）；旧 Promise settle 前保持驱动占用（`runScheduler.ts:87-114`），数据库约束（planning/executing 状态数）与内存占用双重检查。等待人工的运行不占执行权，批准后经 `tryResume` 重新领取。

### 4.3 记录范围：多记录文件的隔离单位

一个 JSON 数组或 CSV 多行文件导入后，每个逻辑记录的检索与证据被限制在整文件码点坐标系内的记录范围里（`src/main/research/recordScope.ts`）。范围只能由导入期的码点累计产生，禁止用 `indexOf` 猜边界（`recordScope.ts:9-14` 注释）；FTS 只索引范围内分块（`chunkRecord`，`recordScope.ts:88-96`）；检索时冻结集合过滤前置到 MATCH 候选阶段（`src/main/retrieval/search.ts:71-102`），清单外内容不挤占候选窗口。旧的多记录来源无范围元数据时以 `RECORD_SCOPE_REQUIRED` 拒绝，不从扁平全文猜边界。

### 4.4 引用支持度：结构层确定，语义层送审，缺员不投票

`src/main/research/citations.ts` 把检查分成两层：结构层（引用归属、冻结清单成员、快照 hash、码点 offset、quote 精确匹配、chunk 覆盖）是确定性规则，失败直接落 `unsupported`；语义层（片段是否真支持命题）交给独立审核。两个反"凑数"的规则：模型只给 quote 时不猜 offset——限定 chunk 内多处命中就拒绝，必须显式提供 offset（`citations.ts:181-213`）；`all_of` 联合证据组持久化预期成员清单，被拒绝的成员保存 null ID 与拒绝原因，缺任何一员整组不成立，剩余成员的"多数票"不能替代全部条件（`citations.ts:310-334`、`allOfIncompleteClaimIds`）。无 supports 引用的命题同样落 `unsupported`，不升级。

### 4.5 预算下沉到网络层，逻辑次数与物理发送分列

研究预算最初只在上层账本里"算术上减一"，网络层重试与备用切换不受控（详见失败案例 F-05）。修复后 `ModelRequestControl`（`src/main/services/modelRequest.ts:43-50`）成为所有真实模型请求的必填控制：`beforeSend` 同步执行预算准入/取消检查/checkpoint 保存，失败则不调用 fetch、不发 sent；一次 call 最多调用 fetchImpl 一次，禁止内部重试与备用切换（`src/main/services/modelRouter.ts:196-234`）；`onAttempt` 逐次观测派发与结算，回调持久化失败会 abort 已派发请求。Ops 侧预算冻结进 `budgetJson`，逻辑次数（规划轮）与物理发送次数分列计数、不重复扣减（`src/main/agent/orchestrator.ts:28-30`、`orchestrator.ts:473-525`）。

### 4.6 隔离评测：局部 epoch、临时库、可回放产物

每个评测案例得到全新临时数据库与临时目录，案例局部 `workspaceEpoch` 随机生成，绝不写生产全局（`src/main/evals/isolation.ts:115-154`）——这修正了评测初始化会刷新业务 epoch 的隔离风险（F-12）。案例产物（trace、观测、规则判分、报告、证据、快照清单）逐文件原子写出、manifest 最后写，存在完整 manifest 才算可回放；hash 校验失败即拒绝继续评分（`src/main/evals/artifacts.ts`）。取消请求在领取下一案例前检查，已完成的终态不被取消覆盖（`src/main/evals/runner.ts`，EVAL-02）。

## 5. 验证

- **测试**：Vitest 全量 130 个文件、**1315 个用例**于提交 `6bf4808` 全部通过（本分支 2026-10-01 实测；基线 `c9c9211` 时为 1098 个）。
- **数据集**：`personal_ops_v1` 50 条（只读 20 / 可撤销写 15 / 歧义澄清 10 / 注入越权 5；dev 30 / holdout 20）；`research_v1` 40 条、六类（单文档定位 10 / 跨文档综合 10 / 冲突 5 / 证据不足 5 / 提示注入 5 / 重复来源 5；dev 24 / holdout 16），gold 标注单人自查、局限如实记录在 `evals/datasets/research_v1/annotations/README.md`。
- **演示复现**：`tests/research/demoRun.test.ts` 四条路线从空库导入到报告，断网守卫下全程只访问本地库；报告落盘重开后逐字节恢复。
- **MCP 进程级测试**：`tests/mcp/startup.test.ts` 启动真实 `--mcp` 进程，覆盖 initialize/list/call、非法 JSON、未批准写提案与伪造批准拒绝、EOF 干净退出与磁盘重开。

## 6. 限制（诚实边界）

1. **全部评测为 Fake 流程验证**。FakeProvider 驱动能证明：状态转移、审批脚本、资源路径、产物保存、判分规则的正确性；不能证明任何真实模型的成功率、参数准确率或引用支持精度。【待 EXP-01 真实数据：真实模型 dev/holdout 成绩、失败归因、成本与延迟】
2. **桌面端到端验收未完成**。启动参数隔离、健康检查、关闭重启与故障注入的桌面场景待 E2E-01 执行；截图与视频待桌面验收与录制。
3. **分发包未重打**。当前 `dist/` 里的 zip 是 2026-09-21 的旧包，不含 Agent/Research/Eval 扩展，不能作为当前能力版本的演示包（待 PKG-01）。
4. **单人标注局限**。数据集 gold 为单人分时自查，独立复核未完成；近重复筛查仅用于候选，逐对人工确认未全部完成。
5. **真实失败案例五例已整理**（`docs/portfolio/failure-cases.md`），但来自开发期受控复现与静态审计，不来自真实模型运行——真实失败归因待 EXP-01。
