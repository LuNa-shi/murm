---
title: Flat
description: Shared task pool, read-only discovery to host-granted writes, Model Access Policy lease guards, and versioned main merges for long-running projects.
section: BUILT-IN PROGRAMS
order: 7
---

**Flat** is built for long-running projects where individual workers may time out or rotate. There is no permanent manager: identical participants discover work from a shared **Task** pool, publish immutable **Materials**, and merge verified changes into a versioned **Workspace `main`**. Source code: [src/environments/flat](https://github.com/LuNa-shi/SwarmEnv/tree/ac72c76/src/environments/flat).

## 1. Registered Services

| Service | Core Operations | Domain Guarantees |
| --- | --- | --- |
| **`task`** | `task_list`, `task_view`, `task_take`, `task_link_material`, `task_finish`, `task_revise`, `task_cancel` | Dependency DAG + exclusive claims creating leased Executions with `fencing_version` |
| **`material`** | `read_materials`, `context_get_material`, `context_publish_material`, `consume_materials`, `material_dispute`, `material_supersede` | Immutable findings, failed attempts, and cross-task citation lineage |
| **`workspace`** | `workspace_public_view/files/read/diff`, `workspace_save`, `workspace_merge` | Versioned public `main` + private commits; saves snapshot cleanly and merges require verification |
| **`judge`** *(optional)* | `workspace_check`, `get_check_result` | Trusted build/verification checks against saved public versions |

## 2. Runtime primitives used

Flat combines three Runtime mechanisms to enforce strict task ownership:

### 1. Read-only discovery followed by `files.prepare` + `files.grant`

Every `researcher` starts with **`writable: false`**. Until it successfully claims a task via `swarm task take T1`, it cannot write to its workspace. Once claimed, [task-handoff.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/flat/task-handoff.ts) runs a four-step handoff on the host:

```ts
// 1. Assemble input files from the pinned public workspace version and cited materials
const inputs = await prepareFlatInputs({ execution, missionWorkspace, contextService });

// 2. Stage files into the empty read-only directory and obtain a trusted PreparedFiles handle
const prepared = await runtime.files.prepare(agentId, {
  requestId: `${handoffId}:prepare`,
  files: inputs.files,
});

// 3. Activate the Execution with execution & handoff deadlines
taskService.dispatch('start_execution', { execution_deadline, handoff_deadline }, envelope);

// 4. Pass the original PreparedFiles object back to unlock writes in the live session
await runtime.files.grant({ requestId: `${handoffId}:grant`, prepared });
```

### 2. Lease-gated model inference via `modelAccessPolicy`

Consider a classic lease-expiry race:

> Agent A holds a 5-minute lease on Task 1 and stalls. At minute 5, the controller reclaims Task 1 and assigns it to Agent B. During the seconds before Agent A's container finishes tearing down, Agent A might still fire another model call on stale state.

`modelAccessPolicy` attaches a synchronous gate right in front of the host **Model Gateway** ([model-access-policy.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/flat/model-access-policy.ts)):

```ts
const modelAccessPolicy: ModelAccessPolicy = {
  authorize(caller) {
    const bot = taskService.getBot(caller.botId);
    if (!bot || isStopping()) return null; // deny immediately

    if (bot.state === 'UNBOUND') {
      return { phase: 'selection', deadlineAt: Date.parse(bot.selection_deadline) };
    }
    const exec = taskService.getExecution(bot.execution_id);
    if (bot.state !== 'ACTIVE' || exec?.state !== 'RUNNING') return null;

    return {
      phase: 'work',
      deadlineAt: Math.min(missionDeadline, Date.parse(exec.execution_deadline)),
      lease: {
        key: exec.execution_id,
        version: exec.fencing_version,
        expiresAt: Date.parse(exec.lease_expires_at),
      },
    };
  },
  withCommit: (commit) => taskService.withServiceLifecycleWrite(commit),
};
```

If the lease expires or its `fencing_version` advances, the Gateway immediately aborts in-flight streaming responses and blocks subsequent turns.

### 3. Auto-continuation and slot replacement

Flat separates turn completion (`settled`) from task completion (`task finish`): if an agent pauses before calling `task finish`, the controller follows up automatically; if a lease expires or stalls, the controller calls `runtime.stop()` and spawns a fresh replacement into the freed slot.

## 3. Host control loop

[controller.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/flat/controller.ts) runs a dual **event + heartbeat reconciliation loop**:

```ts
// Track 1: Event-driven continuation & finish handling
runtime.onEvent((event) => {
  if (event.type !== 'settled') return;
  const { owner, execution } = readDomainState(event.botId);

  if (owner?.state === 'CLOSING' || execution?.state === 'CLOSING') {
    void stopAndRefill(event.botId, 'task-finish');
  } else if (owner?.state === 'ACTIVE' && execution?.state === 'RUNNING') {
    void runtime.send(event.botId, buildContinuationMessage(execution), {
      requestId: `continue:${event.botId}:${event.seq}`,
      mode: 'followUp',
    });
  } else if (owner?.state === 'UNBOUND') {
    void runtime.send(event.botId, FLAT_DISCOVERY_MESSAGE, {
      requestId: `discovery:${event.botId}:${event.seq}`,
      mode: 'followUp',
    });
  }
});

// Track 2: Periodic reconciliation — lease heartbeats, dependency unlocks, stale cleanup, refills
setInterval(() => void reconcileAndRefill(), heartbeatMs);
```

## Source files

- Entrypoint: [src/environments/flat/environment.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/flat/environment.ts)
- Reconciliation controller: [src/environments/flat/controller.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/flat/controller.ts)
- File handoff: [src/environments/flat/task-handoff.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/flat/task-handoff.ts)
- Model lease gate: [src/environments/flat/model-access-policy.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/flat/model-access-policy.ts)
