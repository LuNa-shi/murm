# SwarmEnv

SwarmEnv 研究以显式任务组织的 Agent Swarm。Agent 在工作中提出新的 Task，通过 Material 共享阶段成果，并根据反馈调整正在进行的任务。Runtime 提供可接续执行、资源限制与公共服务。

## 当前状态

仓库已有 Task、Runtime、Workspace、Context、Judge 和观测实现。本 PR 提议确立 task-centric 第一阶段基线；**文档中的目标行为尚未全部实现**。当前已知限制包括预设研究方向、累计新增任务额度、Judge 重试门禁和不完整的运行中反馈。详见 [实现状态](docs/implementation-status.md)。

近期继续使用现有 PutnamBench/Lean 数学环境验证任务机制，不另建非数学环境。

## 设计与开发入口

| 入口 | 内容 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | 项目约束、核心设计准则、开发与验收要求 |
| [GLOSSARY.md](GLOSSARY.md) | 统一领域术语 |
| [目标架构](docs/architecture.md) | 启动、分工、检查、反馈、接续与结束的完整流程 |
| [Agent Task运行契约](docs/20261102-agent-task-runtime-contract.md) | 四 Core、主动登记/认领、Progress Material、compaction 轮换与 Git Workspace lineage |
| [架构复盘](docs/reviews/task-centric-baseline.md) | 固定代码和实验基线的发现与设计推导 |
| [第一阶段计划](docs/plans/phase-1/README.md) | 三个完整代码 Issue 草案、依赖与范围 |
| [两小时验收协议](docs/validation/phase-1-acceptance.md) | 匹配对照、指标定义、触发机会和失败条件 |
| [文档索引](docs/README.md) | 当前规范、实现说明、历史证据与归档 |

先阅读 [开发流程](docs/agents/workflow.md)。本次文档 PR 不修改程序或实验配置。具体运行参数使用当前脚本和 [环境说明](docs/benchmark-environment.md)，不要把尚未实现的设计接口当作已存在命令。

## 服务与观测

服务部署参考 [内置服务](services/builtin/README.md) 和 [Mathlib Search](services/mathlib-search/README.md)。观测运行参考 [观测文档](docs/observability.md)；它描述当前实现，不另行定义目标架构。

真实实验输出统一放在受忽略的 `experiments/<experiment-id>/`，共享观测数据放在 `experiments/.observability/`。脱敏历史报告保留于 [docs/experiments](docs/experiments/)，不得当作新版本已验收的证据。

## 文档版本

当前规范由 `AGENTS.md`、目标架构和日期化的 Agent Task 运行契约共同定义。新建或新版本工程文档使用 `YYYYMMDD-标题短名.md`；稳定入口保留原路径，过时版本移入日期归档。旧设计已保留到 [归档](docs/archive/README.md)，原路径只保留导航。Notion 用于讨论，获确认的实现要求通过仓库 PR 维护；新讨论不会自动改写已经合并的规范。
