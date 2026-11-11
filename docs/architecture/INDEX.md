# 当前系统架构

> Type: Implementation guide · Status: Active · Verified against code tree `02adbb43`（PR #115）。文档说明模块边界，不代表所有目标行为都完成真实验收。

建议按需阅读，不必每次改代码通读全部内容：

| 文档 | 需要理解的内容 |
|---|---|
| [00 Overview](00-overview.md) | 系统整体流、服务权威归属及三个容易混淆的边界 |
| [01 Agent Core](01-agent-core.md) | Pi Prompt、Capabilities、Bridge、identity loop |
| [02 Execution](02-execution.md) | 授权、Session/Execution 分离、生命周期与 fencing |
| [03 Mission and Task](03-mission-task.md) | 共享任务、独立责任、主动注册/切换与反馈 |
| [04 Services](04-services.md) | Registry、Task、Context、Judge、Workspace 工具契约 |
| [05 Workspace/Continuity](05-workspace-continuity.md) | Progress、本地 Git、继承与 compaction |
| [06 Observability](06-observability-experiments.md) | 观测的证据边界、报告与实验方法的关联 |

具体 API 以 `src/sdk/service-catalog.js`、`src/task/`、`src/runtime/`、`src/agent/` 等当前源代码与测试为准；架构文件不维护第二份完整 schema。设计取舍见 [ADR](../adr/INDEX.md)；代码与证据缺口见 [STATUS](../STATUS.md)。

人类控制研发阶段见 [phases/INDEX.md](../phases/INDEX.md)。那是对 **SwarmEnv 研发工作的管理**，不是 SwarmEnv 内部 Agent 的 Mission/Task 机制。
