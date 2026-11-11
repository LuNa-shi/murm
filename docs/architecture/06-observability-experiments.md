# 06. Observability and evidence boundary

Observability is a bounded projection of evidence. Task, Execution, Context, Workspace and Judge services own authoritative state; the observation store joins events for inspection and dashboard views. A chart or count is not a new authority or an explanation of research progress.

## Evidence distinctions

- Published Material ≠ read Material ≠ accepted/used Material ≠ improved output.
- Shared Mission concurrency ≠ independently scoped Task parallelism.
- A completed local Task, one checker PASS and final Mission completion are different facts.
- `protocol_valid=true` does not mean the mathematical goal was achieved.
- Missing evidence is `unknown`, not zero.
- Source inspection, deterministic tests, controlled probes and natural Agent runs are different evidence classes.

## Experiment workflow

每次经批准的运行先登记输入、变量、对照、预期现象、资源与停止规则。结束后区分：
1. **Overview**：输入、执行与可验证的事实。
2. **分析判断**：证据支持的解释、替代原因和未知项。
3. **下一步建议或决定**：AI 可提出建议，阶段负责人审批方向、范围变化和下一实验。

具体定义只在 [实验流程](../workflows/experiment.md) 与 [报告模板](../experiments/TEMPLATE.md) 维护；`experiment-analysis` Skill 生成证据诊断草稿，不能自行修改阶段目标。
