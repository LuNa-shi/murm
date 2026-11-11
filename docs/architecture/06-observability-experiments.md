# 06. Observability and experiments

Observability is a bounded evidence projection, not the domain authority.
Task, Execution, Material, Workspace and Judge services remain authoritative;
the observation store joins their events for inspection and dashboard views.

## Experiment layers

Every registered experiment has four layers:

1. **Registration**: the human-approved hypothesis, changed variables,
   comparison, environment, resources, expected observations and stop rules.
2. **Truth**: deterministic facts extracted from metadata, authoritative state,
   Runtime/Service logs, Workspace manifests and Judge records.
3. **Assessment**: evidence-backed causal interpretation, alternatives and
   confidence. It is a reviewable judgment, not an automatic truth field.
4. **Decision**: whether the stage continues, closes, changes scope or starts a
   new hypothesis.

The report format and Stage Charter templates live in
[`docs/experiments/`](../experiments/README.md) and [`docs/stages/`](../stages/README.md).

## Evidence rules

Missing evidence is `unknown`, not zero. A completed run with `solved=false`
can still provide lifecycle evidence. `protocol_valid=true` does not prove
mathematical progress. A Material being published, read or counted does not
prove it changed later work. A model's prose does not prove a hidden reasoning
step.

The `experiment-analysis` skill is useful for building Task/Execution/Material
windows and checking tool request/response pairs. Its output must remain an
evidence appendix or a draft assessment; a human stage owner decides what the
experiment means and what to do next.
