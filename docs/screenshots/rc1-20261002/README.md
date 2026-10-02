# 合成数据界面截图

六张页面 PNG 由提交 2a75c25 的实际 Electron 工作台通过本机 loopback CDP 捕获。使用独立用户目录、1,000 条合成待办/日程，不含真实账号、个人正文或 API Key。截图对应概览、事务 Agent、研究、评测、待办和日历。另有 packaged-evals.png，来自该提交实际便携包，显示两模块的已冻结配置。

这些图只证明页面渲染与导航。Agent、Research 和 Eval 的空态页面不能作为澄清、审批、引用高亮、冲突与回放已经通过的截图。完整功能素材与真人流程仍需根据 docs/portfolio/demo-script.md 实际录制。

六张页面图的 out 文件 hash、环境、截图 hash 与逐次性能样本保存在 artifacts/acceptance/adc-rc1-20261002/T20/electron-perf-final.json，包内图与验证记录在 T21/package-desktop-check.json。性能报告的 dirty 字段在该版脚本中固定为 true；T20/source-attestation.json 保存实际新克隆的空 git status 和相同构建 hash。维护中的脚本已改为查询实际 git 状态。原始数据不随源码克隆自动出现。
