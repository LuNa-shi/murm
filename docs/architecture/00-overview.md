# 00. Overview

SwarmEnv runs one or more Agent identities against a Mission through a small,
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

**Mission and Task** describe responsibility. A shared Mission Task can be
continued by multiple Executions. An ordinary Task represents a separable
responsibility and normally has one effective Execution at a time. Creating an
ordinary Task does not give the creating identity management authority.

**Execution and Session** describe authorization and a running Agent process.
An Execution is durable domain state. A Session is a Pi conversation attached
to an identity/Core lane. A reusable identity can perform several Executions in
sequence; a new Session is not automatically a new research responsibility.

**Material and Workspace** describe different forms of progress. Material is
versioned shared evidence with producer provenance. Workspace is the private,
mutable file surface of one Execution, with revisions and optional local Git
lineage. A Material count or a Workspace write is activity evidence, not proof
of useful research.

## Normal flow

```text
Agent reads capability profile and Mission/Task state
  → task_take in its own Core lane
  → Runtime binds one Execution and private Workspace
  → Agent reads/publishes/consumes Material and edits Workspace
  → Agent may register a genuinely independent ordinary Task
  → Agent submits a Workspace candidate through the registered Judge Service
  → Judge checks and persists a CheckResult; the Bridge returns it synchronously and the runner records its projection
  → Agent revises, checkpoints, completes, blocks, or hands off
  → Runtime fences/releases this Execution
  → the same identity may take another responsibility
```

The **flat Mission Task model** is the only runtime Task model described by this architecture. The benchmark CLI has no Task-model selector, and the Agent/SDK surface exposes Mission Tasks, relations, Materials and Execution progress without Root/Child structure operations. The normal bound profile uses named Task, Context, Judge, Workspace and Runtime capabilities.

Within the flat benchmark path, `TaskController` observes claimable work and signals idle `IdentityTaskLoop`s; the Agent chooses its Task through `task_take`. Controller and Runner do not select the mathematical research route. See `src/benchmark/putnam-runner.js`, `src/runtime/task-controller.js`, and `src/runtime/identity-task-loop.js`.

## Current implementation versus acceptance

This guide describes the code shape at the pinned reviewed implementation commit, not automatically every subsequent `main` tree. It does not turn
the target rules in `AGENTS.md` into claims that the code has passed every real
experiment. The implementation matrix and each registered experiment must say
which behavior is deterministic-only, real-probe evidence, natural-run
evidence, or still unknown.
