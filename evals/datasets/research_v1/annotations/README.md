# research_v1 Gold 标注说明(rubric)

适用范围:`evals/datasets/research_v1/annotations/*.json`(40 条案例的 gold 标注)。
本文件是数据冻结(DATA-01)的一部分:标注规则、坐标契约与局限在此固定;修改任何标注
内容必须提升数据版本并同步 manifest hash,不修改已发布冻结快照。

- **rubric 版本**:`research-gold.v1`(与每条标注 `annotation.guideline_version` 一致,
  由 `tests/research/gold_integrity.test.ts` 断言)。
- **标注人与日期**:单人(seed)分时标注,标注工作完成于 2026-09-27 提交 `340bec3` 之前,
  状态记为 `adjudicated`(自查后定稿)。**独立第二人复核未完成**,这是当前数据集的已知
  局限;DATA-01(2026-10-01)以 `scripts/check-eval-data.mjs` 工具辅助复核并出具数据
  审查报告(`docs/evaluations/dataset-review.md`),属「单人 + 工具辅助」而非双人独立
  标注,使用本数据集的结论应如实引用该局限。

## 1. 规范文本与码点坐标

- 语料按**规范化 v1** 重放:识别编码 → 解码(UTF-8/UTF-16LE/UTF-16BE,BOM 显式识别) →
  移除起始 BOM → CRLF/CR 转 LF → NFC。JSON 语料先按键排序投影为字段文本,CSV 按
  RFC 4180 解析后按列序投影,再做同一规范化(实现:`src/main/retrieval/normalize.ts`、
  `src/main/research/snapshots.ts`;快照 `snapshots/<fixture_id>/manifest.json` 记录
  每个文件的 `raw_sha256` 与 `text_sha256`)。
- 证据坐标为**规范化全文的码点下标**(`Array.from(text)` 视角,emoji 等增补平面字符
  计 1 个码点):`[start_offset, end_offset)` 切片必须与 `quote` 逐字相等,且 `quote`
  在该文件规范全文中**恰好唯一命中**;`text_sha256` 必须与规范全文一致。
- 坐标由服务端在运行时重验(`resolveSpanOffsets` 唯一匹配补全,模型自报坐标一律重验),
  静态校验见 `gold_integrity.test.ts` 与 `scripts/check-eval-data.mjs`(坐标重放 63/63)。

## 2. 支持与矛盾判定(relation)

- `supports`:quote 的常规语义**直接支持**对应 gold claim 的命题(不允许仅凭主题相关
  判支持;数字、学历、地点等关键约束必须在 quote 内)。
- `contradicts`:quote 的常规语义与命题**不相容**(用于冲突组的另一侧快照)。
- 冲突组每条标注同时含两侧 relation,并声明 `conflict_flags`;矛盾 claim 在报告中并列
  展示、标 `unresolved`,**不按多数副本投票**。
- `missing_requirements` / `fabrication_bans` 记录缺失项与对应禁编造约束;不足以表达
  采用三分语义(no_evidence / not_requested / deferred),「未检索到不能推导为不需要」。

## 3. 诚实不足语义(gold_claims 为空的唯一含义)

- **流程完整但资料不足**:运行终态为 `succeeded`,报告允许 `partial`;标注侧表现为
  `gold_claims: []` + 非空 `missing_requirements` + 非空 `fabrication_bans`,案例
  `tags` 以 `missing:<kind>` 承载缺失语义(如 `missing:salary`)。
- 预算耗尽或执行中断的收尾才对应运行 `partial`/`failed`,**不是**证据不足语义。
- cases、annotations、`docs/demos/deep-research-agent.md`(§2.3)与
  `tests/research/demoRun.test.ts`、`tests/evals/researchIntegration.test.ts`、
  `tests/research/gold_integrity.test.ts` 使用同一解释(四处一致已由
  `check-eval-data.mjs` 的语义扫描记录)。

## 4. 同一来源转载去重(provenance group)

- 每条证据带 `provenance_group_id`(`pg-` 前缀):同一来源的转载、镜像、副本共属一组。
- 「独立来源数」按**组数**计,不按文件数计;同一组内多条证据支持同一命题属预期,
  报告引用时去重展示。
- 同一 `provenance_group_id` 不得跨 dev/holdout 出现(duplicate-004 共模板不同岗位
  分属 `pg-tpl-a`/`pg-tpl-b` 两个组);该约束由 `gold_integrity.test.ts` 与
  `check-eval-data.mjs` 双重校验。

## 5. fact / comparison / recommendation 标签

- 标签定义沿用研究系统 claim 类型枚举(`src/main/research/schemas.ts` 的
  `ClaimType`):`fact` = 单一事实陈述;`comparison` = 两个及以上对象间比较;`recommendation`
  = 行动建议或倾向性结论。
- gold claim 文本(`gold_claims[].text`)在撰写时即为**可核对的单一命题**,当前 40 条
  标注的命题均按 `fact` 语义书写(跨文档综合组的比较式结论在 gold 中拆分为逐对象
  fact,如 cross-001 的三条逐岗位命题),不依赖 `comparison`/`recommendation` 判分;
  真实模型运行的 claim 类型由抽取器自报并在人工支持度审查时独立计分(EXP-01)。

## 6. 变更纪律

- 任何对标注内容、期望文本或坐标的修改都必须:提升数据集版本目录(如 `research_v2`)、
  重新计算 manifest hash、更新本文件的 rubric 版本记录,不修改已发布冻结快照。
- 近重复复核的机器结果与逐对人工结论存于
  `artifacts/data-review/dataset-review.json` 与
  `artifacts/data-review/near-duplicate-conclusions.json`。
