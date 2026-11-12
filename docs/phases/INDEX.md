# 阶段设计索引

> 文档职责：GitHub design Issue 的版本化设计附件。批准、进度、资源授权和验收记录保留在对应 Issue / PR。

本目录按项目负责人 2026-11-12 的要求恢复，用于逐章审核较大阶段的完整方案。编号表示本次恢复后的阅读和依赖顺序，不重编号历史 Phase-1 代码、ADR 或实验，也不恢复旧的阶段状态账本。

| 序号 | 阶段 | 设计与审阅入口 | 与当前代码的关系 |
|---|---|---|---|
| 01 | 第三方 Sandbox、独立 Services 与 Bash CLI | [前置阶段边界](0001-sandbox-services-cli.md) · [Issue #119](https://github.com/LuNa-shi/SwarmEnv/issues/119) | 待实现；此页只索引原 Issue，不扩展其业务范围 |
| 02 | Task–Material–Workspace 协作模型与 Bot 协议 | [完整设计](0002-task-material-workspace/README.md) · [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122) · [讨论 #120](https://github.com/LuNa-shi/SwarmEnv/issues/120) | 基于方案 A 的设计审稿，依赖阶段 01 的执行基础 |

## 如何审阅和维护

1. 先读 Issue 的问题、范围、决定与验收，再读该阶段的总览和分章。具体文档 PR 由 Issue 链接，避免本目录维护一份动态 PR 状态表。
2. 明确区分“用户已经确认的方向”“本稿建议的具体机制”“已经实现的行为”“有证据验证的效果”。方案写得完整，不等于其中所有细节已获批准。
3. 审核结论在 Issue / PR 中记录，并链接明确的文档 commit。后续改动同时呈现需求差异和文档差异，不能用默默改文件的方式扩大范围。
4. 实现 PR 必须同步更新 [architecture](../architecture/INDEX.md) 的完整运行说明，包括 prompt、实际发送路径、状态、权限、失败和清理；不要让读者靠阶段提案推测运行中的代码。
5. 阶段结束时核对最终合并代码、架构说明、生成引用和验收证据。设计文档保留版本化意图与取舍，实施进度继续在 Issue / PR，实验事实保留在 [experiments](../experiments/INDEX.md)。

治理依据：[AGENTS](../../AGENTS.md)、[开发工作流](../workflows/development.md)、[ADR 0018 的修订](../adr/0018-issue-led-engineering-workflow.md)。
