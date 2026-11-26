---
title: Subagents
description: Hierarchical recursive delegation, session context forking, non-waking mailbox messaging, and interrupt recovery built on one custom collaboration Service.
section: HARNESSES
order: 7
---

**Subagents** models a lead agent (`/root`) that breaks down a task, spawns named child agents recursively (up to `maxDepth`), exchanges messages in real time, and integrates results. Source: [examples/subagents](https://github.com/LuNa-shi/murm/tree/main/examples/subagents).

The host imports the public SDK from `@murm/core`. `createSubagentsHarness` belongs to the example source. See the [SDK guide](../sdk.md) for installation.

## 1. Registered Service (`collaboration`)

Subagents registers one domain-specific **`collaboration` Service** ([collaboration-service.ts](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/collaboration-service.ts)) that addresses every team member by hierarchical path (`/root`, `/root/reviewer`, `/root/reviewer/parser`):

| Operation | Key arguments | Host behavior |
| --- | --- | --- |
| `spawn_agent` | `task_name`, `message`, `fork_turns?: 'all' \| 'none'` | Checks depth & path uniqueness → calls `runtime.spawn({ forkFrom })` when `fork_turns` is `'all'` (default) → delivers initial task |
| `send_message` | `target`, `message` | Adds to target inbox → offers via `runtime.send(..., { mode: 'steer', wakeIfIdle: false })`; never wakes an idle member |
| `followup_task` | `target`, `message` | Flushes pending inbox messages together with the new task using `wakeIfIdle: true` to resume the child's existing session (rejects `/root`) |
| `wait_agent` | `timeout_ms?` *(default 30s, min 10s, max 1h)* | Suspends within the current turn until a pending/new message arrives, a new input wakes the agent, or timeout expires |
| `interrupt_agent` | `target` | Calls `runtime.interrupt()` and restores confirmed `discardedInputHashes` back into the member's inbox (rejects `/root` and self) |
| `list_agents` | `path_prefix?` | Joins `runtime.list()` with tree paths to return visible live members, status, and `lastOutcome` |

Context forking depends on the executor. The shipped Pi backend permits `fork_turns: 'all'`; Codex requires an explicit `fork_turns: 'none'`. The host reads backend capabilities and exposes the matching Service schema. Sharing conversation context does not share private files.

Inside the container, agents use the standard `swarm` CLI:

```bash
swarm service view collaboration
swarm collaboration spawn_agent \
  --task-name reviewer \
  --message 'Audit src/parser.ts edge cases and report back.' \
  --fork-turns none \
  --request-id reviewer-start
swarm collaboration wait_agent --timeout-ms 60000 --request-id wait-reviewer
```

## 2. How the controller coordinates delivery

The [controller](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/controller.ts) serializes operations per member, offers notices without waking idle members, and forwards child outcomes to their direct parent. The following excerpts illustrate that flow; the complete controller also owns admission, retries and shutdown:

```ts
// 1. Offer a message to a member: wake an active wait_agent first, else steer only if running
async function offer(member: Member, message: Message) {
  if (message.state === 'returned' || (message.state === 'pending' && releaseWait(member))) {
    return;
  }
  const { state: _state, ...payload } = message;
  const body = JSON.stringify(payload);
  const receipt = await runtime.send(member.id!, body, {
    requestId: message.id,
    source: message.from,
    mode: 'steer',
    wakeIfIdle: false,
  });

  if (receipt.status === 'accepted') {
    message.state = 'queued';
    // Index queued payload by SHA-256 so interrupt_agent can recover it if discarded
    if (receipt.disposition === 'queued') {
      member.submitted.set(createHash('sha256').update(body).digest('hex'), message);
    }
    removeMemberMessage(member, message);
    member.wait?.({ reason: 'input' });
  } else if (receipt.status === 'unknown') {
    message.state = 'unknown';
  } else {
    // Confirmed idle ('not-accepted'): keep safely pending in member.inbox
    message.state = 'pending';
    releaseWait(member);
  }
}

// 2. Automatically route settled child outcomes back to their direct parent
const unsubscribe = runtime.onEvent((event) => {
  const member = byId.get(event.agentId);
  if (!member) return;
  if (event.type === 'settled' || event.type === 'exit') member.executionRevision++;
  if (event.type === 'settled') {
    member.lastOutcome = event.outcome === 'aborted' ? 'interrupted' : event.outcome;
    if (event.outcome !== 'aborted' && !(member.fatalReported && event.outcome === 'failed')) {
      resultFor(member, event); // pushes result into member.parent.inbox and calls offer()
    }
  } else if (event.type === 'error' && event.fatal && !member.fatalReported) {
    member.lastOutcome = 'failed';
    member.fatalReported = true;
    resultFor(member, event);
  }
});
```

When a user sends a prompt to `/root` (or a parent calls `followup_task`), `submit()` first reconciles any `unknown` inbox deliveries, freezes all `pending` messages into the input JSON batch, and delivers them with `wakeIfIdle: true`.

## 3. Shared workspace closeout safety

By default, every member gets a private working directory and children return findings or patches as messages. When `config.workspace` mounts one shared `read-write` workspace across `/root` and children and `/root` has a `collect` spec, [examples/subagents/main.ts](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/main.ts) stops all child writers **before** calling `runtime.close()` so Root's collected files are guaranteed quiescent:

```ts
if (sharedWriters && collect && !sharedDeliveryUnverified) {
  const children = (await runtime.list()).filter((a) => a.parentId && a.status !== 'closed');
  const stops = await Promise.allSettled(
    children.map((a) => runtime.stop(a.id, { timeoutMs: childStopBudgetMs })),
  );
  sharedDeliveryUnverified = stops.some(
    (s) => s.status === 'rejected' || s.value.execution !== 'stopped',
  );
}
const receipt = await runtime.close({ timeoutMs: remainingCloseMs });
```

If any child writer fails to confirm `execution === 'stopped'`, the harness appends `SHARED_WRITERS_UNCONFIRMED` and keeps `cleanup: 'pending'`.

## 4. Programmatic & CLI usage

From a built checkout, configure the Worker image and model endpoint, then use the one-shot or interactive launcher. The [example README](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/README.md) covers OpenSandbox setup and optional host settings:

```bash
export MURM_SUBAGENTS_IMAGE=$(docker image inspect murm-worker:local --format '{{.Id}}')
export MURM_SUBAGENTS_MODEL_URL='https://your-model-endpoint/v1/responses'
export MURM_SUBAGENTS_MODEL_TOKEN='your-bearer-token'

node dist/examples/subagents/main.js dist/examples/subagents/config.js \
  'Split this task into two independent checks and summarize the results.'

node dist/examples/subagents/main.js dist/examples/subagents/config.js --interactive
```

Or embed `createSubagentsHarness` in Node.js:

```ts
// In a host module beside the example's main.js and config.js.
import { createSubagentsHarness } from './main.js';
import config from './config.js';

const signal = AbortSignal.timeout(120_000);
const team = await createSubagentsHarness(config);
try {
  const admitted = await team.input('Analyze the repository structure and delegate module reviews.', 'req-1');
  if (admitted.status !== 'accepted') throw new Error('Root input is unconfirmed');
  const reply = await team.waitForReply({ signal });
  console.log('Root reply:', reply);
} finally {
  const receipt = await team.close({ timeoutMs: 30_000 });
  console.log('Cleanup:', receipt.cleanup);
}
```

The low-level factory does not apply the CLI work deadline to every custom host operation; the caller supplies a cancellation signal and bounds its own work. For repeated user inputs, pass the previous reply sequence as `waitForReply({ after, signal })` so an earlier reply is not mistaken for the new result. Inspect the reply outcome and close receipt separately.

## Source files

- Entry point & interactive CLI: [examples/subagents/main.ts](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/main.ts)
- Controller, mailbox & interrupt recovery: [examples/subagents/controller.ts](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/controller.ts)
- `collaboration` Service manifest: [examples/subagents/collaboration-service.ts](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/collaboration-service.ts)
- Setup & verification notes: [examples/subagents/README.md](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/README.md) · [ProgramBench `fd` run record](https://github.com/LuNa-shi/murm/blob/main/docs/experiments/EXP-20261125-10-issue199-fd.md)
