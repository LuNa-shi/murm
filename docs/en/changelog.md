---
title: Changelog
description: Release history for @luna-shi/murm, covering v0.2.0 and earlier milestones.
section: RELEASES
order: 16
---

All notable changes to **murm** (`@luna-shi/murm`) are tracked here and in the repository's [`CHANGELOG.md`](../../CHANGELOG.md). For an overview of everything available in the current release, see [Latest (v0.2.0)](latest.md).

## Unreleased

- Runtime accepts image-installed executor adapters and verified Pi version selections. Worker images install the selected executable. Pi also supports Chat Completions and the Host accepts trusted transports. Separate project file budgets and disk-backed transfer support larger directory inputs.
- Linux setup can connect to an authenticated OpenSandbox service or prepare a local service before the Worker. The API policy is the default. The strict local policy retains explicitly configured workspace quotas and network rules.
- The SDK accepts an external Sandbox Provider through `createSandbox`. Setup, doctor and built-in configurations share connection defaults. The infrastructure probe supports Pi and Codex.

## v0.2.0 — 2026-11-27

[GitHub Release](https://github.com/LuNa-shi/murm/releases/tag/v0.2.0) · [SHA256SUMS](https://github.com/LuNa-shi/murm/releases/download/v0.2.0/SHA256SUMS) · `ghcr.io/luna-shi/murm-worker:0.2.0`

First public open-source release of `murm` as a single unified TypeScript SDK, CLI, and Trace Viewer package.

### Added

- **Unified `@luna-shi/murm` public SDK**: Narrow root entry exporting `createRuntime`, `createSandbox`, `DEFAULT_WORKER_IMAGE`, `getExecutorCapabilities`, `ServiceRegistry`, `createInProcessAdapter`, and `createHttpJsonAdapter` with full TypeScript declarations ([SDK Guide](sdk.md)).
- **Live observation & runtime management**: `runtime.onEvent` real-time stream (`output`, `settled`, `error`, `exit`, `agentChanged`, `runtimeChanged`, `management`), live `runtime.profiles` / `runtime.services` / `runtime.access` management APIs, and `runtime.files` (`snapshot` / `replace` with SHA-256 digest CAS).
- **Dual executors & open Pi model catalog**: Supports **Pi (`1.3.0`)** (with session `forkFrom` context forking) and **Codex CLI (`0.172.0`)** behind the host Model Gateway. Pi ships a built-in `openai` Responses catalog (`gpt-5.4`, `gpt-5`, `gpt-5-mini`, `gpt-4.1`, `gpt-4.1-mini`, `o4-mini`) and accepts any custom streaming OpenAI Responses-compatible `provider` + `model` via host-synthesized, SHA-256-attested catalogs.
- **Unified host CLI (`murm`)**:
  - `murm --harness <builtin|file|pkg> --prompt <text>` (foreground and JSONL `--mode rpc`)
  - `murm setup` (transparent host preflight, local OpenSandbox `release-1.2.0` container, GHCR-first Worker image pull with local Dockerfile build fallback, and live loopback smoke probe)
  - `murm doctor [--config <config.js>] [--smoke]`
  - `murm init --template subagents --dir <directory>`
- **Built-in Trace Viewer (`murm trace`)**: Folded directly into `src/trace-viewer/` inside `@luna-shi/murm` with zero extra dependencies — swimlane timeline, collaboration handoff links, model/service/session inspectors, resumable SSE live tailing, and automatic SSH forwarding hints.
- **Five reference Harnesses**: `Subagents`, `TaskPool`, `PeerMesh`, `Substrate`, and `Lead-Worker` built on the shared Runtime ([Choose a Harness](harnesses/index.md)).
- **Public distribution & release automation**:
  - One-line CLI installer hosted on GitHub Pages (`https://luna-shi.github.io/murm/install.sh`)
  - Versioned (`luna-shi-murm-0.2.0.tgz`), latest (`luna-shi-murm.tgz`), and `SHA256SUMS` GitHub Release assets
  - Multi-arch (`linux/amd64`, `linux/arm64`) prebuilt Worker image at `ghcr.io/luna-shi/murm-worker:0.2.0`
  - Bilingual EN/ZH Astro documentation site deployed to GitHub Pages

### Changed

- Renamed package from `@murm/core` to `@luna-shi/murm` and merged the standalone Trace Viewer package into `@luna-shi/murm` (eliminating global `murm` binary collisions).
- Built-in CLI Harnesses (`subagents`, `taskpool`, `notes`, `messages`) now default to `DEFAULT_WORKER_IMAGE` and accept unified `MURM_MODEL_*` / `MURM_WORKER_IMAGE` environment variables alongside per-Harness overrides.
- Rewrote EN/ZH [Quickstart](quickstart.md) and [SDK](sdk.md) guides with transparent Linux host prerequisites (Landlock ABI 5+, rootful Docker Engine, host utilities, least-privilege `sudoers`) and self-contained TypeScript SDK examples.

### Security & Isolation

- Same-host Linux Docker isolation with per-sandbox `tmpfs` byte/inode quotas, Landlock ABI 5+ filesystem policy (`agent-filesystem-policy`), and per-UID `nftables` egress rules permitting only the host Bridge and Model Gateway.
- Revocable per-Agent gateway tokens; upstream model API keys and external Service credentials stay on the trusted host.

---

## v0.1.2 — 2026-11-12

[GitHub Tag](https://github.com/LuNa-shi/murm/releases/tag/v0.1.2)

- Mission-scoped flat Task flow with exclusive leases, fencing versions, Material publication, immutable Mission Workspace Git revisions, and centralized Judge checking.
- Independent Service peer hosts and durable SQLite ledgers.

---

## v0.1.0 — 2026-11-11

[GitHub Tag](https://github.com/LuNa-shi/murm/releases/tag/v0.1.0)

- Initial SwarmEnv real-Agent acceptance milestone running isolated Pi Agents on OpenSandbox.
