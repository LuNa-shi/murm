# Experiment registry

> Type: Registry · Status: Active

**Formal research and acceptance runs** within a human-approved phase use `EXP-YYYYMMDD-NN`, allocated before execution using the UTC date and a non-reused daily sequence. A repeated formal run receives a new ID linked with `repeat_of` or `comparison_to`. IDs do not encode the Issue, model, commit or result.

**Implementation checks are different:** local tests, bounded debugging probes and failure reproductions within the approved scope and budget may be repeated without a formal Experiment ID. Preserve the important version/input/result evidence, then report the consolidated findings at a milestone or decision point. See the [experiment workflow](../workflows/experiment.md).

| ID | Kind and status | Run code | Report |
|---|---|---|---|
| `EXP-20261111-01` | Retrospective reporting example, **not preregistered** | `93176b7` | [R16 example](EXP-20261111-01-r16-example.md) |

Use [TEMPLATE.md](TEMPLATE.md) for a new formal experiment. The human phase owner chooses worthwhile research questions and approves changes in scope or resources; registered repetitions within that permission need no per-run approval. Original historical reports can be found in the [fixed pre-cleanup Git tree](https://github.com/LuNa-shi/SwarmEnv/tree/02adbb43d39e0b23befb7f2ffc4b19ffb386a36d/docs/experiments), not in a live `archive/` directory.
