# Current architecture map

This directory is the current implementation-oriented architecture guide for
the SwarmEnv main tree. It is written against the implementation tree at
`02adbb43` (the merge of PR #115). The R16 real-Agent run used parent commit
`93176b7`; the two commits have the same tree, but the experiment evidence is
still bound to `93176b7`.

The documents here answer what the system is and how its modules cooperate.
They do not claim that every documented behavior has passed real-Agent
acceptance. Code/evidence status belongs in `docs/implementation-status.md` and
the experiment reports.

## Reading order

1. [00: Overview](00-overview.md)
2. [01: Agent Core](01-agent-core.md)
3. [02: Execution](02-execution.md)
4. [03: Mission and Task](03-mission-task.md)
5. [04: Services and tools](04-services.md)
6. [05: Workspace and continuity](05-workspace-continuity.md)
7. [06: Observability and experiments](06-observability-experiments.md)

## Authority map

| Question | Authoritative location |
|---|---|
| Project-wide constraints and non-negotiable principles | [`AGENTS.md`](../../AGENTS.md) |
| Domain vocabulary | [`GLOSSARY.md`](../../GLOSSARY.md) |
| Current module boundaries and runtime flow | This directory |
| Interface/state details | [`docs/20261102-agent-task-runtime-contract.md`](../20261102-agent-task-runtime-contract.md) and the relevant source |
| Why a durable design choice exists | [`docs/adr/`](../adr/README.md) |
| Code versus intended behavior | [`docs/implementation-status.md`](../implementation-status.md) |
| 大阶段批准的范围和假设 | [`docs/phases/`](../phases/README.md) |
| What a run actually did | [`docs/experiments/`](../experiments/README.md) |
| Historical material | [`docs/archive/`](../archive/README.md) |

When these sources disagree, the conflict is a documentation defect. Record
the resolution before changing implementation. An experiment report is
evidence of a past run; it cannot silently redefine the current architecture.
