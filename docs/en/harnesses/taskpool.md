---
title: TaskPool
description: A shared task pool with exclusive leases, controlled file handoff, durable Materials and versioned Workspace results.
section: HARNESSES
order: 8
---

## Run an ordinary project

```sh
cd my-project
murm --harness taskpool --prompt "Fix the parser using the project tests"
```

TaskPool creates the Mission and its Workspace in the Run directory. The prompt is the Mission goal. Discovery starts from the read-only project and execution uses the Workspace revision selected when it takes a Task. The sections below also cover direct SDK embedding and explicit benchmark fixtures.

TaskPool lets a group of researchers keep working while individual Agents finish, time out or rotate. Each Agent discovers Tasks, chooses one, publishes reusable Materials and saves its work into the public Workspace. The host keeps the pool populated and enforces ownership through leases.

The implementation lives in `examples/taskpool/`. It composes the [Core SDK](../sdk.md) with the repository's existing Mission, Task, Material and Workspace stores. `runTaskPoolHarness` is a repository host function, not an exported member of `@murm/core`. It requires those stores and a prepared Mission/Workspace; it is not a standalone configuration-only example.

## Services available to a researcher

| Registered Service | Agent CLI | Responsibility |
| --- | --- | --- |
| `task` | `swarm task list`, `view`, `take`, `revise`, `cancel`, `link`, `finish`, `feedback` | Task contracts, dependencies and exclusive Executions |
| `context` | `swarm material list`, `view`, `publish`, `consume`, `dispute`, `supersede`, `unsupersede` | Immutable Materials and their provenance; `material` is the CLI alias for this Service |
| `workspace` | `swarm workspace view`, `files`, `read`, `public-diff`; configured `save`, `status`, `diff`, `apply`, `merge` | Public revisions, live private work and verified integration |
| `judge` (optional) | `swarm judge check`, `result` | Trusted checks of a fixed saved revision |
| `mission` (optional) | `swarm mission view`, `submit`, `submission view` | Mission goal and explicit acceptance of a pinned public result |
| `mathlib-search` (optional) | `swarm mathlib-search search` | Search the pinned Mathlib source |

The host enables `task create` with `autonomousTasks: true`. Dependency replacement, Mission submission and selected Material correction operations also require their domain grants. The workspace manifest only exposes live capture operations when a capture source exists; `apply` requires `workspaceCapture: 'core'`, and `merge` requires the configured merger. A command appearing in general CLI help does not make it available in every Harness. Inspect the authenticated manifest:

```bash
swarm service view task --json
swarm service view context --json
swarm service view workspace --json
swarm task list --state ready
swarm task view TASK_ID_FROM_LIST
swarm task take TASK_ID_FROM_LIST --request-id take-selected-task
```

After `take` succeeds, edit the private project, save an enabled Workspace revision, run any required check, publish evidence with `swarm material publish`, and link it to the Task before finishing. Use the returned Task, Material, revision and check IDs. `task finish` records the declared outcome; the host still has to stop the Agent and complete domain cleanup.

## From discovery to writable work

A researcher starts with `writable: false`. It can read public Task, Material and Workspace state through Services while the project directory remains read-only. Winning a Task reservation starts the handoff in [task-handoff.ts](https://github.com/LuNa-shi/murm/blob/main/examples/taskpool/task-handoff.ts):

1. Pin the public Workspace revision and linked Material inputs. A preparation heartbeat keeps the reservation alive.

3. Activate the Execution in TaskService with its execution and handoff deadlines.


The two SDK calls are distinct because file preparation can fail before the Task is ready to authorize writes. Preparation and grant belong to the trusted host. The Agent requests work through the `task` Service; it does not manufacture a prepared handle or grant itself file access.

If a handoff fails after reservation, the host records its stage and stops or reconciles the affected Agent. A normal claim conflict does not stop the Agent that lost the race.

## Keep model access tied to the lease

The TaskPool controller watches committed TaskService transitions and arms timers for ownership and deadlines. On loss of authority, expiry or a stop request, it calls `runtime.stop`. Core revokes that Agent’s model credentials and aborts live model connections. TaskPool releases the Task owner only on confirmed execution stop and reuses the Slot only after cleanup completes.

The policy complements Service authorization and file access: a stale Agent must not keep using the model while its container is still being stopped. See [model-access-policy.ts](https://github.com/LuNa-shi/murm/blob/main/examples/taskpool/model-access-policy.ts) for the complete guards.

## Continue, retire and replace Agents

The [controller](https://github.com/LuNa-shi/murm/blob/main/examples/taskpool/controller.ts) observes both Runtime events and domain deadlines. A completed `settled` event ends an Agent turn; it does not finish its Task. An active Execution can receive a continuation, and an unbound Agent can receive more discovery guidance. Failed or aborted turns are handled as failures.

A heartbeat renews current leases and reconciles deadlines, finish requests and open capacity. When a Task enters closeout, the controller stops its Agent, reconciles saved work and finalizes the domain state. A replacement is admitted after capacity is released. Unknown execution or pending cleanup remains explicit instead of silently freeing the Slot.

With `completionPolicy: 'tasks'`, success requires all Tasks to reach terminal states without controller failures. With `completionPolicy: 'mission'`, the host requires trusted Mission acceptance. Completing all currently visible Tasks is not equivalent to satisfying that second policy.

## Running TaskPool

The foreground host accepts a trusted module whose default export contains `mode: 'taskpool'`, finite `timeoutMs`, and `options` for `runTaskPoolHarness`. Those options include the Backend, stores, Mission/Workspace IDs, worker Profile inputs and deadline. A runnable configuration must first initialize and bind those domain objects; there is no shipped `examples/taskpool/config.ts` to copy.

After building the repository and creating that host module:

```bash
node dist/scripts/run-harness.js --config ./my-taskpool-config.mjs
```

The host accepts JSON-line `status`, Task-directed `input`, and `stop` commands. Task-directed input is resolved against the current Execution owner. It is not an arbitrary direct message to an Agent. The final record contains the Runtime identity and report path; the [foreground protocol](../../architecture/17-harness-reporting.md#foreground-harness-control) defines its commands and result codes.

Saved reports can be read without loading model configuration:

```bash
node dist/scripts/read-harness-result.js \
  --run-directory ./runs/RUNTIME_ID_FROM_RESULT \
  --runtime-id RUNTIME_ID_FROM_RESULT
```

## Implementation reference

- [Harness assembly and closeout](https://github.com/LuNa-shi/murm/blob/main/examples/taskpool/harness.ts)
- [Task admission and file handoff](https://github.com/LuNa-shi/murm/blob/main/examples/taskpool/task-service.ts)
- [Material publication, capture and finishing](https://github.com/LuNa-shi/murm/blob/main/examples/taskpool/publication-services.ts)
- [TaskPool implementation manual](../../architecture/15-core-runtime.md#taskpool-model-authority-and-trusted-identity-startup)
