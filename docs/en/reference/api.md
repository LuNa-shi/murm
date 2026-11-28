---
title: SDK & API Reference
description: Complete lookup reference for @luna-shi/murm exports, createSandbox, createRuntime, Agent lifecycle, send/onEvent semantics, runtime.files, Runtime management, Service protocol, and error codes.
section: REFERENCE
order: 15
---

This reference follows the current source implementation of **`@luna-shi/murm`**. Its package version is still `0.2.0`, but the published v0.2.0 artifact predates some APIs listed here. For conceptual guides, start with [Runtime & Agents](../runtime.md) and [Services & Permissions](../services.md); for exact TypeScript declarations, see [Types & Source Map](./types.md); for host and container CLIs, see [CLI Reference](./cli.md).

## Install the SDK

Build a candidate archive using the [current-source Quickstart](../quickstart.md), then install that exact archive in a Node.js 22.19+ project:

```bash
npm install --ignore-scripts /absolute/path/to/luna-shi-murm-0.2.0.tgz
```

For the published release instead, use the [v0.2.0 installation guide](../latest.md) and its [fixed API reference](https://github.com/LuNa-shi/murm/blob/v0.2.0/docs/en/reference/api.md). Keep the package, Worker image and documentation aligned with the source candidate you run.

## Public package exports

All public values and TypeScript types are imported from the single root entry `@luna-shi/murm`:

| Export | Kind | Purpose |
| --- | --- | --- |
| `createSandbox(config)` | Function | Creates a reusable OpenSandbox connection handle or plugs in a custom `{ provider }` `SandboxProvider`. |
| `resolveSandboxConnection(overrides?)` | Function | Resolves Lifecycle URL, local token, and image defaults matching the CLI (use only in trusted host config). |
| `createRuntime(options)` | Async function | Opens a Run control plane (`outputDir/<runtimeId>/`, Service Bridge, Model Gateway) with configurable `executor` and `filePolicy`. |
| `recoverRuntime(options)` | Async function | Reopens a durable Run under verified same-host ownership; supports cleanup-only and dynamic Service restoration. |
| `createPiExecutor({ version })` / `createCodexExecutor({ version })` | Function | Selects a verified built-in executor version (Pi `1.3.0` / `1.4.0`, Codex `0.172.0`); `'pi'` / `'codex'` shorthands remain supported. |
| `createExecutorAdapter(declaration)` / `EXECUTOR_ADAPTER_PROTOCOL` | Function / Constant | Declares an image-installed external executor adapter (`murm-executor-v1`). |
| `DEFAULT_WORKER_IMAGE` / `workerImageFor(selection)` | Constant / Function | Default dual-executor Worker image, or the single-executor Worker image matching a chosen executor. |
| `getExecutorCapabilities(selection)` | Function | Static capability lookup for a configured executor (no network side effects). |
| `ServiceRegistry` | Class | Holds Service registrations passed into `createRuntime()`. |
| `createInProcessAdapter(impl)` | Function | Wraps a host-process `invoke` handler (and optional `exportState`) as a `ServiceAdapter`. |
| `createHttpJsonAdapter(options)` | Function | Wraps an external HTTP JSON Service endpoint with `Idempotency-Key` and optional bearer auth. |
| `Harness`, `HarnessContext`, `HarnessInput`, `HarnessJson` | Types | Describe an ESM project entry, captured input, host callbacks and final result. |
| `ProjectPreflightError`, `projectConfiguration`, `observeProjectRuntime`, `projectResult` | Class / Functions | Normalize trusted configuration, represent rejection before allocation, observe Runtime state and project the saved result. |
| `runInput`, `createInputAdmission`, `runWithReport`, `readHarnessResult`, `createOwnedResources` | Functions | Track an exclusive turn, fence input, save or inspect a report, and reconcile owned resources. |
| `checkGitProject`, `seedTeamRepository`, `seededCheckoutInstruction`, `initializeGitRepository`, `importGitTree`, `commitGitTree`, `isGitTreePath` | Functions | Validate and seed a Git project from a captured FileTree, and describe its initial checkout. |
| `decodeFileTree`, `snapshotFileTree`, `completeFileTreeDigest`, `stableStringify`, `MurmError`, `requestHttp`, `httpClient` | Functions / Class | Work with bounded file bytes and stable digests, retain error codes, or connect to a trusted Service. |

The five [reference Harness applications](../../../examples/README.md) build against this root entry. The [author contract](../../architecture/23-project-harness.md#authoring-an-example) describes lifecycle and file handling. Built-in aliases load the bundled entries.

Runtime assembles its own Bridge, model gateway and built-in `agent` Service. Example-owned in-process Services need no separate container. External collaboration facilities and optional [Mathlib Search](../../../examples/services/mathlib-search/README.md) have explicit example deployment and ownership; SDK registration alone does not start or destroy them. [Deployment guide](../../../deploy/README.md)

## `createSandbox(config)` & `createRuntime(options)`

```ts
import {
  DEFAULT_WORKER_IMAGE,
  ServiceRegistry,
  createRuntime,
  createSandbox,
} from '@luna-shi/murm';

const sandbox = createSandbox(); // setup connection defaults

const runtime = await createRuntime({
  sandbox,
  executor: 'pi', // 'pi' (default) | 'codex' | createPiExecutor(...) | createExecutorAdapter(...)
  connection: { advertiseHost: '172.17.0.1' },
  models: {
    default: {
      provider: 'openai',
      model: 'gpt-5.4',
      // protocol defaults to 'responses'; Pi also supports 'chat-completions' or a custom ModelTransport
      upstream: { url: modelUrl, headers: modelHeaders },
    },
  },
  services: new ServiceRegistry(),
  profiles: {
    reader: { model: 'default', image: DEFAULT_WORKER_IMAGE, writable: false, services: {} },
  },
  maxAgents: 2,
  outputDir: './runs',
});
```

- **`createSandbox`**. Reads setup defaults or accepts explicit `endpoint`, `apiKey`, resources and creation lifetime. A trusted `{ provider }` keeps the custom integration contract. Removed strict quotas and endpoint host rewriting fail before allocation.

- **`connection`**. One `publicUrl` supports a reverse-proxy prefix. `bindHost` and `bindPort` control the listener. `modelGateway` retains `requestTimeoutMs`, `maxOutputTokens` and `maxRequests`.

- **`models`**: defaults to streaming Responses; Pi also supports `protocol: 'chat-completions'` and `capabilities: { contextWindow, maxOutputTokens, tools, reasoning }`; trusted host modules can supply a custom `ModelTransport`. Upstream credentials stay strictly on the host.
- **`filePolicy`**: independently configure `initial`, `snapshot`, `replace`, `export`, and `session` limits (`maxBytes`, `maxFileBytes`, `maxFiles`, `maxEntries`, `timeoutMs`) plus `controllerSpoolBytes` and `workerSpoolBytes`.
- **`getExecutorCapabilities(selection)`**: Pi (`1.3.0` / `1.4.0`) supports `contextFork`, `activeSteer`, `followUp`, and `one-at-a-time`; Codex (`0.172.0`) supports `activeSteer`, `followUp`, and `all` without context forking.

## Agent lifecycle

- **`runtime.spawn({ requestId, profile, parentId?, forkFrom?, writable?, files?, bindings?, secretEnv?, workspace?, collect? })`**: reserves a Slot (up to `maxAgents`), provisions the Sandbox, and resolves to an `idle` `AgentInfo`. Seed private files via `files`, or request a shared workspace from a trusted Provider declaring that capability. `forkFrom` clones live Session context on supported executors (`pi`).
- **`runtime.get(agentId)`** / **`runtime.list({ parentId?, status? })`**: return current `AgentInfo` snapshots.
- **`runtime.state`**: `'open' | 'closing' | 'closed'`.

## Input delivery & live observation

- **`runtime.send(agentId, text, { requestId, mode?, wakeIfIdle?, source?, steeringMode? })`**:
  - Defaults to `mode: 'steer'` and `wakeIfIdle: true`; pass `mode: 'followUp'` to queue work after the current execution.
  - Returns `InputReceipt` (`{ status: 'accepted', disposition: 'started' | 'queued' | 'handled' }` or `{ status: 'unknown' }`), or `{ status: 'not-accepted', reason: 'idle' }` when `wakeIfIdle: false`.
  - Reconcile `unknown` by replaying the exact `requestId` and arguments; changing arguments under the same `requestId` throws `CONFLICT`.
- **`runtime.onEvent(listener)`**: returns an `unsubscribe()` function. Register before `spawn`/`send`, then query `get`/`list`/`state` for initial state. A subscriber with 32 pending async callbacks receives a counted `subscriberGap` after a callback settles. Read current state to resynchronize.
  - Emits `output`, `settled`, `error`, `exit`, `agentChanged`, `runtimeChanged`, and `management`.
  - Events may arrive before `send()` resolves; listener errors are isolated and logged.

## Controlled file primitives (`runtime.files`)

```ts
const original = await runtime.files.snapshot(agentId, { requestId: 'capture-1', paths: ['.'] });
const receipt = await runtime.files.replace(agentId, {
  requestId: 'replace-1',
  expectedDigest: original.digest,
  files: nextTree,
  writable: true,
});
```

- A `FileTree` maps project-relative paths to UTF-8 or base64 regular files with optional `0o644` or `0o755` mode (limits: 10,000 files, 2 MiB per file, 16 MiB total).
- **`snapshot(agentId, { requestId, paths, maxBytes? })`**: `paths: ['.']` produces a `complete:sha256:...` digest; specific subpaths produce a `partial:sha256:...` digest.
- **`replace(agentId, { requestId, expectedDigest, files, writable? })`**: checks the complete digest, pauses writers, atomically installs `files` (including deletions and modes) in the private workspace, optionally upgrades `writable: true`, and preserves the live session. Returns `completed`, `failed` (confirmed rollback), or `unknown` (reconcile with identical arguments).

## Interrupt, stop, and close

- **`runtime.interrupt(agentId, { requestId, timeoutMs? })`**: cancels pending Bridge calls, clears queued inputs (optionally returning `discardedInputHashes`), and aborts active work while keeping container, session, files, and Slot.
- **`runtime.stop(agentId, { timeoutMs? })`**: revokes credentials on entry, confirms executor stop, archives the session, collects declared files, deletes the Sandbox, and frees the Slot. Returns `StopReceipt` separating `execution: 'stopped' | 'unknown'` from `cleanup: 'complete' | 'pending'`.
- **`runtime.close({ timeoutMs? })`**: default timeout `60_000` ms. Stops all Agents, retires dynamic Services, calls `exportState()`, closes host gateways, writes `runtime.json`, and returns `CloseReceipt`. Required export failures retain the Sandbox; retry `stop()` / `close()` on the same Runtime after resolving blockers.

## Runtime management

Update Profiles, Services, and Agent permissions while a Run is open (all mutations require stable `requestId`s):

- **`runtime.profiles`**: `register({ id, requestId, profile, actorId? })`, `get(id)`, `list()` — adds immutable Profiles mid-Run.
- **`runtime.services`**: `register({ requestId, registration, deploymentRef, implementationId, ownership, actorId? })`, `get(id)`, `list()`, `retire({ serviceId, requestId, timeoutMs?, actorId? })` — dynamically mounts Services or drains and retires them.
- **`runtime.access`**: `get(agentId)`, `grant({ agentId, serviceId, operations, requestId, binding? })`, `revoke({ agentId, serviceId, operations, requestId })` — mutates live Agent Service grants (optionally gated by `agentAccessPolicy`).
- **`runtime.management.get()`**: returns the current sequenced snapshot (`{ sequence, profiles, services, access }`). Subscribe via `onEvent` before reading, buffer `management` events with higher `sequence`, and re-read if a sequence gap appears.

## Service protocol & built-in `agent` Service

- **Registration (`ServiceRegistry.registerService`)**: requires `contract_version: '2'`, unique `id` (not reserved `'agent'`), `title`, `purpose`, `provider_version`, `endpoint` (`{ transport: 'in-process' }` or `{ transport: 'http-json', url }`), and non-empty `capabilities`. Schemas compile strictly with Ajv `8.20.0` draft-07 (synchronous, no coercion, no defaults).
- **Invocation (`ServiceAdapter.invoke`)**: receives `{ manifest, capability, input, envelope: { operation_id }, caller: { runtimeId, agentId, profile, binding? }, signal, assertAuthorized }`. Default per-call timeout is `30_000` ms (configurable per capability via `timeout_ms`: `1..86_400_000`).
- **Optional state export (`ServiceAdapter.exportState({ signal })`)**: called once during `runtime.close()` (30-second cap) and written to `service-state.<id>.json`.
- **HTTP JSON wire contract (`createHttpJsonAdapter`)**: POSTs `{ input, envelope, caller }` to `endpoint.url + (capability.path ?? '/v2/' + capability.operation)` with `Content-Type: application/json`, `Idempotency-Key: <operation_id>`, and optional host `Authorization: Bearer <token>`. Remote servers must authenticate this host connection before trusting `caller` and return `{ "ok": true, "result": <json> }` (2 MiB max, redirects disabled).
- **Built-in `agent` Service**: grant explicitly in `Profile.services.agent` — child lifecycle (`['spawn', 'get', 'send', 'stop']`) and optional delegated access (`['access_get', 'grant', 'revoke']`, gated by `agentAccessPolicy`). `spawn` requires target role in `Profile.spawnProfiles` (`fork: true` requires `Profile.allowContextFork: true`); `get`/`send` target self or direct children; `stop` targets direct children only.

For host `murm` commands, container `swarm` commands, and environment variables, see **[CLI Reference](./cli.md)**.

## Error codes & recovery

| Code / status | Meaning | How to handle |
| --- | --- | --- |
| `INVALID_CONTRACT` / `SERVICE_INPUT_INVALID` | Invalid arguments, config, or JSON Schema input | Fix the input or config; the operation did not execute |
| `SERVICE_OUTPUT_INVALID` | Adapter returned JSON violating `output_schema` | For writes, state may already have changed — inspect Service state before retrying |
| `NOT_FOUND` / `NOT_ALLOWED` | Unknown agent/operation, missing Profile grant, fatal fence, or Runtime closing | Check Profile grants and agent status; do not retry unauthorized calls |
| `CONFLICT` | Same `requestId` reused with different arguments, digest/version mismatch, or no free Slot (`maxAgents`) | Use a fresh `requestId` for new parameters, refresh digests, or wait for `stop()` to free a Slot |
| `OPERATION_UNKNOWN` / `status: 'unknown'` from Runtime input | Host wait expired or transport dropped after dispatch | Reconcile by repeating the **exact same `requestId` and arguments** |
| `SERVICE_TIMEOUT` / unknown Service write | The adapter may already have performed its side effect | Retain `operation_id` and reconcile through that Service's own idempotency contract; Registry does not auto-retry writes |
| `cleanup: 'pending'` | Execution stop, session archive, required `collect`, or Sandbox delete incomplete | Inspect `pending[].action` and `errors`, resolve the blocker, and retry `stop()` / `close()` on the same Runtime |

## recoverRuntime and Worker probes

`recoverRuntime(options: RecoverRuntimeOptions): Promise<Runtime>` is a public root export. Options extend `CreateRuntimeOptions` with `runDirectory`, optional `cleanupOnly`, and `restoreService(definition): Promise<ServiceRegistration | undefined>`. Creation options add `persistence: { deploymentId, contract, retainForMs? }` and `operationLimits`. Recovery verifies the original contract and same-host, same-boot ownership.

`runtime.probeWorkerEvent(agentId, { requestId, timeoutMs? })` returns `{ requestId, elapsedMs }` after a correlated Worker event reaches Core. It requires a live Agent and uses the ordinary event ingestion path. See [Runtime recovery](../runtime.md#durable-recovery-and-kubernetes).

## HarnessSession

Create a `HarnessSession` with `createHarnessSession(projectHarness, options)` from the package root. Choose `lifetime`, a resolved `configuration` or `configPath`, `outputRoot` and optional `clientCapabilities.questions`. Use `describe()` to discover the input format, supported lifetimes and Agent controls. Start once with `start({ cwd, prompt }, { requestId })`. Follow `onEvent(handler, { initialSnapshot: true })` or get the current view with `getState()`. Submit supported work with `input(payload, { requestId })` and answer a pending question with `respond(questionId, answer, { requestId })`. Call `stop({ requestId, reason })` and await `completion` to check cleanup and export.

`HarnessRpcClient` takes an existing piped child process, exposes a `ready` promise and implements the same operations over JSONL. The caller manages the process. The [standalone example](../../../examples/harness-session/README.md) shows direct SDK, RPC and terminal clients. See the [Harness lifecycle manual](../../architecture/23-project-harness.md).

### Authoring and compatibility

A default `Harness` receives `HarnessContext`. Return business, artifact and cleanup evidence from `run`. The Session adds Run identity, questions, operations and report-save evidence to `HarnessResult`. The enclosing `runId` and any Core `runtime.id` identify different lifecycles.

- New modules use `inputDescriptor`, `context.registerAgentControls({ runtime })`, `context.runWithRuntime` for owned Runtime work and a single Session, and `runInput` for exclusive Agent turns. Dispatch callbacks receive the original `requestId` and a bounded `operationId` to reuse for native dispatch and receipt lookup.
- `ProjectHarness`, `ProjectHarnessContext`, `ProjectHarnessResult` and `inputDescription` are deprecated compatibility names. They delegate to the same contract. Remove them only in a future announced compatibility revision.
- `projectConfiguration` validates trusted author settings and `ProjectPreflightError` signals rejection before allocation. `observeProjectRuntime` adds business status and receipt lookup to a single Session observation. `projectResult` shares the current cleanup projection for older `runWithReport` callers.
- Use the Host's `reportPath` on a successful save and verify `runId` when reading `project-run.json`. `readHarnessResult` continues to read the older standalone files using a Runtime ID.
