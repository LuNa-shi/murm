# 阶段设计索引

> 文档职责：阶段设计与验收合同。**Phase 0005 以本目录中合入 main 的完整设计为唯一需求权威**，issues 从设计派生并记录执行；其他阶段仍是 GitHub design Issue 的版本化附件。进度、资源授权与验收证据保留在对应 Issue / PR。

本目录按项目负责人 2026-11-12 的要求恢复，用于逐章审核较大阶段的完整方案。编号表示本次恢复后的阅读和依赖顺序，不重编号历史 Phase-1 代码、ADR 或实验，也不恢复旧的阶段状态账本。

| 序号 | 阶段 | 设计与审阅入口 | 与当前代码的关系 |
|---|---|---|---|
| 05（当前） | Core / Harness：Build your own swarm | [唯一权威入口](0005-core-environment/README.md) · [Core](0005-core-environment/01-core.md) · [Harness](0005-core-environment/02-environment.md) · [推进与验收](0005-core-environment/03-delivery-and-validation.md) | 2026-11-23 已确认 Q1–Q8 的目标规范；新 API 与迁移仍待实施和真实验收，不将设计入库视作已实现 |
| 01 | 第三方 Sandbox、独立 Services 与 Bash CLI | [前置阶段边界](0001-sandbox-services-cli.md) · [Issue #119](https://github.com/LuNa-shi/SwarmEnv/issues/119) | OpenSandbox 与 Bash CLI 已进入正常路径；`755c72e` 的正式 runner 仍使用同进程三库，独立 HTTP host 不构成完整生命周期部署。后续工程见 #130 |
| 02 | Task–Material–Workspace 协作模型与 Agent 协议 | [完整设计](0002-task-material-workspace/README.md) · [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122) · [讨论 #120](https://github.com/LuNa-shi/SwarmEnv/issues/120) | 核心模型及 whole-Workspace 检查已由 PR #124/#126/#128 实现；本目录保留批准的设计与固定版本附件，当前 API、兼容路径和限制见 Architecture |
| 03 | 长程 Swarm 效率优化 | [规格附件](0003-long-run-efficiency.md) · [Issue #137](https://github.com/LuNa-shi/SwarmEnv/issues/137) | 用户讨论形成的目标设计，尚未实现；覆盖 Task 合同与调整、Agent 指导、错误反馈、集中局部检查及 Putnam 完整端到端验收 |
| 04 | 原生 Agensh 数学实验 | [实验与适配设计](0004-agensh-lean-replication.md) · [Issue #157](https://github.com/LuNa-shi/SwarmEnv/issues/157) | 待审方案，给出原生移植、局部证明与主定理判据，以及 murm 复现的准入条件 |

Phase 03: [FLT root-only proof reconstruction](0003-flt-subtree-benchmark/README.md), linked to [Issue #135](https://github.com/LuNa-shi/SwarmEnv/issues/135). Target design; current execution focus is Q20.

## 如何审阅和维护

1. Phase 0005 先读已合入 main 的权威设计，再读引用其固定版本的总 issue 与子 issues；需求变更先修设计并同步任务。其他阶段先读 Issue 的问题、范围、决定与验收，再读总览和分章。PR 与进度在 GitHub 中关联，本目录不维护动态状态表。
2. 明确区分“用户已经确认的方向”“本稿建议的具体机制”“已经实现的行为”“有证据验证的效果”。方案写得完整，不等于其中所有细节已获批准。
3. 审核结论在 Issue / PR 中记录，并链接明确的文档 commit。后续改动同时呈现需求差异和文档差异，不能用默默改文件的方式扩大范围。
4. 实现 PR 必须同步更新 [architecture](../architecture/INDEX.md) 的完整运行说明，包括 prompt、实际发送路径、状态、权限、失败和清理；不要让读者靠阶段提案推测运行中的代码。
5. 阶段结束时核对最终合并代码、架构说明、生成引用和验收证据。设计文档保留版本化意图与取舍，实施进度继续在 Issue / PR，实验事实保留在 [experiments](../experiments/INDEX.md)。

治理依据：[AGENTS](../../AGENTS.md)、[开发工作流](../workflows/development.md)、[ADR 0018 的修订](../adr/0018-issue-led-engineering-workflow.md)。

