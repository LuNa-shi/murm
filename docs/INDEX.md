# SwarmEnv documentation index

> Status: Active · Current runtime code baseline: `02adbb43` (PR #115 tree) · Reviewed 2026-11-11

This is the single entry point for active project documentation. Historic designs, retired Issue plans and old experiment reports are available from Git history, not kept as parallel current specifications.

## Find the right document

| Question | Document | Responsibility |
|---|---|---|
| What are we researching? | [PROJECT.md](PROJECT.md) | Research goals and open questions, not a mandated implementation strategy |
| What is implemented and actually supported by evidence? | [STATUS.md](STATUS.md) | Versioned evidence snapshot, not a substitute for source or new experiments |
| How does the system work today? | [architecture/INDEX.md](architecture/INDEX.md) | Runtime modules, Task/Execution boundary, state and continuity |
| How does a Coding Agent implement and verify changes? | [workflows/development.md](workflows/development.md) | Autonomous implementation and testing within approved designs |
| How should experiments be conducted? | [workflows/experiment.md](workflows/experiment.md) | Diagnostic probes versus formally approved research experiments |
| Who chooses the next research question? | [phases/INDEX.md](phases/INDEX.md) | Human-owned hypothesis selection, priority and bounded delegation |
| How are formal experiments registered? | [experiments/INDEX.md](experiments/INDEX.md) | Experiment IDs, report template, representative historical example |
| Why was a design chosen? | [adr/INDEX.md](adr/INDEX.md) | Architectural decisions and tradeoffs |
| How are benchmark and observability tools operated? | [operations/benchmark.md](operations/benchmark.md), [operations/observability.md](operations/observability.md) | Operational references, subject to current CLI/source verification |

[AGENTS.md](../AGENTS.md) defines the human/Coding Agent working boundary; [GLOSSARY.md](../GLOSSARY.md) defines SwarmEnv runtime terminology. The [experiment-analysis skill](../.codex/skills/experiment-analysis/SKILL.md) describes how to reconstruct evidence for an existing run.

## Authority and maintenance

- **Human-reviewed design and approved phase documents** define the intended behavior and what a Coding Agent is permitted to change. A draft is not an approved contract.
- **Source code and tool schemas** describe the implementation. **Tests and experiment records** establish what was actually verified. If they disagree with an approved design, record the discrepancy and investigate; do not silently rewrite the requirement to match code.
- ADRs explain decisions; old Issue plans and historical runs do not override active approved documents.
- The human owner selects valuable research questions and authorizes scope and resources. Coding Agents can autonomously repair, test and repeat within those bounds; a new research hypothesis requires review.
- Update the applicable active document and evidence references when an approved decision changes. Avoid competing copies of the same procedure. New project-wide terms and report conventions require human review.
- Do not create `archive/` folders, redirect stubs or a second `CONTEXT.md`. Obsolete documents can be recovered by pinned Git commits.

## Historical records

Read the [fixed `docs/` tree at `02adbb43`](https://github.com/LuNa-shi/SwarmEnv/tree/02adbb43d39e0b23befb7f2ffc4b19ffb386a36d/docs) for pre-cleanup documents and old Issue reports. Original raw experimental evidence may live only in ignored local storage; Git history does not automatically contain those raw files.
