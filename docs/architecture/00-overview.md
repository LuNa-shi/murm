# 00. Overview

SwarmEnv runs one or more Bot lifecycles against a Mission through a small,
task-scoped service surface. The system has four different responsibilities:

```text
Agent Core / Pi session
        │ named tools and prompt contract
        ▼
Services Bridge + Capability Profile
        │ authenticated, task-scoped calls
        ├── Task Service       Mission, Task, Execution facts
        ├── Context Service    Material and consumption facts
        ├── Judge Service      checker execution and CheckResult facts
        ├── Workspace/Runtime  private files, revisions, fencing, Sandbox
        └── Catalog/Registry   manifests, tools, documentation and hashes
```

The benchmark runner owns the outer run, Core lanes and finalization. The Agent-facing Bridge reads the current Workspace source and invokes Judge directly; the runner only records the returned CheckResult and applies the existing Task completion projection.
Runtime owns process/session lifecycle and physical cleanup. Domain Services
own authoritative Task, Execution, Material and Judge state. The Agent chooses
research actions through the exposed tools; the Runtime does not choose a
mathematical route.

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
Bot reads capability profile and public Mission/Task/Material/Workspace state
  → task_take in its own Core lane
  → Runtime binds one Execution and private Workspace
  → Agent reads/publishes/consumes Material and edits Workspace
  → Agent may register a genuinely independent ordinary Task
  → Agent submits a Workspace candidate through the registered Judge Service
  → Judge checks and persists a CheckResult; the Bridge returns it synchronously and the runner records its projection
  → Agent revises, checkpoints, completes, blocks, or hands off
  → Runtime fences/releases this Execution
  → Runtime stops the Bot; a fresh Bot may continue from public state
```

The **flat Mission Task model** is the only runtime Task model described by this architecture. The benchmark CLI has no Task-model selector, and the Agent/SDK surface exposes Mission Tasks, relations, Materials and Execution progress without Root/Child structure operations. The normal bound profile uses named Task, Context, Judge, Workspace and Runtime capabilities.

Within the flat benchmark path, `TaskController` observes eligible work and signals idle `IdentityTaskLoop`s; the Agent chooses its Task through `task_take`. Controller and Runner do not select the mathematical research route. See `src/benchmark/putnam-runner.js`, `src/runtime/task-controller.js`, and `src/runtime/identity-task-loop.js`.

## Current implementation versus acceptance

This guide describes the code shape at the pinned reviewed implementation commit, not automatically every subsequent `main` tree. It does not turn
the target rules in `AGENTS.md` into claims that the code has passed every real
experiment. The implementation matrix and each registered experiment must say
which behavior is deterministic-only, real-probe evidence, natural-run
evidence, or still unknown.
