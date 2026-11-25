---
title: Lead-Worker
description: Staged direction-and-feedback loop combining transactional SQLite Board claims, causal read gates, and Git commit SHA-256 verification.
section: BUILT-IN HARNESSES
order: 10
---

**Lead-Worker** *(repository module: `src/environments/lead-helper`)* fits teams that need one clear owner of direction while forcing field constraints discovered during execution back into the next round of planning. One **lead** and 2–7 **workers** (`helper` roles in code) coordinate through a local SQLite **Board** and personal Gitea branches. Source code: [src/environments/lead-helper](https://github.com/LuNa-shi/SwarmEnv/tree/ac72c76/src/environments/lead-helper).

## 1. Registered Services

Lead-Worker registers two Services with asymmetric role permissions ([board.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/lead-helper/board.ts)):

- **`board` (transactional SQLite state machine)**:
  - `lead`: `read`, `list_subtasks`, `announce` (set/revise direction), `assign`, `create_subtask`, `update_subtask`, `note`.
  - `helper` (worker): `read`, `list_subtasks`, `create_subtask`, `claim` (exclusive transactional claim), `update_subtask`, `note` (feedback), `landed`, `complete`.
- **`gitea`**: `pull_request_write` for both roles, paired with native `git` pushes to personal branches.

The `board` Service enforces three strict invariants:
1. **Exclusive transactional claims**: `claim` checks `expected_revision` inside `BEGIN IMMEDIATE` to assign a single permanent `owner`.
2. **Read-before-write causal gates**: `lead` cannot `announce` citing `feedback_ids` unless `reads` proves it read them; workers cannot `complete` unless they read the latest `direction_id`.
3. **Byte-level Git verification**: `complete` submits `{ commit, path, sha256, bytes }`, which the Board verifies live against Gitea via `git.verifyDelivery` before committing.

## 2. Runtime primitives used

- **Fixed team with isolated credentials**: spawns `lead` and `helper1..helperN` upfront with distinct Profiles, Gitea `bindings`, `secretEnv.GITEA_TOKEN`, and required `collect(includeGit: true)`. Built-in `bot` Service is disabled.
- **Fatal failure fence**: `runtime.onEvent` watches for any `fatal` error or unexpected `exit`, calling `board.fence()` to freeze writes while preserving ownership state and failure artifacts.
- **Staged turn orchestration**: uses `runInput` across alternating lead/worker stages in persistent sessions.

## 3. Host control loop

[src/environments/lead-helper/index.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/lead-helper/index.ts) implements the two-round `runWorkflow` (and extensible `runStage` with candidate verification):

```ts
// Step 1: Lead publishes initial direction, assignments, and ready subtasks
await dispatch('lead', 'lead-initialize', { type: 'initialize', goal, helpers });
assertInitialBoardReady(board.snapshot());

// Step 2: Workers concurrently claim subtasks, push Git commits, and post feedback
await Promise.all(
  helperRoles.map((role) =>
    dispatch(role, `${role}-initial`, { type: 'helper-initial' })
  )
);

// Step 3: Register supplemental user input; Lead reads all feedback and updates direction
board.registerUserInput('lead-adjust', supplement);
await dispatch('lead', 'lead-adjust', {
  type: 'user-and-feedback',
  user_input_id: 'lead-adjust',
  supplement,
});

// Step 4: Same workers read the revised direction in their preserved sessions and ship round 2
await Promise.all(
  helperRoles.map((role) =>
    dispatch(role, `${role}-followup`, { type: 'helper-followup' })
  )
);
```

On close, the host waits for `runtime.close()` to confirm all Git checkouts are archived and containers removed before closing SQLite and revoking temporary Gitea tokens.

## Source files

- Orchestrator (`runWorkflow` / `runStage`): [src/environments/lead-helper/index.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/lead-helper/index.ts)
- SQLite Board & causal checks: [src/environments/lead-helper/board.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/lead-helper/board.ts)
- Gitea provisioning & delivery verification: [src/environments/lead-helper/git.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/lead-helper/git.ts)
- Usage guide: [examples/lead-helper-environment/README.md](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/examples/lead-helper-environment/README.md)
