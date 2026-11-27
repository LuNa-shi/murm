---
title: Latest (v0.2.0)
description: Complete feature guide for murm v0.2.0 — unified @luna-shi/murm SDK & CLI, dual Pi/Codex executors with open Pi model catalogs, built-in Trace Viewer, and five reference Harnesses.
section: RELEASES
order: 15
badge: v0.2.0
---

**`murm v0.2.0`** (released **2026-11-27**) is the first public open-source release of `@luna-shi/murm` — a unified TypeScript SDK, host CLI, and zero-dependency browser Trace Viewer for building and observing isolated multi-agent Harnesses.

| Release artifact | Reference |
| --- | --- |
| **Version** | `v0.2.0` ([GitHub Release](https://github.com/LuNa-shi/murm/releases/tag/v0.2.0) · [SHA256SUMS](https://github.com/LuNa-shi/murm/releases/download/v0.2.0/SHA256SUMS)) |
| **Package** | `@luna-shi/murm` (single tarball bundling SDK, `murm` CLI, `swarm` CLI, and `murm trace`) |
| **Worker image** | `ghcr.io/luna-shi/murm-worker:0.2.0` (`linux/amd64`, `linux/arm64`, exported as `DEFAULT_WORKER_IMAGE`) |
| **Executors** | Pi `1.3.0` (default) · Codex CLI `0.172.0` |
| **Changelog** | [Full release history](changelog.md) |

## Install or upgrade

Install the global CLI from the latest GitHub Release:

```bash
curl -fsSL https://luna-shi.github.io/murm/install.sh | sh
murm setup
```

Or install directly with npm:

```bash
# Global CLI (tracks latest release)
npm install -g --ignore-scripts --allow-remote=root \
  https://github.com/LuNa-shi/murm/releases/latest/download/luna-shi-murm.tgz

# Project SDK dependency (pinned to v0.2.0)
npm install --ignore-scripts --allow-remote=root \
  https://github.com/LuNa-shi/murm/releases/download/v0.2.0/luna-shi-murm-0.2.0.tgz
```

> With npm 12+, reinstalls from a lockfile containing a GitHub Release tarball URL also require `--allow-remote=root` (for example `npm ci --allow-remote=root`).

## What's included in v0.2.0

### 1. Unified `@luna-shi/murm` TypeScript SDK

One narrow public root entry point exports all seven runtime primitives and their TypeScript declarations:

- `createSandbox` — configures the local-docker OpenSandbox isolation backend (CPU/memory limits, `tmpfs` disk byte/inode quotas, and timeouts).
- `createRuntime` — manages Agent lifecycles (`spawn`, `get`, `list`, `send`, `interrupt`, `stop`, `close`), event streaming, dynamic management, file snapshots, and deterministic cleanup receipts (`StopReceipt`, `CloseReceipt`).
- `DEFAULT_WORKER_IMAGE` — points directly to the matching prebuilt Worker image (`ghcr.io/luna-shi/murm-worker:0.2.0`).
- `getExecutorCapabilities` — inspects executor support for active steering, queued-input cancellation, conditional input, and session context forking.
- `ServiceRegistry`, `createInProcessAdapter`, `createHttpJsonAdapter` — register in-process or external HTTP JSON Services under Service Protocol v2, with per-Profile operation allowlists and `assertAuthorized()` re-checks before side effects.

Key Runtime capabilities shipped in `v0.2.0`:

- **Real-time event stream**: `runtime.onEvent` emits `output`, `settled`, `error`, `exit`, `agentChanged`, `runtimeChanged`, and `management` events.
- **File inspection and CAS replacement**: `runtime.files.snapshot` and `runtime.files.replace` read and atomically replace paused Agent file trees guarded by SHA-256 digests (`complete:sha256:...`).
- **Live runtime management**: `runtime.profiles`, `runtime.services`, `runtime.access`, and `runtime.management.get()` allow adding Profiles, registering or retiring Services, and granting or revoking Agent permissions during a Run under an optional `agentAccessPolicy`.

Read [Runtime](runtime.md), [Services & Permissions](services.md), and [SDK & API Reference](reference/api.md) for signatures and examples.

### 2. Dual Executors & Open Pi Model Catalog

`murm` runs every Agent behind the host **Model Gateway**, keeping upstream API keys on the host and issuing revocable per-Agent bearer tokens to sandboxes:

- **Pi (`1.3.0`, default)** — supports session context forking (`spawn({ forkFrom })`), active steering (`mode: 'steer'`), follow-up queuing, conditional delivery (`wakeIfIdle: false`), and queued-input cancellation.
- **Codex CLI (`0.172.0`)** — selectable per Runtime via `executor: 'codex'` or `MURM_EXECUTOR=codex` over the same Model Gateway and Service Bridge.
- **Open Pi model support** — ships a built-in `openai` Responses catalog (`gpt-5.4`, `gpt-5`, `gpt-5-mini`, `gpt-4.1`, `gpt-4.1-mini`, `o4-mini`) and accepts **any** custom streaming OpenAI Responses-compatible `provider` + `model` pair by synthesizing a host-side, SHA-256-attested catalog for the Worker.

### 3. Host Isolation & Security Boundary

Each Agent executes in an isolated Linux Docker container orchestrated through OpenSandbox (`release-1.2.0`):

- **Filesystem isolation**: Landlock ABI 5+ policy (`agent-filesystem-policy`) + bounded per-sandbox `tmpfs` byte and inode quotas (`mount-agent-workspace.py`).
- **Network isolation**: per-UID `nftables` egress rules restrict container traffic to the host Service Bridge and Model Gateway (plus explicit `Profile.network.allow` entries when configured, such as Gitea for PeerMesh/Lead-Worker).
- **Credential separation**: upstream model API keys and external Service admin tokens never enter Agent containers.

### 4. Unified `murm` CLI & Transparent Setup

The `murm` binary covers setup, diagnostics, project scaffolding, Harness execution, and trace inspection:

| Command | Purpose |
| --- | --- |
| `murm setup` | Verifies Linux/Docker/Landlock/`sudo` prerequisites, starts local OpenSandbox `release-1.2.0`, pulls `ghcr.io/luna-shi/murm-worker:0.2.0` (with local Dockerfile build fallback), and runs a real loopback smoke probe. |
| `murm doctor [--config <file>] [--smoke]` | Runs read-only host and configuration diagnostics (and optional live sandbox smoke test). |
| `murm init --template subagents --dir <dir>` | Scaffolds an editable standalone Subagents Harness project. |
| `murm --harness <builtin\|file\|pkg> --prompt <text>` | Runs a built-in or custom Harness against the current project in foreground or JSONL `--mode rpc`. |
| `murm trace --root <dir> [--port 8787]` | Launches the built-in browser Trace Viewer for saved or in-flight Runs. |

Built-in CLI Harnesses (`subagents`, `taskpool`, `notes`, `messages`) accept unified environment variables: `MURM_MODEL_URL`, `MURM_MODEL_TOKEN`, `MURM_MODEL_PROVIDER`, `MURM_MODEL_ID`, `MURM_EXECUTOR`, and `MURM_WORKER_IMAGE`.

### 5. Built-in Browser Trace Viewer (`murm trace`)

In `v0.2.0`, the Trace Viewer is folded directly into `@luna-shi/murm` (`src/trace-viewer/`) with zero extra dependencies:

- Multi-agent swimlane timeline with clickable collaboration handoff links across Services.
- Inspectors for model exchanges, Service invocations, native Pi/Codex sessions, and exported artifacts.
- Live tailing of active Runs via resumable Server-Sent Events (SSE).
- Automatic `ssh -N -L` port-forwarding instructions when started inside a remote SSH session.

See the [Trace Viewer Guide](../operations/trace-viewer.md).

### 6. Five Reference Harnesses on One Runtime

All five Harnesses share the same Runtime and differ only in coordination rules and Services:

| Harness | Coordination model | Guide |
| --- | --- | --- |
| **Subagents** | Recursive parent/child delegation, optional Pi context forking, non-waking mailbox, and interrupt recovery | [Subagents](harnesses/subagents.md) |
| **TaskPool** | Exclusive leased Tasks with fencing versions, Material lineage, Git Workspace revisions, and centralized Judge checks | [TaskPool](harnesses/taskpool.md) |
| **PeerMesh** | Flat peer engineering team using soft Board claims, Mattermost chat/DMs, and host-verified Gitea PR merges | [PeerMesh](harnesses/peermesh.md) |
| **Substrate** | Equal peer pool publishing, searching, reading, and citing immutable artifacts (including Lean 4 FATE configs) | [Substrate](harnesses/substrate.md) |
| **Lead-Worker** | Static or dynamic Lead delegation over a shared Board with Git delivery retention | [Lead-Worker](harnesses/lead-worker.md) |

Compare them side by side in [Choose a Harness](harnesses/index.md).

## Migrating from v0.1.x

- **Package rename & merge**: Replace `@murm/core` imports with `@luna-shi/murm`. If you previously installed a separate Trace Viewer package, uninstall it — `murm trace` is now bundled inside `@luna-shi/murm`.
- **Default Worker image**: Built-in Harnesses default to `DEFAULT_WORKER_IMAGE` (`ghcr.io/luna-shi/murm-worker:0.2.0`) instead of requiring a locally built `murm-worker:local` image ID. If you maintain a custom Worker image, rebuild it from the `v0.2.0` `deploy/worker/Dockerfile` so the Worker startup contract and Pi model catalog attestation match.
- **Unified environment variables**: `MURM_MODEL_URL`, `MURM_MODEL_TOKEN`, `MURM_MODEL_PROVIDER`, `MURM_MODEL_ID`, `MURM_EXECUTOR`, and `MURM_WORKER_IMAGE` work across `subagents`, `taskpool`, `notes`, and `messages` (per-Harness overrides continue to work where supported).

## Host requirements

The released v0.2.0 OpenSandbox isolation backend requires a single Linux host (`x86_64` or `aarch64`) with **Linux kernel Landlock ABI >= 5**, **Node.js 22.19+**, local **rootful Docker Engine**, host utilities (`python3`, `nftables`, `util-linux`, `coreutils`, `iproute2`), and least-privilege non-interactive `sudo` rules. See the [v0.2.0 Quickstart](https://github.com/LuNa-shi/murm/blob/v0.2.0/docs/en/quickstart.md) for this release’s installation instructions.
