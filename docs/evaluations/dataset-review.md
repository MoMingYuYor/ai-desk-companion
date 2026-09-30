# 数据审查报告:统一案例、标注与数据冻结(DATA-01)

- 审查日期:2026-10-01
- 审查人:DATA-01 实施代理(**单人 + 工具辅助审查**;独立第二人复核未完成,见「局限」)
- 依据:`docs/superpowers/plans/2026-09-30-project-completion/delivery.md` DATA-01 节
- 机器结果:`artifacts/data-review/dataset-review.json`(由 `scripts/check-eval-data.mjs`
  生成,status=pass,888 项检查全部通过,退出码 0)
- 近重复人工结论:`artifacts/data-review/near-duplicate-conclusions.json`
- 标注说明(rubric):`evals/datasets/research_v1/annotations/README.md`(版本 `research-gold.v1`)

## 1. 数量与拆分核对

两数据集的案例 ID 唯一、fixture 可加载、gold 可读,manifest 声明的类别
total/dev/holdout 与实际逐组计数完全一致,无额外类别、无漏列类别。

### personal_ops_v1(Ops)——目标 50 = 30/20 ✓

| 类别 | total | dev | holdout |
| --- | --- | --- | --- |
| 只读 | 20 | 12 | 8 |
| 可撤销写 | 15 | 9 | 6 |
| 歧义澄清 | 10 | 6 | 4 |
| 注入越权 | 5 | 3 | 2 |
| **合计** | **50** | **30** | **20** |

终态分布:succeeded 45、failed 5(全部为注入越权类,注入必须失败)。
fixture 为内置虚拟库 `ops-empty`/`ops-seeded`(跨 split 共享属预期设计,泄漏检查以
输入与参数为准);必需参数中的种子记录引用(如 `seed-todo-2`)均真实存在。

### research_v1(Research)——目标 40 = 24/16 ✓

| 组别 | total | dev | holdout |
| --- | --- | --- | --- |
| 单文档定位 | 10 | 6 | 4 |
| 跨文档综合 | 10 | 6 | 4 |
| 冲突 | 5 | 3 | 2 |
| 证据不足 | 5 | 3 | 2 |
| 提示注入 | 5 | 3 | 2 |
| 重复来源 | 5 | 3 | 2 |
| **合计** | **40** | **24** | **16** |

终态分布:全部 40 条 `succeeded`(证据不足组同样以 `succeeded` 收尾、报告允许
`partial`,见 §4)。每案例一个 fixture(40/40 一一对应),语料四类格式(.md/.txt/.json/.csv)
齐备,`fixtures/research/<id>` 与数据集快照 `snapshots/<id>` 逐字节一致(58/58 文件)。

## 2. 冻结 hash(dataset-review.json `hashes` 字段)

| 数据集/范围 | sha256 |
| --- | --- |
| personal_ops_v1 cases.jsonl(= manifest 声明) | `9235bcd6191f6d3c102f0a9a18850e16e3eea9e9113076ec9ddf0c5667336ca8` |
| personal_ops_v1 manifest.json(文件) | `2c304a0d12509365d6d3f4222519be4bf98e2a426a9c00ccafca12c133824918` |
| research_v1 cases.jsonl(= manifest 声明) | `b7d3db70a10129cca9bd4db7bf05ebabd6d32931cd85e9b49179d400a41c7165` |
| research_v1 manifest.json(文件) | `907611ca885906197e3cce95556036c5169bd56e7c6dc1f199aaf7985ad4d6f8` |
| research_v1 annotations 树(41 文件含 README) | `e79c61ca89a934c4281accf8c9a88d2a192d0c7ef0c6798d3affab693ff01290` |
| research_v1 snapshots 树 | `3ecfc0d3f0e924ce9fe87b0bf1c4713bddfe423e614fa0a232aae04be44aa99e` |
| fixtures/research 树(含 demo/ 演示语料) | `9fe412a1d9a4bf0707a71e9425241cc1ba861caa1d683f8b1fe6b75a7c8da72c` |

**冻结声明**:以上 hash 对应本报告日期的 `feat/agent-portfolio` 工作区数据。自本报告
起,两数据集视为冻结;任何内容变化(案例、gold、语料、期望坐标)必须创建新数据版本
目录并重算 hash,不修改已发布冻结快照。运行时加载器(`loadDatasetFromDir`)与本审查
脚本均校验 `cases_sha256`,hash 不一致即拒绝执行;**加载器/检查脚本不通过时禁止启动
正式实验**。

## 3. 坐标检查(research gold 证据重放)

按规范化 v1 重放全部 gold 证据(与 `tests/research/gold_integrity.test.ts` 同一契约,
由脚本独立复算):

- 证据总数 63;text_sha256 一致 63/63;码点 offset 切片与 quote 逐字一致 63/63;
  quote 在规范全文唯一命中 63/63;失败 0。
- 特性语料(emoji、CRLF、BOM、NFD、JSON 投影、CSV 投影)均覆盖。
- 快照 manifest 的 raw/text sha256 重放与实际文件一致(58/58 文件)。
- 测试侧交叉核对:`tests/evals/dataset.test.ts` 新增 DATA-01 用例以 TS 真实现
  (`normalize.ts`)重算语料 hash,与快照 manifest、脚本产物三方闭环,防止脚本复刻
  的规范化实现漂移。

## 4. 诚实不足语义统一核对

结论:**cases、annotations、docs/demos、测试四处解释一致**,无需修正。

| 位置 | 表述 | 核对 |
| --- | --- | --- |
| cases(5 条证据不足案例) | `terminal_status: "succeeded"`,tags 含 `gold-empty`、`missing:<kind>` | 脚本逐条通过 |
| annotations(同 5 条) | `gold_claims: []` + 非空 `missing_requirements` + 非空 `fabrication_bans` | 脚本逐条通过 |
| docs/demos/deep-research-agent.md §2.3 | 「终态 `succeeded`,报告 `partial`」;讲解点明示「预算耗尽走确定性收尾判 partial/failed,不伪装成 no_evidence」 | 脚本文本扫描通过 |
| 测试 | `demoRun.test.ts`(「insufficient 证据不足:succeeded/partial,unanswered 非空且零 claim 不编造」)、`researchIntegration.test.ts`(「succeeded 与 gold_claims 为空兼容」)、`gold_integrity.test.ts`(「证据不足组:gold_claims 为空,tags 承载 missing 语义」)、`researchAdapter.ts` 注释 | 脚本文本扫描通过 |

即:流程完整但资料不足 → 运行 `succeeded`、报告可 `partial`;预算/执行中断 → 运行
`partial`/`failed`。两者不混用。本轮未发现不一致,未修改任何测试或数据。

## 5. 跨 split 泄漏检查

全部为脚本机器检查,发现 0 项异常:

| 检查 | 范围 | 结果 |
| --- | --- | --- |
| 归一化输入(NFKC + 去空白)跨 split | Ops 50 条、Research 40 条 | 无重复 |
| fixture 跨 split | Research 40 fixture | 无(一一对应);Ops 两内置库共享为预期设计 |
| 规范文本 hash 跨 split | Research 58 份语料 | 无重复 |
| source identity(raw sha256)跨 fixture | Research 58 份原始文件 | 无同源复制 |
| provenance group 跨 split | gold 全部 `pg-*` 组 | 无跨 split |
| URL 归一化(小写、去尾斜杠、去 fragment)跨 split | 语料全部 URL(example.invalid 保留域) | 无跨 split 重复 |

## 6. 近重复候选筛查与逐对人工结论

筛查方法:字符三元组 Jaccard(delivery.md 参考实现,NFKC + 去空白),**阈值 0.8 仅用于
筛查,不直接判泄漏**;比较分组同质(Research 语料对语料、各数据集输入对输入),不借
「文件名不同/fixture 不同」跳过任何对。

| 分组 | 单元数 | 两两比较数 | 候选(J≥0.8) |
| --- | --- | --- | --- |
| research 语料对语料 | 58 | 1653 | 3 |
| research 输入对输入 | 40 | 780 | 0 |
| Ops 输入对输入 | 50 | 1225 | 0 |

候选共 3 对,**全部为重复来源组同 case 内的设计内转载对,均同在 dev、不跨 split**,
逐对人工结论(详见 near-duplicate-conclusions.json):

| 候选对 | Jaccard | 关系 | 结论 |
| --- | --- | --- | --- |
| duplicate-001/origin.md ↔ repost.txt | 0.806 | 同岗位转载(repost 标注「(转载)」,正文逐字同,pg-dup-1) | 无泄漏 |
| duplicate-002/copy_a.json ↔ copy_b.json | 0.940 | 同岗位 JSON 副本(仅 source_url 尾号不同,pg-dup-2) | 无泄漏 |
| duplicate-005/mirror.csv ↔ src.csv | 0.949 | 同岗位镜像(仅 URL 与发布日期不同,pg-dup-5) | 无泄漏 |

**低于阈值的边界复核**(J∈[0.5,0.8),工具辅助逐对过目,记录于 conclusions 文件
`boundary_review_below_threshold`):共 17 对,含唯一一对跨 split 对
cross-001/research_engineer.csv ↔ cross-009/tb.csv(J=0.567,相似性完全来自共享 CSV
表头与 URL 模板,岗位内容不同,判无关/无泄漏);其余为冲突组同 case 双快照、duplicate-003
二次转发(J=0.771,与候选同性质)、duplicate-004 与 cross-007 的共模板不同岗位对——
均不跨 split,属设计内材料。

**结论:未发现跨 split 泄漏,无需重新划分数据,当前冻结版本保持不变。**

## 7. 局限披露

1. **单人 + 工具辅助审查**:近重复候选逐对结论与边界复核由实施代理(单一审查者)
   借助机器筛查完成;独立第二人复核未完成。逐对理由已全文记录以供后续独立复核。
2. gold 标注本身为单人分时自查(`adjudicated`),已在 `annotations/README.md` 与
   manifest `provenance` 披露。
3. Ops 状态断言核对基于表名合法性与种子记录引用存在性;行数 delta 的运行时正确性由
   Eval Runner 的执行期判分验证,不在静态审查范围。
4. 本报告不构成真实模型效果结论;数据冻结仅是 EXP-01 正式实验的前置条件。

## 8. 复现命令

```bash
# 数据结构与人工泄漏检查(退出码 0 为通过;不通过禁止启动正式实验)
node scripts/check-eval-data.mjs --output artifacts/data-review/dataset-review.json

# 数据集契约 + gold 完整性测试
node node_modules/vitest/vitest.mjs run tests/evals/dataset.test.ts tests/research/gold_integrity.test.ts
```
