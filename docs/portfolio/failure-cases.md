# 真实失败案例分析（六例）

> 来源：本项目 2026-09-29 状态审查（`docs/project-status-review-2026-09-29.md` 第 6 节 F-01～F-13）与提交历史中可查证的真实工程过程。每例均为开发期通过**静态审计或受控复现**发现的真实缺陷，附定位证据、修复提交号与回归测试名——不是虚构的"教学案例"，也**不是真实模型运行失败**（真实模型失败归因【待 EXP-01 真实数据】产生后增补）。
> 源码行号引用以修复后提交 `6bf4808` 为准；"原错误位置"指修复前审查报告中记录的位置。

---

## F-01 网关缺落盘注入：成功返回未经关键写入落盘确认

- **触发**：静态审计生产启动接线——`ToolGateway` 的 `persistCoordinator` 依赖是可选的，而生产入口构造网关时没有传入。sql.js 是内存库 + 主动 flush 模型，事务"提交"后数据未必已在磁盘上。
- **原错误**：写操作在内存事务提交后立即向调用方返回成功；若 flush 失败或进程随后崩溃，用户看到"成功"的写入实际丢失；重试时因回执也在同一内存库，幂等保护与数据一起消失。同时备份规格遗漏审批的冻结 `arguments_json` 列，恢复后未执行审批缺参数（旧实现用 `{}` 冒充）。
- **定位证据**：审查记录 `src/main/index.ts:189`（旧：直接 `new ToolGateway` 漏传协调器）、`src/main/tools/gateway.ts:161`（旧：落盘分支存在但生产不可达）、`src/main/backup/validate.ts:128`（旧：备份校验缺冻结参数列）。
- **修复**：提交 `6bbfec9`（OPS-01）——新增工厂 `createAgentGateway`（`src/main/agent/runtime.ts`），把 `persistCoordinator` 变为必填、缺失即显式拒绝（错误信息逐项列出缺失依赖）；关键写入经 `commitCritical` 落盘成功才返回，失败抛 `PERSIST_FAILED` 携带原 operationId、可重试且不重复执行（`src/main/db/operations.ts:183-207`）；备份兼容矩阵扩展 v3～v9，v7+ 审批参数列恢复，缺冻结参数的未执行审批置 `expired` 而不用 `{}` 冒充。生产接线完成于提交 `762a148`（`src/main/index.ts:235` 起）。
- **回归测试**：
  - `tests/agent/criticalPersistence.test.ts`——`成功返回时业务、回执和冻结参数已经存在于磁盘`；`落盘失败:PERSIST_FAILED 携带原 operationId,不谎报成功;解除后重试只保存并重放`；`renameSync 失败同样以 PERSIST_FAILED 拒绝,旧磁盘内容保持不变`；`todo.update 首次执行后 revision 增长,保存重试仍重放回执成功`；`createAgentGateway 对缺失关键依赖显式拒绝`
  - `tests/backup/validation.test.ts:275`——`OPS-01: v7/v8/v9 备份的审批冻结参数恢复后保持一致`；`:297 v5/v6 旧备份缺参数的待执行审批恢复后置 expired 并记录原因`；`:322 参数为 null 的已批准审批恢复后失效,不再继续执行`
  - `tests/backup/recovery.test.ts:236`——恢复→重开全程参数/hash、业务行与回执一致；`:271/:297` 恢复失败回滚快照。
- **剩余边界**：临时磁盘库的关闭、重开、恢复与重复批准已回归；真实桌面环境下的崩溃-恢复故障注入待 E2E-01 执行。

## F-05 预算未下沉：账面 6 次请求，实际可能发出更多

- **触发**：静态审计请求链路——Research 工作流在上层账本计算单次限额，但真实模型适配器没有接收该动态限额与取消信号；`ModelRouter` 的默认行为是每次 180 秒超时、每供应商最多三次尝试并允许备用切换。
- **原错误**：预算语义停留在账本算术层：上层记 6 次，网络层重试与备用切换不受控，实际请求次数可能超过授权上限，成本与观测双双失控；用户取消也到不了网络层，后台请求继续。
- **定位证据**：审查记录 `src/main/research/workflow.ts:774`（旧：限额计算）、`src/main/agent/completer.ts:62`（旧：真实适配器未接 control）、`src/main/services/modelRouter.ts:117`（旧：默认重试/备用切换）。
- **修复**：提交 `53900c0`（RES-01）——定义 `ModelRequestControl`（`src/main/services/modelRequest.ts:43-50`）作为所有真实模型请求的必填控制：单发送策略（一次 call 最多调 fetchImpl 一次、禁内部重试与备用切换，`src/main/services/modelRouter.ts:196-234`）、`beforeSend` 同步预算准入（失败不调用 fetch、不发 sent）、`onAttempt` 以 attemptId 去重逐次观测、`signal` 真实 abort 贯穿 fetch；usage 缺失记 null 不记 0；预算账本 checkpoint 升级 v2（`sentAttemptIds`，`src/main/research/budget.ts:217-227`），重启不重置、不重发历史请求。Ops 侧预算冻结与逻辑/物理分列收口于提交 `5a26976`（OPS-04）。
- **回归测试**：`tests/modelRouter.test.ts`（RES-01 单发送契约组）——`RES-01 单发送策略不隐藏重试或备用切换`；`RES-01 准入拒绝或预取消发送 0 次、不发 sent、错误原样传播`；`RES-01 指定 policy.providerId 不存在时发送 0 次并拒绝`；`RES-01 fetch 同步抛错也记录一次 sent 与一次 settled`；`RES-01 缺 usage 的成功保留全 null`；`用户取消后不再发起后续请求`。
- **剩余边界**：受控回归全部基于模拟 fetch；真实供应商 429、慢响应、计费行为下的预算停止与部分产物语义待 EXP-01 真实请求验证。

## F-06 范围泄漏：选一条记录，检索命中同文件其他记录

- **触发**：静态审计快照与检索语义——多记录文件（JSON 数组、CSV 多行）的每个逻辑来源都保存并索引整文件；检索先取全库 500 候选、再用冻结集合过滤。
- **原错误**：两条泄漏路径：选中记录 A 做研究，FTS 检索能命中同一文件里记录 B 的内容，证据张冠李戴；候选窗口先到先得，清单外匹配可以占满 500 上限，把唯一相关记录挤出窗口（漏召回）。两种失败都直接侵蚀引用可信度。
- **定位证据**：审查记录 `src/main/research/snapshots.ts:20`（旧：整文件快照语义）、`src/main/research/retrieval.ts:321`（旧：先取候选后过滤的顺序）。
- **修复**：提交 `53900c0`（RES-02）——引入 `RecordScope` 记录范围契约（`src/main/research/recordScope.ts`）：范围由导入期与投影同序的码点累计产生（禁止 `indexOf` 猜边界）、`chunkRecord` 只对记录范围内切片分块、FTS 只索引范围内块；检索冻结集合过滤**前置到 MATCH 候选阶段**（`src/main/retrieval/search.ts:71-102`，参数绑定 + 分批 + 全局截断）；冻结清单 v2 携带 `record_scope`，旧多记录来源无范围以 `RECORD_SCOPE_REQUIRED` 明确拒绝。
- **回归测试**：`tests/research/retrieval.test.ts:542`——`RES-02 冻结首条记录不能检索第二条记录`；`:601 超过 500 个清单外匹配仍召回唯一冻结记录(冻结过滤先于截断)`；`:583 邻块不进入另一记录:expandAdjacent 只在记录自身范围内取块`；`tests/research/recordScope.test.ts`——投影等价、CSV 引号内换行归属、emoji/NFC 码点切片、逻辑 gold 定位的空匹配/跨边界/多匹配拒绝。
- **剩余边界**：引用结构检查同时拒绝落在记录范围外的 span（`src/main/research/citations.ts:113-120`），检索入口与证据出口两端已闭环；超大库（数千文档）下的召回质量专项验证待后续数据规模实验。

## F-07 all_of 缺员：被拒成员"消失"，不完整证据组被判成立

- **触发**：静态审计联合证据判定——`all_of` 证据组中被拒绝的成员落库时被跳过，后续组检查只能看到剩余成员。
- **原错误**：一个两成员的 `all_of` 组，其中一员引用结构失败或被拒绝后，组判定基于"剩余一员"作出"成立"结论——`all_of` 的语义是全部条件同时成立，缺员应整组不成立；被拒成员从视野中消失，错误结论反而更"干净"。
- **定位证据**：审查记录 `src/main/research/workflow.ts:958`（旧：落库时跳过缺失引用）、`src/main/research/citations.ts:219`（旧：组判定只统计现存成员）。
- **修复**：提交 `53900c0`（RES-03）——`AllOfRequirement` 在抽取期与 Claim、引用同事务持久化预期成员清单（存于 Claim.review 的 `evidence_requirements` 段，`src/main/research/citations.ts:287-297`）；被拒成员保存 null ID 与拒绝原因，禁止只留有效成员；缺员判定（`checkAllOfCompleteness`，`citations.ts:310-334`）要求 members 与 expectedIndices 精确一一对应、未知结果按缺失处理；缺员 all_of 在**落库、结构检查、直接送审、报告终检四层**都不能升级，fake 声称 `supported` 无效。
- **回归测试**：`tests/research/allOfCompleteness.test.ts:43`——`RES-03 预期两成员但一成员被拒时整组不成立`；`:227 validateCitations:缺员 all_of 落 unsupported 并保留拒绝原因;全部被拒亦然`；`:237 报告构建拒绝缺员事实:claim 被手工置 supported 也不进入事实区`；`:180 执行关闭/重开临时库:缺员状态与预期两员保留,再跑 validateCitations 仍拒绝`；`:212 跳过 validateCitations 直接送审:缺员命题被确定性拒绝`；`:292 重复 validateCitations 不升级缺员命题`。
- **剩余边界**：真实模型生成 `all_of` 组的频率与缺员形态待 EXP-01 观测；当前保证的是"缺员必不成立"的确定性语义，不预测模型行为。

## F-10 取消覆盖：取消后仍跑下一条，终态被改写为 completed

- **触发**：受控复现——评测批次运行中请求取消：取消后仍启动了第二个 case；批次收尾时最终状态被覆盖为 `completed`，用户看不到"已取消"。
- **原错误**：批次循环领取下一案例前不检查取消请求；取消只设了一个标志位，收尾逻辑无条件写终态，把 `cancelled` 覆盖掉。
- **定位证据**：审查记录 `src/main/evals/runner.ts:198`（旧：批次循环）、`src/main/evals/runner.ts:236`（旧：取消方法）。受控复现结论：取消后仍启动第二条并最终 completed。
- **修复**：提交 `ec98890`（EVAL-02）——`cancelRequested` + `AbortController` + StopReason 贯穿批次循环：领取下一案例前检查取消，取消后不进入案例执行器、剩余组合标 `not_run`（失败原因"用户取消"）；已完成的案例结果保留，终态不被取消覆盖；状态文件原子替换与严格续跑校验；中断检测与预算跨重启不重置。
- **回归测试**：`tests/evals/runner.test.ts:201`——`取消探针:首条完成后请求取消,后续组合不进入案例执行器,终态不被覆盖`（探针 fixture 控制时序：w2 领取前挂起，w1 完成后请求取消再放行，断言 not_run 单列与原结果保留）。
- **剩余边界**：进程内取消语义已回归；桌面评测页的手动取消、窗口关闭与重启续跑的时序待 E2E-01。

## F-13（部分）Windows stdin 合成 EOF：stdio 服务第一条消息都收不到

- **触发**：MCP-01 进程级实测（提交 `6bf4808` 附带实测记录 `docs/mcp-connection.md`）——在 Electron Windows 环境用 `process.stdin` 接线 stdio 协议，进程启动后首读立即触发合成 EOF。
- **原错误**：stdio MCP 服务依赖读 stdin 接收 JSON-RPC 请求；`process.stdin` 在 Electron Windows 下的首读合成 EOF 使 `close` 事件先于任何数据到达，服务"启动即退出"，协议测试全部无法进行。
- **定位证据**：`src/main/index.ts:280-297`（修复后代码与注释：「Windows/Electron 的 process.stdin 首读即合成 EOF(MCP-01 实测),改用 fd 0」——`createReadStream('', { fd: 0 })` + 行读取接口）。
- **修复**：提交 `6bf4808`——stdin 接线改为直接读文件描述符 0 的流；启动日志一律走 stderr 不污染协议流；EOF 关闭后干净退出（退出码 0）。
- **回归测试**：`tests/mcp/startup.test.ts`——真实子进程级用例 `initialize→list→读工具;非法 JSON;未批准写提案与伪造批准;EOF 干净退出;磁盘校验`（含 `closeStdinAndExit` 后断言退出码 0）与退出重开用例（第一会话创建提案后 EOF 退出，第二会话同一 userData 重启提案仍在）。
- **剩余边界**：已在实测环境验证；不同终端宿主（Windows Terminal、VS Code 集成终端、管道宿主）下的 EOF 传播差异未穷举。

---

## 来源与局限说明

| 例 | 发现方式 | 修复提交 | 回归文件 |
| --- | --- | --- | --- |
| F-01 | 静态审计 | `6bbfec9` + `762a148` | `tests/agent/criticalPersistence.test.ts`、`tests/backup/*.test.ts` |
| F-05 | 静态审计 | `53900c0`（收口 `5a26976`） | `tests/modelRouter.test.ts` |
| F-06 | 静态审计 | `53900c0` | `tests/research/retrieval.test.ts`、`recordScope.test.ts` |
| F-07 | 静态审计 | `53900c0` | `tests/research/allOfCompleteness.test.ts` |
| F-10 | 受控复现 | `ec98890` | `tests/evals/runner.test.ts` |
| F-13 部分 | 进程级实测 | `6bf4808` | `tests/mcp/startup.test.ts` |

局限：以上失败均发现于 FakeProvider 流程验证与静态审计阶段，证明的是**实现正确性与契约执行**；真实模型交互下的失败模式（错误参数形态、幻觉 ID、格式漂移、预算内停不下来）【待 EXP-01 真实数据】。届时按规范增补真实失败归因，保留本批开发期案例作为工程过程记录。
