# 00. Overview

murm runs Agent lifecycles against a Mission through authenticated services. The components below divide process lifecycle, durable domain authority, public research evidence and discovery:

```text
Agent Core / Pi session
        │ native tools and CLI contract
        ▼
Services Bridge + Capability Profile
        │ authenticated, task-scoped calls
        ├── Task Service       Mission, Task, Execution facts
        ├── Context Service    Material and consumption facts
        ├── Judge Service      checker execution and CheckResult facts
        ├── Workspace/Runtime  public revisions, guest worktrees, fencing, Sandbox
        └── Catalog/Registry   manifests, tools, documentation and hashes
```

The Harness host owns its collaboration policy, capacity and finalization. The programmable Core owns Agent resources and input delivery. TaskPool adds Mission, Task and Execution authority through its Service adapters. For a registered Agent, Bridge resolves Judge input from a saved numeric revision in the public Mission Workspace. File checks select a path; project checks export the complete revision. Unsaved guest edits are not checker input. Judge persists a CheckResult and the Service records its operation result before the fenced response is delivered to the Agent. Task finish, main merge and fixed-input Mission acceptance are separate decisions. Runtime owns process/session lifecycle and cleanup. Task, Context and Judge own their respective durable facts. Agents choose research actions; Runtime does not choose a mathematical route.

## The three boundaries a reader must keep separate

**Mission and Task** describe responsibility. Mission is a shared objective
and is never taken. A Task represents a separable responsibility and has at
most one effective Execution at a time; a Mission may legally have no Tasks.
Creating a Task does not give the creating Agent management authority.

**Agent, Execution and Session** describe authorization and a running process.
An Execution is durable domain state. A Session is a Pi conversation attached
to an Agent/Core lane. An Agent starts a fresh Sandbox/Pi and performs zero or one
Execution. After finish, handoff or timeout Runtime stops the Agent and destroys
its Sandbox; a later Agent continues only through public Task, Material and
Workspace revision records.

**Material and Workspace** describe different forms of progress. Material is
versioned shared evidence with producer provenance. The Mission Workspace is a
persistent Runtime-owned Git repository; each Execution receives a separate
materialized directory and public revisions are referenced as
`(workspace_id, revision, path)`. A Material count or a Workspace write is
activity evidence, not proof of useful research.

## Normal flow

```text
Agent starts unbound with an empty protected guest project
  → reads capabilities and public Mission/Task/Material/Workspace state
  → prefers suitable existing work; otherwise proposes a bounded Task
  → task_take reserves one Execution in its Core
  → Runtime pins public inputs, prepares the guest, activates E, grants access
  → Agent reads/publishes/consumes Material and edits the guest project
  → Agent explicitly saves a public revision
  → Agent may check that fixed revision through Judge
  → Judge persists the result and its fixed input identity
  → Agent may merge a fixed public revision into main under Runtime guards
  → an authorized live Agent may separately submit fixed main and selected Materials
    for trusted Mission acceptance (independent of Task completion)
  → Agent explicitly finishes done, incomplete, blocked or cancelled
  → Runtime confirms process/Sandbox isolation, then releases E and Core
  → a fresh Agent may continue from public state
```

The **Mission Task contract** defines TaskPool domain responsibilities. The Agent/SDK surface exposes Mission Tasks, relations, Materials and Runtime-owned Execution lifecycle facts without Root/Child structure operations. Agents use the read, write, edit and bash tools, with the typed `swarm` CLI routed through their authenticated Bridge to Task, Material, Judge and Workspace operations. They do not receive a second set of domain-native tools.

The Phase 0005 TaskPool controller owns discovery, continuation and directed feedback while the public Core owns Agent allocation and stop. The legacy domain Runtime remains directly callable. The old TaskController, IdentityTaskLoop and benchmark composition have been removed; TaskPool owns dependency repair and discovery. The [Core Runtime](15-core-runtime.md), [TaskPool integration](02-execution.md), and [Harness host](17-harness-reporting.md#foreground-harness-control) describe the current paths.

## Current implementation versus acceptance

This guide describes the code shape at the pinned reviewed implementation commit, not automatically every subsequent `main` tree. It does not turn
the target rules in `AGENTS.md` into claims that the code has passed every real
experiment. The implementation matrix and each registered experiment must say
which behavior is deterministic-only, real-probe evidence, natural-run
evidence, or still unknown.
