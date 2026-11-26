---
title: TaskPool
description: Shared task pool, read-only discovery to host-granted writes, Model Access Policy lease guards, and versioned main merges for long-running projects.
section: BUILT-IN HARNESSES
order: 7
---

**TaskPool** *(repository module: `src/harnesses/taskpool`)* is built for long-running projects where individual workers may time out or rotate. There is no permanent manager: identical participants discover work from a shared **Task** pool, publish immutable **Materials**, and merge verified changes into a versioned **Workspace `main`**. Source code: [src/harnesses/taskpool](https://github.com/LuNa-shi/SwarmEnv/tree/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/harnesses/taskpool).

## 1. Registered Services

| Service | Core Operations | Domain Guarantees |
| --- | --- | --- |
| **`task`** | `task_list`, `task_view`, `task_take`, `task_link_material`, `task_finish`, `task_revise`, `task_cancel` | Dependency DAG + exclusive claims creating leased Executions with `fencing_version` |
| **`material`** | `read_materials`, `context_get_material`, `context_publish_material`, `consume_materials`, `material_dispute`, `material_supersede` | Immutable findings, failed attempts, and cross-task citation lineage |
| **`workspace`** | `workspace_public_view/files/read/diff`, `workspace_save`, `workspace_merge` | Versioned public `main` + private commits; saves snapshot cleanly and merges require verification |
| **`judge`** *(optional)* | `workspace_check`, `get_check_result` | Trusted build/verification checks against saved public versions |

## 2. Runtime primitives used

TaskPool combines three Runtime mechanisms to enforce strict task ownership:

### 1. Read-only discovery followed by `files.prepare` + `files.grant`

Every `researcher` starts with **`writable: false`**. Until it successfully claims a task via `swarm task take T1`, it cannot write to its workspace. Once claimed, [task-handoff.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/harnesses/taskpool/task-handoff.ts) runs a four-step handoff on the host:

```ts
// 1. Assemble input files from the pinned public workspace version and cited materials
const inputs = await prepareTaskPoolInputs({ execution, missionWorkspace, contextService });

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

> Agent A holds a five-minute lease on Task 1 and stalls. When the lease expires, its container may still be running while cleanup proceeds. The Model Gateway denies inference under the stale lease. The controller can refill the slot after it confirms cleanup.

`modelAccessPolicy` attaches a synchronous gate right in front of the host **Model Gateway** ([model-access-policy.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/harnesses/taskpool/model-access-policy.ts)):

```ts
const modelAccessPolicy: ModelAccessPolicy = {
  authorize(caller) {
    const agent = taskService.getAgent(caller.agentId);
    if (!agent || isStopping()) return null; // deny immediately

    if (agent.state === 'UNBOUND') {
      return { phase: 'selection', deadlineAt: Date.parse(agent.selection_deadline) };
    }
    const exec = taskService.getExecution(agent.execution_id);
    if (agent.state !== 'ACTIVE' || exec?.state !== 'RUNNING') return null;

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

TaskPool separates turn completion (`settled`) from task completion (`task finish`): if a worker pauses before calling `task finish`, the controller follows up automatically; if a lease expires or stalls, the controller calls `runtime.stop()` and spawns a fresh replacement into the freed slot.

## 3. Host control loop

[controller.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/harnesses/taskpool/controller.ts) runs a dual **event + heartbeat reconciliation loop**:

```ts
// Track 1: Event-driven continuation & finish handling
runtime.onEvent((event) => {
  if (event.type !== 'settled') return;
  const { owner, execution } = readDomainState(event.agentId);

  if (owner?.state === 'CLOSING' || execution?.state === 'CLOSING') {
    void stopAndRefill(event.agentId, 'task-finish');
  } else if (owner?.state === 'ACTIVE' && execution?.state === 'RUNNING') {
    void runtime.send(event.agentId, buildContinuationMessage(execution), {
      requestId: `continue:${event.agentId}:${event.seq}`,
      mode: 'followUp',
    });
  } else if (owner?.state === 'UNBOUND') {
    void runtime.send(event.agentId, AGENT_DISCOVERY_MESSAGE, {
      requestId: `discovery:${event.agentId}:${event.seq}`,
      mode: 'followUp',
    });
  }
});

// Track 2: Periodic reconciliation — lease heartbeats, dependency unlocks, stale cleanup, refills
setInterval(() => void reconcileAndRefill(), heartbeatMs);
```

## Source files

- Entrypoint: [src/harnesses/taskpool/harness.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/harnesses/taskpool/harness.ts)
- Reconciliation controller: [src/harnesses/taskpool/controller.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/harnesses/taskpool/controller.ts)
- File handoff: [src/harnesses/taskpool/task-handoff.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/harnesses/taskpool/task-handoff.ts)
- Model lease gate: [src/harnesses/taskpool/model-access-policy.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/harnesses/taskpool/model-access-policy.ts)
