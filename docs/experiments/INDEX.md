# 实验登记索引

> Type: Registry · Status: Active · 新实验先登记，再运行。

新的运行编号为 `EXP-YYYYMMDD-NN`，`YYYYMMDD` 使用 UTC 日期，`NN` 是该日按顺序分配且不复用的编号。编号不编码 Issue、模型、结果或代码提交；重试分配新 ID，通过 `repeat_of`、`comparison_to` 关联前次实验。

实验要求见 [实验流程](../workflows/experiment.md)，新报告从 [TEMPLATE.md](TEMPLATE.md) 创建。原始证据必须留在受忽略的本地 `experiments/`，此处只保留经审阅的脱敏报告、登记与指向固定提交的引用。

| ID | 类型 / 状态 | 代码身份 | 说明 |
|---|---|---|---|
| [EXP-20261111-01](EXP-20261111-01-r16-example.md) | **Retrospective example**，非预注册 | `93176b7` | 对旧 R16 运行的事后格式示例；不能视为符合新阶段/预注册流程 |

旧实验报告保留在 [PR #116 之前的 `docs/experiments/` Git 树](https://github.com/LuNa-shi/SwarmEnv/tree/02adbb43d39e0b23befb7f2ffc4b19ffb386a36d/docs/experiments)。旧 ID 仍用于追溯原运行，**不批量重命名、不重写历史结果**。新一轮实验的审批与上下文需按 [阶段](../phases/INDEX.md) 另行登记。
