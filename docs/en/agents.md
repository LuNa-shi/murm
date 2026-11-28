---
title: Agents & Profiles
description: Define role Profiles, spawn persistent Agent sessions, send tasks and mid-flight steers, handle interrupts, and safely reconcile retries.
section: CORE BUILDING BLOCKS
order: 5
---

A **Profile** is a role blueprint; an **Agent** is a persistent executor session spawned from that blueprint. This page covers how you define roles, run multi-turn Agents, send messages, and recover cleanly from interrupts or timeouts.

## 1. Defining roles with Profiles

Declare your roles in `createRuntime({ profiles })`:

```ts
const profiles = {
  researcher: {
    prompt: 'Investigate performance bottlenecks in the codebase and publish verified findings to the board.',
    model: 'default', // Alias from runtime.models
    image: DEFAULT_WORKER_IMAGE, // Container image for this role
    writable: false, // Whether /workspace/project starts writable
    services: { board: ['publish', 'search'] }, // Least-privilege Service allowlist
    collect: { paths: ['notes.md'], includeGit: false, maxBytes: 1_048_576, required: false }, // Artifacts exported before close
  },
};
```

> **Why is `image` on Profile instead of Runtime?**
> Different roles in one swarm often need different toolchains — for example, general researchers can use an official image (`workerImageFor(executor)` or `DEFAULT_WORKER_IMAGE`), while a formal-verification specialist uses an image with Lean or custom compilers preinstalled. When every role uses the same environment, simply pass the same image constant on each Profile.

Other optional fields include `spawnProfiles` and `allowContextFork` (for delegating child Agents via the built-in `agent` Service) and `network: { allow: [...] }` (to permit specific internal IPv4 endpoints).

## 2. Persistent session lifecycle and capacity slots

```text
spawn() ──► starting ──► idle ◄──► running ──► stop() / close() ──► closing ──► closed
                          │           │
                          └───────────┴──► unexpected exit ──► exited ──► stop() / close()
```

```ts
// Boot an Agent (optionally seeding private files into /workspace/project)
const researcher = await runtime.spawn({
  requestId: 'spawn-researcher-1',
  profile: 'researcher',
  files: {
    'brief.txt': { encoding: 'utf8', data: 'Focus on memory allocation and cache invalidation.' },
  },
});
```

Three practical things to remember:

1. **Agents start `idle`**: `spawn()` prepares the container and executor session without making any model calls until you call `runtime.send()`.
2. **Context and files persist across turns**: when a turn finishes and returns to `idle`, the Agent retains its conversation history and local files so you can keep asking follow-up questions.
3. **Slots are freed only on `stop()` / `close()`**: every open Agent (including `idle` and `exited`) occupies one slot out of `maxAgents`. Call `runtime.stop(agent.id)` when a member is no longer needed to archive its session, remove its container, and free the slot.

## 3. Sending messages: `runtime.send()`

Pick the delivery mode that matches your coordination style:

| Options | Behavior | Common use case |
| --- | --- | --- |
| `mode: 'steer'` *(default)* | Injects guidance into an active turn at a safe boundary (or starts a turn if idle) | Mid-flight requirement updates or pushing urgent peer notices |
| `mode: 'followUp'` | Queues behind the current turn and runs next (or starts immediately if idle) | Sequential multi-step instructions |
| `wakeIfIdle: false` | **Delivers only if busy**; if idle, returns `not-accepted` (`idle`) without waking the Agent | Non-waking mailboxes that avoid spending tokens on minor notices |

```ts
const receipt = await runtime.send(
  researcher.id,
  'Inspect the caching layer and publish verified findings to the board.',
  { requestId: 'task-1', mode: 'followUp' },
);
```

## 4. Admission vs. completion, and safe retries

`runtime.send()` returns an **admission receipt** — it tells you whether the executor accepted the message, not whether the turn finished:

- **`accepted`** (`started` / `queued` / `handled`): wait for the `settled` event on `runtime.onEvent()` to know when the turn ends.
- **`not-accepted`**: e.g., `wakeIfIdle: false` found the Agent idle — keep the message in your Harness mailbox for later.
- **`unknown`**: if a timeout or disconnect makes delivery ambiguous, **never switch to a new `requestId`** (that could execute the task twice). Retry `send()` with the exact same `requestId` and payload to reconcile whether it was accepted.

> Likewise, a `settled` event only proves the model stopped its turn — verify real success against your Service state and exported files.

## 5. Interrupting work without losing context: `runtime.interrupt()`

To stop a running Agent mid-turn while keeping its container, workspace, and conversation history intact:

```ts
const result = await runtime.interrupt(researcher.id, {
  requestId: 'interrupt-1',
});
// If queued messages were cleared before running, result.discardedInputHashes
// lists their SHA-256 digests so your Harness mailbox can restore them cleanly.
```

`interrupt()` aborts active inference and in-flight Bridge calls, clears queued inputs, and leaves the Agent ready for fresh `send()` calls.

---

**Next:** see how Agents talk safely to models and shared Services across the **[Host Gateway](gateway.md)**.

## Agent Session settings and context

Add `session` to a Profile or an individual `spawn` request to select thinking level, compaction and retry settings, queue modes, tools and explicit Guest resources. Spawn overrides merge nested fields with the captured Profile configuration. Each Agent owns its effective settings. Read the actual executor values through `runtime.session.getState(agent.id)`.

```ts
const agent = await runtime.spawn({
  profile: 'researcher', requestId: 'researcher-session',
  session: { thinkingLevel: 'low', tools: ['read', 'bash'], retry: { enabled: true } },
});
await runtime.session.configure(agent.id, {
  thinkingLevel: 'medium', compaction: { enabled: true },
}, { requestId: 'configure-researcher' });
await runtime.send(agent.id, {
  type: 'context', customType: 'project-reference', content: 'Use the reviewed revision.',
  display: false, details: { revision: 'reviewed' },
}, { requestId: 'reference', delivery: 'append' });
const state = await runtime.session.getState(agent.id);
const stats = await runtime.session.getStats(agent.id);
const messages = await runtime.session.getMessages(agent.id, { limit: 50, maxBytes: 65536 });
```

Context delivery must be explicit. Append adds context at the native safe boundary without starting the model. NextTurn waits for the next new run. Steer and followUp use their corresponding native input timing and accept `wakeIfIdle`. Pending next-turn context is discarded by interruption, queue clearing and stopping. Context that has already entered history remains available. Receipts and events identify each context input and its actual disposition.

`runtime.session.compact(agent.id, { requestId })` requires idle status with no starting input. It returns busy while work is active. Coordinate your own Harness scheduler before compacting. `abortRetry` cancels the current executor retry and can affect the turn outcome. `clearQueue` reports the executor's discarded text hashes and context identities. A Harness must also reconcile its own pending inbox or batches.

Mutation request IDs retain their original operation and arguments. Retrying an unknown receipt queries that operation. Use the same ID and payload, including after a lost response. Changed parameters conflict. Executor capability declarations and Guest handshake determine availability. An unsupported query reports unsupported or unavailable.

A Host policy can stop an Agent before its fourth successful automatic compaction opportunity. Configure `hooks.beforeCompact` when creating the Runtime and return `stop` when `request.reason !== 'manual' && request.successfulAutoCompactions >= 3`. Return `allow` otherwise. The finite policy wait is awaited before the native summary request. Stop uses the Agent's ordinary archival, required export and cleanup path. The policy receives an AbortSignal and must treat cancellation as terminal for that decision.

Subscribe to Runtime events before sending work. Session events use `{ type: 'session', agentId, event }`. `messageStart`, `textDelta` and `messageEnd` share a message ID. Accumulate deltas by message and content block, then replace their content with the complete final message. Tool, compaction, retry, settings and context events retain their native operation identities. Read `toolActivity` for calls currently executing. Session usage and current context usage are separate measurements, and fork history can contribute to Session totals. With pricing unconfigured, cost is null.

The bundled `examples/agent-session.ts` program consumes a configuration module exported by your application and imports the SDK only from the package root. After building, run `node dist/examples/agent-session.js /absolute/config.mjs worker 'Your prompt'`. The module's default export is a complete `CreateRuntimeOptions` value containing the selected Profile. The program installs its three-success automatic-compaction policy, adds append and next-turn context, reads actual Session state/statistics/messages and prints the stop and final cleanup receipts. Its work period is bounded at 120 seconds and cleanup at 30 seconds. Your supplied model and Sandbox configuration determine the execution environment and resource limits.
