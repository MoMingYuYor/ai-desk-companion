# Eval CLI Fake 冒烟记录（EVAL-05 / EXP-01 前置）

执行日期：2026-09-30。代码版本：feat/agent-portfolio @ EVAL-05 接线提交。全部为 fake 执行（流程验证，非模型能力成绩）。

## 实测命令与结果

```bash
npm run build
# Ops 数据集冒烟（30/50 条 dev）
node out/main/eval-cli.js run --dataset personal_ops_v1 --split dev --execution fake \
  --config fake-flow-v1 --repeats 1 --max-cases 30 --artifact-root artifacts/eval-smoke
# → 退出码 0；evalRunId=eval-muol96nt-f83fbc60；status=completed；
#   passed=28 failed=2 not_run=0
# report 重生成
node out/main/eval-cli.js report --run-id eval-muol96nt-f83fbc60
# → 退出码 0；报告含 execution_kind=fake、schema v1 与复现命令
```

- `passed=28 / failed=2`：两条失败为 personal_ops_v1 内置 fake 通路的既有基线（ops-write-03、ops-write-08，与 EVAL-05 之前 ops50 通路结果逐条一致），非本次回归。
- fake-flow-v1 首次运行时自动注册并冻结（configRoot 下 config JSON + sidecar hash + 模板）。

## research_v1 冒烟：被配置绑定校验正确拦截（预期行为）

```bash
node out/main/eval-cli.js run --dataset research_v1 --split dev --execution fake \
  --config fake-flow-v1 --repeats 1 --max-cases 5 --artifact-root artifacts/eval-smoke
# → 退出码 1：配置 fake-flow-v1 冻结的数据 hash(9235bcd6…) ≠ research_v1(b7d3db70…)
```

这是 EVAL-05 的「配置冻结于特定数据集」校验按设计工作。research 侧的 fake 通路已由
`tests/evals/researchIntegration.test.ts`（隔离环境 + gold 判分 + 产物回放，11 例）覆盖；
CLI 级 research 批次需先经 `roundOneConfigs('research-extraction', …)` 冻结一份绑定
research_v1 的 fake 配置——已列入 experiment-plan.json 的真实执行前置步骤。

## EXP-01 fake smoke 状态

- Ops 冒烟（CLI 链路）：**PASS**（本文件）。
- Research 冒烟（CLI 链路）：**BLOCKED（配置前置）**，测试级通路 PASS。
- 全量 540 项（90×2×3）fake 预检：待 research fake 配置冻结后经同一 CLI 执行；
  属 EXP-01 真实执行前的预检步骤，当前真实模型执行因无凭据为 NOT_RUN。
