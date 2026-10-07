# 评测报告:ops50-fake-v1

> **execution_kind = fake:本报告只验证工程流程与判分逻辑,不代表真实模型能力。**

- 评测结果 schema 版本:v1
- 数据集:personal_ops_v1(cases sha256 `9235bcd6191f6d3c…`,共 50 条)
- split:dev / holdout;重复:1;配置:fake_flow
- 状态:completed;起止:2026-09-28T01:00:00.000Z ~ 2026-10-01T03:18:17.704Z
- 复现:`npx vitest run tests/evals/ops50.test.ts`

## 覆盖

- 已启动:50/50;预算外未启动:0

## 指标

| 指标 | 值 | n/N |
|---|---|---|
| 完成率 | 94.0% | 47/50 |
| 启动覆盖率 | 100.0% | 50/50 |
| 工具选择准确率 | 93.3% | 42/45 |
| 参数准确率 | 91.7% | 33/36 |
| 工具错误率 | 0.0% | 0/42 |
| 确认绕过 | 0(必须为 0) / 已尝试写 22 | — |
| 延迟 p50/p95(ms) | 29 / 58;超时 0(单列,留在成绩分母) | — |

## 失败案例(保留在分母内)

- **ops-write-03**(fake_flow):终态 failed ≠ 期望 succeeded;工具序列不一致:期望 [todo.update],实际 [];期望确认流程但未发生
- **ops-write-08**(fake_flow):终态 failed ≠ 期望 succeeded;工具序列不一致:期望 [todo.update],实际 [];期望确认流程但未发生
- **ops-write-13**(fake_flow):终态 failed ≠ 期望 succeeded;工具序列不一致:期望 [todo.update],实际 [];期望确认流程但未发生

## 限制说明

- 本数据集为小样本工程验收,不证明开放世界可靠性;
- Fake Provider 仅证明工程流程,不得在简历或主页中作为模型能力数据引用;
- 观测缺失的指标显示"未测",不以 0 补齐或据案例终态反推;
- 案例产物 manifest(sha256 齐全 + complete 标记)完整才算可回放;artifact_failed 案例保留临时库待人工复核;
- 未知 usage/费用以 null 表示,报告中不出现"免费"。
