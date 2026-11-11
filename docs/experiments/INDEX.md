# Experiment registry

> Type: Formal run registry · Status: Active

Formal experiments performed under a **human-approved GitHub Issue** use `EXP-YYYYMMDD-NN`, allocated before execution using the UTC date and a non-reused daily sequence. Every formal entry links the parent Issue, tested commit and report. Repeated experiments receive new IDs linked via `repeat_of` or `comparison_to`; IDs do not encode Issue, model or outcome.

Implementation unit tests, bounded debugging probes and failure reproductions are different: they may run and repeat within an approved Issue and resource allowance **without a formal EXP ID**. Keep reproducible evidence and summarize at meaningful milestones. See [experiment workflow](../workflows/experiment.md).

| ID | Parent Issue / context | Type and status | Code | Report |
|---|---|---|---|---|
| `EXP-20261111-01` | Historical R16; no newly approved Issue | **Retrospective example, not preregistered** | `93176b7` | [R16 example](EXP-20261111-01-r16-example.md) |

Use [TEMPLATE.md](TEMPLATE.md) for each new formal study. An approved Issue may delegate a bounded matrix and repeated runs, so a separate human approval is not needed for every execution. The human decides the value/importance of research hypotheses and any material scope change.

## Retention and interpretation

This directory is retained because a current implementation manual cannot reconstruct a historical observation. Keep the registry, reusable report template and reports still cited by current Issues, PRs, ADRs or accepted design decisions. When a report leaves the active tree, replace its maintained references with an immutable Git link; do not silently discard the evidence behind a current claim. The existing R16 example remains explicitly retrospective and is not proof of a later implementation's behavior.

Architecture describes runtime mechanisms, including the evidence pipeline. These reports record the actual inputs, tested version, observations and limitations of particular runs. Neither creates a second stage plan.

Historical experimental reports can be found in [the fixed pre-cleanup Git tree](https://github.com/LuNa-shi/SwarmEnv/tree/02adbb43d39e0b23befb7f2ffc4b19ffb386a36d/docs/experiments). Git does not necessarily include raw records from ignored local experiment directories.
