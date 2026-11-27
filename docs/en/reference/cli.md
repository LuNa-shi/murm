---
title: CLI Reference
description: Complete command reference for the host murm CLI, unified environment variables, in-container swarm CLI, and repository foreground runners.
section: REFERENCE
order: 16
---

`@luna-shi/murm` ships two binaries: **`murm`** (run on the trusted Linux host) and **`swarm`** (preinstalled inside Worker containers so Agents can call Services over the Bridge).

## Host CLI (`murm`)

### Commands overview

| Command | Purpose |
| --- | --- |
| `murm` | Starts an interactive session in the current murm project directory |
| `murm setup [--mode existing\|local] [--config <module>]` | Starts a managed local OpenSandbox with auto-generated credentials (`--mode local`), or validates an existing service (`--mode existing`), then prepares the selected Worker image |
| `murm doctor [--config <module>] [--smoke]` | Read-only configuration and Lifecycle auth diagnostics; pass `--smoke` for a live Pi/Codex Worker end-to-end probe |
| `murm init --template subagents --dir <directory>` | Scaffolds an editable standalone Subagents project directory |
| `murm --harness <module> --prompt <text> [options]` | Runs a built-in, local ESM, or package Harness in foreground against a project directory |
| `murm --harness <module> --mode rpc [options]` | Runs a Harness over JSONL `stdin`/`stdout` with `ready`, `run`, `status`, and `stop` control |
| `murm trace [--root] <runs-dir> [--port 8787] [--open]` | Starts the built-in browser [Trace Viewer](../trace-viewer.md) on `127.0.0.1` |

### Running Harnesses (`murm --harness`)

```bash
# Foreground run against the current directory
murm --harness subagents --prompt "Fix the parser and add regression tests"

# Explicit target directory, custom config module, and output root
murm --harness taskpool \
  --cwd ./my-project \
  --config ./taskpool.config.mjs \
  --output-dir ./runs \
  --prompt "Resolve all failing unit tests"

# Local custom ESM Harness module
murm --harness ./review-harness.mjs --prompt "Audit error handling"

# JSONL RPC mode (send {"id":"1","operation":"run","input":{"cwd":"...","prompt":"..."}} after ready)
murm --harness subagents --mode rpc --output-dir ./runs
```

- **Built-in Harness names**: `subagents`, `taskpool`, `peermesh`, `substrate`, `lead-worker`, `notes`, `messages`.
- **Module resolution**: pass a built-in name, an explicit `.mjs` / ESM `.js` path, or an installed npm package name (resolved from the invocation directory).
- **RPC protocol (`--mode rpc`)**: emits JSONL frames on `stdout` and diagnostics on `stderr`. Wait for `ready`, send a single `run` request containing `cwd` and `prompt`, and optionally query `status` or trigger `stop` in flight.

## Unified environment variables

Built-in CLI Harnesses (`subagents`, `taskpool`, `notes`, `messages`) share one consistent set of host environment variables (per-Harness overrides such as `MURM_SUBAGENTS_*` continue to take precedence when set):

| Variable | Default | Purpose |
| --- | --- | --- |
| `MURM_MODEL_URL` | *(required)* | Streaming OpenAI Responses-compatible endpoint ending in `/v1/responses` |
| `MURM_MODEL_TOKEN` | *(optional)* | Upstream bearer token kept strictly on the host Model Gateway |
| `MURM_MODEL_PROVIDER` | `openai` | Model provider name for Pi/Codex routing (any custom provider supported) |
| `MURM_MODEL_ID` | `gpt-5.4` *(Pi)* | Model ID sent to the upstream endpoint (required when `MURM_EXECUTOR=codex`) |
| `MURM_EXECUTOR` | `pi` | Executor backend: `pi` or `codex` |
| `MURM_WORKER_IMAGE` | `DEFAULT_WORKER_IMAGE` | Custom Docker Worker image reference (`ghcr.io/luna-shi/murm-worker:0.2.0` by default) |
| `MURM_LIFECYCLE_URL` | `http://127.0.0.1:8080/v1` | Local OpenSandbox Lifecycle API URL |
| `MURM_LIFECYCLE_TOKEN` | *(optional)* | Optional OpenSandbox API key |
| `MURM_ADVERTISE_HOST` | `172.17.0.1` | Container-reachable non-loopback host IPv4 address |
| `MURM_ENDPOINT_HOST` | `127.0.0.1` | Host loopback address used to reach published Sandbox ports |

> `PeerMesh`, `Substrate`, and `Lead-Worker` require additional facility variables (such as Gitea, Mattermost, Board MySQL DSN, or Lean paths). See their individual pages under [Harnesses](../harnesses/index.md).

## Container CLI (`swarm`)

Inside every Sandbox, `swarm` communicates with the host Service Bridge using Core-injected protected environment variables (`MURM_BRIDGE_URL`, `MURM_BRIDGE_TOKEN`, `MURM_BRIDGE_CONTRACT_VERSION=2`):

```bash
# Discover permitted Services and inspect full JSON schemas
swarm service list
swarm service view <service-id> --json

# Invoke a permitted operation (named flags, --input file, or --stdin)
swarm <service> <operation> --input payload.json --request-id <unique-id>
swarm <service> <operation> --stdin --request-id <unique-id>
swarm service invoke <service-id> <operation> --input payload.json --request-id <unique-id>

# Built-in agent Service (when granted in Profile.services.agent)
swarm agent spawn --profile worker --text 'Audit src/parser.ts' --fork true --request-id child-1
swarm agent get <agent-id>
swarm agent send <agent-id> --text 'Focus on error paths' --mode steer --wake-if-idle false --request-id steer-1
swarm agent stop <agent-id> --request-id stop-1
```

### `swarm` exit codes

| Exit code | Meaning |
| --- | --- |
| `0` | Operation succeeded |
| `1` | Transport, Bridge, or Service runtime error |
| `2` | CLI syntax or JSON Schema contract error |
| `3` | Checker completed successfully with a business fail verdict (`fail` / `failed` / `source_failure` / `mathematical_failure` / `incorrect`) |

## Repository foreground runners (from source)

When working directly inside a built `murm` source checkout, two additional developer scripts drive configured `taskpool` or `peermesh` fixtures over JSON-line `stdin` (`status`, `kickoff`, `input`, `wait`, `stop`) and inspect saved reports offline:

```bash
node dist/scripts/run-harness.js --config <host-config.mjs>
node dist/scripts/read-harness-result.js --run-directory <dir> --runtime-id <id>
```

Internal Harness helpers (`src/harnesses/shared/run-input.ts` and `src/harnesses/shared/run-report.ts`) are repository utilities rather than exports of `@luna-shi/murm`.
