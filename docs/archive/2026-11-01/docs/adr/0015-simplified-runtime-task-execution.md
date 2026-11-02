# ADR 0015: Simplify normal runtime orchestration around Task Controller and Core Daemons

Status: accepted for Issue #70. This ADR supersedes ADR 0009's waiting-Core
reassignment rule and the older normal-flow `WAITING`/parent-review
assumptions. Legacy Task records and contracts remain readable; a legacy
waiting Execution can resume only on its stored Core binding (or without a
prior Core binding) through the compatibility path.

## Context

The runtime previously spread responsibility across a Scheduler, Agent claim
turns, Runtime binding, and Task Service wait/resume transitions. That made a
released Core look occupied, allowed a blocked Task to retain an active
Execution, and made it difficult to distinguish a Session restart from a new
Task attempt. The durable Task Service already owns the facts needed to make
the lifecycle checkable.

## Decision

- The Task Controller is the deterministic reconciliation role. It observes
  committed Task Service events, checks dependency and admission conditions,
  reopens eligible blocked Tasks idempotently, and signals idle Core Daemons.
  It never ranks or claims Tasks.
- Each reusable Core has one Core Daemon. The Daemon obtains a bounded
  claimable shortlist, runs the stateless selection turn, validates the
  selected ID against that shortlist, claims the Task, and hands the resulting
  Execution to Runtime. A claim conflict has a bounded rescan and never
  becomes an unbounded retry.
- Runtime is the execution substrate. It materializes Workspace, starts and
  supervises the bound Task Session, handles leases, fencing, recovery, and
  release, and does not choose Tasks.
- A normal-flow Execution is one attempt for one Task and one Core. A Session
  restart retains its Execution ID; a later claim after release creates a new
  Execution ID. A blocked Task has no active Execution and consumes no Core.
- Normal-flow dependency blocking records a typed Task, Material, or
  CheckResult dependency in the Task structure before ending the Execution.
  The Task's `block_reason` identifies that dependency, and only such
  dependency blocks are automatically reopened by reconciliation. Legacy
  opaque block reasons require an explicit reopen operation.
- Normal-flow child Tasks validate their own completion contract and reach
  `DONE`; parent review remains available only for legacy contracts that
  explicitly request it.
- Execution `WAITING` remains a compatibility path for old evidence and
  contracts. It does not create a semantic Core `WAITING` projection in the
  normal-flow benchmark.

## Consequences

The queue has one durable authority and one value-selection boundary. Core
capacity is reusable after every terminal or dependency-blocked attempt, while
Session recovery remains visible as the same Execution. Controller events give
low-latency wakeups and the periodic sweep remains the repair path. Reports can
separate Task, Execution, Core, and Session evidence without inferring state
from utilization alone.

The compatibility boundary is explicit: old records may still be resumed or
reviewed through their stored contract, but new normal-flow writes use typed
dependencies, `BLOCKED`, and `DONE`.
