# 测试与真实验收

代码 Issue 同时需要确定性/集成测试和符合 [第一阶段协议](../validation/phase-1-acceptance.md) 的两小时真实实验。测试检查权限、状态、重放、并发与工具绑定；真实运行检查行为是否实际进入Agent研究。各Issue自己完成本闭环验收，不推迟到最后一个集成Issue。

本次文档 PR 检查链接、规范一致性、归档映射、源码未改动与 `git diff --check`。文档变更不宣称产生运行指标提升，不为了文档验收启动两小时付费实验。无法运行完整 `npm test` 时必须在PR中说明，不能报告为通过。

代码提交前运行相关测试、`npm test` 和 `git diff --check`。真实实验前记录clean commit及配置；拒绝默默替换provider、模型或fixture。4 Core、7200秒是阶段实验配置，不是架构永久常量。

原始运行保存在本地忽略的 `experiments/exp-YYYYMMDD-<id>/`，YYYYMMDD取UTC开始日期。报告写到该目录 `analysis/experiment-analysis.md`。经审阅的脱敏发布副本可保存在 `docs/experiments/`，原始证据不可提交。

分析先按Task串联提出、执行和更新，再检查对应工具调用。必须区分真实行为、受控故障干预、测试fixture与代码静态推断。未触发事件记为INCONCLUSIVE，环境未就绪记为BLOCKED。
