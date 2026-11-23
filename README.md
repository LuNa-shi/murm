# SwarmEnv

SwarmEnv is a programmable JavaScript harness for coordinating multiple agents. The Core runs Bots with independent Pi sessions, project directories and OpenSandbox resources. An Environment supplies the collaboration policy, Service permissions, inputs and finish criteria.

## Run the Notes example

Start with two Bots that pass a supplied fact through a custom Notes Service. The host verifies the writer's publication, the reader's lookup and both files written by the same reader across two turns. The instructions build and install the Core tarball in a standalone directory, then show how to read the saved result. The example requires Node.js 22.19 or newer, local Docker OpenSandbox, a compatible Pi 1.3.0 Worker image and a Kimi K3 Responses endpoint. [Notes installation and run instructions](examples/notes-environment/README.md)

The installable candidate provides `@swarmenv/core`, `@swarmenv/core/services` and `@swarmenv/core/backends/pi-opensandbox`. Use the foreground CLI to start, inspect, direct input to or stop a configured flat or agensh Environment. The saved-result command reads the persisted Runtime and Environment reports by their Runtime ID. Flat live Workspace publication currently requires a trusted capture binding supplied by the host. [Foreground and saved-result commands](docs/architecture/17-environment-reporting.md#foreground-environment-control)

## Environments

| Environment | Collaboration |
|---|---|
| flat | Bots take independent Tasks exclusively and share versioned Materials and a public Workspace. [Flat execution](docs/architecture/02-execution.md#3-how-flat-work-reaches-a-bot) |
| agensh | Independent peers coordinate through Git, messages and a shared Board. [Agensh](docs/architecture/18-agensh-environment.md) |
| subagents | A parent creates and directs its own child Bots through a scoped Service. [Subagents example](examples/subagents-environment/README.md) |
| scaleMAS | A fixed pool publishes, searches and cites durable contributions. [scaleMAS](docs/architecture/19-scalemas-environment.md) |
| lead-helper | Helpers claim Board work and deliver through Git under a lead's shared direction. [Lead-helper example](examples/lead-helper-environment/README.md) |

## Start here

| Reader / question | Document |
|---|---|
| Research purpose and open questions | [PROJECT.md](docs/PROJECT.md) |
| Coding Agent instructions and permissions | [AGENTS.md](AGENTS.md) |
| Current documentation map | [docs/INDEX.md](docs/INDEX.md) |
| Current Core / Environment stage requirements | [Phase 0005 authoritative design](docs/phases/0005-core-environment/README.md) — full Core, Environment and delivery plan |
| Human-reviewed development task | Derived GitHub Issue for Phase 0005; approved Issue contract for other stages |
| Implementation decisions and handoff for an Issue | The originating **GitHub Issue / PR** |
| Complete proposed stage design and review order | [docs/phases/INDEX.md](docs/phases/INDEX.md), linked to its design Issue and PR |
| Complete current implementation, prompts and interfaces | [docs/architecture/INDEX.md](docs/architecture/INDEX.md) |
| Development and experiment workflows | [Development](docs/workflows/development.md) · [Experiments](docs/workflows/experiment.md) |
| Domain vocabulary | [GLOSSARY.md](GLOSSARY.md) |

For the Core / Environment stage, the [Phase 0005 design on main](docs/phases/0005-core-environment/README.md) is the sole source of target requirements, scope and acceptance. Its Issues cite the design revision and track implementation, dependencies and evidence; requirements change through the design PR first. Notion pages are migration sources. The design is not a claim that the new APIs are implemented. Other stages retain the human-approved Issue as their requirements contract. Resource and publication authorization stays explicit. Each implementation PR updates the affected Architecture, and stage closeout reconciles the manual, final code and evidence.

## Implementation map

- `src/core/` — programmable Runtime, Bot lifecycle, Service Bridge and Pi/OpenSandbox backend
- `src/environments/` — flat, agensh and peer collaboration policies
- `src/agent/` — capability profiles, Worker launch contracts, model catalog, Responses gateway and Services Bridge
- `src/task/`, `src/context/`, `src/judge/` — authoritative domain state
- `src/runtime/` — Execution processes, resources and Workspaces
- `src/observability/` — read-only JSON/SSE event and state inspection; [terminal and Observer migration](docs/architecture/07-run-configuration.md#optional-services-and-observer-migration)
- `scripts/`, `config/`, `services/`, `test/` — operation, configuration, integrations and tests

Operational references: [built-in services](services/builtin/README.md), and [Mathlib Search](services/mathlib-search/README.md).

## Evidence and history

The implementation manual describes the current code. Implementation progress and outstanding checks belong in the relevant GitHub Issue/PR. The experiment index preserves observations tied to older revisions, including the whole-Workspace collaboration and trusted acceptance observed on the PR #128 implementation. [Implementation manual](docs/architecture/INDEX.md) · [Experiment index](docs/experiments/INDEX.md) · [EXP-20261116-04](docs/experiments/EXP-20261116-04-workspace-project-1h.md)

The benchmark runner, dedicated mathematical launchers and embedded datasets are preserved in the fixed research revision. [Research tree](https://github.com/LuNa-shi/SwarmEnv/tree/dc011003fa0354a881b7a3ba9ba901fe36cbcac9)

Obsolete documentation remains accessible from the [fixed Git history tree](https://github.com/LuNa-shi/SwarmEnv/tree/02adbb43d39e0b23befb7f2ffc4b19ffb386a36d/docs). This working tree does not recreate an `archive/` directory. Ignored raw experiment data may not exist in Git history.

