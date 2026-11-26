---
title: API & Configuration
description: Complete reference for @murm/core Runtime methods, unified send semantics, file controls, Service protocol v2, the swarm CLI, foreground host CLI, backend config, and error contracts.
section: REFERENCE
order: 12
---

This reference describes the public interfaces of **`@murm/core` `0.2.0`** in the current source tree. Start with [Use the TypeScript SDK](../sdk.md) for installation and a complete runnable example; use [Types & Source Map](./types.md) to look up declarations.

## Package entry points

Import all public types and the six runtime values from `@murm/core`. The values are `createSandbox`, `createRuntime`, `getExecutorCapabilities`, `ServiceRegistry`, `createInProcessAdapter`, `createHttpJsonAdapter`.

## Runtime management

Use `runtime.profiles.register/get/list` for immutable Profiles and `runtime.services.register/get/list/retire` for the Service directory. Use `runtime.access.get/grant/revoke` to change an existing Agent's operation permissions. Mutations use stable request IDs. Service retirement closes admission, waits for authorized work to drain, and reports its current state. The application owns deployment and external facility cleanup.

Subscribe with `onEvent` before reading `runtime.management.get()`. Buffer management changes during the read, then apply the changes newer than the returned management `sequence`. Re-read if a sequence is missing. The same root entry exports the management request, receipt, snapshot and event types. See [Runtime management](../../architecture/15-core-runtime.md#runtime-management).

## `createRuntime(options)`

```ts
import { createRuntime, createSandbox, ServiceRegistry } from '@murm/core';

const runtime = await createRuntime({
  sandbox: createSandbox({
    lifecycleBaseUrl: 'http://127.0.0.1:8080/v1',
    isolation: { disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  }),
  connection: { advertiseHost: '172.17.0.1' },
  models: {
    default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: modelUrl, headers: modelHeaders } },
  },
  services: new ServiceRegistry(),
  profiles: { reader: { model: 'default', image, writable: false, services: {} } },
  maxAgents: 2,
  outputDir,
});
```

`createSandbox` captures OpenSandbox deployment settings. Its `kind` defaults to `opensandbox`. Supply the Lifecycle URL and explicit disk byte and inode limits. The optional `timeoutSeconds` defaults to 3600 and is a safe integer of at least 60. `connection.advertiseHost` supplies a container-reachable non-loopback host IPv4 address for both endpoints. Use `connection.bridge` or `connection.modelGateway` for explicit overrides. Provider credentials stay on the trusted host.

Runtime owns `executor` (Pi by default), `models`, `connection`, `profiles`, `services`, `maxAgents`, and `outputDir`. `getExecutorCapabilities('pi' | 'codex')` is static. Both executors support steer, followUp, conditional input, queued input cancellation and explicit `all`. Pi also supports Context Fork and `one-at-a-time`. Use model URLs ending in `/v1/responses`. Set `connection.modelGateway.maxOutputTokens: null` to preserve the executor's parameters.

## Agent lifecycle

`spawn({ requestId, profile, parentId?, forkFrom?, writable?, files?, workspace?, secretEnv? })` initializes an idle Agent. Seed a private directory with `files`, or attach a shared directory with `workspace: { id, mode: 'read-only' | 'read-write' }`. With a supported executor, `forkFrom` copies Session context from a live Agent in the same Runtime. Capability checks precede allocation. Idle Agents occupy a Slot. `get(agentId)` and `list({ parentId?, status? })` return current snapshots. `runtime.state` is `open`, `closing`, or `closed`.

## Input delivery and events

`runtime.send(agentId, text, { requestId, mode?, wakeIfIdle?, source?, steeringMode? })` defaults to `steer` and `wakeIfIdle: true`. Use `followUp` to deliver after current work. Conditional delivery may return `not-accepted/idle`. An accepted input is `started`, `queued`, or `handled`. Reconcile unknown admission by retrying the original arguments under the original ID. Changed arguments conflict. The receipt describes admission.

### Live observation

`onEvent(listener)` returns a function that removes that listener. Register before lifecycle operations, and read `get/list/state` for the current view. The subscription delivers `output`, `settled`, `error`, `exit`, `agentChanged` and `runtimeChanged`. On either state notification, query the current state. Events may arrive before operation receipts. Listener failures are isolated. A settlement marks one observed executor execution as completed, failed or aborted. Establish business completion through application-owned evidence.

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

A `FileTree` maps project-relative paths to UTF-8 or base64 regular files with optional `0644` or `0755` mode. Parent directories are implicit. Use `paths: ['.']` for a complete snapshot. Explicit file or directory paths produce a partial digest. The limits are 10,000 files, 2 MiB per file and 16 MiB total, with an optional lower snapshot `maxBytes`. Protected paths and links are outside the tree.

`replace` checks a complete digest and installs the whole target tree in the same private directory, including deletions and mode changes. Omitting `writable` preserves access. Passing `true` can grant writing after installation. The Agent and Session continue. Digest conflicts and shared replacement are rejected. The Worker resumes writers before issuing a completed receipt. A proven rollback returns `failed`. Reconcile an unknown outcome using the original request arguments. A retry of completed work preserves the Agent's later edits.

## Interrupt, stop, and close

`interrupt(agentId, { requestId, timeoutMs? })` clears queued work and interrupts execution while retaining Session, files and Slot. If unconfirmed, retry the original ID.

`stop(agentId, { timeoutMs? })` revokes model and Bridge access on entry. After confirming execution stop, it archives Session, collects files, deletes the sandbox and frees the Slot. `close({ timeoutMs? })` handles all Agents, host endpoints and the Runtime report. The default timeout is 60 seconds. Receipts separate `stopped/unknown` execution from `complete/pending` cleanup. Required export failures retain the sandbox. Repeating cleanup joins active work or retries an unfinished stage. Existing external Services retain their owners.

## Service protocol v2 & built-in `agent` Service

- **Registration (`ServiceRegistry.registerService`)**: requires `contract_version: '2'`, unique `id` (not reserved `'agent'`), `title`, `purpose`, `provider_version`, `endpoint` (`{ transport: 'in-process' }` or `{ transport: 'http-json', url }`), and non-empty `capabilities`. Schemas compile strictly with Ajv `8.20.0` draft-07 (synchronous, no coercion, no defaults).
- **Invocation (`ServiceAdapter.invoke`)**: receives `{ manifest, capability, input, envelope: { operation_id }, caller: { runtimeId, agentId, profile, binding? }, signal, assertAuthorized }`. Default per-call timeout is `30_000` ms (configurable per capability via `timeout_ms`: `1..86_400_000`).
- **Optional state export (`ServiceAdapter.exportState({ signal })`)**: called once during `runtime.close()` (30-second cap) and written to `service-state.<id>.json`.
- **HTTP JSON wire contract (`createHttpJsonAdapter`)**: POSTs `{ input, envelope, caller }` to `endpoint.url + (capability.path ?? '/v2/' + capability.operation)` with headers `Content-Type: application/json`, `Idempotency-Key: <operation_id>`, and optional host `Authorization: Bearer <token>`. Must return `{ "ok": true, "result": <json> }` (2 MiB max, redirects disabled).
- **Built-in `agent` Service**: grant operations explicitly via `Profile.services.agent` (`['spawn', 'get', 'send', 'stop']`).
  - `spawn` requires target role in `Profile.spawnProfiles`; `fork: true` requires `Profile.allowContextFork: true`.
  - `get` and `send` target the caller itself or a direct child; `stop` targets only a direct child.

The application can attach an already-running HTTP Service or use a host adapter for an existing CLI. The Messages example exposes the same operations from an in-process or HTTP implementation. The GitHub example runs a scoped, read-only `gh issue list` on the application host under Bridge authorization. The host keeps the Service and GitHub credentials. [Bridge Service examples](https://github.com/LuNa-shi/murm/tree/main/examples/bridge-services)

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

## Repository helpers & foreground CLI

The following helpers are source used by bundled Harnesses, not additional package exports. External consumers should use the public Runtime methods, or implement their own policy using the runnable SDK example.

- **`src/harnesses/shared/run-input.ts`** (`runInput`): single-source exclusive turn helper (verifies `idle`, subscribes before sending, resolves on `'started'` + matching `settled`).
- **`src/harnesses/shared/run-report.ts`** (`runWithReport`): runs `createRuntime` → `run` → bounded `close` → optional `afterClose`, preserving independent `businessFailure`, `cleanupFailure`, and `reportSaveFailure` slots in `harness-report.json`.
- **Foreground host CLI (`scripts/run-harness.ts` & `scripts/read-harness-result.ts`)**: drives configured `taskpool` or `peermesh` harnesses over JSON-line `stdin` (`status`, `kickoff`, `input`, `wait`, `stop`) and inspects saved `runtime.json` + `harness-report.json` offline:

```bash
node dist/scripts/run-harness.js --config <host-config.mjs>
node dist/scripts/read-harness-result.js --run-directory <dir> --runtime-id <id>
```

## Error codes & recovery

| Code / status | Meaning | How to handle |
| --- | --- | --- |
| `INVALID_CONTRACT` / `SERVICE_INPUT_INVALID` | Invalid arguments, config, or JSON Schema input | Fix the input or config; the operation did not execute |
| `SERVICE_OUTPUT_INVALID` | Adapter returned JSON violating `output_schema` | For writes, state may already have changed — inspect Service state before retrying |
| `NOT_FOUND` / `NOT_ALLOWED` | Unknown agent/operation, missing Profile grant, fatal fence, or Runtime closing | Check Profile grants and agent status; do not retry unauthorized calls |
| `CONFLICT` | Same `requestId` reused with different arguments, version mismatch, or no free Slot (`maxAgents`) | Use a fresh `requestId` for new parameters, or wait for `stop()` to free a Slot |
| `OPERATION_UNKNOWN` / `status: 'unknown'` from Runtime input | Host wait expired or transport dropped after input dispatch | Reconcile the input by repeating the **exact same `requestId` and arguments** |
| `SERVICE_TIMEOUT` / unknown Service write | The adapter may already have performed its side effect | Retain the operation ID and inspect or reconcile through that Service's own idempotency contract; Registry does not automatically retry or deduplicate writes |
| `cleanup: 'pending'` | Execution stop, session archive, required `collect`, or sandbox delete incomplete | Inspect `pending[].action` and `errors`, fix the cause, and call `stop()` / `close()` again |
