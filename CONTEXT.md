# SwarmEnv 仓库上下文与阅读地图

本文件不复制完整术语表和设计正文，只记录当前阅读入口、文档职责和已经确认的协作约定。

## 新增术语规则

需要新增领域词、架构标签或报告层名时，先向用户确认。确认后先在本文件记录采用的词和含义，再决定是否把它加入 [GLOSSARY.md](GLOSSARY.md)；未确认的词不得进入规范文档、报告模板或代码接口名称。

当前已确认的报告用词：

- `Overview`：实验报告中描述运行事实、关键输入和过程概况的部分。
- `Experiment ID`：一次具体运行的稳定标识，新运行采用 `EXP-YYYYMMDD-NN`。

1. [AGENTS.md](AGENTS.md)：开发约束与核心原则。
2. [GLOSSARY.md](GLOSSARY.md)：领域词汇。
3. [docs/architecture/README.md](docs/architecture/README.md)：当前main的模块边界和运行方式；[docs/architecture.md](docs/architecture.md)保留第一阶段目标架构。
4. [Agent Task运行契约](docs/20261102-agent-task-runtime-contract.md)：四 Core、主动 Task、Progress Material、compaction 轮换和 Git Workspace lineage。
5. [docs/implementation-status.md](docs/implementation-status.md)：哪些目标尚未实现。
6. [第一阶段计划](docs/plans/phase-1/README.md)：待讨论的三个代码 Issue。
7. [阶段协作说明](docs/phases/README.md)：每个大阶段的人工范围、假设、实验矩阵和关闭决定。

`src/` 是当前实现，`test/` 是回归，`docs/experiments/` 是实验报告和历史证据。旧设计入口转到 [归档索引](docs/archive/README.md)，不能覆盖当前规范。若实现与目标不同，以明确差距推进修改，不把现有行为重新写成目标。
