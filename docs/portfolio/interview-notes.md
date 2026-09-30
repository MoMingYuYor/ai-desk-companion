# 面试讲述笔记：六个设计点

> 每项按同一结构：为什么存在 → 被否决的替代方案 → 如何被测试（引用测试文件与用例名）→ 一处有意取舍。源码位置对应提交 `6bf4808`。所有评测结论基于 Fake 流程验证，真实模型成绩【待 EXP-01 真实数据】。

---

## 1. 幂等：runOperation / operation_receipts

**为什么存在**。桌面应用里"成功"是个复杂的承诺：事务提交了、进程崩了、落盘还没确认——用户重试时如果再执行一次，就是重复创建待办。`operation_receipts` 表把每次关键命令的 `(operation_id, command, request_hash, result_ref)` 作为回执落库，`runOperation`（`src/main/db/operations.ts:114-141`）保证"业务写入与回执在同一事务内提交"：要么都成、要么整体回滚，不存在"业务已写、回执缺失"的半状态。同 ID 同摘要重试返回首次结果（`replayed: true`），同 ID 不同摘要 CONFLICT——防止幂等键被复用到不同请求。

**被否决的替代方案**：
- "先查 revision 再查回执"——会导致保存重试被本次执行造成的 revision 增长拒绝，回执重放永远走不通；实际实现是幂等查重先于 revision 检查。
- "应用层去重（内存 Map）"——崩溃后丢失，跨重启无效；回执在数据库里才有恢复语义。
- "回执存请求全文"——拒绝；只存 `result_ref`（JSON 结果引用），不存请求全文或凭据（`operations.ts:97-99`）。

**如何被测试**：`tests/db/operations.test.ts`——
- `首次执行:业务写入与回执同一事务落库,返回 replayed:false`
- `同 ID 同摘要重试:返回首次结果且 replayed:true,即使原 revision 已过期`
- `同 ID 不同摘要:CONFLICT,且不执行业务写入`
- `apply 抛普通错误:回执与业务写入一起回滚`

**一处有意取舍**：工具层幂等键是 `runId:tool:callIndex`（`src/main/tools/gateway.ts:166`）——callIndex 是**持久索引**，重启后同一调用位置不会换键；回执重放对审批校验同样生效（存在性、决定、参数 hash、计划版本、审批归属都在重放路径上复核），但目标版本与有效期只对"新执行"生效，避免保存重试被自己造成的 revision 增长误拒（`gateway.ts:152-156` 注释）。

---

## 2. 版本绑定：乐观锁 assertRevision + 审批目标版本

**为什么存在**。审批是异步的：提案生成后用户可能几分钟后才批准，期间目标记录可能被用户手动改掉、删掉，或被另一次写操作更新。如果不绑定版本，批准执行的就是"批准时的想象"而不是"当前的现实"。两层防护：`assertRevision`（`src/main/db/operations.ts:151-163`）在事务内做乐观锁条件检查——目标不存在 `TARGET_UNAVAILABLE`、revision 不匹配 `CONFLICT`；网关在提案时用 `resolveTargetVersion` 解析目标版本存入审批记录，执行前重新解析并与批准时绑定值比对（`src/main/tools/gateway.ts:367-381`），不一致即 CONFLICT 要求重新生成提案。计划版本同理：审批绑定 `planVersion`，执行时计划已换版即拒绝（`gateway.ts:352-354`）。

**被否决的替代方案**：
- "批准时快照全部参数，执行时直接用快照写"——会把过期内容写进被并发修改过的记录，覆盖用户的其他修改；实际做法是发现版本漂移就拒绝并让提案重走。
- "悲观锁（批准期间锁定目标记录）"——跨 IPC 与异步等待持有锁，用户不批准就永久锁死；乐观锁把冲突检测推迟到执行瞬间。
- "只在执行时校验、不绑定到审批"——无法区分"目标变了"与"参数变了"，失败原因不可解释；两层分别校验让每个 CONFLICT 都有明确原因。

**如何被测试**：`tests/db/operations.test.ts`——`revision 条件检查失败:CONFLICT,业务写入与回执整体回滚`、`目标不存在:TARGET_UNAVAILABLE 且整体回滚`；`tests/agent/toolGateway.test.ts`——`计划版本变化:CONFLICT`、`pending 审批:拒绝;批准后:执行一次;重复批准执行:回执防重`；`tests/agent/criticalPersistence.test.ts`——`todo.update 首次执行后 revision 增长,保存重试仍重放回执成功`。

**一处有意取舍**：目标版本与有效期校验放在 `runOperation` 的 apply 内、只对"新执行"生效（`gateway.ts:266-268`）——这不是疏漏：首次执行成功后 revision 已增长，落盘失败的保存重试走回执重放路径，若在重放路径上再校验目标版本就会永远 CONFLICT。校验分层把"新的业务执行"与"恢复已提交结果"分开对待。

---

## 3. 预算下沉：ModelRequestControl beforeSend/onAttempt

**为什么存在**。上层账本说"最多 6 次请求"，但 Router 的默认行为是每次超时 180 秒、每供应商最多三次尝试并允许备用切换——账面 6 次实际可能发出十几次请求，成本失控（失败记录 F-05）。修复后所有真实模型请求必填 `ModelRequestControl`（`src/main/services/modelRequest.ts:43-50`）：一次 `call` 最多调用 `fetchImpl` 一次（`policy.maxAttempts` 恒为 1、`fallback` 恒为 disabled，`src/main/services/modelRouter.ts:196-234`）；`beforeSend` 同步执行预算准入、取消检查与 checkpoint 保存，失败则不调用 fetch、不发 sent；`onAttempt` 以 `attemptId` 去重地逐次观测派发（sent）与结算（settled），回调持久化失败必须 abort 已派发请求并以 `OBSERVATION_FAILED` 失败、保留已派发记录。超时与取消经真实 `AbortController.abort` 贯穿到网络层，不用 Promise.race 留下后台请求。

**被否决的替代方案**：
- "Router 内部重试几次提高成功率"——请求数对上层不可见，预算语义被网络层吞噬；重试的责任上移到工作流（每次重试是新 call、新 attemptId，重新过准入）。
- "预算只在账本上减计数，不管网络层"——正是被修复的缺陷；账面数字与实际发送脱钩。
- "usage 缺失记 0"——0 表示"确认没有消耗"，与"供应商未返回"混淆；实际记 null（`modelRequest.ts:80-82`），成本未知就显示未知。

**如何被测试**：`tests/modelRouter.test.ts`（RES-01 单发送契约组）——
- `RES-01 单发送策略不隐藏重试或备用切换`
- `RES-01 准入拒绝或预取消发送 0 次、不发 sent、错误原样传播`
- `RES-01 指定 policy.providerId 不存在时发送 0 次并拒绝`
- `RES-01 fetch 同步抛错也记录一次 sent 与一次 settled`
- `RES-01 缺 usage 的成功保留全 null`
- `tests/agent/modelCompleter.test.ts` 覆盖缺省 control 的一次发送默认控制。

**一处有意取舍**：逻辑次数与物理发送分列（`src/main/agent/orchestrator.ts:28-30`、`orchestrator.ts:473-525`）。逻辑次数计"规划轮"（首轮/澄清重入/读后规划轮各一次），用于决定"还开不开新一轮"；物理发送（sentModelAttempts）经 `beforeSend` 准入预留，达到上限直接拒绝发送。两个数字语义不同（一次规划轮可能 0 次物理发送——被准入拒绝），合并成一个计数要么多扣要么漏扣。checkpoint v2 持久化 `sentAttemptIds`（`src/main/research/budget.ts:217-227`），重启后不重置、不重发历史请求。

---

## 4. 资料范围：RecordScope 冻结过滤前置

**为什么存在**。多记录文件（JSON 数组、CSV 多行）按整文件保存快照与索引时，选中一条记录做研究，检索仍会命中同一文件里其他记录的内容——证据张冠李戴（失败记录 F-06）。`RecordScope`（`src/main/research/recordScope.ts`）在导入期用码点累计产生每条记录在整文件规范全文里的 `[startOffset, endOffset)` 范围；分块只对范围内切片进行（`chunkRecord`，块 offset 加回 scope.startOffset 后与全文件对应切片逐字一致）；检索时冻结清单过滤**前置到 MATCH 候选阶段**（`src/main/retrieval/search.ts:71-102`：候选阶段 JOIN `retrieval_chunks` 按冻结 document_id 过滤，参数绑定、分批取候选、合并后统一截断），清单外内容从源头上不进入候选窗口，也就不会挤占候选限额。

**被否决的替代方案**：
- "检索取全库 500 候选后再用冻结集合过滤"——正是被修复的缺陷：大库中清单外匹配可以占满 500 候选，把唯一相关记录挤出窗口（漏召回）。
- "用 `indexOf(quote)` 猜记录边界"——quote 重复、跨记录出现时边界不可靠；范围只由导入期与投影同序的码点累计产生（`recordScope.ts:9-14` 注释）。
- "旧数据无范围就从扁平全文按分隔符切"——分隔符可能出现在字段内容里（CSV 引号内换行）；实际以 `RECORD_SCOPE_REQUIRED` 明确拒绝旧多记录来源，不猜。

**如何被测试**：`tests/research/retrieval.test.ts`——
- `RES-02 冻结首条记录不能检索第二条记录`
- `超过 500 个清单外匹配仍召回唯一冻结记录(冻结过滤先于截断)`
- `邻块不进入另一记录:expandAdjacent 只在记录自身范围内取块`
- `tests/research/recordScope.test.ts`——投影等价、CSV 引号内换行归属、emoji/NFC 码点切片、`空匹配、跨边界与多匹配明确失败;quote 重复不改变定位` 等。

**一处有意取舍**：引用结构检查同时把"span 必须落在冻结记录范围内"作为一条独立规则（`src/main/research/citations.ts:113-120`）——即使某个 span 的 quote 碰巧能在全文里对上，只要它落在记录范围之外（同一文件其他记录的内容、或范围被改写后的位置），引用直接失败。范围不只约束检索入口，也约束证据出口，两端一致才闭环。

---

## 5. 引用支持度：Claim → Citation → Span → Snapshot 闭包

**为什么存在**。"报告里说我的简历提到过 X"必须能点回到原文那一行，且这一行真的属于本次运行的冻结来源。`validateCitations`（`src/main/research/citations.ts:379-503`）沿 Claim → Citation → EvidenceSpan → SourceSnapshot → Source 逐项校验：引用属于本次运行、来源在冻结清单内、快照 hash 与清单一致、offset 合法、`Array.from(normalized_text).slice(start,end).join('') === quote` 逐字一致、span_sha256 与 quote 指纹一致（篡改检测）、chunk 覆盖该 span。manifest 先经 `verifySnapshotManifest` 复核，快照被替换即整体失败。结构检查分两层结论：确定性失败落 `unsupported`；结构通过且存在有效 supports 的保持 `candidate`，等待语义层审核（片段是否真支持命题由独立审核判断，结构检查不越权下结论）。

**被否决的替代方案**：
- "只校验 URL 可打开、域名可信或引用编号存在"——明确不构成合格引用（`citations.ts:7-8` 注释，P0 无网络）；来源可信性来自导入时双 hash 与冻结清单，不是 URL 可达性。
- "多处命中时取第一处作为 offset"——定位会静默指错；实际拒绝并要求显式提供 offset（`resolveSpanOffsets`，`citations.ts:181-213`）。
- "语义审核也塞进结构模块"——结构规则可判定、语义判断不可判定，混在一起会让失败原因不可解释；分层让每个 unsupported 都有确定性理由。

**如何被测试**：`tests/research/citations.test.ts`（结构闭包逐项失败原因、冲突检测分组）；`tests/research/allOfCompleteness.test.ts`——
- `RES-03 预期两成员但一成员被拒时整组不成立`
- `validateCitations:缺员 all_of 落 unsupported 并保留拒绝原因;全部被拒亦然`
- `报告构建拒绝缺员事实:claim 被手工置 supported 也不进入事实区`
- `执行关闭/重开临时库:缺员状态与预期两员保留,再跑 validateCitations 仍拒绝`
- `tests/research/demoRun.test.ts` 四路线验证终态与报告特征（含冲突并列不投票、证据不足诚实收尾）。

**一处有意取舍**：缺员 `all_of` 不投票升级（`checkAllOfCompleteness`，`citations.ts:310-334`）。`all_of` 的语义是"全部条件同时成立"，被拒绝的成员持久化保存 null ID 与拒绝原因（预期成员清单存于 Claim.review 的 evidence_requirements 段），缺任何一员整组不成立——不能用剩余成员的多数票替代全部条件。这个规则在落库、结构检查、直接送审、报告终检四层一致执行，fake 声称 `supported` 也不能升级。对称地，无 supports 引用（或只有 context 引用）的命题同样落 `unsupported`，不升级（`citations.ts:472-475`）。

---

## 6. 隔离评测：局部 epoch / 临时库

**为什么存在**。评测要在业务进程内运行工具、写数据库——如果评测案例直接用业务库、或初始化时刷新了全局 `workspaceEpoch`，会弄脏用户数据、打断业务窗口的旧预览（失败记录 F-12）。`createIsolatedCaseEnv`（`src/main/evals/isolation.ts:115-154`）为每个 case、配置和重复创建全新临时库与临时目录：fixture 按 ID 播种初始状态；案例局部 `workspaceEpoch` 随机生成，绝不调用 `initWorkspaceEpoch()` 修改生产全局；网关通过注入的 `workspaceEpochGetter` 使用局部 epoch（`src/main/tools/gateway.ts:41-45`），生产组合继续用全局 getter。临时目录只在预先创建的评测根目录下清理，不根据 case 输入拼接系统路径。配套产物链（`src/main/evals/artifacts.ts`）：案例结束清理临时库之前，把 trace、观测、规则判分、报告、证据、快照清单逐文件原子写出，manifest（`complete: true` + 逐文件 sha256）最后写——存在完整 manifest 才算可回放；`loadCaseArtifacts` 校验失败即抛 `ArtifactIntegrityError`，调用方不得继续评分（失败记录 F-11 的修复）。

**被否决的替代方案**：
- "评测共用业务库，测试数据加前缀区分"——删除、迁移、epoch 刷新都会伤及业务数据；隔离成本远低于清理成本。
- "固定时钟连耗时测量一起冻结"——固定时钟只控制领域日期（案例预定脚本断言用），耗时测量始终走单调钟（`isolation.ts:136-138` 注释，C-02 契约）。
- "案例结束直接删临时库，只留 run ID"——正是 F-11：时间线、报告、证据无法回放；产物导出失败时保留临时库并标 `artifact_failed`，绝不把案例标成可回放。

**如何被测试**：`tests/evals/isolation.test.ts`——
- `两 case 修改相同 task ID:各自只看到本 case 数据`
- `每个案例环境得到独立局部 epoch;getter 稳定`
- `创建与销毁案例环境前后,生产全局 epoch 保持不变`
- `正常入口不存在 autoApprove 类选项:网关仍拒绝 approved 声明`
- `tests/evals/artifacts.test.ts`（pathGuard 防穿越、manifest 完整性、hash 校验）；`tests/evals/runner.test.ts`（取消控制与续跑校验）。

**一处有意取舍**：评测的 `interaction_script`（案例预定脚本）只经测试注入的 `EvaluationContext` 启用（`isolation.ts:8-9` 注释），正常应用不存在"评测模式自动批准"公开开关——隔离不仅隔离数据，也隔离权限：评测基础设施本身不能成为生产绕过审批的入口。

---

## 附：数字速查（只引可核对事实）

| 事实 | 数值 | 出处 |
| --- | --- | --- |
| Ops 数据集 | 50 条（只读 20/可撤销写 15/歧义澄清 10/注入越权 5；dev 30/holdout 20） | `evals/datasets/personal_ops_v1/manifest.json` |
| Research 数据集 | 40 条六类（单文档定位 10/跨文档综合 10/冲突 5/证据不足 5/提示注入 5/重复来源 5；dev 24/holdout 16） | `evals/datasets/research_v1/manifest.json` |
| 自动化测试 | 基线 `c9c9211` 1098 例 → 提交 `6bf4808` 1315 例（130 文件，全通过） | 2026-10-01 `npx vitest run` 实测 |
| 演示路线 | 4 条（normal/conflict/insufficient/injection），断网守卫下本地完成 | `docs/demos/deep-research-agent.md`、`tests/research/demoRun.test.ts` |
| 研究预算（演示配置） | max_model_calls 6 / max_subqueries 3 / max_chunks_per_subquery 8 / max_active_seconds 120 | `docs/demos/deep-research-agent.md` |
| 真实模型成功率/成本/延迟 | 【待 EXP-01 真实数据】 | — |
