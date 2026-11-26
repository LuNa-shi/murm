---
title: Lead-Worker
description: A fixed lead and worker team that revises its direction using worker feedback and verifies delivery against Git.
section: HARNESSES
order: 11
---

## Run an ordinary project

```sh
cd my-project
murm --harness lead-worker --prompt "Fix the parser using the project tests"
```

Lead–Worker sends the prompt to the Lead and initializes team Git and member Sandbox files. Choose the dynamic team with `MURM_LEAD_WORKER_TEAM=dynamic`. The dynamic checker uses an immutable Docker image ID from `MURM_LEAD_WORKER_CHECKING_IMAGE` or the Worker image setting. The sections below also cover direct SDK embedding and explicit benchmark fixtures.

**Lead-Worker** (`src/harnesses/lead-worker/`) fits teams that want one explicit owner of direction while enforcing that worker feedback discovered during execution actually reaches the next round of planning. One `lead` and 2–7 workers (`helper1..helperN`) run in persistent sessions with separate Gitea accounts, personal Git branches, and a local SQLite **`board` Service**.

The host composes Runtime, Services and the OpenSandbox backend using the [SDK](../sdk.md). `createLeadWorkerHarness` and `runLeadWorker` are repository modules under `src/harnesses/lead-worker/`, not public package exports. The default mode configures the team before startup. The packaged [dynamic orders example](../../../examples/lead-worker/README.md) lets the Lead deploy a checking Service, register a Profile, admit a new member and change an original Worker’s grants while work is underway.

## 1. Registered Services & asymmetric permissions

[src/harnesses/lead-worker/board.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/lead-worker/board.ts) enforces distinct operations per role at both the Service Bridge (`Profile.services`) and inside the adapter:

```ts
export const boardPermissions = Object.freeze({
  lead: ['read', 'list_subtasks', 'announce', 'assign', 'create_subtask', 'update_subtask', 'note'],
  helper: ['read', 'list_subtasks', 'create_subtask', 'claim', 'update_subtask', 'note', 'landed', 'complete'],
});
```

Both roles also receive `gitea: ['pull_request_write']` plus native `git` access to their own branch over the allowlisted Gitea origin (`Profile.network.allow` + `secretEnv.GITEA_TOKEN`). The built-in `agent` Service is not enabled.

Inside the Board's SQLite `BEGIN IMMEDIATE` transaction, three strict invariants are enforced:

1. **Exclusive permanent claims**: `claim` verifies `row.owner === null && row.state === 'ready' && row.revision === input.expected_revision` before setting a permanent `owner`. Claims never expire or reassign automatically.
2. **Causal read-before-write gates**:
   - `announce` rejects with `FEEDBACK_NOT_READ` if `lead` cites `feedback_ids` it has not previously observed via `board read`.
   - `landed` / `complete` rejects with `DIRECTION_NOT_READ` if the helper has not observed the latest `direction_id` via `board read`.
3. **Live byte-level Git verification**: before committing `landed` or `complete`, the adapter calls `git.verifyDelivery()` against Gitea to confirm the helper's own branch commit SHA, file path, byte length, and exact SHA-256 digest (and on later rounds, verifies the artifact contains the revised direction text).

```ts
// Excerpt from src/harnesses/lead-worker/board.ts
if (['landed', 'complete'].includes(operation)) {
  const subtask = deliveryGuard(state, caller, input, role);
  delivery = await verifyDelivery({
    actor: caller.agentId,
    subtask: structuredClone(subtask),
    delivery: structuredClone(input.delivery),
    direction: structuredClone(state.directions.at(-1)),
    requireDirectionText: state.directions.length > 1,
    signal,
  });
  if (!delivery || delivery.verified !== true) throw error('DELIVERY_INVALID');
}
```

Example commands run by agents inside Bash:

```bash
swarm board read --request-id helper1-read
swarm board claim --input claim.json --request-id helper1-claim
swarm board complete --input complete.json --request-id helper1-done
```

## 2. Staged control loop & failure fencing

In [src/harnesses/lead-worker/index.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/lead-worker/index.ts), `createLeadWorkerHarness()` spawns the fixed team upfront (`maxAgents: 1 + helperCount`), binds their IDs into `board` and `git`, and subscribes to `runtime.onEvent()` so any fatal error, non-completed settlement, or unexpected exit immediately calls `board.fence()` — freezing further Board mutations while preserving all records for inspection.

The default workflow runs two alternating rounds. Its repository `runInput` helper sends one host-owned input after subscribing to settlement events. The following sketch omits the shared cancellation signal and validation around each stage:

```ts
// Stage 1a: Lead publishes initial direction, assignments, and ready subtasks
await dispatch('lead', 'lead-initialize', { type: 'initialize', goal, helpers });

// Stage 1b: Helpers concurrently claim subtasks, push Git commits, and post feedback notes
await Promise.all(
  helperRoles.map((role) =>
    dispatch(role, `${role}-initial`, { type: 'helper-initial' }),
  ),
);

// Stage 2a: Register supplemental user input; Lead reads all feedback & updates direction
board.registerUserInput('lead-adjust', supplement);
await dispatch('lead', 'lead-adjust', {
  type: 'user-and-feedback',
  user_input_id: 'lead-adjust',
  supplement,
});

// Stage 2b: Original helpers read the updated direction in their preserved sessions and ship round 2
await Promise.all(
  helperRoles.map((role) =>
    dispatch(role, `${role}-followup`, { type: 'helper-followup' }),
  ),
);
```

For a host-managed schedule with `helperCount: 3`, the factory also exposes `prepareStages({ signal })` and `runStage(...)`. The first stage receives `goal` and `paths`; later stages receive `supplement` and new `paths`. Optional task specifications, a host signal, a deadline and a candidate verifier can be supplied. Up to four serial stages reuse the same team. The supplied CLI still runs the short two-round workflow.

The read gates establish which feedback and direction were observed. Delivery verification establishes account, commit and byte provenance; it does not establish the semantic quality of arbitrary code.

## 3. Running the example

From a built checkout, prepare OpenSandbox, a compatible Pi Worker image, a Gitea instance and a Responses endpoint. The [example README](https://github.com/LuNa-shi/murm/blob/main/examples/lead-worker/README.md) lists host settings and the installed-package invocation.

```bash
# Set run ID, immutable worker image, OpenSandbox URL, Gitea admin credentials, and model URL
node dist/examples/lead-worker/main.js dist/examples/lead-worker/config.js
```

On close, the host fences new Board writes and calls `runtime.close()`. It closes the Board connection and revokes owned Gitea credentials only after Core confirms stopped execution and complete cleanup. Unknown execution, required export failures or Board evidence failures leave dependencies pending for reconciliation. The shared repository, Board database, commits and PRs remain for review. Inspect `harness-report.json` for business failure, delivered and unfinished work, uncertain inputs, cleanup and report-save outcomes.

## Source files

- Harness orchestrator (`runWorkflow`, `prepareStages`, `runStage`): [src/harnesses/lead-worker/index.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/lead-worker/index.ts)
- SQLite `board` Service & causal gates: [src/harnesses/lead-worker/board.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/lead-worker/board.ts)
- Gitea provisioning & SHA-256 delivery verification: [src/harnesses/lead-worker/git.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/lead-worker/git.ts)
- Example config & guide: [examples/lead-worker/README.md](https://github.com/LuNa-shi/murm/blob/main/examples/lead-worker/README.md)
