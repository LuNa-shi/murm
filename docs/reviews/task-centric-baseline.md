# 从任务提出、执行与更新复盘现有架构

状态：证据与设计推导，**不另行定义规范**。整理自 [Notion 架构复盘](https://app.notion.com/p/40b4e07aa023818f97ade56d43c32c8f)，并纳入用户后续对 Judge 的明确修正。代码固定为 `75fca5aa647154a642d676c639c8770d1f7eb90a`；实验运行提交为 `fc15f2e3fff237312f26df15da4694b9f5c11a8c`。

## 1. Task 主线解释了聚合指标遗漏的现象

已发布实验使用4个 Core、6个初始任务和2个动态新增额度，历时约两小时；共8个 Tasks、11次 Executions、90份 Materials、1次 Judge 检查，原题未完成。七项研究任务各执行一次，完整证明 Task 经历四次执行。

| 完整证明 Execution | Core | 2026-10-31 UTC | 结果 |
| --- | --- | --- | --- |
| `113f78dc…` | 2 | 01:55:48—02:25:51 | EXPIRED |
| `8485fb8a…` | 4 | 02:25:59—02:56:02 | EXPIRED |
| `e1a7de67…` | 2 | 02:56:10—03:26:14 | EXPIRED |
| `209ab47b…` | 1 | 03:26:23—03:55:41 | FAILED，位于运行收束阶段 |

研究任务最晚于02:18:57结束，其后约97分钟的绑定任务执行集中到同一证明 Task。唯一 Candidate 检查发生在首次 Execution，结果为 source-level FAIL。这里的时间取自报告的可见窗口；不能从 EXPIRED 自动推断有效 handoff，也不能从材料计数推断数学价值。

来源：[运行摘要](../experiments/exp-20261031-putnam_2025_b1-flat-dynamic-2h-fc15f2e-r1/run-summary.json)、[完整脱敏分析](../experiments/exp-20261031-putnam_2025_b1-flat-dynamic-2h-fc15f2e-r1/analysis/experiment-analysis.md)。原始对话和证明源码仍在本地。

## 2. 任务提出受到实验脚本的限制

`FLAT_RESEARCH_ROUTES` 在运行前确定形式化审查、几何、组合、Lean 和验证任务。两项动态任务分别来自 Agent 与失败回调。`onTaskCreate` 统计所有非初始任务，包括已结束任务，因此2个名额用完后无法继续派生。

这说明最新运行主要检验了执行预设分工和有限新增任务，尚不足以评价持续自主分工。代码限制确实关闭了继续创建的可能；公开报告没有全部被放弃/拒绝的提案，不能进一步声称它阻止了多少有价值研究。

应把最小启动责任、通用工具说明与领域研究方向分开。取消模板和累计额度之后，还须验证 agent 能从已有证据提出可执行的不同工作，并使额度在工作结束后可继续使用。

来源：[runner 的固定代码](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/benchmark/putnam-runner.js)。对应完整改动为 [S2](../plans/phase-1/02-autonomous-task-supply.md)。

## 3. Judge 失败被编码成额外的协作流程

通用 TaskController 不产生数学路线。自动研究任务来自 benchmark 的 `judgeCandidate` / `createFlatFeedbackTask`；失败后还要求后续 Task 完成、交付 Response 并被集成，才能再次提交 Candidate。代码验证流程条件，没有比较两次候选是否真正使用不同路线。

用户确认的目标是外部工具式检查：Agent 在一次执行中检查、读取诊断、修改并再次检查。上述 follow-up 和门禁不应继续作为默认求解路径。Candidate 的版本与检查绑定仍需保留，但服务内部记录不应变成 Agent 必须手工执行的一套任务流程。

来源：[runner](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/benchmark/putnam-runner.js)、[#107](https://github.com/LuNa-shi/SwarmEnv/issues/107)。对应 [S1](../plans/phase-1/01-iterative-judge.md)。

## 4. 执行接续与公共知识还没有形成可靠的反馈过程

Task 的 `timebox_ms` 被 Runtime 用于每次 Execution；它不是 Task 累计预算。反复认领完整证明责任可以持续获得执行窗口，但时间切片无法说明每次接续新增了什么研究。

现代任务并行额度为1。独立研究结束、新增额度耗尽后，只有证明 Task 可继续，造成后半程单责任接续。此时缩短时间窗只会增加换人次数。提醒实现还使用固定间隔与 `timeout-1` 的较小值，短窗口下可能仅在截止前约1毫秒提醒。

报告将该 Task 的四次执行均显示为 initial/only，attempt 都为1；恢复路径又可以在同 Execution ID 增加 Session generation。应按真实执行身份和时间连接任务历史，保留前驱、材料和累计成本。

来源：[Task Service](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/task/task-service.js)、[Runtime](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/runtime/runtime.js)。

## 5. 通知已存在，处理与调整仍有缺口

定向 Response 会创建 material_available 通知，Runtime 使用 followUp 发送给运行中的 Session。因此显式任务并不天然要求等待结束后反馈。但发送成功即标记 delivered，不能证明接收者已解释证据或改变行动。

目前缺少完整的同伴纠正、任务范围变更和接续处理路径；普通 Experience 发布也没有完整的失效传播。`task.close` 把某个接收者的接受提升为生产 Task 的全局 CLOSED，使多接收者的不同处理结果难以表达。

目标应将研究反馈保存到 Task，让有效负责人在运行中处理；换执行后继续保留。方法改变可在本次研究中完成，交付范围变化要明确留痕，已授权取消则撤销旧执行权。材料内容本身不被静默覆盖。

来源：[Task Service](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/task/task-service.js)、[Context](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/context/context-service.js)。对应 [S3](../plans/phase-1/03-feedback-and-continuity.md)。

## 6. 哪些结论需要避免扩大

90份材料中既有跨任务交付，也有自用检查点。#107 指出58份没有消费者的材料多数属于后者；缺少读取不能直接解释为浪费。材料读取与后续操作关联已经出现，但公开脱敏内容不足以验证全部数学价值。

10月28日产生47个 Tasks的树状实验，与发布的v0.1.0基线不是同一运行。后者在 `fb3bef54` 上记录3 Tasks、3 Executions、4 Materials和1次检查。不同运行只作历史诊断，不能拼成严格的版本改进曲线。

这轮修复通过三条可验收现象检验架构：失败后是否恢复直接检查迭代；初始工作结束后是否还能产生并执行独立任务；运行中反馈是否改变工作并被后续执行继承。它们的具体反证条件见 [第一阶段验收](../validation/phase-1-acceptance.md)。
