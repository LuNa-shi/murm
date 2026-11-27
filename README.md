<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/murm-logo-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/murm-logo-light.svg" />
  <img alt="murm" src="docs/assets/murm-logo-light.svg" width="210" />
</picture>

<h1>murm</h1>

<p><strong>Build your own multi-agent Harness.</strong></p>

<p>A local-first TypeScript SDK and CLI for running isolated Agents, connecting them to shared Services, and observing checkable multi-agent Runs.</p>

<p>
  <a href="https://github.com/LuNa-shi/murm/releases/tag/v0.2.0"><img alt="Release v0.2.0" src="https://img.shields.io/github/v/release/LuNa-shi/murm?style=flat-square&color=111318" /></a>
  <a href="https://github.com/LuNa-shi/murm/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/LuNa-shi/murm/ci.yml?branch=main&style=flat-square&label=CI" /></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <img alt="Node >= 22.19" src="https://img.shields.io/badge/node-%3E%3D22.19-16a34a?style=flat-square" />
</p>

<p>
  <a href="https://luna-shi.github.io/murm/">Website</a> ·
  <a href="docs/en/quickstart.md">Quickstart</a> ·
  <a href="docs/en/latest.md">What's New (v0.2.0)</a> ·
  <a href="docs/en/changelog.md">Changelog</a> ·
  <a href="docs/en/sdk.md">SDK Guide</a> ·
  <a href="docs/zh/overview.md">中文文档</a>
</p>

</div>

---

`murm` separates **how Agents collaborate** from **how Agents are isolated and supervised**. You write the **Harness** — who starts work, what shared state and Services Agents can call, and what evidence establishes completion. The **Runtime** owns isolated OpenSandbox execution (Pi or Codex), host-gated model access, authenticated Service bridging, live observation, artifact collection, and verified cleanup.

## Why murm

- **One Runtime, any topology** — Swap between recursive Subagents, leased TaskPool, PeerMesh, Substrate, or Lead-Worker without modifying the Runtime.
- **Strict host/sandbox boundary** — Each Agent runs in its own Linux Docker sandbox (OpenSandbox + `tmpfs` disk quota + Landlock ABI 5+ + `nftables` egress policy). Model API keys and external Service tokens stay on the host.
- **Dual executors, open model support** — Runs **Pi (`1.3.0`)** (default, with session context forking and dynamic OpenAI Responses model catalogs) or **Codex CLI (`0.172.0`)** behind the same host Model Gateway.
- **Single unified package** — `@luna-shi/murm` bundles the TypeScript SDK, `murm` CLI, `swarm` container CLI, built-in Harnesses, and the zero-dependency browser Trace Viewer (`murm trace`).

## Quick start

On a Linux host with Node.js 22.19+, rootful Docker Engine, Landlock ABI 5+, and the host isolation utilities (`python3`, `nftables`, `util-linux`, `iproute2`, plus non-interactive `sudo` rules — see [Prerequisites](docs/en/quickstart.md#1-prerequisites-execution-host)):

```sh
# 1. Install the CLI globally from the latest GitHub Release
curl -fsSL https://luna-shi.github.io/murm/install.sh | sh

# 2. Verify host prerequisites, start local OpenSandbox, pull/build the Worker image, and run a smoke probe
murm setup

# 3. Point murm at any streaming OpenAI Responses-compatible endpoint
export MURM_MODEL_URL="https://api.openai.com/v1/responses"
export MURM_MODEL_TOKEN="sk-..."

# 4. Run a built-in Harness against your project
cd my-project
murm --harness subagents --prompt "Fix the parser and add tests"

# 5. Inspect timelines, model exchanges, and artifacts in the built-in Trace Viewer
murm trace --root ./subagents-runs --port 8787
```

To install the CLI directly with npm instead of `install.sh`:

```sh
npm install -g --ignore-scripts --allow-remote=root \
  https://github.com/LuNa-shi/murm/releases/latest/download/luna-shi-murm.tgz
```

For an unpublished revision, [install the candidate from a checkout](docs/en/quickstart.md#install-a-candidate-from-a-checkout) before running `murm setup`.

`Subagents`, `TaskPool`, `Notes`, and `Messages` default to the matching prebuilt Worker image (`ghcr.io/luna-shi/murm-worker:0.2.0`, exported as `DEFAULT_WORKER_IMAGE`). Override it with `MURM_WORKER_IMAGE` when using a custom image. Use `--harness` to select any built-in (`subagents`, `taskpool`, `peermesh`, `substrate`, `lead-worker`, `notes`, `messages`), a local ESM module, or an installed package. In `--mode rpc`, tasks arrive over JSONL with live `status` and `stop` control.

## Build with the TypeScript SDK

Install the versioned `v0.2.0` Release asset in your project:

```sh
npm install --ignore-scripts --allow-remote=root \
  https://github.com/LuNa-shi/murm/releases/download/v0.2.0/luna-shi-murm-0.2.0.tgz
```

Import all seven public runtime exports (`createSandbox`, `createRuntime`, `DEFAULT_WORKER_IMAGE`, `getExecutorCapabilities`, `ServiceRegistry`, `createInProcessAdapter`, `createHttpJsonAdapter`) and all public types from `@luna-shi/murm`.

- Self-contained runnable `handoff.ts`: [Quickstart — Option B](docs/en/quickstart.md#5-option-b-use-the-sdk-in-your-own-typescript-project)
- Observation, file controls, external HTTP Services, and cleanup receipts: [SDK Guide](docs/en/sdk.md)
- Exact signatures and types: [API Reference](docs/en/reference/api.md) · [Types & Source Map](docs/en/reference/types.md)

## Built-in Harnesses

The repository includes five substantial Harnesses sharing the same Runtime with different collaboration policies:

| Harness | How Agents coordinate | Start here |
| --- | --- | --- |
| **Subagents** | A parent creates and directs children through a scoped Service; Pi can fork conversation context. | [Guide](docs/en/harnesses/subagents.md) · [Example](examples/subagents/README.md) |
| **TaskPool** | Agents exclusively claim leased Tasks and publish Materials and Workspace revisions toward a shared Mission. | [Guide](docs/en/harnesses/taskpool.md) · [Example](examples/taskpool/README.md) |
| **PeerMesh** | Peers coordinate with Git, Mattermost messages, and a shared Board, each with its own identity and branch. | [Guide](docs/en/harnesses/peermesh.md) · [Example](examples/peermesh/README.md) |
| **Substrate** | A fixed peer pool publishes, searches, reads, and cites immutable contributions (with optional Lean/FATE checking). | [Guide](docs/en/harnesses/substrate.md) · [Example](examples/substrate/README.md) |
| **Lead-Worker** | A lead and fixed or dynamic helpers coordinate through a Board and retain deliveries in Git. | [Guide](docs/en/harnesses/lead-worker.md) · [Example](examples/lead-worker/README.md) |

Compare mechanisms in [Choose a Harness](docs/en/harnesses/index.md) or write your own in [Build Your Own Harness](docs/en/build-your-harness.md).

## Built-in Trace Viewer

Inspect saved or live Run timelines, Service handoffs, model exchanges, and exported artifacts in a local browser UI bundled inside `@luna-shi/murm` (zero extra dependencies):

```sh
murm trace --root ./subagents-runs --port 8787
```

When started inside an SSH session, `murm trace` prints the matching `ssh -N -L` port-forwarding command automatically. See the [Trace Viewer guide](docs/operations/trace-viewer.md).

## Releases & documentation

- **Latest release (`v0.2.0`)**: [What's New](docs/en/latest.md) · [最新版本特性 (中文)](docs/zh/latest.md) · [GitHub Release](https://github.com/LuNa-shi/murm/releases/tag/v0.2.0)
- **Changelog**: [CHANGELOG.md](CHANGELOG.md) · [Website Changelog](docs/en/changelog.md) · [更新日志 (中文)](docs/zh/changelog.md)
- **Architecture & research**: [Architecture Manual](docs/architecture/INDEX.md) · [Research Context](docs/PROJECT.md) · [ProgramBench Pastel](benchmarks/programbench-pastel/README.md) · [PutnamBench TaskPool](benchmarks/putnambench-taskpool/README.md) · [Experiment Reports](docs/experiments/INDEX.md)

## Contributing & developing from source

```sh
git clone https://github.com/LuNa-shi/murm.git
cd murm
npm ci --ignore-scripts
npm run build
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [Development Workflow](docs/workflows/development.md), and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
