# SwarmEnv 文档索引

> Status: Active · 核对基线：PR #116 分支，运行实现基线 `02adbb43`（PR #115 合并树），2026-11-11。
>
> 本目录只保留当前有维护责任的说明、可复用流程、决策记录和一份标明回溯性质的示例。历史设计、Issue 证据和旧报告请查固定 Git 提交，不再放在工作树中参与当前决策。

## 根据问题选择入口

| 需要做什么 | 入口 | 权威范围 |
|---|---|---|
| 了解项目和研究目标 | [PROJECT.md](PROJECT.md) | 问题与研究范围；不预设具体实现 |
| 查当前代码实现及证据缺口 | [STATUS.md](STATUS.md) | 版本化状态快照；不能替代源码和实验 |
| 理解系统模块、任务、接续 | [architecture/INDEX.md](architecture/INDEX.md) | 当前实现边界与交互 |
| 开发或 Review PR | [workflows/development.md](workflows/development.md) | Coding Agent 工作流程 |
| 登记、运行、分析实验 | [workflows/experiment.md](workflows/experiment.md) | 实验流程与证据要求 |
| 查看获批准的研究阶段 | [phases/INDEX.md](phases/INDEX.md) | 人类批准的范围、假设与权限 |
| 查实验 ID 或报告格式 | [experiments/INDEX.md](experiments/INDEX.md) | 实验登记、报告与示例 |
| 理解为什么做出某项决定 | [adr/INDEX.md](adr/INDEX.md) | 设计决策的背景和取舍 |
| 启动基准或观测服务 | [operations/benchmark.md](operations/benchmark.md)、[operations/observability.md](operations/observability.md) | 操作指引，使用前核对当前脚本 |

全局 Coding Agent 指令见 [AGENTS.md](../AGENTS.md)，领域术语见 [GLOSSARY.md](../GLOSSARY.md)；前者不承载具体运行时 API 设计，后者不维护参数和状态机。`.codex/skills/experiment-analysis/SKILL.md` 是实验诊断执行技能，必须遵循本仓库的实验规范。

## 文档维护约定

- 当前代码和运行事实以实际源码、固定提交、实验元数据为准；架构说明只解释并链接它们。
- 新增概念和报告栏目名称先明确取得人类确认。草案不可悄然变成接口契约。
- 同一个流程只在一个权威文件维护。ADR 解释历史决策缘由，不覆盖当前代码。
- 当前文档更新时记录核对版本和未验证项，禁止以文档 PR 声称新的实验结果。
- 不建立 `archive/`、旧路径占位文件或额外的 `CONTEXT.md`；历史通过 Git 固定提交追溯。

## 历史资料如何找

PR #116 整理前的文档树： [`02adbb43/docs`](https://github.com/LuNa-shi/SwarmEnv/tree/02adbb43d39e0b23befb7f2ffc4b19ffb386a36d/docs)。旧实验和 Issue 附录都可以在此提交查看；原始运行证据可能只存在于本地忽略目录中，Git 不会自动保存它们。旧文档不能证明当前实现或审批状态。
