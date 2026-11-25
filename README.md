# murm

murm is a TypeScript toolkit for building multi-agent Harnesses. A Harness composes Agent Profiles, shared Services and its coordination policy. The Runtime runs each Agent in an isolated Sandbox and records the execution as a Run. The Core library exposes the Runtime, Service framework and Pi/OpenSandbox backend. [Website](https://luna-shi.github.io/SwarmEnv/) · [Core concepts](GLOSSARY.md)

## Run the Notes example

Start with two Agents that pass a supplied fact through a custom Notes Service. The host verifies the writer's publication, the reader's lookup and both files written by the same reader across two turns. The instructions build and install the Core tarball in a standalone directory, then show how to read the saved result. The example requires Node.js 22.19 or newer, local Docker OpenSandbox, a compatible Pi 1.3.0 Worker image and a Kimi K3 Responses endpoint. [Notes installation and run instructions](examples/notes/README.md)

The installable candidate provides `@murm/core`, `@murm/core/services` and `@murm/core/backends/pi-opensandbox`. Use the foreground CLI to start, inspect, direct input to or stop a configured TaskPool or PeerMesh Harness. The saved-result command reads the persisted Runtime and Harness reports by their Runtime ID. TaskPool supports reading public Workspace results and publishing Materials. Saving live Agent files to a Workspace revision requires a trusted capture binding supplied by the host. [Foreground and saved-result commands](docs/architecture/17-harness-reporting.md#foreground-harness-control)

## Harnesses

| Harness | Collaboration |
|---|---|
| TaskPool | Agents take independent Tasks exclusively and share versioned Materials and a public Workspace. [TaskPool execution](docs/architecture/02-execution.md#3-how-taskpool-work-reaches-an-agent) |
| PeerMesh | Independent peers coordinate through Git, messages and a shared Board. [Run the installed PeerMesh example](examples/peermesh/README.md) |
| Subagents | A parent creates and directs its own child Agents through a scoped Service. [Subagents example](examples/subagents/README.md) |
| Substrate | A fixed pool publishes, searches and cites durable contributions. [Substrate example](examples/substrate/README.md) |
| Lead-Worker | Helpers claim Board work and deliver through Git under a lead's shared direction. [Lead-Worker example](examples/lead-worker/README.md) |

## Upgrade from SwarmEnv

Install the `murm-core-0.2.0.tgz` candidate and update imports from `@swarmenv/core` to `@murm/core`, including the `/services` and `/backends/pi-opensandbox` subpaths. Update source and installed example paths using the table below. The package API exports `AgentInfo`, `AgentStatus` and `AgentEvent` alongside the previous type names.

| Previous Harness | Current name | Source |
|---|---|---|
| `subagents` | Subagents | [examples/subagents](examples/subagents) |
| `flat` | TaskPool | [src/harnesses/taskpool](src/harnesses/taskpool) |
| `agensh` | PeerMesh | [src/harnesses/peermesh](src/harnesses/peermesh) |
| `scaleMAS` | Substrate | [src/harnesses/substrate](src/harnesses/substrate) |
| `lead-helper` | Lead-Worker | [src/harnesses/lead-worker](src/harnesses/lead-worker) |

Use `dist/scripts/run-harness.js` to start a foreground Harness and `dist/scripts/read-harness-result.js` to inspect a saved Run. The previous command paths and `flat` / `agensh` mode values remain accepted. The Agent-side Service CLI remains `swarm`. Existing `SWARMENV_*` settings, Worker image contracts and saved Run formats still apply. [Command and record details](docs/architecture/17-harness-reporting.md#foreground-harness-control)

## Start here

| Reader / question | Document |
|---|---|
| Research purpose and open questions | [PROJECT.md](docs/PROJECT.md) |
| Coding Agent instructions and permissions | [AGENTS.md](AGENTS.md) |
| Current documentation map | [docs/INDEX.md](docs/INDEX.md) |
| Current Core / Harness stage requirements | [Phase 0005 authoritative design](docs/phases/0005-core-environment/README.md) — full Core, Harness and delivery plan |
| Human-reviewed development task | Derived GitHub Issue for Phase 0005; approved Issue contract for other stages |
| Implementation decisions and handoff for an Issue | The originating **GitHub Issue / PR** |
| Complete proposed stage design and review order | [docs/phases/INDEX.md](docs/phases/INDEX.md), linked to its design Issue and PR |
| Complete current implementation, prompts and interfaces | [docs/architecture/INDEX.md](docs/architecture/INDEX.md) |
| Development and experiment workflows | [Development](docs/workflows/development.md) · [Experiments](docs/workflows/experiment.md) |
| Domain vocabulary | [GLOSSARY.md](GLOSSARY.md) |

For the Core / Harness stage, the [Phase 0005 design on main](docs/phases/0005-core-environment/README.md) is the sole source of target requirements, scope and acceptance. Its Issues cite the design revision and track implementation, dependencies and evidence; requirements change through the design PR first. Notion pages are migration sources. The design is not a claim that the new APIs are implemented. Other stages retain the human-approved Issue as their requirements contract. Resource and publication authorization stays explicit. Each implementation PR updates the affected Architecture, and stage closeout reconciles the manual, final code and evidence.

## Implementation map

- `src/core/` — programmable Runtime, Agent lifecycle, Service Bridge and Pi/OpenSandbox backend
- `src/harnesses/` — TaskPool, PeerMesh, Substrate and Lead-Worker collaboration policies
- `src/agent/` — capability profiles, Worker launch contracts, model catalog, Responses gateway and Services Bridge
- `src/task/`, `src/context/`, `src/judge/` — authoritative domain state
- `src/runtime/` — Execution processes, resources and Workspaces
- `src/observability/` — read-only JSON/SSE event and state inspection; [terminal and Observer migration](docs/architecture/07-run-configuration.md#optional-services-and-observer-migration)
- `scripts/`, `config/`, `services/`, `test/` — operation, configuration, integrations and tests

Operational references: [built-in services](services/builtin/README.md), and [Mathlib Search](services/mathlib-search/README.md).

## Evidence and history

The [ProgramBench Pastel benchmark](benchmarks/programbench-pastel/README.md) runs one real software reconstruction task through Subagents, TaskPool and PeerMesh with independently recorded collaboration and evaluator evidence.

The implementation manual describes the current code. Implementation progress and outstanding checks belong in the relevant GitHub Issue/PR. The experiment index preserves observations tied to older revisions, including the whole-Workspace collaboration and trusted acceptance observed on the PR #128 implementation. [Implementation manual](docs/architecture/INDEX.md) · [Experiment index](docs/experiments/INDEX.md) · [EXP-20261116-04](docs/experiments/EXP-20261116-04-workspace-project-1h.md)

The legacy mathematical benchmark runner, dedicated launchers and embedded datasets are preserved in the fixed research revision. [Research tree](https://github.com/LuNa-shi/SwarmEnv/tree/dc011003fa0354a881b7a3ba9ba901fe36cbcac9)

Obsolete documentation remains accessible from the [fixed Git history tree](https://github.com/LuNa-shi/SwarmEnv/tree/02adbb43d39e0b23befb7f2ffc4b19ffb386a36d/docs). This working tree does not recreate an `archive/` directory. Ignored raw experiment data may not exist in Git history.

