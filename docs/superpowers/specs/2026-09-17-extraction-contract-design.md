# 提取契约层与三级自愈设计

日期：2026-09-17。状态：设计已确认（用户要求免中间评审，直接实现）。

## 1. 目标

接入不同能力的 AI 模型时，"从通知/材料中提取时间、地点、事件、参与人物等信息"的流程保持统一：

1. 尽量自动救活：解析/校验失败先自动修复，而不是让用户手动重试。
2. 多模型按序兜底：某个模型反复产出不合格输出时，按备用顺序切换下一个模型。
3. 产出结构统一：提示词规范与运行时校验来自同一份字段定义，不再两处维护。

## 2. 架构

### 2.1 单一事实源 schema（新增 `src/shared/extraction.ts`）

- `ANALYSIS_EXTRACTION_SCHEMA`：分析输出字段的类型化描述（key/type/required/enum/说明/子字段），以现有 `AnalysisPayload` 为基础，`actionItems[]` 新增 `participants: string[]`（参与人物）。
- `schemaToPrompt(schema)`：把 schema 渲染成系统提示词中的 JSON 规范段落（`prompts.ts` 消费）。
- `validateAnalysisPayload(raw)`：运行时校验。致命失败=整体不是对象/无法解析；字段级问题一律**降级不报废**（类型不符的字段置空并产出 warning，warning 由 engine 并入 `questions`）。

### 2.2 三级自愈管线（`engine.runAnalysis`）

```
按 provider 顺序游标 cursor 从 0 开始:
  ① router.call(剩余providers) → 解析 JSON → 校验
  ② 通过(含字段降级) → 成功;warnings 并入 questions
  ③ 致命失败 → 用同一 provider 自修复一次:
       messages + [assistant 原始输出] + [user: 错误反馈,要求只输出修正后的 JSON]
       ├─ 修复后通过 → 成功
       └─ 仍失败 → 记录原因;cursor 跳到实际使用的 provider 之后;
                    广播 evt:model-switched("输出格式不合格,已切换备用模型")
全部 provider 耗尽 → analysis 状态 failed,error 汇总各模型失败原因;rawResponse 保留
```

- 网络错误/429/5xx 仍由 `ModelRouter` 内部重试与切换，与本游标共用同一 provider 顺序，不会死循环。
- 修复调用复用实际产出不合格输出的那个 provider（按 `used.providerId` 定位）。
- 取消（Abort）随时生效；修复调用仍属同一桌宠活动任务。
- few-shot 修正示例始终附加在系统提示词后（对所有模型统一，不按能力裁剪）；`response_format` 仅对声明支持且协议为 chat-completions 的 provider 注入，两者叠加无害。

### 2.3 能力开关 `supportsJsonMode`

- `providers` 表新增 `supports_json_mode INTEGER NOT NULL DEFAULT 0`，schema 版本 2→3（`ALTER TABLE` 迁移，新建库直接含列）。
- `ProviderInput/ProviderInfo` 新增 `supportsJsonMode`；设置页提供商表单增加勾选框（默认关）。
- `ModelRouter.callAttempt` 在该开关开启且协议为 chat-completions 时注入 `response_format: { type: 'json_object' }`。

### 2.4 参与人物字段

- `ActionCandidate.participants?: string[]`；`normalizeCandidate` 容错收敛（非字符串元素过滤）。
- 确认落库时并入 notes（`参与人:A、B`），不改 events/todos 表结构；候选卡片展示参与人标签。

## 3. 涉及文件

新增：`src/shared/extraction.ts`、`tests/extraction.test.ts`、`tests/extractionRecovery.test.ts`。
修改：`src/shared/types.ts`、`src/main/services/{prompts,engine,modelRouter}.ts`、`src/main/db/{schema,dao}.ts`、`src/main/ipc.ts`（provider 保存透传）、`SettingsPage.tsx`、`ChatPage.tsx`、`tests/mail/migration.test.ts`、`tests/rules.test.ts`、`tests/modelRouter.test.ts`。

## 4. 范围与边界

- 自愈管线本期只接 `runAnalysis`（通知分析）；课表/校历导入维持原路径，后续按需复用。
- 参与人仅做提取与展示、确认时并入 notes，不参与指纹与日程字段。
- `evt:model-switched` 桌宠气泡文案区分"输出格式不合格"与既有"网络切换"。

## 5. 验收

- 校验器畸形输入矩阵、自修复成功/失败、按序切换、耗尽汇总、participants 落库、jsonMode 注入、迁移 v2→v3 均有测试。
- 既有 214 用例回归通过；typecheck 与构建通过。
