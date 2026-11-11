# 06. Observability and experiments

Observability is a bounded evidence projection, not the domain authority.
Task, Execution, Material, Workspace and Judge services remain authoritative;
the observation store joins their events for inspection and dashboard views.

## Experiment report sections

Every registered experiment has four sections:

1. **Registration**: the human-approved hypothesis, changed variables,
   comparison, environment, resources, expected observations and stop rules.
2. **Overview**: deterministic facts extracted from metadata, authoritative state,
   Runtime/Service logs, Workspace manifests and Judge records.
3. **分析判断**：证据支持的原因解释、替代原因、置信度和未知项。
4. **下一步决定**：是否继续当前阶段、改变范围、停止，或开始新的假设。

The report format and phase templates live in
[`docs/experiments/`](../experiments/README.md) and [`docs/phases/`](../phases/README.md).

## Evidence rules

Missing evidence is `unknown`, not zero. A completed run with `solved=false`
can still provide lifecycle evidence. `protocol_valid=true` does not prove
mathematical progress. A Material being published, read or counted does not
prove it changed later work. A model's prose does not prove a hidden reasoning
step.

The `experiment-analysis` skill is useful for building Task/Execution/Material
windows and checking tool request/response pairs. Its output must remain an
evidence appendix or a draft analysis; the human phase owner decides what the
experiment means and what to do next.
