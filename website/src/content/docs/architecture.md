---
title: System Architecture
description: Follow the exact trust boundaries, data flows, and request paths connecting the host process, OpenSandbox containers, Worker, Service Bridge, and Model Gateway.
section: ARCHITECTURE
order: 3
---

Every `murm` run operates across two explicit trust boundaries: the **Trusted Host** executes your Harness, holds all upstream secrets, and writes authoritative logs; **Isolated Sandboxes** contain each agent's filesystem, shell execution, and network access.

![murm System Architecture: Trusted Host and Isolated Sandboxes](../../assets/images/architecture-overview.jpg)

## 1. Host vs. Sandbox responsibilities

- **Trusted Host**: runs your **Harness** (host TS logic) and **Runtime**. Creating a Runtime automatically starts two run-scoped local HTTP servers:
  - **Service Bridge**: receives `swarm` CLI requests from containers, verifies identity and schemas, and dispatches to registered Services.
  - **Model Gateway**: proxies `/v1/responses` calls from Pi, injects upstream API keys on the host, enforces timeouts/limits, and records raw traces.
- **Isolated Sandboxes**: each `runtime.spawn()` launches a dedicated Docker container through OpenSandbox with enforced disk quotas and network allowlists, running a **Worker** supervisor alongside the **Pi Agent**.

## 2. Inside the container: why Worker and Agent are separate

Containers do not run a bare Pi process. A lightweight trusted **Worker** launches and supervises an unprivileged Pi subprocess configured with only four local tools (`read`, `write`, `edit`, `bash`).

Separating Worker from Pi solves two practical multi-agent problems:

1. **Controlled file handoffs**: `files.prepare`, `files.grant`, `files.snapshot`, and the guarded install flow execute through the Worker. It can briefly pause active writers, capture a consistent snapshot, or flip directory write permissions without granting Pi extra OS privileges.
2. **Archive-before-delete teardown**: when stopping an agent, the Runtime instructs Worker to terminate Pi first (freezing disk state) while keeping Worker alive to stream the native Pi session and `collect` artifacts back to the host before deleting the container.

## 3. How a Service call crosses the Bridge

When an agent executes `swarm <service> <operation>` inside Bash, the call moves through a five-stage verified pipeline:

![How a Service Call Crosses the Bridge: 5-Step Verified Pipeline](../../assets/images/service-bridge-flow.jpg)

1. **Container command**: `swarm` automatically attaches the container-scoped `MURM_BRIDGE_TOKEN` and posts JSON to the host Service Bridge.
2. **Token & ACL check**: the Bridge resolves the real `agentId` and `profile`, then verifies `Profile.services` permits the requested operation. Unauthorized calls fail immediately with `403 NOT_ALLOWED`.
3. **Strict JSON Schema validation**: `ServiceRegistry` validates inputs against `manifest.input_schema` (draft-07) before business code ever runs.
4. **Trusted caller injection & execution**: the Bridge constructs an unforgeable `caller` (`runtimeId`, `agentId`, `profile`, and optional `binding`) and invokes either the in-process function or remote HTTP Service.
5. **Output validation & trace tape**: responses are checked against `output_schema`, returned to the agent, and durably appended to `service-calls.jsonl`.

### How agents discover available Services

Agents can inspect their permitted capabilities at any time via `swarm service list` and `swarm service view <id>` for full operation schemas.

Core composes the initial system prompt at Agent startup. Core adds a runtime preamble, a `<tools>` section, and a `<services>` section before any `Profile.prompt` role instructions. The Services section shows a CLI command and description for each operation granted by the frozen Profile and registered manifest, plus guidance on requesting help. For an operation that conflicts with a built-in CLI command, the section shows `swarm service invoke <service> <operation>`. Pi provides its four local tool definitions separately.

## 4. Model Gateway path

All `/v1/responses` calls from Pi flow through the host **Model Gateway**:

- **Keys stay on the host**: upstream `Authorization` headers live solely in host configuration; containers never see raw model credentials.
- **Unified limits and recording**: the Gateway enforces per-request timeouts (default 120s) and output caps, saving redacted request/response traces under `model-trace/<attemptId>/`.
- **Optional `modelAccessPolicy` gate**: lease-based harnesses such as [TaskPool](../harnesses/taskpool/) can attach a synchronous authorization hook to abort streaming calls the instant a task lease expires or changes fencing version. Most harnesses (Subagents, PeerMesh, Substrate) leave this unset.

## 5. Durable Run directory layout

Core writes Run records under `outputDir/<runtimeId>/`. It redacts registered credentials in its traces. The records and archived files may still contain private prompts, tool results and project contents. Harnesses that use the reporting helper also save a separate delivery report.

```text
outputDir/<runtimeId>/
├── runtime.json                 # Effective config, stop receipts, cleanup verdict
├── evidence.jsonl               # Ordered lifecycle, input, and event timeline
├── service-calls.jsonl          # Private Service trace, including inputs and results
├── service-state.<id>.json      # Optional per-Service state snapshots on close
├── model-trace/<attemptId>/     # Raw request.json, response.txt, result.json
├── <agentId>/
│   ├── session/                 # Native Pi JSONL conversation archive
│   └── artifacts/files/         # Files exported via Profile/Spawn collect specs
└── harness-report.json      # Harness delivery outcome & independent error slots
```

Next, read [Anatomy of a Run](../run-lifecycle/) to walk through these primitives inside a concrete multi-turn collaboration.
