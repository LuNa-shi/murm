---
title: TaskPool
description: Shared task pool with exclusive leased claims, read-only discovery to host-granted writes, Model Access Policy lease guards, and versioned Workspace merges.
section: BUILT-IN HARNESSES
order: 8
---

**TaskPool** (`src/harnesses/taskpool/`) is designed for long-running projects where individual agents time out, finish bounded work, or rotate cleanly without losing progress. There is no permanent manager: identical `researcher` agents discover open **Tasks**, publish immutable **Materials**, save verified revisions to a public **Workspace**, and hand off through durable shared state.

## 1. Registered Services

| Service | Core CLI operations | Domain guarantees |
| --- | --- | --- |
| **`task`** | `list`, `view`, `create`, `take`, `link`, `finish`, `revise`, `cancel`, `dependency-replace`, `feedback` | Dependency DAG + exclusive claims creating leased **Executions** with monotonic `fencing_version` |
| **`material`** | `list`, `view`, `search`, `publish`, `consume`, `dispute`, `supersede`, `unsupersede` | Immutable findings and provenance links across Tasks and Executions |
| **`workspace`** | `view`, `history`, `status`, `diff`, `public-diff`, `files`, `read`, `search`, `save`, `apply`, `merge` | Versioned public `main` plus unmerged saved revisions; `merge` can gate advances behind a host verifier |
| **`judge`** *(optional)* | `check`, `result` | Runs trusted host checks against fixed saved Workspace revisions |
| **`mission`** *(optional)* | `view`, `submit`, `submission view` | Reads the shared Mission goal and submits pinned `main` + Material selection for final acceptance |

A typical worker cycle inside Bash uses the uniform `swarm` CLI:

```bash
# 1. Read-only discovery while UNBOUND
swarm task list --state ready
swarm task view T1
swarm task take T1 --request-id take-t1

# 2. After host grants write access: edit, save, check, publish, and finish
swarm workspace save --request-id save-t1
swarm judge check --revision 0.2 --request-id check-t1
swarm material publish --content '{"revision":"0.2","summary":"Fixed parser edge case"}' --request-id pub-m1
swarm task link --task-id T1 --material-id M1 --role experience --request-id link-m1
swarm task finish --outcome done --workspace-revision 0.2 --material-ids '["M1"]' --request-id finish-t1
```

## 2. Three Runtime primitives working together

### Read-only discovery → `files.prepare()` + `files.grant()`

Every `researcher` spawns with **`writable: false`**. While unbound, it can inspect Tasks, Materials, and public Workspace files through Services, but cannot modify `/workspace/project`.

When the agent wins `swarm task take`, [task-handoff.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/taskpool/task-handoff.ts) heartbeats the reservation while running a four-step host handoff:

```ts
// 1. Assemble pinned public workspace revision + linked Material inputs
const inputs = await prepareTaskPoolInputs({
  execution: taken.execution,
  taskService,
  missionWorkspace,
  workspaceId,
  workspaceManager,
  contextService,
});

// 2. Stage files into the empty read-only directory; returns a frozen PreparedFiles handle
const prepared = await runtime.files.prepare(agentId, {
  requestId: `${id}:prepare`,
  files: inputs.files,
});

// 3. Activate the Execution in TaskService with finite execution & handoff deadlines
execution = taskService.dispatch(
  'start_execution',
  { core_id: agent.core_id, started_at, execution_deadline, handoff_deadline },
  executionEnvelope(execution, `${id}:start`),
).execution;

// 4. Pass the exact PreparedFiles object back to unlock write access in the live container
await runtime.files.grant({ requestId: `${id}:grant`, prepared });
```

### Lease-gated model inference via `modelAccessPolicy`

If an agent stalls and its lease expires while container teardown is still running, [model-access-policy.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/taskpool/model-access-policy.ts) stops stale inference right inside the host Model Gateway:

```ts
export function authorizeTaskPoolAgent({ taskService, missionId, agentId, deadline, isStopping }): ModelPermit | null {
  const at = Date.now();
  const agent = taskService.getAgent(agentId);
  if (isStopping() || agent?.mission_id !== missionId || at >= Math.min(deadline(), Date.parse(agent.hard_deadline))) {
    return null;
  }
  if (agent.state === 'UNBOUND') {
    const selectionDeadline = Date.parse(agent.selection_deadline);
    return !agent.execution_id && at < selectionDeadline
      ? { phase: 'selection', deadlineAt: Math.min(deadline(), Date.parse(agent.hard_deadline), selectionDeadline) }
      : null;
  }
  const execution = taskService.getExecution(agent.execution_id);
  const leaseDeadline = Date.parse(execution?.lease_expires_at);
  if (agent.state !== 'ACTIVE' || execution?.state !== 'RUNNING' || at >= leaseDeadline) return null;

  const phase = isSoftCloseout(execution, at) ? 'closeout' : 'work';
  return {
    phase,
    deadlineAt: Math.min(deadline(), Date.parse(agent.hard_deadline), Date.parse(execution.execution_deadline)),
    lease: { key: agent.execution_id, version: execution.fencing_version, expiresAt: leaseDeadline },
  };
}
```

Whenever a lease expires or its `fencing_version` changes, the Model Gateway immediately aborts in-flight streaming responses and blocks new model requests. Combined with `modelGateway.selectionReasoningEffort: 'low'`, unbound discovery turns can also use lighter reasoning effort while active work turns keep full reasoning.

### Dual event + heartbeat reconciliation loop

[controller.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/taskpool/controller.ts) separates turn settlement (`settled`) from task completion (`swarm task finish`):
- **Event track (`runtime.onEvent`)**: if an agent settles while its Execution is still `RUNNING`, the controller sends a `followUp` continuation turn; if it is `UNBOUND`, it sends discovery guidance; if `CLOSING` (after `task finish`), it calls `runtime.stop()`, finalizes domain state, and spawns a fresh replacement into the freed Slot.
- **Heartbeat track (`setInterval`)**: renews active leases, detects stalled or expired agents, stops them cleanly, and refills open Slots up to `capacity` until all Tasks are terminal (or the Mission is accepted under `completionPolicy: 'mission'`).

## 3. Running with the foreground CLI

TaskPool can be launched through the repository's foreground host CLI (`scripts/run-harness.ts`), which accepts JSON-line commands on `stdin` (`status`, `input`, `stop`) and writes a final summary with `runtimeId` and `reportPath`:

```bash
node dist/scripts/run-harness.js --config ./my-taskpool-config.mjs

# Inspect saved reports after completion:
node dist/scripts/read-harness-result.js \
  --run-directory "./runs/$runtime_id" \
  --runtime-id "$runtime_id"
```

## Source files

- Harness assembly & closeout: [src/harnesses/taskpool/harness.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/taskpool/harness.ts)
- Reconciliation controller: [src/harnesses/taskpool/controller.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/taskpool/controller.ts)
- File handoff (`prepare` / `grant`): [src/harnesses/taskpool/task-handoff.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/taskpool/task-handoff.ts)
- Lease gate (`ModelAccessPolicy`): [src/harnesses/taskpool/model-access-policy.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/taskpool/model-access-policy.ts)
- Publication & workspace capture: [src/harnesses/taskpool/publication-services.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/taskpool/publication-services.ts)
