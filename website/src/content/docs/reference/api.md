---
title: API & Configuration
description: Reference for Runtime methods, unified send semantics, file control, Service protocol v2, the swarm CLI, backend config, and error contracts.
section: REFERENCE
order: 12
---

This reference matches `@swarmenv/core` `0.2.0` at commit [`ac72c76`](https://github.com/LuNa-shi/SwarmEnv/commit/ac72c76). See [Types & Mapping](../types/) for complete TypeScript declarations.

## Package entrypoints

| Entrypoint | Exports | Purpose |
| --- | --- | --- |
| `@swarmenv/core` | `createRuntime` | Create a Runtime instance for one Run |
| `@swarmenv/core/services` | `ServiceRegistry`, `createInProcessAdapter`, `createHttpJsonAdapter`, `builtinBotRegistration`, `getAdapterMetadata`, `invokeService`, `isJson`, `snapshotServiceRegistry` | Register and invoke Services |
| `@swarmenv/core/backends/pi-opensandbox` | `createPiOpenSandboxBackend` | Configure the Pi/OpenSandbox execution backend |

## `createRuntime(options)`

```ts
createRuntime(options: CreateRuntimeOptions): Promise<Runtime>
```

- `backend`: single-use backend handle from `createPiOpenSandboxBackend()` (cannot be shared across multiple Runtimes).
- `profiles`: map of role name → `Profile`, frozen on creation; unknown model aliases or Service operations fail immediately.
- `services`: populated `ServiceRegistry` (ID `bot` is reserved for the built-in bot Service).
- `maxBots`: positive integer bounding concurrent resource slots.
- `outputDir`: root directory; run artifacts are written to `outputDir/<runtime.id>/`.
- `modelAccessPolicy` *(optional)*: synchronous Model Gateway hook (`authorize(caller): ModelPermit | null`, `withCommit(commit)`) for lease-gated harnesses such as [TaskPool](../../harnesses/taskpool/).

## Agent lifecycle: `spawn`, `get`, `list`

```ts
runtime.spawn(options: SpawnOptions): Promise<BotInfo>
runtime.get(botId: string): Promise<BotInfo>
runtime.list(filter?: BotListFilter): Promise<BotInfo[]>
```

- `spawn` registers identity, claims a capacity slot, boots the container and Pi session, and resolves in `status: 'idle'` without starting inference.
- Options: `requestId` (idempotency key), `profile`, `parentId`, `forkFrom` (copies native session prefix from an active agent in the same Runtime), `writable`, `files`, `workspace` (`frozen-copy` or shared `{ id, mode: 'read-only' | 'read-write' }`), `bindings`, `secretEnv`, `collect`.
- `list` filters by `parentId` (omitted / `null` for root agents / specific ID) and `status`.
- **States**: `starting` → `idle` ⇄ `running` → `closing` → `closed` (unexpected crash: `exited`). Slots stay occupied through `idle`, `exited`, and `closing` until container deletion finishes in `closed`.

## Input delivery & events: `send` (recommended), `start`, `steer`, `onEvent`

```ts
runtime.send(botId: string, input: string, options: SendOptions & { wakeIfIdle?: true }): Promise<InputReceipt>
runtime.send(botId: string, input: string, options: SendOptions): Promise<ConditionalInputReceipt>

// Convenience aliases (prefer unified send in new Harnesses)
runtime.start(botId: string, input: string, options: { requestId: string }): Promise<InputReceipt>
runtime.steer(botId: string, input: string, options: SteerOptions): Promise<InputReceipt>

runtime.onEvent(handler: (event: BotEvent) => void): () => void
```

| Option | Default | Behavior |
| --- | --- | --- |
| `mode` | `'steer'` | `'steer'` injects after the current tool batch before the next model call; `'followUp'` queues after the active turn settles |
| `wakeIfIdle` | `true` | `true` wakes an idle agent; `false` delivers only while `running`, returning `{ inputId, status: 'not-accepted', reason: 'idle' }` when idle |
| `source` | caller | Non-empty host label (up to 256 chars) recorded in logs |
| `steeringMode` | `'one-at-a-time'` | `'all'` drains all pending steer items at once; persists on the Pi session |

- **Receipts**: `accepted` (`disposition: 'started' | 'queued' | 'handled'`), `not-accepted` (`reason: 'idle'`), or `unknown` (reconcile with the exact same `requestId` and payload).
- **Events** (each carries `botId` and monotonic `seq`): `output`, `settled` (`outcome: 'completed' | 'failed' | 'aborted'`), `error` (`fatal`), `exit` (`expected`).

## Controlled file primitives

```ts
runtime.files.prepare(botId: string, options: { requestId: string; files: FileSeed }): Promise<PreparedFiles>
runtime.files.grant(options: { requestId: string; prepared: PreparedFiles }): Promise<GrantReceipt>
runtime.files.snapshot(botId: string, options: { requestId: string; paths: readonly string[]; includeGit?: boolean; maxBytes?: number }): Promise<FileSnapshot>
```

- **`prepare` + `grant`**: stages files into an empty read-only workspace and issues a trusted `PreparedFiles` handle; pass that exact in-memory object to `grant` to unlock write access.
- **`snapshot`**: pauses active writers (including shared-workspace peers) via Worker to return a consistent `{ version, digest, files }` snapshot (up to 16 MiB).
- **`collect`**: `{ paths, includeGit, maxBytes, required }`. Failing a `required: true` export or session archive preserves the container and returns `cleanup: 'pending'`.

## Interrupt, stop, and close

```ts
runtime.interrupt(botId: string, options: { requestId: string; timeoutMs?: number }): Promise<InterruptReceipt>
runtime.stop(botId: string, options?: { timeoutMs?: number }): Promise<StopReceipt>
runtime.close(options?: { timeoutMs?: number }): Promise<CloseReceipt>
```

- **`interrupt`**: cancels in-flight Bridge calls, aborts active execution, flushes pending inputs, and returns **`discardedInputHashes`** (SHA-256 digests) while keeping session, workspace, and slot intact.
- **`stop` / `close`**: runs strictly in order — **stop execution → archive session → collect files → delete sandbox & free slot**. Reports `execution: 'stopped' | 'unknown'` and `cleanup: 'complete' | 'pending'`; retries resume incomplete steps.

## Service protocol v2 & `swarm` CLI

- **Manifest v2** (`contract_version: '2'`): declares `id`, `title`, `purpose`, `endpoint` (`in-process` or `http-json`), and `capabilities` (`side_effect`, `idempotent`, draft-07 `input_schema`/`output_schema`, `errors`, `timeout_ms` default 30s).
- **`ServiceRequest`**: passes validated `input`, `envelope.operation_id`, unforgeable `caller` (`{ runtimeId, botId, profile, binding? }`), `signal`, and `assertAuthorized()`.
- **Optional `exportState({ signal })`**: called on `runtime.close()` (30s cap) and persisted to `service-state.<id>.json`.
- **HTTP Services**: POST to `endpoint.url + (capability.path ?? '/v2/' + operation)` with `idempotency-key` and optional Bearer token; response must be `{ ok: true, result }` (2 MiB cap, redirects disabled).
- **Built-in `bot` Service** (when authorized in `Profile.services.bot`): `spawn`, `get`, `send` (supports `mode` & `wake_if_idle`), `stop` (direct children only).

```bash
swarm service list
swarm service view <service-id>
swarm <service> <operation> --input payload.json --request-id <unique-id>
```

## Pi/OpenSandbox backend config

| Section | Required Fields | Notes |
| --- | --- | --- |
| `sandbox` | `lifecycleBaseUrl` | Optional `apiKey`, `execdToken`, `endpointHost`, `resourceLimits`, `commandTimeoutMs`, `timeoutSeconds` (default 3600, min 60) |
| `bridge` | `host`, `publicUrl` | `publicUrl` must contain `{port}` and a non-loopback IPv4 reachable from containers |
| `modelGateway` | `host`, `advertiseHost` | Optional `requestTimeoutMs` (default 120s), `maxOutputTokens` (default 32,768; `null` for unlimited) |
| `models` | Alias map | Each entry needs `provider`, `model`, `upstream: { url, headers }` (`url` must end with `/v1/responses`) |
| `isolation` | `network: 'local-docker'`, `disk: { bytes, inodes }` | Mandatory local Docker network and disk quotas |

## Error codes

| Code / Status | Meaning & Recovery |
| --- | --- |
| `INVALID_CONTRACT` / `SERVICE_INPUT_INVALID` | Contract, schema, or config mismatch; fix inputs and resubmit |
| `NOT_FOUND` / `NOT_ALLOWED` | Unknown target, missing Profile permission, or Runtime closing |
| `CONFLICT` | Same `requestId` reused with different arguments, or version/slot conflict |
| `OPERATION_UNKNOWN` / `SERVICE_TIMEOUT` / `status: 'unknown'` | Outcome uncertain; reconcile with the exact same `requestId` and payload |
| `cleanup: 'pending'` | Inspect `pending[].action` and `error`, resolve, and call `stop()` / `close()` again |
