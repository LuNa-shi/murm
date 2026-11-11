# SwarmEnv

SwarmEnv 是一个研究多智能体自主协作的系统：多个 Agent 可以围绕同一 Mission 工作，提出独立 Task，通过 Material 共享与利用成果，并借助 Judge、Workspace 和 Runtime 实现检查与连续执行。

当前主要以 PutnamBench/Lean 数学任务检验协作机制。这个测试场景不是研究目标的全部，也不意味着现有系统已经证明多 Agent 在解题质量或效率上优于基线。

## 从哪里开始

| 读者 | 入口 |
|---|---|
| 第一次了解研究目标 | [docs/PROJECT.md](docs/PROJECT.md) |
| Coding Agent 开发或 Review | [AGENTS.md](AGENTS.md) |
| 找到当前有效文档 | [docs/INDEX.md](docs/INDEX.md) |
| 理解运行时架构 | [docs/architecture/INDEX.md](docs/architecture/INDEX.md) |
| 查看现有实现及真实证据缺口 | [docs/STATUS.md](docs/STATUS.md) |
| 研究阶段和人类决策边界 | [docs/phases/INDEX.md](docs/phases/INDEX.md) |
| 实验如何登记、运行和分析 | [docs/workflows/experiment.md](docs/workflows/experiment.md) |
| 领域术语 | [GLOSSARY.md](GLOSSARY.md) |

## 仓库中的主要实现

`src/agent/` 是 Pi Agent、Prompt/Capability 和 Bridge；`src/task/`、`src/context/`、`src/judge/` 保存对应领域状态；`src/runtime/` 管理执行与工作区；`src/observability/` 提供可观测数据。运行入口及配置见 `scripts/`、`config/`、`services/` 与 `test/`。

环境准备参考 [Benchmark 操作说明](docs/operations/benchmark.md)；内置服务与 Mathlib Search 的部署说明分别位于 [services/builtin/README.md](services/builtin/README.md) 和 [services/mathlib-search/README.md](services/mathlib-search/README.md)。

## 当前状态与历史资料

截至 PR #116 文档核对，参考实现树为 `02adbb43`（PR #115），R16 真实实验能展示 Task/Execution 等生命周期，但没有完成数学目标，也没有提供匹配的 root-only 对照。详见 [STATUS](docs/STATUS.md) 与 [R16 回溯报告](docs/experiments/EXP-20261111-01-r16-example.md)。

旧设计、旧 Issue 验收和旧实验报告不再作为当前仓库的规范目录。原文可从 [固定历史提交](https://github.com/LuNa-shi/SwarmEnv/tree/02adbb43d39e0b23befb7f2ffc4b19ffb386a36d/docs) 查阅，原始实验数据可能保存在本地忽略目录中。此仓库不再使用 `archive/` 目录复制历史。
