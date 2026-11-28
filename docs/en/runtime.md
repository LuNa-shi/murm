---
title: Runtime
description: Goal-oriented guide to the Runtime control plane — setup, live event monitoring, cross-Agent file syncing, dynamic updates, and safe shutdown recovery.
section: CORE BUILDING BLOCKS
order: 4
---

**Runtime** is the control plane for a single multi-agent run. Once you have a [Sandbox](sandbox.md) config, role Profiles, and Services, you use `runtime` to run the swarm, watch live events, move files safely, update permissions mid-run, and shut everything down cleanly.

> For full signatures and error codes, see the [SDK & API Reference](reference/api.md).

## 1. Creating a Runtime

Start a new run with `createRuntime()`:

```ts
import {
  DEFAULT_WORKER_IMAGE,
  ServiceRegistry,
  createRuntime,
} from '@luna-shi/murm';

const runtime = await createRuntime({
  sandbox, // Immutable config from createSandbox()
  executor: 'pi', // Default 'pi', or switch to 'codex'

  // Host IPv4 reachable from Docker containers (typically 172.17.0.1 on Linux)
  connection: { advertiseHost: process.env.MURM_ADVERTISE_HOST ?? '172.17.0.1' },

  // Model aliases: upstream URLs and API keys stay strictly on the host Model Gateway
  models: {
    default: {
      provider: process.env.MURM_MODEL_PROVIDER ?? 'openai',
      model: process.env.MURM_MODEL_ID ?? 'gpt-5.4',
      // protocol defaults to 'responses'; Pi also supports 'chat-completions'
      upstream: {
        url: process.env.MURM_MODEL_URL!,
        headers: process.env.MURM_MODEL_TOKEN
          ? { authorization: `Bearer ${process.env.MURM_MODEL_TOKEN}` }
          : {},
      },
    },
  },

  // Optional: tune per-stage file budgets for larger repos (initial / snapshot / replace / export / session)
  // filePolicy: { initial: { maxBytes: 64 * 1024 ** 2 } },

  services: new ServiceRegistry(), // Pre-registered shared Services (see Services & Permissions)
  profiles: {
    researcher: {
      prompt: 'Inspect the repository and record key findings.',
      model: 'default',
      image: DEFAULT_WORKER_IMAGE,
      writable: false,
      services: {},
    },
  },
  maxAgents: 4, // Maximum concurrent live Agents
  outputDir: './runs', // Traces and artifacts are saved under outputDir/<runtime.id>/
});
```

`createRuntime()` sets up the run directory, Model Gateway, and Service Bridge, but starts **zero containers** until your Harness explicitly calls `runtime.spawn()` (covered next in [Agents & Profiles](agents.md)).

> **Flexible executors & model protocols**: beyond the `'pi'` (`1.3.0` default) and `'codex'` (`0.172.0`) shorthands, use `createPiExecutor({ version: '1.4.0' })`, `createCodexExecutor(...)`, or `createExecutorAdapter(...)` for image-installed executors. Pi supports both **Responses** and **Chat Completions** (see [SDK & API Reference](reference/api.md)).

## 2. Monitoring what happens: `runtime.onEvent()`

Runtime never imposes a collaboration strategy — instead, it streams every meaningful transition through `runtime.onEvent()`. **Subscribe before calling `spawn()` or `send()`** so you never miss early events.

| What you want to do | Event type | When it fires |
| --- | --- | --- |
| Stream Agent replies live | `output` | As an Agent emits text chunks during a turn |
| Know when a turn finishes to trigger the next step | `settled` | When a turn ends (`outcome: 'completed' \| 'failed' \| 'aborted'`) |
| Handle crashes or unexpected exits | `error` / `exit` | On execution errors or container exits (`fatal` / `expected` flags) |
| Refresh a dashboard or local mirror | `agentChanged` / `runtimeChanged` / `management` | When Agent state, Runtime state, or dynamic config changes |

A practical pattern driving coordination from `settled`:

```ts
const completed = new Set<string>();

const unsubscribe = runtime.onEvent((event) => {
  // 1. Stream Agent output to your host console
  if (event.type === 'output') {
    process.stdout.write(`[${event.agentId.slice(0, 8)}] ${event.text}`);
    return;
  }

  // 2. React when an Agent finishes its current turn
  if (event.type === 'settled') {
    if (event.outcome === 'completed') completed.add(event.agentId);
    console.log(`Agent ${event.agentId.slice(0, 8)} finished turn: ${event.outcome}`);
    return;
  }

  // 3. Catch failures or unexpected exits
  if (event.type === 'error' || (event.type === 'exit' && !event.expected)) {
    console.error('Runtime alert:', event);
  }
});
```

## 3. Working with sandbox files: `runtime.files`

Each Agent gets a private `/workspace/project` by default. When your Harness needs to read files from one Agent or sync them into another without restarting its session, use `runtime.files`:

```ts
// 1. Capture a consistent snapshot (file tree + SHA-256 digest) from coder's sandbox
const coderSnap = await runtime.files.snapshot(coder.id, {
  requestId: 'snap-coder-1',
  paths: ['.'],
});

// 2. Atomically replace another Agent's workspace using its last known digest (CAS)
const receipt = await runtime.files.replace(reviewer.id, {
  requestId: 'sync-to-reviewer-1',
  expectedDigest: reviewerInitialDigest, // from an earlier snapshot on reviewer
  files: coderSnap.files,
  // Optional: pass writable: true to unlock a read-only workspace on handoff
});
```

- **Why pass `expectedDigest`?** `files.replace` pauses writer processes inside the target sandbox, checks that the directory hasn't changed unexpectedly, applies adds/edits/deletes atomically, and keeps the Agent's conversation session intact.
- **Need live shared files across multiple Agents?** Pass `workspace: { id: 'shared-repo', mode: 'read-write' }` to `runtime.spawn()`, and call `runtime.stop()` on all writers before exporting final artifacts.

## 4. Dynamic updates while a run is live

Initial Profiles and Services are snapshotted at creation time. When a Harness intentionally needs to evolve the team mid-run, use the audited management APIs:

- `runtime.profiles.register(...)` — add a new immutable role Profile.
- `runtime.services.register(...)` / `retire(...)` — attach a new Service or drain and retire an existing one.
- `runtime.access.get(...)` / `grant(...)` / `revoke(...)` — inspect or update a live Agent's Service permissions without restarting its container.

## 5. Clean shutdown and recovery: `runtime.close()`

When the goal is met or your budget expires, call `runtime.close()`:

```ts
const receipt = await runtime.close({ timeoutMs: 60_000 });
unsubscribe();

if (receipt.cleanup !== 'complete') {
  // Inspect receipt.pending (e.g., blocked artifact export or container delete), fix, and retry close()
  console.warn('Pending cleanup items:', receipt.pending);
}
```

`runtime.close()` strictly follows **archive-before-delete**: stop executors → export sessions, Service states, and declared `Profile.collect` artifacts → delete containers only after archiving succeeds. If a required export or delete fails, `receipt.cleanup` stays `'pending'` with exact entries in `receipt.pending`, and retrying `close()` on the same Runtime safely resumes cleanup.

---

**Next:** learn how to define role Profiles, spawn persistent Agents, send messages, and recover from interrupts in **[Agents & Profiles](agents.md)**.

## Session controls and Harness shutdown

The `session` group on Runtime controls a specified Agent. It exposes configure, compact, abortRetry, clearQueue, getState, getStats and getMessages. Structured context uses the existing send method with explicit append, nextTurn, steer or followUp delivery. All configuration values and results use root-exported murm types. The selected Guest executor owns the native Session and the Host uses its confirmed configuration and receipts. The [Agent guide](agents.md#agent-session-settings-and-context) gives runnable call shapes.

A Harness that owns its Runtime can call `fenceRuntimeAdmissions(runtime)` synchronously before asynchronous dispatcher shutdown. The helper closes new Agent spawn, send and Session mutation admission while retaining existing operation reconciliation. The Runtime owner still calls stop or close to perform archival, required exports and physical cleanup. HarnessSession uses the same boundary for its managed Runtime registrations.
