# murm

murm is a TypeScript toolkit for building multi-agent Harnesses. A Harness composes Agent Profiles, shared Services and its coordination policy. The Runtime runs each Agent in an isolated Sandbox and records the execution as a Run. The Core library exposes the Runtime, Service framework and OpenSandbox backend with configurable Pi and Codex executors. [Website](https://luna-shi.github.io/murm/) · [Core concepts](GLOSSARY.md)

## Quick Start

Run Subagents directly from the checkout. On a Linux host with Node.js 22.19 or newer, a local OpenSandbox provider and a compatible Worker image, build the checkout with `npm ci && npm run build`. If the host still needs OpenSandbox or the Worker, run `./scripts/setup` from the checkout root to build the checkout and prepare both. [Host requirements](docs/architecture/07-run-configuration.md#host-checks-and-checkout-preparation)

Create `examples/subagents/.env` with your Worker image and model endpoint, as shown in the [Subagents example](examples/subagents/README.md#run-from-the-checkout). Then run a task from the example directory.

```sh
cd examples/subagents
node --env-file=.env ../../dist/examples/subagents/main.js \
  ../../dist/examples/subagents/config.js \
  'Suggest two checks to make before merging a pull request.'
```

The example prints the report path and closes its Sandboxes after the task. Edit `examples/subagents/config.ts` to change the configuration and rebuild from the checkout root. [Quick Start](https://luna-shi.github.io/murm/docs/quickstart/)

The two-Agent Notes handoff shows how to implement a custom Service and verify exported files across turns. [Notes example](examples/notes/README.md)

The installable candidate provides Runtime types and lifecycle through `@murm/core`, Service registration and adapters through `@murm/core/services`, and the configurable Pi or Codex backend through `@murm/core/backends/opensandbox`. Use the foreground CLI to start, inspect, direct input to or stop a configured TaskPool or PeerMesh Harness. The saved-result command reads the persisted Runtime and Harness reports by their Runtime ID. TaskPool supports reading public Workspace results and publishing Materials. Saving live Agent files to a Workspace revision requires a trusted capture binding supplied by the host. [Foreground and saved-result commands](docs/architecture/17-harness-reporting.md#foreground-harness-control)

## Harnesses

| Harness | Collaboration |
|---|---|
| TaskPool | Agents take independent Tasks exclusively and share versioned Materials and a public Workspace. [TaskPool execution](docs/architecture/02-execution.md#3-how-taskpool-work-reaches-an-agent) |
| PeerMesh | Independent peers coordinate through Git, messages and a shared Board. [Run the installed PeerMesh example](examples/peermesh/README.md) |
| Subagents | A parent creates and directs its own child Agents through a scoped Service. [Subagents example](examples/subagents/README.md) |
| Substrate | A fixed pool publishes, searches and cites durable contributions. [Substrate example](examples/substrate/README.md) |
| Lead-Worker | Helpers claim Board work and deliver through Git under a lead's shared direction. [Lead-Worker example](examples/lead-worker/README.md) |

## Upgrade to murm

Install the `murm-core-0.2.0.tgz` archive and use `@murm/core`, `@murm/core/services` and `@murm/core/backends/pi-opensandbox`. Update Harness paths using the table above. Host scripts use `run-harness.js` and `read-harness-result.js`. The foreground host accepts `taskpool` and `peermesh`, and the Agent-side Service CLI is `swarm`.

Use the `MURM_*` settings in the example configuration and rebuild the Worker image from this revision. Start a new Run directory for new Harness and Runtime records. The package entry points, Agent identifiers, Service operation names, and Worker and record contracts use the current vocabulary. The project repository is [LuNa-shi/murm](https://github.com/LuNa-shi/murm). [Command and record details](docs/architecture/17-harness-reporting.md#foreground-harness-control)

## Start here

| Reader / question | Document |
|---|---|
| Research purpose and open questions | [PROJECT.md](docs/PROJECT.md) |
| Coding Agent instructions and permissions | [AGENTS.md](AGENTS.md) |
| Current documentation map | [docs/INDEX.md](docs/INDEX.md) |
| Current Core / Harness stage requirements | [Phase 0005 authoritative design](docs/phases/0005-core-harness/README.md) — full Core, Harness and delivery plan |
| Human-reviewed development task | Derived GitHub Issue for Phase 0005; approved Issue contract for other stages |
| Implementation decisions and handoff for an Issue | The originating **GitHub Issue / PR** |
| Complete proposed stage design and review order | [docs/phases/INDEX.md](docs/phases/INDEX.md), linked to its design Issue and PR |
| Complete current implementation, prompts and interfaces | [docs/architecture/INDEX.md](docs/architecture/INDEX.md) |
| Development and experiment workflows | [Development](docs/workflows/development.md) · [Experiments](docs/workflows/experiment.md) |
| Domain vocabulary | [GLOSSARY.md](GLOSSARY.md) |

For the Core / Harness stage, the [Phase 0005 design on main](docs/phases/0005-core-harness/README.md) is the sole source of target requirements, scope and acceptance. Its Issues cite the design revision and track implementation, dependencies and evidence; requirements change through the design PR first. Notion pages are migration sources. The design is not a claim that the new APIs are implemented. Other stages retain the human-approved Issue as their requirements contract. Resource and publication authorization stays explicit. Each implementation PR updates the affected Architecture, and stage closeout reconciles the manual, final code and evidence.

## Implementation map

| Directory | What to look for |
| --- | --- |
| [`examples/`](examples/subagents/README.md) | Runnable Harness examples with editable tasks and configuration. Start with Subagents or the Notes Service. |
| [`src/core/`](docs/architecture/15-core-runtime.md) | Programmable Runtime, Agent lifecycle, Service Bridge and OpenSandbox backend assembly. |
| [`src/harnesses/`](docs/architecture/02-execution.md) | TaskPool, PeerMesh, Substrate and Lead-Worker coordination policies and shared host helpers. |
| [`src/runtime/`](docs/architecture/16-pi-opensandbox-backend.md), `src/agent/` | Sandbox management, Execution and Workspace support, model catalog validation and Responses gateway. |
| [`src/services/`](src/services/mathlib-search/README.md), `src/sdk/` | Optional Service integrations and internal Service hosting and registration. Task, Context and Judge own their domain state in `src/task/`, `src/context/` and `src/judge/`. |
| [`deploy/`](docs/architecture/07-run-configuration.md#local-setup-and-doctor) | Worker image, local OpenSandbox config and Service deployment recipes. See [built-in services](deploy/builtin-services/README.md) and [Mathlib Search](src/services/mathlib-search/README.md). |
| [`scripts/`](docs/architecture/07-run-configuration.md) | Build, setup, command entry points and Worker process code. Project templates live alongside setup under `scripts/local-setup/templates/`. |
| `benchmarks/` | Opt-in benchmark runners with fixed inputs and evaluators. See [Pastel](benchmarks/programbench-pastel/README.md) and [PutnamBench](benchmarks/putnambench-taskpool/README.md). |
| `test/`, `test-support/` | Regression tests and reusable test fixtures. |
| [`docs/`](docs/INDEX.md), `website/` | Implementation manual, designs and experiment records, plus the separately built documentation site. |
| [`trace-viewer/`](docs/operations/trace-viewer.md) | Standalone web UI for saved and live Core Runs. |
| `.github/`, `third_party/` | Repository automation and pinned external code. |

## Evidence and history

The [ProgramBench Pastel benchmark](benchmarks/programbench-pastel/README.md) runs one real software reconstruction task through Subagents, TaskPool and PeerMesh with independently recorded collaboration and evaluator evidence.

The implementation manual describes the current code. Implementation progress and outstanding checks belong in the relevant GitHub Issue/PR. The experiment index preserves observations tied to older revisions, including the whole-Workspace collaboration and trusted acceptance observed on the PR #128 implementation. [Implementation manual](docs/architecture/INDEX.md) · [Experiment index](docs/experiments/INDEX.md) · [EXP-20261116-04](docs/experiments/EXP-20261116-04-workspace-project-1h.md)

The legacy mathematical benchmark runner, dedicated launchers and embedded datasets are preserved in the fixed research revision. [Research tree](https://github.com/LuNa-shi/SwarmEnv/tree/dc011003fa0354a881b7a3ba9ba901fe36cbcac9)

Obsolete documentation remains accessible from the [fixed Git history tree](https://github.com/LuNa-shi/SwarmEnv/tree/02adbb43d39e0b23befb7f2ffc4b19ffb386a36d/docs). This working tree does not recreate an `archive/` directory. Ignored raw experiment data may not exist in Git history.

## License

murm's original code and documentation are licensed under the [MIT License](LICENSE). Third-party material retains its own terms. [Third-party notices](docs/third-party-notices.md)

