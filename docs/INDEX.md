# SwarmEnv documentation index

> Status: Active · Documentation reviewed 2026-11-11

This is the entry point for current maintained documents. Old Issues, designs and experimental reports are available in pinned Git history rather than a parallel `archive/` tree.

## Documentation map

| Question | Source | Responsibility |
|---|---|---|
| Why are we researching SwarmEnv? | [PROJECT.md](PROJECT.md) | Research motivation and open problems, not a task approval |
| What should the next work item deliver? | **Human-approved GitHub Issue / accepted Agent Brief** | Intended behavior, rationale, scope and acceptance |
| Which engineering process should be followed? | **Installed Matt engineering skills** and [AGENTS.md](../AGENTS.md) | `/to-spec`, `/to-tickets`, `/implement`, `/implement-spec`, `/tdd`, `/code-review`, `/pr` |
| Where are tracker/triage/domain skill settings? | [agents/](agents/issue-tracker.md) | GitHub Issue tracker, triage labels and domain docs |
| Where should long-running local execution context go? | [phases/INDEX.md](phases/INDEX.md) | Optional Issue-numbered implementation notes, **not** a second spec |
| What is the accepted system design? | [architecture/INDEX.md](architecture/INDEX.md) | Maintained architecture baseline |
| What is implemented and verified? | [STATUS.md](STATUS.md) | Issue/PR/commit evidence and gaps |
| What are the SwarmEnv-specific workflows? | [workflows/development.md](workflows/development.md), [workflows/experiment.md](workflows/experiment.md) | Project constraints layered on installed skills |
| Where are formal experiments? | [experiments/INDEX.md](experiments/INDEX.md) | Registered runs and reports |
| Why was a design chosen? | [adr/INDEX.md](adr/INDEX.md) | Durable design decisions |
| How are tools operated? | [operations/benchmark.md](operations/benchmark.md), [operations/observability.md](operations/observability.md) | Operational notes, checked against source |

Root [GLOSSARY.md](../GLOSSARY.md) defines runtime vocabulary. The [experiment-analysis skill](../.codex/skills/experiment-analysis/SKILL.md) reconstructs existing experiment evidence.

## Sources of authority

- **Human-approved GitHub Issue or accepted Agent Brief:** product/research requirements and acceptance.
- **Accepted Architecture/ADRs:** baseline outside the Issue's approved change.
- **Installed Matt engineering skills:** engineering procedure; [AGENTS.md](../AGENTS.md) adds human/Agent permissions and SwarmEnv-specific boundaries.
- **Source, tests and experiments:** implemented and observed behavior; [STATUS](STATUS.md) tracks meaningful verification milestones.
- **Optional local notes in `phases/`:** technical context pointers for agents, not an independent Phase approval or a replacement for the GitHub Issue/ticket graph.

At design-changing PR merge, synchronize the accepted Architecture. At Issue closeout, verify Architecture, STATUS, code and the Issue's evidence links are aligned. See AGENTS.md for full decision boundaries and permission rules.

## Historical records

The [pre-cleanup `docs/` tree at `02adbb43`](https://github.com/LuNa-shi/SwarmEnv/tree/02adbb43d39e0b23befb7f2ffc4b19ffb386a36d/docs) preserves older tracked documents. Ignored raw experiment evidence may not be in Git. Do not recreate `archive/`, redirect stubs or a redundant `CONTEXT.md`.
