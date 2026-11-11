# 实验流程：登记 → 运行 → Overview → 分析 → 决定

> Type: Workflow · Status: Active · Updated: 2026-11-11
>
> 实验用来回答一个明确的研究或系统问题，不要求每次都运行固定两小时，也不把工具调用数、任务数当作目标。参考 [阶段规范](../phases/INDEX.md) 与 [实验索引](../experiments/INDEX.md)。

## 1. 登记（必须在运行前）

- 确认阶段负责人已批准主要问题、允许改变的变量、资源和停止条件。探索性实验可在阶段内比较若干候选，但需说明探索性质与比较边界。
- 在 [实验 INDEX](../experiments/INDEX.md) 分配 `EXP-YYYYMMDD-NN`；重复运行使用新 ID 并记录 `comparison_to` 或 `repeat_of`。
- 冻结代码 clean commit、fixture/PutnamBench/Lean/Mathlib、provider/model、Prompt/profile/schema hashes、Core 数、预算、时长、脚本/命令、基线对照和主要判据。
- 区分自然 Agent 实验、受控 probe、确定性测试和故障注入。无法确认输入环境则记 `BLOCKED`；不默默替换。

## 2. 执行与收集

- 运行前检查环境和敏感信息边界。原始 Agent 对话、源码、stdout/stderr、Workspace 数据、私密状态库保留在忽略的本地 `experiments/`，不提交到仓库。
- 保留 Task、Execution、Session、Core、Material、Candidate、CheckResult、Workspace/revision 的真实 ID 和时间边界。
- 不在看过结果后修改阈值、模型、工具或 fixture 继续称作同一可比较实验。发生偏离应记录并重新登记下一次运行。

## 3. 整理证据与报告

- 用 `.codex/skills/experiment-analysis/SKILL.md` 分析；Canonical 发表结构见 [TEMPLATE](../experiments/TEMPLATE.md)。
- **Overview**：只写运行身份、可核实事实、工具结果、执行过程、数学结果与环境/协议结果。
- **分析判断**：按代码/契约缺陷、工具/Provider/环境、Agent 行为、实验混杂或架构假设解释；给证据、替代原因、置信度和反证办法。
- **下一步决定**：AI 只提出有界建议；继续、修改阶段范围或开启新假设需阶段负责人明确决定。
- 未观察到的情况是 `INCONCLUSIVE` 或 `unknown`，不是零次或 PASS。失败检查不等于没有系统研究行为；大量活动不等于有价值的协作。

## 4. 关闭或继续

对照预登记判据汇总 PASS/FAIL/INCONCLUSIVE/BLOCKED，实际成本未知则标 `unknown`，不补零。更新索引与 [STATUS](../STATUS.md)，链接固定代码提交和脱敏报告；研究阶段是否关闭取决于人类审批。未经批准不得启动下一轮付费运行。
