# 历史设计归档

基线：`75fca5aa647154a642d676c639c8770d1f7eb90a`，日期：2026-11-01。原文按Git blob原样保存，不改写历史内容。旧入口仅保留导航；当前要求见 [架构](../architecture.md)、[Agent Task运行契约](../20261102-agent-task-runtime-contract.md) 和 [AGENTS](../../AGENTS.md)。新的工程文档使用日期开头，过时版本进入相应日期目录。

历史文件的相对链接保留原状，应使用原提交阅读上下文；归档内容不参加当前规范/链接验收。实验报告与 `documents/archive/` 已有材料保持原位置和内容，不纳入设计清理。服务运行指南保持当前实现说明身份。

## 原文映射

| 原路径 | 归档副本 | 原blob |
| --- | --- | --- |
| `AGENTS.md` | [原文](2026-11-01/AGENTS.md) | `4582835880c3fa9cf82e8ad7149223098c636e2a` |
| `CONTEXT.md` | [原文](2026-11-01/CONTEXT.md) | `9548350731d71784ec29556bf556c251c0a5bfc9` |
| `GLOSSARY.md` | [原文](2026-11-01/GLOSSARY.md) | `91a40caeb6b3e0bb17d2cc97dfb61faa30f46e5a` |
| `README.md` | [原文](2026-11-01/README.md) | `8fb6e46f8246878832435a77ee951898c229048a` |
| `documents/SwarmEnv_Design_v1.2.md` | [原文](2026-11-01/documents/SwarmEnv_Design_v1.2.md) | `98554a98f0cb3415d481ba0ba6323132e61f9678` |
| `docs/design-simplified-task-execution-model.md` | [原文](2026-11-01/docs/design-simplified-task-execution-model.md) | `f0b8a167517f996be24bb0c1e03cc433fd50fc3a` |
| `docs/design-task-oriented-agent-swarm-task-service.md` | [原文](2026-11-01/docs/design-task-oriented-agent-swarm-task-service.md) | `72d7a25bbb0387c522edf5e8bada7246291bed67` |
| `docs/issue-28-scope-and-acceptance-plan.md` | [原文](2026-11-01/docs/issue-28-scope-and-acceptance-plan.md) | `aea66cc235935bbace6938897ed137aefd5edae0` |
| `docs/issue-30-scheduler-spec.md` | [原文](2026-11-01/docs/issue-30-scheduler-spec.md) | `136cd411f93e1ce89ffcb5b4d9bde2b2109dfb57` |
| `docs/issue-34-swarm-execution-model-v2.md` | [原文](2026-11-01/docs/issue-34-swarm-execution-model-v2.md) | `8f5c2504689aed1ac2c7fbce0b4d7f5dff9f30a8` |
| `docs/issue-70-runtime-architecture-design.md` | [原文](2026-11-01/docs/issue-70-runtime-architecture-design.md) | `39749acf97a0496e07532d8266e1218cbb8fd5a5` |
| `docs/agent-core.md` | [原文](2026-11-01/docs/agent-core.md) | `e68867cbdfaacf3f3d9d0d3420c5b57487d86f10` |
| `docs/task-flow.md` | [原文](2026-11-01/docs/task-flow.md) | `2060d6ba7e491e1cf3c6d631a0010b8059ea2f6e` |
| `docs/task-service.md` | [原文](2026-11-01/docs/task-service.md) | `6577424bf4e1dc2a1bfd2a96841c01885c5e6f80` |
| `docs/runtime.md` | [原文](2026-11-01/docs/runtime.md) | `75c7ed226dd035cddfe95ad30afc3924a8a021ac` |
| `docs/context-service.md` | [原文](2026-11-01/docs/context-service.md) | `99893b52782028871d1df70535b5e3706b3b4c94` |
| `docs/judge.md` | [原文](2026-11-01/docs/judge.md) | `7b85b129b4224cf6d7fad7315c7a538e70213112` |
| `docs/putnambench-benchmark.md` | [原文](2026-11-01/docs/putnambench-benchmark.md) | `acc93a77dcdcfed91e0bbb1b792923d4674e34b8` |
| `docs/putnambench-four-core-system-walkthrough.md` | [原文](2026-11-01/docs/putnambench-four-core-system-walkthrough.md) | `974da40acce07ff3bf92760d17aef038f317b120` |
| `docs/benchmark-analysis-sop.md` | [原文](2026-11-01/docs/benchmark-analysis-sop.md) | `1285642fb3f7a8dd56c7fb0a01248e9a3f290ca7` |
| `docs/agents/workflow.md` | [原文](2026-11-01/docs/agents/workflow.md) | `31a3e2d4c72861ace56e10a4934bb9e2adf90f8a` |
| `docs/agents/testing.md` | [原文](2026-11-01/docs/agents/testing.md) | `d465b6dc2c5a36df5564bb2a3760a1f4c203f951` |
| `docs/agents/domain.md` | [原文](2026-11-01/docs/agents/domain.md) | `5459a5a22ddc4e70e733afb54860f9a9b5a4ef6f` |
| `docs/agents/issue-tracker.md` | [原文](2026-11-01/docs/agents/issue-tracker.md) | `42dcad11482beb28f1580fa459ca8da6094bcf3b` |
| `.codex/skills/experiment-analysis/SKILL.md` | [原文](2026-11-01/.codex/skills/experiment-analysis/SKILL.md) | `9b523c7ecc9ab5574b55d5f231fdffe1ebc75add` |

## ADR

旧ADR目录整体保留原tree `cabb17ad065d91082159aaa3c41d3f2c81a446c1` 于 `2026-11-01/docs/adr/`。当前 [ADR索引](../adr/README.md) 说明新旧效力；原有17个文件均保留导航，重复的历史0011编号不追溯改号。

## 仍在原位置的资料

`docs/experiments/`、issue运行证据、research笔记与examples均为历史/参考，不作为当前规范。运行环境和服务手册描述具体工具用法，遇到设计冲突以当前架构和实现状态为准。
