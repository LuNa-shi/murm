---
title: API & Configuration
description: Complete reference for @murm/core Runtime methods, unified send semantics, file controls, Service protocol v2, the swarm CLI, foreground host CLI, backend config, and error contracts.
section: REFERENCE
order: 12
---

This reference matches **`@murm/core` `0.2.0`** on `main`. See [Types & Source Map](../types/) for the exact TypeScript declarations and source links.

## Package entry points

| Entry point | Public exports | Purpose |
| --- | --- | --- |
| `@murm/core` | `createRuntime`, `finalizeRun` (plus all Core types) | Create, control and finalize a Run |
| `@murm/core/services` | `ServiceRegistry`, `createInProcessAdapter`, `createHttpJsonAdapter`, `builtinAgentRegistration`, `getAdapterMetadata`, `invokeService`, `isJson`, `snapshotServiceRegistry` | Define, validate, and register v2 Services |
| `@murm/core/backends/opensandbox` | `createOpenSandboxBackend`, `getOpenSandboxBackendCapabilities` (plus `OpenSandboxBackendConfig`, `BackendCapabilities`, `ExecutorKind`) | Configure Pi or Codex on OpenSandbox and inspect executor capabilities |
| `@murm/core/backends/pi-opensandbox` | `createPiOpenSandboxBackend` (plus `PiOpenSandboxBackendConfig`) | Configure the Pi `1.3.0` / OpenSandbox container backend |

## Finalize a Run

Import `finalizeRun` from `@murm/core` after classifying the application outcome. Pass the Runtime, the base output directory and a typed `business` outcome. Use `status: 'completed'` with a JSON value, or `status: 'failed'` or `'cancelled'` with an application error code and message. The returned report separately contains `coreClose`, `artifactVerification`, `facilities` and `reportSaveFailure`.

`verifyArtifacts` may inspect the exported artifacts using the Core close receipt. Supply `ownedFacilities` only for facilities this application owns. Their close callbacks run after verification and confirmed Core cleanup. If Core returns a pending receipt, the report carries its pending resource identities and retains the facilities. The cleanup wait has its own `cleanupTimeoutMs` (default 60,000 ms) and the callbacks receive its AbortSignal. If the host wait ends before Core returns a receipt, the close status is `unknown`. Confirmed save returns the path to `outputDir/<runtime.id>/run-finalization.json`.

One call finalizes a Runtime object. A second call fails with `CONFLICT`. For pending work, query the same Runtime using `close` and reconcile the original facility handles.

## `createRuntime(options)`

```ts
createRuntime(options: CreateRuntimeOptions): Promise<Runtime>
```

| Field | Required | Behavior |
| --- | --- | --- |
| `backend` | Yes | Single-use opaque handle from `createPiOpenSandboxBackend()`; claiming it binds it exclusively to this Runtime |
| `profiles` | Yes | Record of role name → `Profile`, deep-copied and frozen at assembly; invalid model aliases, unknown Service operations, or missing `spawnProfiles` fail with `INVALID_CONTRACT` |
| `services` | Yes | Populated `ServiceRegistry` (the ID `agent` is reserved for the built-in Agent Service) |
| `maxAgents` | Yes | Positive safe integer bounding concurrent Agent Slots |
| `outputDir` | Yes | Base output directory; Core writes all run data under `outputDir/<runtime.id>/` |
| `modelAccessPolicy` | No | Synchronous Model Gateway gate (`authorize(caller): ModelPermit \| null`, `withCommit(commit)`) for lease-bounded harnesses like [TaskPool](../../harnesses/taskpool/) |

Assembly uses a fixed 60-second host wait. No Agent sandboxes are allocated during `createRuntime()`.

## Agent lifecycle: `spawn`, `get`, `list`

```ts
runtime.spawn(options: SpawnOptions): Promise<AgentInfo>
runtime.get(agentId: string): Promise<AgentInfo>
runtime.list(filter?: AgentListFilter): Promise<AgentInfo[]>
```

- **`spawn(options)`**: reserves an `agentId` and capacity Slot, creates the container and Pi session, verifies readiness, and resolves in `status: 'idle'` with no initial inference. Replaying the exact same `requestId` and parameters returns the original result; changed parameters throw `CONFLICT`.
  - Supported fields: `requestId`, `profile`, `parentId`, `forkFrom` (live agent in same Runtime), `writable` (overrides `Profile.writable`), `files` (`FileSeed`, max 10,000 files / 2 MiB per file / 16 MiB total), `workspace` (`{ id, mode: 'read-only' | 'read-write' }` or `{ mode: 'frozen-copy', files }`), `bindings`, `secretEnv`, `collect`.
- **`get(agentId)`**: returns an immutable `AgentInfo` snapshot (`id`, `profile`, `parentId?`, `status`, `cursor`, `latestOutput?`, `lastError?`, `lastStop?`). Remains readable after `closed`.
- **`list(filter?)`**: returns snapshots in creation order. Filter by `parentId` (`null` for root agents, or a specific parent ID) and/or `status` (single status or array).
- **Lifecycle states**: `starting` → `idle` ⇄ `running` → `closing` → `closed` (unexpected crash: `exited`). Capacity Slots remain occupied until container deletion confirms `closed`.

## Input delivery & events: `send`, `start`, `steer`, `onEvent`

```ts
runtime.send(agentId: string, input: string, options: SendOptions & { wakeIfIdle?: true }): Promise<InputReceipt>
runtime.send(agentId: string, input: string, options: SendOptions): Promise<ConditionalInputReceipt>

// Convenience aliases over the same host ledger (prefer runtime.send in new Harnesses)
runtime.start(agentId: string, input: string, options: { requestId: string }): Promise<InputReceipt>
runtime.steer(agentId: string, input: string, options: SteerOptions): Promise<InputReceipt>

runtime.onEvent(handler: (event: AgentEvent) => void): () => void
```

| Option | Default | Behavior |
| --- | --- | --- |
| `requestId` | *(required)* | 1–128 identifier chars (`[A-Za-z0-9_.:-]`); deduplicates replays and reconciles `unknown` receipts |
| `mode` | `'steer'` | `'steer'` injects after the current tool batch before the next model request; `'followUp'` queues after the active turn settles |
| `wakeIfIdle` | `true` | `true` wakes an `idle` agent; `false` delivers only while `running`, returning `{ inputId, status: 'not-accepted', reason: 'idle' }` if idle |
| `source` | `'host'` | Optional audit label (1–256 chars) recorded separately from authenticated caller identity |
| `steeringMode` | `'one-at-a-time'` | Valid only with `mode: 'steer'`; `'all'` drains all pending steer inputs together and persists on the Pi session |

- **Receipts**:
  - `{ inputId, status: 'accepted', disposition: 'started' | 'queued' | 'handled' }`
  - `{ inputId, status: 'not-accepted', reason: 'idle' }` *(only when `wakeIfIdle: false`)*
  - `{ inputId, status: 'unknown' }` — reconcile by repeating the exact same `requestId` and payload; Core queries the Worker's saved RPC ledger instead of injecting a duplicate prompt.
If an application timeout or AbortSignal ends the host wait after submission, keep the submitted request ID and arguments. Poll the original receipt with the same `send` call when its result is unknown. Use `interrupt` to interrupt a running turn and `stop` for Agent shutdown. An uncorrelated `settled` event describes the Agent execution. The application verifies business completion separately.

- **Events (`AgentEvent`)** — every event carries `agentId` and monotonic `seq`:
  - `{ type: 'output', text }`
  - `{ type: 'settled', outcome: 'completed' | 'failed' | 'aborted', output?, error? }`
  - `{ type: 'error', error, fatal }` — when `fatal: true`, Core revokes Bridge/model credentials and fences fresh admissions synchronously before subscribers fire.
  - `{ type: 'exit', reason, expected }`

## Controlled file primitives (`runtime.files`)

```ts
runtime.files.prepare(agentId: string, options: { requestId: string; files: FileSeed }): Promise<PreparedFiles>
runtime.files.grant(options: { requestId: string; prepared: PreparedFiles }): Promise<GrantReceipt>
runtime.files.snapshot(agentId: string, options: { requestId: string; paths: readonly string[]; includeGit?: boolean; maxBytes?: number }): Promise<FileSnapshot>
runtime.files.install(agentId: string, options: { requestId: string; expected: FileSnapshot; files: FileSeed }): Promise<FileInstall>
runtime.files.installStatus(agentId: string, options: { requestId: string }): Promise<FileInstall | null>
runtime.files.confirm(agentId: string, options: { requestId: string }): Promise<FileInstall>
```

- **`prepare` + `grant`**: installs an immutable `FileSeed` into an empty read-only workspace and returns a frozen `PreparedFiles` handle (`agentId`, `version`, `digest`). Passing that exact in-memory object to `grant()` unlocks write access.
- **`snapshot`**: Worker pauses project writers (all owners for shared mounts) and returns `{ agentId, requestId, version, digest, files }` up to 16 MiB (`includeGit` is opt-in).
- **`install` + `confirm`**: replaces a live writable private workspace only if full-tree bytes and modes still match `expected: FileSnapshot`, holding writers paused until `confirm()` commits and resumes them. Use `installStatus()` to check a cached receipt without starting a new operation.
- **`collect`**: configured on `Profile.collect` or overridden at `spawn({ collect })`: `{ paths, includeGit, allowMissingGit?, maxBytes, required }`. When `required: true`, failed export keeps the sandbox alive and returns `cleanup: 'pending'`.

## Interrupt, stop, and close

```ts
runtime.interrupt(agentId: string, options: { requestId: string; timeoutMs?: number }): Promise<InterruptReceipt>
runtime.stop(agentId: string, options?: { timeoutMs?: number }): Promise<StopReceipt>
runtime.close(options?: { timeoutMs?: number }): Promise<CloseReceipt>
```

- **`interrupt`**: advances the execution epoch, cancels pending Bridge calls for that agent, clears Pi input queues, aborts active execution, and returns `{ interruptId, status: 'interrupted' | 'unknown', discardedInputHashes? }` while keeping the container, session, files, and Slot intact.
- **`stop` / `close`**: runs strictly in order — **stop Pi execution → archive native session → export `collect` files → delete sandbox & free Slot** (`close()` also shuts down Bridge/Gateway, runs optional `exportState()`, flushes logs, and atomically writes `runtime.json`). Both default to `timeoutMs: 60_000`. Retries skip completed stages.

## Service protocol v2 & built-in `agent` Service

- **Registration (`ServiceRegistry.registerService`)**: requires `contract_version: '2'`, unique `id` (not reserved `'agent'`), `title`, `purpose`, `provider_version`, `endpoint` (`{ transport: 'in-process' }` or `{ transport: 'http-json', url }`), and non-empty `capabilities`. Schemas compile strictly with Ajv `8.20.0` draft-07 (synchronous, no coercion, no defaults).
- **Invocation (`ServiceAdapter.invoke`)**: receives `{ manifest, capability, input, envelope: { operation_id }, caller: { runtimeId, agentId, profile, binding? }, signal, assertAuthorized }`. Default per-call timeout is `30_000` ms (configurable per capability via `timeout_ms`: `1..86_400_000`).
- **Optional state export (`ServiceAdapter.exportState({ signal })`)**: called once during `runtime.close()` (30-second cap) and written to `service-state.<id>.json`.
- **HTTP JSON wire contract (`createHttpJsonAdapter`)**: POSTs `{ input, envelope, caller }` to `endpoint.url + (capability.path ?? '/v2/' + capability.operation)` with headers `Content-Type: application/json`, `Idempotency-Key: <operation_id>`, and optional host `Authorization: Bearer <token>`. Must return `{ "ok": true, "result": <json> }` (2 MiB max, redirects disabled).
- **Built-in `agent` Service**: grant operations explicitly via `Profile.services.agent` (`['spawn', 'get', 'send', 'stop']`).
  - `spawn` requires target role in `Profile.spawnProfiles`; `fork: true` requires `Profile.allowContextFork: true`.
  - `get` and `send` target the caller itself or a direct child; `stop` targets only a direct child.

## `swarm` CLI (inside containers)

The `swarm` binary (`dist/scripts/swarm.js`) runs inside containers over `MURM_BRIDGE_URL`, `MURM_BRIDGE_TOKEN`, and `MURM_BRIDGE_CONTRACT_VERSION=2` (all injected and protected by Core):

```bash
# Discover permitted services and full schemas
swarm service list
swarm service view <service-id> --json

# Invoke any registered service operation
swarm <service> <operation> --input payload.json --request-id <unique-id>
swarm <service> <operation> --stdin --request-id <unique-id>
swarm service invoke <service-id> <operation> --input payload.json --request-id <unique-id>

# Built-in agent control (when granted in Profile.services.agent)
swarm agent spawn --profile worker --text 'Audit src/parser.ts' --fork true --request-id child-1
swarm agent get <agent-id>
swarm agent send <agent-id> --text 'Focus on error paths' --mode steer --wake-if-idle false --request-id steer-1
swarm agent stop <agent-id> --request-id stop-1
```

**CLI exit codes**: `0` success, `1` transport/service error, `2` CLI/contract argument error, `3` checker completed successfully with a business fail verdict (`fail` / `failed` / `source_failure` / `mathematical_failure` / `incorrect`).

## Host utilities & foreground CLI

- **`src/harnesses/shared/run-input.ts`** (`runInput`): single-source exclusive turn helper (verifies `idle`, subscribes before sending, resolves on `'started'` + matching `settled`).
- **`src/harnesses/shared/run-report.ts`** (`runWithReport`): runs `createRuntime` → `run` → bounded `close` → optional `afterClose`, preserving independent `businessFailure`, `cleanupFailure`, and `reportSaveFailure` slots in `harness-report.json`.
- **Foreground host CLI (`scripts/run-harness.ts` & `scripts/read-harness-result.ts`)**: drives configured `taskpool` or `peermesh` harnesses over JSON-line `stdin` (`status`, `kickoff`, `input`, `wait`, `stop`) and inspects saved `runtime.json` + `harness-report.json` offline:

```bash
node dist/scripts/run-harness.js --config <host-config.mjs>
node dist/scripts/read-harness-result.js --run-directory <dir> --runtime-id <id>
```

## Pi/OpenSandbox backend config

```ts
import { createPiOpenSandboxBackend } from '@murm/core/backends/pi-opensandbox';

const backend = createPiOpenSandboxBackend({
  sandbox: {
    lifecycleBaseUrl: 'http://127.0.0.1:8080/v1',
    endpointHost: '127.0.0.1',
    apiKey: process.env.OPEN_SANDBOX_API_KEY,
    resourceLimits: { cpu: '1', memory: '1Gi' },
    commandTimeoutMs: 20_000,
    timeoutSeconds: 3600, // optional; safe integer >= 60, default 3600
  },
  bridge: {
    host: '0.0.0.0',
    publicUrl: 'http://172.17.0.1:{port}', // non-loopback IPv4 reachable from containers
  },
  modelGateway: {
    host: '0.0.0.0',
    advertiseHost: '172.17.0.1',
    requestTimeoutMs: 120_000, // default 120_000
    maxOutputTokens: null,     // safe integer >= 16, default 32_768, or null for provider default
    selectionReasoningEffort: 'low', // optional; applies during selection phase permits
  },
  models: {
    default: {
      provider: 'kimi_proxy',
      model: 'k3',
      upstream: {
        url: 'https://your-model-endpoint/v1/responses',
        headers: { authorization: `Bearer ${process.env.MODEL_TOKEN}` },
      },
    },
  },
  isolation: {
    network: 'local-docker',
    disk: { bytes: 64 * 1024 ** 2, inodes: 4096 },
  },
});
```

## Error codes & recovery

| Code / status | Meaning | How to handle |
| --- | --- | --- |
| `INVALID_CONTRACT` / `SERVICE_INPUT_INVALID` | Invalid arguments, config, or JSON Schema input | Fix the input or config; the operation did not execute |
| `SERVICE_OUTPUT_INVALID` | Adapter returned JSON violating `output_schema` | For writes, state may already have changed — inspect Service state before retrying |
| `NOT_FOUND` / `NOT_ALLOWED` | Unknown agent/operation, missing Profile grant, fatal fence, or Runtime closing | Check Profile grants and agent status; do not retry unauthorized calls |
| `CONFLICT` | Same `requestId` reused with different arguments, version mismatch, or no free Slot (`maxAgents`) | Use a fresh `requestId` for new parameters, or wait for `stop()` to free a Slot |
| `OPERATION_UNKNOWN` / `SERVICE_TIMEOUT` / `status: 'unknown'` | Host wait expired or transport dropped after dispatch | Reconcile by repeating the **exact same `requestId` and payload** |
| `cleanup: 'pending'` | Execution stop, session archive, required `collect`, or sandbox delete incomplete | Inspect `pending[].action` and `errors`, fix the cause, and call `stop()` / `close()` again |
