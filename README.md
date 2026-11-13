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
| Complete proposed stage design and review order | [docs/phases/INDEX.md](docs/phases/INDEX.md), linked to its design Issue and PR |
| Complete current implementation, prompts and interfaces | [docs/architecture/INDEX.md](docs/architecture/INDEX.md) |
| Development and experiment workflows | [Development](docs/workflows/development.md) · [Experiments](docs/workflows/experiment.md) |
| Domain vocabulary | [GLOSSARY.md](GLOSSARY.md) |

The GitHub Issue is the human-facing place to approve **why** a change matters, **what** it should do, and **which observations** constitute success. It owns requirements, acceptance and resource authorization. Numbered phase documents are complete design attachments reviewed through the linked Issue/PR; approval names the accepted document revision. Progress, handoffs and ticket dependencies stay on GitHub. Each implementation PR updates the affected architecture; each completed stage reconciles the manual with the final code and verification evidence.

## Implementation map

- `src/agent/` — Pi Agent adapter, prompts, capability profiles, Services Bridge
- `src/task/`, `src/context/`, `src/judge/` — authoritative domain state
- `src/runtime/` — Execution processes, resources and Workspaces
- `src/observability/` — event/state inspection
- `scripts/`, `config/`, `services/`, `test/` — operation, configuration, integrations and tests

Operational references: [Benchmark](docs/operations/benchmark.md), [built-in services](services/builtin/README.md), and [Mathlib Search](services/mathlib-search/README.md).

## Evidence and history

The [implementation manual](docs/architecture/INDEX.md) documents the pinned runtime baseline, while the [R16 retrospective example](docs/experiments/EXP-20261111-01-r16-example.md) records version-bound experimental activity. It does not establish mathematical success or a matched collaboration benefit. Implementation progress and outstanding checks belong in the relevant GitHub Issue/PR.

Obsolete documentation remains accessible from the [fixed Git history tree](https://github.com/LuNa-shi/SwarmEnv/tree/02adbb43d39e0b23befb7f2ffc4b19ffb386a36d/docs). This working tree does not recreate an `archive/` directory. Ignored raw experiment data may not exist in Git history.
