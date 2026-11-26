---
title: Anatomy of a Run
description: Walk through a concrete two-agent scenario from createRuntime and idle spawn through unified send, file handoffs, safe interrupts, and archive-before-delete closeout.
section: ARCHITECTURE
order: 4
---

Runtime primitives make the most sense when read in execution order. Follow one concrete scenario: **`architect` and `tester` collaborate on a parser refactor** — a mid-flight edge case arrives while `architect` is busy, `tester` drifts off-track and gets safely interrupted without losing queued messages, and the run closes cleanly with full archives.

## Agent state machine

Every spawned agent follows one explicit lifecycle:

```text
                   spawn()                     send() [wake]
  (unallocated) ──────────> starting ────────> idle <═══════════> running
                                │               │                    │
                                │ start fail    │ stop() / close()   │ crash
                                v               v                    v
                             closing <──────────┴──────────────── exited
                                │
                                │ 1. stop Pi execution
                                │ 2. archive native session
                                │ 3. collect declared artifacts
                                │ 4. delete sandbox & free slot
                                v
                             closed
```

Slots (`maxAgents`) stay occupied from registration in `starting` all the way through `idle`, `running`, `exited`, and `closing` until container deletion is confirmed in `closed`.

## Phase 1: Start a Run and spawn idle agents

Calling `createRuntime()` freezes your Profiles and `ServiceRegistry`, initializes `outputDir/<runtimeId>/`, and opens the Model Gateway and Service Bridge. No containers exist yet.

Subscribe to `runtime.onEvent()` **before** spawning or sending work so fast events are never missed. Each `runtime.spawn()` reserves a Slot, boots the container and Pi session, verifies readiness, and resolves with `status: 'idle'` — no model call starts automatically:

```ts
const unsubscribe = runtime.onEvent((event) => {
  if (event.type === 'output') {
    console.log(`[${event.agentId}] output seq=${event.seq}`);
  } else if (event.type === 'settled') {
    handleTurnSettled(event); // outcome: 'completed' | 'failed' | 'aborted'
  } else if (event.type === 'error' && event.fatal) {
    // Authority is already fenced by Core before this handler fires
    handleFatalAgentFailure(event.agentId, event.error);
  } else if (event.type === 'exit' && !event.expected) {
    handleUnexpectedExit(event.agentId, event.reason);
  }
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

Separating `spawn()` from the first input lets your Harness bind agent IDs into Services, routing tables, and parent/child maps before any agent executes a single step.

## Phase 2: Deliver work and notices with unified `send()`

`runtime.send(agentId, input, options)` handles both initial work and mid-flight messages. Two options determine exact timing:

- **`mode: 'followUp'`**: queues input to run after the agent's current turn finishes. Use for new tasks or serialized work batches.
- **`mode: 'steer'`** *(default)*: injects input after the active tool batch finishes and before the next model request — redirecting work without killing a running Bash command. Pass `steeringMode: 'all'` to drain all pending steer items together (default is `'one-at-a-time'`).
- **`wakeIfIdle: false`** *(default `true`)*: delivers **only if the target agent is currently `running`**. If the agent is `idle`, the Worker returns `{ inputId, status: 'not-accepted', reason: 'idle' }` without waking it or spending tokens.

```ts
// 1. Start architect on the refactor (wakes idle agent)
const startReceipt = await runtime.send(
  architect.id,
  'Refactor src/parser.ts and publish interface changes via `swarm notes put`.',
  { requestId: 'arch-turn-1', mode: 'followUp' },
);

// 2. While architect may be busy, offer a non-waking steer notice
const noticeText = 'Edge case: case-sensitive paths containing slashes need escaping.';
const notice = await runtime.send(architect.id, noticeText, {
  requestId: 'notice-slash-rule',
  source: 'tester',
  mode: 'steer',
  wakeIfIdle: false,
});

if (notice.status === 'not-accepted') {
  // architect is already idle — buffer in your mailbox instead of waking it
  mailbox.enqueue(architect.id, noticeText);
} else if (notice.status === 'unknown') {
  // Transport timed out — reconcile later using the exact same requestId & payload
  pendingReconcile.push({ agentId: architect.id, requestId: 'notice-slash-rule', text: noticeText });
}
```

### Admission receipts vs. turn completion

`runtime.send()` returns an **admission receipt**, not the agent's final response:
- `{ inputId, status: 'accepted', disposition: 'started' | 'queued' | 'handled' }`
- `{ inputId, status: 'not-accepted', reason: 'idle' }` *(only when `wakeIfIdle: false`)*
- `{ inputId, status: 'unknown' }`

Wait for the `settled` event on `onEvent` to observe turn completion. If a transport drop or 60-second host wait produces `status: 'unknown'`, repeat `runtime.send()` with the **exact same `requestId` and arguments** — the Runtime queries the Worker's saved RPC result ledger instead of injecting a duplicate prompt. Reusing the same `requestId` with different arguments throws `CONFLICT`.

> **Single-source convenience helper**: When an agent has only one input source and runs one exclusive turn at a time (as in Notes, Substrate, and Lead-Worker), use [`runInput()`](https://github.com/LuNa-shi/SwarmEnv/blob/main/src/harnesses/shared/run-input.ts), which verifies the agent is `idle`, subscribes before sending, and resolves when both a `'started'` receipt and the matching `settled` event arrive.

## Phase 3: Coordinate files safely

Choose the file primitive that matches your collaboration model:

| Pattern | Runtime API | How it works |
| --- | --- | --- |
| **Private workspace (default)** | `spawn({ files })` | Each container gets an isolated `/workspace/project` optionally seeded with up to 10,000 files / 16 MiB |
| **Shared live workspace** | `spawn({ workspace: { id, mode: 'read-write' \| 'read-only' } })` | Multiple sandboxes mount one Runtime-scoped project directory; read-only mounts are kernel-enforced even with the same guest UID |
| **Frozen copy** | `spawn({ workspace: { mode: 'frozen-copy', files } })` | Seeds a private directory from an immutable `FileSeed` (such as an earlier snapshot) |
| **Read-only discovery → write handoff** | `writable: false` → `files.prepare()` → `files.grant()` | Agent inspects Services read-only; once it claims work, host stages files and passes the exact in-memory `PreparedFiles` handle to unlock writes |
| **Mid-run consistent capture** | `files.snapshot(agentId, { requestId, paths })` | Worker pauses project writers (all owners for shared mounts) and returns `{ version, digest, files }` up to 16 MiB |
| **Guarded live replacement** | `files.install()` → commit domain state → `files.confirm()` | Replaces a live writable directory only if bytes still match `expected: FileSnapshot`, holding writers paused until `confirm()` |

```ts
// Example: read-only discovery followed by host-controlled write grant (used by TaskPool)
const prepared = await runtime.files.prepare(worker.id, {
  requestId: 'handoff-1:prepare',
  files: taskSeedFiles,
});
// Commit domain ownership on the host first, then pass the exact PreparedFiles object:
await runtime.files.grant({
  requestId: 'handoff-1:grant',
  prepared,
});
```

## Phase 4: Interrupt without destroying the session

Suppose mid-run `tester` starts writing assertions against an obsolete signature. Instead of killing its container and losing its conversation context, call `runtime.interrupt()`:

```ts
const interrupted = await runtime.interrupt(tester.id, {
  requestId: 'interrupt-tester-1',
  timeoutMs: 15_000,
});

if (interrupted.status === 'interrupted') {
  // Restore any queued steer payloads that Pi discarded before reading them
  for (const digest of interrupted.discardedInputHashes ?? []) {
    const lost = submittedSteersBySha256.get(digest);
    if (lost) mailbox.requeueFront(tester.id, lost);
  }

  // Same container, session, and workspace stay alive — send new direction immediately
  await runtime.send(
    tester.id,
    'The parser signature changed. Re-read src/parser.ts and update the test suite.',
    { requestId: 'tester-turn-2', mode: 'followUp' },
  );
}
```

`interrupt()` increments the agent's execution epoch, cancels pending Service Bridge calls for that agent, clears Pi's input queues, aborts the active run, and waits for Pi to confirm `idle`. The returned `discardedInputHashes` (SHA-256 digests of discarded queued strings) lets your Harness recover unsent mailbox items with zero guesswork.

## Phase 5: Archive-before-delete closeout

Follow a strict teardown order in every Harness:

1. Stop your Harness's timers, pollers, and external event feeds so no new work is dispatched.
2. If multiple agents share a `read-write` workspace and one agent exports `collect` files, stop the other writers first and verify `execution === 'stopped'` before collecting.
3. Call `await runtime.close({ timeoutMs: 30_000 })`. Core executes these stages strictly in sequence:
   1. Reject new admissions and close Bridge/Model Gateway intake (exporting optional `ServiceAdapter.exportState()` snapshots).
   2. Confirm Pi execution stopped inside every container.
   3. Archive each agent's native Pi session (`<agentId>/session/`) and declared `collect` files (`<agentId>/artifacts/`).
   4. Delete sandboxes, free Slots, close backend resources, flush `evidence.jsonl` / `service-calls.jsonl`, and atomically write `runtime.json`.
4. Only after `closeReceipt.cleanup === 'complete'` should your Harness close external databases or revoke external credentials.

Every `StopReceipt` and `CloseReceipt` separates two independent facts:
- **`execution` (`'stopped' | 'unknown'`)**: whether the guest process is confirmed terminated.
- **`cleanup` (`'complete' | 'pending'`)**: whether session archives, `required: true` artifact exports, sandbox deletion, and trace flushes all succeeded.

If a required export or container deletion fails or times out, Core leaves the sandbox intact and reports `cleanup: 'pending'` with the exact `pending[].action` (`'archive-session'`, `'collect-artifacts'`, `'delete-sandbox'`, etc.). Calling `runtime.stop(agentId)` or `runtime.close()` again skips already-completed stages and retries only the pending step.

Next, learn how to assemble these primitives into your own multi-agent system in [Build Your Own Harness](../build-your-harness/).
