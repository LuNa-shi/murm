# 00. Overview

SwarmEnv runs Bot lifecycles against a Mission through authenticated services. The components below divide process lifecycle, durable domain authority, public research evidence and discovery:

```text
Agent Core / Pi session
        │ named tools and prompt contract
        ▼
Services Bridge + Capability Profile
        │ authenticated, task-scoped calls
        ├── Task Service       Mission, Task, Execution facts
        ├── Context Service    Material and consumption facts
        ├── Judge Service      checker execution and CheckResult facts
        ├── Workspace/Runtime  public revisions, guest worktrees, fencing, Sandbox
        └── Catalog/Registry   manifests, tools, documentation and hashes
```

The benchmark runner owns the outer run, Core slots and finalization. For a registered Bot, Bridge resolves Judge input from a saved numeric revision in the public Mission Workspace. File checks select a path; project checks export the complete revision. Unsaved guest edits are not checker input. Judge persists a CheckResult; the runner records its observation separately from the fenced response delivered to the Bot. Task finish, main merge and fixed-input Mission acceptance are separate decisions. Runtime owns process/session lifecycle and cleanup. Task, Context and Judge own their respective durable facts. Agents choose research actions; Runtime does not choose a mathematical route.

## The three boundaries a reader must keep separate

**Mission and Task** describe responsibility. Mission is a shared objective
and is never taken. A Task represents a separable responsibility and has at
most one effective Execution at a time; a Mission may legally have no Tasks.
Creating a Task does not give the creating Bot management authority.

**Bot, Execution and Session** describe authorization and a running process.
An Execution is durable domain state. A Session is a Pi conversation attached
to a Bot/Core lane. A Bot starts a fresh Sandbox/Pi and performs zero or one
Execution. After finish, handoff or timeout Runtime stops the Bot and destroys
its Sandbox; a later Bot continues only through public Task, Material and
Workspace revision records.

**Material and Workspace** describe different forms of progress. Material is
versioned shared evidence with producer provenance. The Mission Workspace is a
persistent Runtime-owned Git repository; each Execution receives a separate
materialized directory and public revisions are referenced as
`(workspace_id, revision, path)`. A Material count or a Workspace write is
activity evidence, not proof of useful research.

## Normal flow

```text
Bot starts unbound with an empty protected guest project
  → reads capabilities and public Mission/Task/Material/Workspace state
  → prefers suitable existing work; otherwise proposes a bounded Task
  → task_take reserves one Execution in its Core
  → Runtime pins public inputs, prepares the guest, activates E, grants access
  → Agent reads/publishes/consumes Material and edits the guest project
  → Agent explicitly saves a public revision
  → Agent may check that fixed revision through Judge
  → Judge persists the result; the runner records diagnostic evidence
  → Agent may merge a fixed public revision into main under Runtime guards
  → an authorized live Bot may separately submit fixed main and selected Materials
    for trusted Mission acceptance (independent of Task completion)
  → Agent explicitly finishes done, incomplete, blocked or cancelled
  → Runtime confirms process/Sandbox isolation, then releases E and Core
  → a fresh Bot may continue from public state
```

The **flat Mission Task model** is the normal benchmark model; the following chapters label retained lower-level compatibility APIs separately. The benchmark CLI has no Task-model selector, and the Agent/SDK surface exposes Mission Tasks, relations, Materials and Execution progress without Root/Child structure operations. Bots use the read, write, edit and bash tools, with the typed `swarm` CLI routed through their authenticated Bridge to Task, Material, Judge and Workspace operations. They do not receive a second set of domain-native tools.

Within the flat benchmark path, `TaskController` observes eligible work and signals idle `IdentityTaskLoop`s; the Agent chooses its Task through `task_take`. Controller and Runner do not select the mathematical research route. See `src/benchmark/putnam-runner.js`, `src/runtime/task-controller.js`, and `src/runtime/identity-task-loop.js`.

## Current implementation versus acceptance

This guide describes the code shape at the pinned reviewed implementation commit, not automatically every subsequent `main` tree. It does not turn
the target rules in `AGENTS.md` into claims that the code has passed every real
experiment. The implementation matrix and each registered experiment must say
which behavior is deterministic-only, real-probe evidence, natural-run
evidence, or still unknown.
