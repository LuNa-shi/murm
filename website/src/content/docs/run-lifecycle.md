---
title: Anatomy of a Run
description: Follow a two-agent refactoring scenario from spawn and unified send delivery through file handoffs, safe interrupts, and archive-before-delete closeout.
section: ARCHITECTURE
order: 4
---

API tables are easier to internalize through a concrete timeline. Walk through one realistic scenario: **`architect` and `tester` collaborate to refactor a parser module and write regression tests** — mid-flight a new requirement arrives, `tester` drifts off-track and gets interrupted without losing queued messages, and the run closes cleanly.

![Agent Lifecycle, Unified send(), Interrupt and Safe Close Order](../../assets/images/agent-lifecycle.jpg)

## Phase 1: Start a Run and spawn idle agents

Your Harness calls `createRuntime()`, freezing the Profile and Service registries and creating `outputDir/<runId>/`. No containers exist yet.

Calling `runtime.spawn()` registers an `agentId`, reserves a capacity **Slot** (bounded by `maxBots`), boots the sandbox and Pi session, and returns with `status: 'idle'` — no inference starts automatically:

```ts
// Subscribe before sending the first input so fast events are never missed
const unsubscribe = runtime.onEvent((event) => {
  handleEvent(event);
});

const architect = await runtime.spawn({
  requestId: 'spawn-architect',
  profile: 'architect',
  workspace: { id: 'parser-repo', mode: 'read-write' },
});
const tester = await runtime.spawn({
  requestId: 'spawn-tester',
  profile: 'tester',
  workspace: { id: 'parser-repo', mode: 'read-write' },
});
```

Separating `spawn` from the first input lets your Harness wire routing tables, parent-child links, and listeners cleanly before any model call fires.

## Phase 2: Deliver work with unified `send`

`runtime.send(agentId, text, options)` is the single entry point for delivering work and notifications. Two flags control timing and wake semantics precisely:

- **`mode: 'followUp'`**: queues after the agent's current turn settles. Use for independent new tasks or batched external events.
- **`mode: 'steer'`** *(default)*: injects after the current tool batch finishes and before the next model request — correcting direction without killing an in-flight shell command.
- **`wakeIfIdle: false`** *(default `true`)*: delivers **only if the target agent is currently `running`**. If the agent is already `idle`, the Runtime returns `{ status: 'not-accepted', reason: 'idle' }` without waking it or spending tokens.

Here is how cleanly that pattern works for cross-agent notifications:

```ts
// 1. Start architect on the refactor (wakes idle agent)
await runtime.send(architect.id, 'Refactor src/parser.ts and publish interface changes via notes.', {
  requestId: 'task-arch-1',
  mode: 'followUp',
});

// 2. Mid-flight, tester spots an edge case and notifies architect if it is actively running
const notice = await runtime.send(architect.id, 'Note: case-sensitive paths containing slashes have a special rule.', {
  requestId: 'notice-1',
  mode: 'steer',
  wakeIfIdle: false,
});

if (notice.status === 'not-accepted') {
  // architect already settled to idle — hold in mailbox instead of wasting a model turn
  mailbox.push(architect.id, 'Note: case-sensitive paths containing slashes have a special rule.');
}
```

### Delivery receipts vs. turn completion

`runtime.send()` resolves to an **acceptance receipt** (`accepted`, `not-accepted`, or `unknown`), not the model's final answer. When a turn finishes reasoning and tool execution, `onEvent` emits **`settled`** (`outcome: 'completed' | 'failed' | 'aborted'`) and the agent returns to `idle` with its session and workspace preserved.

If a transient transport error produces `status: 'unknown'`, re-issue the exact same `requestId` and payload to reconcile — the Runtime checks the original submission and never double-injects a duplicate prompt.

## Phase 3: Three patterns for file collaboration

| Scenario | Runtime file primitive | Behavior |
| --- | --- | --- |
| **Concurrent edits on one codebase** (Subagents) | `spawn({ workspace: { id, mode: 'read-write' } })` | Multiple agents mount one shared runtime directory while keeping sessions and tokens isolated |
| **Read-only discovery, write after claim** (TaskPool) | Start with `writable: false` → `files.prepare()` → `files.grant()` | Agent cannot mutate files until the host validates a claim and grants the trusted `PreparedFiles` handle |
| **Consistent mid-run read for checks or commits** | `runtime.files.snapshot(agentId, { requestId, paths })` | Worker pauses writers briefly and returns consistent file bytes, version, and digest |

For final deliverables, declare `collect` on a Profile or `spawn` call (`paths`, `includeGit`, `maxBytes`, and `required`).

## Phase 4: Safe interruption without losing queued messages

Suppose six minutes in, `tester` is writing tests against an outdated interface. Instead of killing the container and throwing away its accumulated context, call `runtime.interrupt()`:

```ts
const interrupted = await runtime.interrupt(tester.id, {
  requestId: 'interrupt-tester-1',
  timeoutMs: 15_000,
});

if (interrupted.status === 'interrupted') {
  // Restore any queued steer messages discarded by Pi back into your mailbox
  recoverDiscardedMailboxMessages(tester.id, interrupted.discardedInputHashes);

  // Session and workspace remain intact — redirect immediately
  await runtime.send(tester.id, 'Interface is finalized. Rewrite filter tests against latest src/parser.ts.', {
    requestId: 'task-tester-2',
    mode: 'followUp',
  });
}
```

`interrupt` cancels in-flight Bridge calls for that agent, aborts the active turn, flushes unconsumed inputs, and returns `discardedInputHashes` (SHA-256 digests) so your Harness can recover dropped notifications losslessly.

## Phase 5: Archive-before-delete closeout

Follow a strict four-step teardown sequence:

1. Stop your Harness's own timers, pollers, and external event feeds;
2. Call `await runtime.close({ timeoutMs: 30_000 })`;
3. The Runtime runs: **reject new calls → stop Pi processes → archive native sessions & `collect` files → delete sandboxes & free slots → shut down Bridge/Gateway and write `runtime.json`**;
4. Only after `close()` completes should your Harness close its own databases or revoke temporary external credentials.

Receipts report two independent axes:
- **`execution` (`'stopped' | 'unknown'`)**: whether agent execution is confirmed halted;
- **`cleanup` (`'complete' | 'pending'`)**: whether required session archives, required `collect` exports, and container deletions all succeeded.

If a required `collect` export or session archive fails, the Runtime keeps the container intact and returns `cleanup: 'pending'` with the exact pending actions so you can retry `stop()` or `close()` without losing deliverables.

Next, see how five distinct multi-agent harnesses are built on these exact primitives in [Five Topologies Overview](../harnesses/).
