# murm

Build your own multi-agent Harness.

murm is a TypeScript SDK for running isolated Agents and connecting them to shared Services. You write the collaboration policy: who starts work, how Agents communicate, what they share, and when the job is done. The Runtime manages Agent lifecycles, input delivery, Service access, execution records and cleanup. The OpenSandbox backend runs Pi or Codex inside each Agent's Sandbox.

[Website](https://luna-shi.github.io/murm/) · [Documentation](docs/en/overview.md) · [中文文档](docs/zh/overview.md) · [SDK guide](docs/en/sdk.md) · [Architecture](docs/architecture/INDEX.md)

## Get started

Choose an existing Harness to run, or use the SDK to build one.

### Run an existing Harness

Start with [Subagents](examples/subagents/README.md). On a supported Linux host with Node.js 22.19 or newer, npm, a local OpenSandbox provider and a compatible Worker image:

```sh
npm ci
npm run build
```

If the host still needs OpenSandbox and the Worker, run `./scripts/setup` from the checkout instead. Create `examples/subagents/.env` using the [example settings](examples/subagents/README.md#run-from-the-checkout), then run:

```sh
cd examples/subagents
node --env-file=.env ../../dist/examples/subagents/main.js \
  ../../dist/examples/subagents/config.js \
  'Suggest two checks to make before merging a pull request.'
```

The example prints its result and report location, then closes the Run. The [quickstart](docs/en/quickstart.md) runs the Messages SDK handoff and explains its model configuration. For an editable interactive Subagents project, see [project initialization](docs/architecture/07-run-configuration.md#project-initialization-and-interactive-entry).

### Build with the SDK

The package is currently an installable **private candidate** (`@murm/core` 0.2.0). Build an archive from the checkout:

```sh
npm ci
npm pack
```

`npm pack` runs the build and produces `murm-core-0.2.0.tgz`. Install that archive into your TypeScript application; this workflow does not require a public npm registry release:

```sh
npm install --save-exact /absolute/path/to/murm-core-0.2.0.tgz
```

One package provides three primary import paths:

| Import | Use it to |
| --- | --- |
| `@murm/core` | Create a Runtime, configure typed Profiles, control Agents, observe execution and finalize a Run. |
| `@murm/core/services` | Register Services and connect in-process or HTTP JSON adapters. |
| `@murm/core/backends/opensandbox` | Configure OpenSandbox, select Pi or Codex, and inspect executor capabilities. |

`@murm/core/backends/pi-opensandbox` remains a Pi-only compatibility entry. These are subpaths of the same package, with a single version and installation.

The [SDK guide](docs/en/sdk.md) follows a complete two-Agent Messages handoff. Its [TypeScript example](examples/bridge-services/README.md#run-the-typescript-handoff) runs from both the checkout and an independently installed archive. It registers a Service, starts a writer and reader, observes Service calls and execution settlement, verifies the exported file, and saves the finalization report. It also demonstrates connecting an existing HTTP Service while keeping its credential on the host.

## Choose a collaboration mechanism

The repository includes five substantial Harnesses. They share the Runtime but make different choices about ownership, communication and durable results.

| Harness | How Agents coordinate | Start here |
| --- | --- | --- |
| Subagents | A parent creates and directs children through a scoped Service; Pi can fork conversation context. | [Guide](docs/en/harnesses/subagents.md) · [Example](examples/subagents/README.md) |
| TaskPool | Agents exclusively take Tasks and publish Materials and Workspace revisions toward a shared Mission. | [Guide](docs/en/harnesses/taskpool.md) · [TaskPool benchmark](benchmarks/putnambench-taskpool/README.md) |
| PeerMesh | Peers use Git, messages and a shared Board, each with its own identity and branch. | [Guide](docs/en/harnesses/peermesh.md) · [Example](examples/peermesh/README.md) |
| Substrate | A fixed peer pool publishes, searches, reads and cites durable contributions. | [Guide](docs/en/harnesses/substrate.md) · [Example](examples/substrate/README.md) |
| Lead-Worker | A lead and fixed helpers coordinate through a Board and retain deliveries in Git. | [Guide](docs/en/harnesses/lead-worker.md) · [Example](examples/lead-worker/README.md) |

These are repository implementations and examples, not additional package exports. The [mechanism comparison](docs/en/harnesses/index.md) explains their boundaries. The smaller [Messages](examples/bridge-services/README.md) and [Notes](examples/notes/README.md) examples are useful starting points for a new Service.

## What the Runtime guarantees

Each Agent has its own Sandbox and persistent Session, with a private working directory by default. A Harness can explicitly select a shared workspace. Profiles and the Service registry are captured when the Runtime is created. A settled Agent remains available and occupies its Slot until cleanup completes.

Input submission and task success are separate observations. `send()` returns an admission receipt; the Harness observes execution and checks its own result. `observe()` provides a snapshot and a cursor-based stream for maintaining a live view. `finalizeRun()` records business outcome, artifact verification and Core cleanup separately. Required export failures retain the affected Sandbox for investigation or retry. See [Run lifecycle](docs/en/run-lifecycle.md) and [API reference](docs/en/reference/api.md).

The supported backend uses same-host, Docker-backed OpenSandbox. Pi and Codex expose different capabilities; query the backend before relying on context fork or a steering mode. [Architecture](docs/en/architecture.md) explains the host, Worker, Bridge and model gateway boundaries.

## Develop murm

Use Node.js 24 for the repository's CI-compatible development environment. The website has its own dependency installation.

```sh
npm ci
npm run typecheck
npm run docs:generate
npm run docs:check
npm test
npm --prefix website ci
BASE_PATH=/murm SITE_URL=https://luna-shi.github.io npm --prefix website run build
```

| Directory | Contents |
| --- | --- |
| `src/core/` | Public SDK, Agent lifecycle, Bridge, observation, finalization and backend integration. |
| `src/harnesses/`, `examples/` | Collaboration policies, runnable hosts and editable SDK examples. |
| `src/runtime/`, `src/task/`, `src/context/`, `src/judge/`, `src/workspace/` | Resource and domain implementations used by the built-in Harnesses. |
| `src/sdk/`, `src/services/` | Internal Service infrastructure and optional integrations. The public Service entry is `@murm/core/services`. |
| `deploy/`, `scripts/` | Worker and Service deployment, setup, CLI entry points and build tools. |
| `docs/en/`, `docs/zh/` | English and Chinese user guides, also rendered by the website. |
| `docs/architecture/` | Current implementation manual, full prompt/API/storage references and source inventory. |
| `website/`, `trace-viewer/` | Static documentation site and the separate Run inspection UI. |
| `benchmarks/`, `test/`, `test-support/` | Opt-in evaluations, regression tests and fixtures. |

Read [AGENTS.md](AGENTS.md) and the [development workflow](docs/workflows/development.md) before making changes. [docs/INDEX.md](docs/INDEX.md) maps maintained documentation. Current behavior belongs in architecture and SDK guides; proposed changes and their acceptance remain attached to the relevant Issue.

## Research and evidence

The [research context](docs/PROJECT.md) describes the questions behind murm. [ProgramBench Pastel](benchmarks/programbench-pastel/README.md) and [PutnamBench TaskPool](benchmarks/putnambench-taskpool/README.md) document included evaluation drivers. [Experiment reports](docs/experiments/INDEX.md) preserve observations tied to their original code, model and inputs; they do not establish every later revision's behavior or performance.

## License

murm's original code and documentation use the [MIT License](LICENSE). Third-party material retains its own terms. See [third-party notices](docs/third-party-notices.md).
