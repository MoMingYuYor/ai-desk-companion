# 简历事实陈述草稿（三条）

> 使用规则（PORT-01 规范）：仅引用已通过且具有 n/N 的结果；Fake 结果明确写"流程测试"；真实模型成功率等尚未产生的数字一律用【待 EXP-01 真实数据】占位，不得填写。以下每条均可通过源码位置、测试用例或数据集文件核对。

---

## 条目一：产品与技术实现

**草稿**：

> 开发本地优先的 Electron + TypeScript 桌面 AI 事务助手：本地资料导入（JSON/CSV/Markdown，码点坐标快照 + FTS4 检索）、带可定位引用的研究报告（Claim→Citation→Span→Snapshot 闭包校验，quote 与原文逐字一致）、研究建议转待办的完整用户路径；主进程单写者架构下，所有数据库写操作经幂等回执（operation_receipts）与人工审批（冻结参数 hash + 计划版本 + 目标版本 + 有效期）保护，防重复写入、防越权执行。建设 90 条人工标注样例数据集（Ops 50 条四类 + Research 40 条六类）与四条演示路线（normal/conflict/insufficient/injection），自动化测试 1315 个用例全部通过。

- 核对来源：`src/main/tools/gateway.ts`、`src/main/db/operations.ts`、`src/main/research/citations.ts`、`evals/datasets/*/manifest.json`、`tests/research/demoRun.test.ts`。
- 【待 EXP-01 真实数据：Ops 任务完成率、参数准确率——当前不可填写】

## 条目二：工具执行与引用设计

**草稿**：

> 设计工具执行网关与引用证据链：风险等级由注册表决定（调用方风险声明一律按未知字段拒绝）；写操作先提案生成审批，绑定冻结参数 hash、计划版本、目标版本与有效期，批准到执行之间目标被再修改即乐观锁 CONFLICT；信封携带 approved 键（无论值）一律拒绝，审批归属校验阻止跨运行携带批准。引用侧实现 Claim→Citation→EvidenceSpan→SourceSnapshot 闭包结构校验：来源必须在冻结清单内、quote 与快照码点切片逐字一致、多处命中拒绝猜测定位；all_of 联合证据持久化预期成员清单，缺员整组不成立、不以剩余成员投票升级；证据不足时诚实降级为 insufficient 收尾，不编造。

- 核对来源：`src/main/tools/gateway.ts:88-381`、`src/main/research/recordScope.ts`、`src/main/research/citations.ts:82-503`；回归测试 `tests/agent/toolGateway.test.ts`、`tests/research/allOfCompleteness.test.ts`、`tests/db/operations.test.ts`。
- 【待 EXP-01 真实数据：引用有效率、可核验事实引用覆盖率、人工支持精度——当前不可填写】

## 条目三：验证与评测基础设施

**草稿**：

> 建设隔离评测与可回放产物基础设施：每个评测案例独立临时数据库与临时目录，案例局部 workspaceEpoch 与生产全局完全隔离（评测前后生产 epoch 不变）；评测产物（trace/观测/判分/报告/证据/快照清单）逐文件原子写出并以 sha256 manifest 完整性标记，hash 校验失败拒绝评分；模型请求预算经 beforeSend 准入下沉到网络层（单发送契约，禁内部重试与备用切换），逻辑规划轮次与物理发送次数分列计数、跨重启不重置；批次取消在领取下一案例前检查、终态不被覆盖。从真实开发缺陷整理五例失败分析（网关缺落盘注入、预算未下沉、范围泄漏、all_of 缺员、评测取消覆盖），均附定位证据与回归测试。当前全部评测为 FakeProvider 流程验证；真实模型 dev/holdout 成绩待真实实验产生。

- 核对来源：`src/main/evals/isolation.ts`、`src/main/evals/artifacts.ts`、`src/main/services/modelRequest.ts`、`src/main/services/modelRouter.ts:196-234`、`docs/portfolio/failure-cases.md`。
- 【待 EXP-01 真实数据：dev 54 / holdout 36 全套对照成绩、失败归因分布、成本与延迟——当前不可填写】

---

## 写作纪律对照（自检）

| 规范要求 | 本草稿处理 |
| --- | --- |
| 仅引用已通过且具有 n/N 的结果 | 测试数写"1315 个用例全部通过"（实测，见下）；数据集写具体条数与拆分 |
| Fake 结果明确写"流程测试" | 条目三末句明确"全部评测为 FakeProvider 流程验证" |
| 不填真实模型成功率 | 三处【待 EXP-01 真实数据】占位 |
| "建设 90 条样例与隔离评测"可用表述 | 条目一采用（50+40=90，manifest 可核对） |
| 测试计数 | 基线 `c9c9211` 为 1098 例（完成计划记录）；提交 `6bf4808` 实测 1315 例、130 文件全通过（2026-10-01 `npx vitest run`）。若发布时 HEAD 变化，须重新实测后更新 |
| 四条演示路线 | normal / conflict / insufficient / injection，`tests/research/demoRun.test.ts` 复现 |
