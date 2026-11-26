---
title: System Architecture
description: Trust boundaries, host gateways, container Worker supervision, the five-stage Service Bridge pipeline, and the durable Run archive layout.
section: ARCHITECTURE
order: 3
---

Every `murm` Run enforces one hard trust boundary: the **Trusted Host** runs your Harness, owns all upstream credentials, and writes authoritative logs; **Isolated Sandboxes** run unprivileged Pi agent processes with constrained filesystems and default-deny networking.

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ TRUSTED HOST (Node.js process)                                             │
│                                                                            │
│  [ Your Harness ] ──> [ Core Runtime ] ──> outputDir/<runtimeId>/          │
│     • Control loop        • Agent registry & slots   (runtime.json,        │
│     • Role Profiles       • Input & file ledgers      evidence.jsonl,      │
│     • Custom Services     • Event stream              service-calls.jsonl, │
│          ▲                                            model-trace/)        │
│          │                                                                 │
│  ┌───────┴───────────────────┐      ┌───────────────────────────────────┐  │
│  │ Service Bridge (HTTP)     │      │ Model Gateway (HTTP /v1/responses)│  │
│  │ • Bearer auth -> agentId  │      │ • Per-agent revocable token       │  │
│  │ • Profile.services ACL    │      │ • Injects upstream API keys       │  │
│  │ • Ajv draft-07 validation │      │ • Optional modelAccessPolicy gate │  │
│  └───────────▲───────────────┘      └────────────────▲──────────────────┘  │
└──────────────┼───────────────────────────────────────┼─────────────────────┘
               │ MURM_BRIDGE_URL                       │ Gateway origin
               │ (firewall-allowed IPv4)               │ (firewall-allowed IPv4)
┌──────────────┼───────────────────────────────────────┼─────────────────────┐
│ ISOLATED SANDBOX (OpenSandbox Docker container per Agent)                  │
│              │                                       │                     │
│  [ Root Worker Supervisor ] ── manages ──> [ Unprivileged Pi 1.3.0 ]       │
│   • Stages frozen profile prompt            • Tools: read/write/edit/bash  │
│   • Pauses writers for snapshot/install     • Runs `swarm <svc> <op>`      │
│   • Stops Pi & streams archives on close    • Bounded /workspace/project   │
└────────────────────────────────────────────────────────────────────────────┘
```

## 1. Host vs. Sandbox responsibilities

### Trusted Host
Creating a Runtime via `createRuntime()` initializes three run-scoped subsystems before any container starts:
1. **Model Gateway**: binds one local HTTP listener and SQLite ledger per configured model alias, proxies `/v1/responses` calls to the real upstream provider, and records complete request/response traces.
2. **Service Bridge**: binds a local HTTP server that authenticates container requests, enforces `Profile.services` permissions, validates JSON Schemas, and invokes registered Services.
3. **Backend handle**: binds the single-use `PiOpenSandboxBackend` configuration (local Docker isolation, disk limits, OpenSandbox lifecycle endpoint).

### Isolated Sandboxes
Each `runtime.spawn()` creates one Docker container via OpenSandbox with:
- Dedicated CPU/memory limits (`resourceLimits`) and a bounded project filesystem (`isolation.disk.bytes` and `inodes`).
- Per-agent network firewall rules installed in the container namespace before Pi starts: only the host Service Bridge, host Model Gateway, and explicit non-loopback IPv4 origins in `Profile.network.allow` are reachable (IPv6 and all other destinations are dropped).
- An explicit environment containing only `Profile.env`, `spawn.secretEnv`, and the container's own Bridge/Gateway credentials — the host's `process.env` is never leaked into sandboxes.

## 2. Inside the container: why Worker and Pi are separate

Containers do not run a bare Pi process. A root-owned **Worker** launches and supervises an unprivileged **Pi `1.3.0`** subprocess over JSON-RPC with extensions, skills, prompt templates, and project context files disabled — leaving only Pi's four native local tools (`read`, `write`, `edit`, `bash`).

Separating the supervisor from the agent solves three multi-agent reliability problems:

1. **Guarded file controls**: `runtime.files.prepare`, `grant`, `snapshot`, and `install` run over authenticated Worker management routes (`/core/files/*`). The Worker briefly pauses Agent-UID processes to guarantee consistent reads or atomic workspace swaps without giving Pi extra OS privileges.
2. **Context Fork**: `runtime.spawn({ forkFrom })` asks the source container's Worker for `/core/session/snapshot`, walks the active session ancestry to the latest balanced tool-call/result boundary, scrubs parent credentials, and boots the child with `fork.jsonl` while the parent keeps running undisturbed.
3. **Archive-before-delete teardown**: when `runtime.stop()` runs, the Worker terminates the Pi process group first (freezing disk state) while staying alive to stream `/core/session/archive` and `/core/files/collect` back to the host before the container is deleted.

## 3. How a Service call crosses the Bridge

Inside Bash, an agent runs a command such as:

```bash
swarm notes put --input note-request.json --request-id notes-put
```

The `swarm` CLI reads three protected environment variables injected into the container (`MURM_BRIDGE_URL`, `MURM_BRIDGE_TOKEN`, and `MURM_BRIDGE_CONTRACT_VERSION=2`) and sends a JSON request to the host Bridge:

```json
POST <MURM_BRIDGE_URL>/call
Authorization: Bearer <per-agent-random-token>
Content-Type: application/json

{
  "service_id": "notes",
  "operation": "put",
  "operation_id": "notes-put",
  "payload": {
    "key": "core-service-boundary",
    "text": "{\"baseline\":\"...\",\"source\":\"...\",\"finding\":\"...\"}"
  }
}
```

The Bridge executes a five-stage verified pipeline:

1. **Authentication & liveness check**: validates the bearer token before reading the body (2 MiB limit), resolves `{ runtimeId, agentId, profile, binding? }` from private Runtime state, and confirms the agent is `idle` or `running` without a fatal authority fence.
2. **Profile ACL enforcement**: checks that `Profile.services[service_id]` explicitly includes `operation`. Unauthorized or revoked callers fail immediately with `NOT_ALLOWED`.
3. **Strict input validation**: validates `payload` against `capability.input_schema` using pinned Ajv `8.20.0` (strict synchronous JSON Schema draft-07, no type coercion, no default insertion). Invalid payloads return `SERVICE_INPUT_INVALID` before the adapter ever runs.
4. **Single invocation with live authority hook**: dispatches `adapter.invoke({ manifest, capability, input, envelope, caller, signal, assertAuthorized })` once. There is no automatic write retry — Services own business idempotency via `envelope.operation_id`. Calling `assertAuthorized()` right before committing a write rechecks live Bridge revocation synchronously.
5. **Output validation & trace capture**: validates the returned JSON against `capability.output_schema` (`SERVICE_OUTPUT_INVALID` on violation), returns the result to `swarm`, and records the start/settled rows in `service-calls.jsonl` and lifecycle metadata in `evidence.jsonl`.

### How agents discover their permitted Services

At agent startup, Core stages a frozen system prompt at `/workspace/runtime/profile-prompt.txt` containing:
1. A runtime preamble and `<tools>` overview;
2. A `<services>` section generated directly from the agent's permitted operations in `Profile.services` and the registered manifests (using `swarm <service> <operation>`, or `swarm service invoke <service> <operation>` when an operation name conflicts with a built-in CLI group);
3. Any role-specific instructions from `Profile.prompt`.

Agents can also query their filtered manifest schemas live at any time:

```bash
swarm service list
swarm service view notes --json
swarm notes put --help
```

## 4. Model Gateway path

Every `/v1/responses` request from Pi routes through the host **Model Gateway**:

- **Credentials stay on the host**: upstream URLs and `Authorization` headers live only in `PiOpenSandboxBackendConfig.models`. Containers hold only a per-agent revocable gateway token.
- **Bounded execution & trace capture**: the Gateway enforces `requestTimeoutMs` (default `120_000` ms) and `maxOutputTokens` (default `32_768`, or `null` to preserve provider defaults without a host clamp), plus optional `selectionReasoningEffort: 'low'` for selection-phase permits. Every fresh upstream attempt writes `request.json`, raw streamed `response.txt`, and `result.json` under `model-trace/<attemptId>/`.
- **Optional `modelAccessPolicy` gate**: lease-based harnesses like [TaskPool](../harnesses/taskpool/) supply a synchronous `authorize(caller)` hook returning a `ModelPermit` (`phase`, `deadlineAt`, optional `lease`). If the lease expires or its `fencing_version` changes mid-stream, the Gateway aborts the in-flight response immediately. Harnesses without leases leave `modelAccessPolicy` unset.

## 5. Durable Run directory layout

Core creates `outputDir/<runtimeId>/` with mode `0700` and writes private files with mode `0600`. Registered credentials (sandbox API keys, execd tokens, upstream headers, `secretEnv`, and HTTP adapter tokens) are scrubbed from traces, including across streamed chunks and JSON-escaped strings.

```text
outputDir/<runtimeId>/
├── runtime.json                      # Atomic summary: config, prompt digests, stop/close receipts
├── evidence.jsonl                    # Ordered ledger: spawn, input, event, service, stop, errors
├── service-calls.jsonl               # Full authenticated Service call payloads, results & errors
├── service-state.<serviceId>.json    # Optional snapshots from ServiceAdapter.exportState() on close
├── model-access/                     # Per-model SQLite attempt ledgers (runtime_model_attempts)
├── model-trace/
│   └── <attemptId>/
│       ├── request.json              # Received & forwarded Responses payload + timestamps
│       ├── response.txt              # Raw streamed upstream response body
│       └── result.json               # HTTP/terminal status, failure cause, metered usage
├── <agentId>/
│   ├── session/
│   │   ├── manifest.json             # Original & redacted SHA-256 digests of native Pi logs
│   │   └── files/                    # Native Pi JSONL session files (including pre-compaction)
│   └── artifacts/
│       ├── manifest.json             # Effective collect policy, file sizes, modes, SHA-256s
│       └── files/                    # Exported workspace files (and .git when includeGit: true)
└── harness-report.json               # Written by runWithReport() with independent failure channels
```

Next, follow [Anatomy of a Run](../run-lifecycle/) to see how these components behave across a concrete multi-turn execution.
