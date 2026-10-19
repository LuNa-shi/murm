# ADR 0009: One root task with reusable core slots

- Status: Accepted
- Date: 2026-10-18
- Supersedes: the static four-child execution shape described in the first
  version of the PutnamBench walkthrough

## Decision

Each PutnamBench problem creates exactly one root Task. The benchmark's four
cores are reusable worker slots. A slot claims an available Task from the
root's queue; the successful claim atomically creates one Execution and binds
the slot to that leased responsibility.

The root Task owns the problem Workspace and its requirements. The
problem formalization is written into that Workspace during Task creation. It
is not published as a Context Service Material. Context Service remains the
shared channel for later observations, proposals, artifacts, and judge
feedback.

An active parent Execution creates direct child Tasks through the Task Service
when it needs decomposition. Child Tasks enter the same root queue. A child
may itself create children while it is active. `max_children` is a safety
bound, not a switch that disables decomposition; proof Tasks use the normal
positive default unless their contract explicitly proves that no child is
needed.

A core slot is released when its Execution waits, succeeds, fails, or is
fenced after lease expiry. Waiting preserves the Task, Workspace, checkpoint,
and responsibility lineage. A later explicit claim either hands a ready
waiting Execution to the next Agent or creates a new Execution according to
the retry policy after fencing/expiry. An Execution is therefore a lease over
a Task, not a permanent identity for a core.

Raw experiment evidence is stored below the experiment directory, including
service logs, agent logs, Runtime state, SQLite, Workspaces, and checker
records. Sanitized reports are written below a separate report directory and
never include candidate source, proof text, raw transcript, stdout, or stderr.

## Consequences

- Parallelism is expressed by available core slots and queue claims, not by
  preassigning four permanent proof Tasks.
- The Task Service must expose a queue claim operation that can select a Task
  without a caller already knowing its Task ID.
- Runtime must materialize the Task's Workspace for the newly created Execution
  and must release capacity on wait and expiry.
- Reports must audit the root tree and Execution leases rather than assuming
  four fixed Task IDs.
- Durable raw records can contain sensitive or answer-bearing working data, so
  they stay in the local private experiment tree and are excluded from Git.
