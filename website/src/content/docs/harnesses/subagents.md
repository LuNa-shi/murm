---
title: Subagents
description: Hierarchical recursive delegation, non-waking mailbox messaging, context forking, and safe interrupts built on one custom collaboration Service.
section: BUILT-IN HARNESSES
order: 6
---

**Subagents** models a lead agent (`/root`) that breaks down a problem, spawns named child agents recursively, coordinates via messages in real time, and integrates their work. Source code: [examples/subagents](https://github.com/LuNa-shi/SwarmEnv/tree/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/examples/subagents).

## 1. Registered Service

Instead of exposing raw `agent` primitives directly to the model, Subagents registers a domain-specific **`collaboration` Service** ([collaboration-service.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/examples/subagents/collaboration-service.ts)) that gives every participant a hierarchical path (`/root`, `/root/reviewer`, up to `maxDepth`):

| Operation | Example Arguments | Host Behavior |
| --- | --- | --- |
| `spawn_agent` | `--task-name reviewer --message '...' --fork-turns none\|all` | Validates depth & uniqueness → calls `runtime.spawn()` (passing `forkFrom` when `fork_turns: 'all'`) → delivers initial task |
| `send_message` | `--target /root --message '...'` | Enqueues in target mailbox → attempts `runtime.send(..., { mode: 'steer', wakeIfIdle: false })`; never wakes idle members |
| `followup_task` | `--target /root/reviewer --message '...'` | Flushes pending mailbox messages together with the new instruction using `wakeIfIdle: true` to resume the existing session |
| `wait_agent` | `--timeout-ms 60000` | Suspends within the current turn until any new message/child result arrives or timeout expires |
| `interrupt_agent` | `--target /root/reviewer` | Calls `runtime.interrupt()` and restores `discardedInputHashes` back into the member's mailbox |
| `list_agents` | `--path-prefix /root` | Combines `runtime.list()` with hierarchy metadata to show visible paths, status, and latest output |

## 2. Runtime primitives used

1. **Session forking (`spawn({ forkFrom })`)**: when a parent spawns a child without `--fork-turns none`, the host passes `forkFrom: caller.id` so the child inherits the parent's full conversation prefix; pass `none` for a clean context.
2. **Non-waking conditional delivery (`send(..., { mode: 'steer', wakeIfIdle: false })`)**: eliminates mailbox race conditions. Busy recipients receive messages before their next model step; idle recipients return `not-accepted` so messages stay buffered without wasting a model turn.
3. **Lossless interruption (`interrupt` + `discardedInputHashes`)**: the host tracks SHA-256 digests of queued steer messages and restores any unconsumed payloads discarded by Pi back into the member's inbox.
4. **Optional shared workspace (`workspace: { id, mode: 'read-write' }`)**: members default to private directories, or can mount one shared runtime workspace for large codebase edits (stopping child writers before final export).

## 3. Host control loop

Strip away validation and [controller.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/examples/subagents/controller.ts) revolves around each member's `inbox` and `wait` handle:

```ts
// 1. Offer a message to a member without disturbing idle agents
async function offer(member: Member, message: Message) {
  if (releaseWait(member)) return;

  const body = JSON.stringify(message);
  const receipt = await runtime.send(member.id!, body, {
    requestId: message.id,
    source: message.from,
    mode: 'steer',
    wakeIfIdle: false,
  });

  if (receipt.status === 'accepted') {
    if (receipt.disposition === 'queued') {
      member.submitted.set(sha256(body), message);
    }
    removeFromInbox(member, message);
  }
  // If status === 'not-accepted' (idle), the message stays safely in member.inbox
}

// 2. Forward completed child turns to their direct parent
runtime.onEvent((event) => {
  const member = byId.get(event.agentId);
  if (!member?.parent) return;
  if (event.type === 'settled' && event.outcome !== 'aborted') {
    const resultMsg = buildChildResultMessage(member, event);
    member.parent.inbox.push(resultMsg);
    void offer(member.parent, resultMsg);
  }
});
```

User prompts from CLI or `--interactive` mode call `submit(root, ...)`, flushing `/root`'s unread inbox together with the user prompt using `wakeIfIdle: true`.

## 4. End-to-end validation (ProgramBench `fd`)

In [EXP-20261125-10](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/docs/experiments/EXP-20261125-10-issue199-fd.md), Subagents ran with 3 slots (`/root` + 2 children) on a shared workspace for a 1-hour rebuild of `fd 10.3.0`:

- **Measured concurrency**: `/root` spawned `/root/probe_patterns` and `/root/probe_filters` with **515 seconds** of overlapping child model execution;
- **Verified adoption**: `/root/probe_filters` authored 66 filter tests handed off to `/root`, exposing 38 failures that `/root` fixed to green;
- **Mid-flight user input**: a symlink/cycle requirement injected at minute 3 propagated to `/root/probe_patterns`, yielding 16 dedicated tests;
- **Clean teardown**: 43m 54s wall time, **1,042 / 1,235 (84.37%)** offline cleanroom tests passing, all 3 sessions, 200 model traces, and container deletions confirmed complete.

## Source files

- Entrypoint & interactive CLI: [examples/subagents/main.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/examples/subagents/main.ts)
- Controller & mailbox: [examples/subagents/controller.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/examples/subagents/controller.ts)
- Service manifest: [examples/subagents/collaboration-service.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/examples/subagents/collaboration-service.ts)
