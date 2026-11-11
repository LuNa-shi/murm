# SwarmEnv

SwarmEnv is a research environment for autonomous collaboration among multiple Agents. Agents can work on a shared Mission, define independent Tasks, exchange versioned Materials, and use Judge, Workspace and Runtime capabilities to check and continue their work.

Current research experiments primarily use PutnamBench and Lean/Mathlib to examine collaboration mechanisms. This benchmark choice does not limit the research agenda, and existing runs do not by themselves establish a multi-Agent performance advantage.

## Start here

| Reader / question | Document |
|---|---|
| Research purpose and open questions | [PROJECT.md](docs/PROJECT.md) |
| Coding Agent instructions and permissions | [AGENTS.md](AGENTS.md) |
| Current documentation map | [docs/INDEX.md](docs/INDEX.md) |
| Human-reviewed development task | **Approved GitHub Issue** (Issue discussion and acceptance criteria) |
| Implementation decisions and handoff for an Issue | The originating **GitHub Issue / PR** |
| Complete current implementation, prompts and interfaces | [docs/architecture/INDEX.md](docs/architecture/INDEX.md) |
| Implementation progress and evidence | [docs/STATUS.md](docs/STATUS.md) |
| Development and experiment workflows | [Development](docs/workflows/development.md) · [Experiments](docs/workflows/experiment.md) |
| Domain vocabulary | [GLOSSARY.md](GLOSSARY.md) |

The GitHub Issue is the human-facing place to approve **why** a change matters, **what** it should do, and **which observations** constitute success. The GitHub Issue and its human-approved comments are the sole requirements and acceptance source. Implementation decisions, progress, handoffs and ticket dependencies stay on the Issue/PR, with no separate local Phase or spec document. Each implementation PR updates the affected architecture; each completed stage reconciles the manual with the final code and verification evidence.

## Implementation map

- `src/agent/` — Pi Agent adapter, prompts, capability profiles, Services Bridge
- `src/task/`, `src/context/`, `src/judge/` — authoritative domain state
- `src/runtime/` — Execution processes, resources and Workspaces
- `src/observability/` — event/state inspection
- `scripts/`, `config/`, `services/`, `test/` — operation, configuration, integrations and tests

Operational references: [Benchmark](docs/operations/benchmark.md), [built-in services](services/builtin/README.md), and [Mathlib Search](services/mathlib-search/README.md).

## Evidence and history

The runtime snapshot in [STATUS](docs/STATUS.md) currently references the `02adbb43` tree (PR #115). The [R16 retrospective example](docs/experiments/EXP-20261111-01-r16-example.md) shows Task/Execution activity but does not establish mathematical success or a matched root-only comparison.

Obsolete documentation remains accessible from the [fixed Git history tree](https://github.com/LuNa-shi/SwarmEnv/tree/02adbb43d39e0b23befb7f2ffc4b19ffb386a36d/docs). This working tree does not recreate an `archive/` directory. Ignored raw experiment data may not exist in Git history.
