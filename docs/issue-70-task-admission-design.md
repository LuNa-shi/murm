# Issue 70: Task admission and backpressure contract

Status: Proposed design draft. This document is intentionally limited to the
admission boundary and its relationship with the two runtime roles. It does
not change Runtime behavior.

## Decision

Task Service is the only authority that may accept a new Task or structural
Task relation. An Agent may propose work, but it cannot reserve capacity by
writing a partial Task. The admission decision is one atomic operation:

1. validate the proposal;
2. read the current root, execution, turn, and responsibility counters;
3. either commit the Task and its relations together, or commit nothing;
4. return a structured result that records the accepted budget deltas.

A failed admission does not put the current Execution into a waiting state and
does not implicitly block its parent.

## Counter scopes

Every Root Task has an admission policy captured in its durable configuration.
The policy contains the limits below. A limit change is itself an audited
policy update; it is not an untracked runtime constant.

### Root unfinished-task limit

The root scope contains the Root Task and all descendants reachable through
the structural parent relation. The unfinished count includes Tasks in
`OPEN`, `RUNNING`, and `BLOCKED`. It excludes `DONE`, `CLOSED`, and
`CANCELED`.

A child proposal is accepted only when:

```
unfinished_count + 1 <= max_unfinished_tasks
```

The Root is counted. This makes the limit describe the total live problem
surface rather than only the children visible in the queue.

### Root OPEN limit

The OPEN count includes only Tasks in the same root scope whose state is
`OPEN`. It is the claimable queue bound:

```
open_count + 1 <= max_open_tasks
```

A Task moving from `BLOCKED` to `OPEN` is also an admission event. If
reopening would exceed the bound, it remains `BLOCKED` with a typed
`BACKPRESSURE_OPEN_LIMIT` reason and is reconsidered when an OPEN Task reaches
a terminal state. A controller must not silently drop the reopen event.

### Execution child-creation limit

An Execution receives a cumulative child-creation budget when it starts. The
counter increases only after a child creation is committed. An idempotent
retry with the same operation key returns the original result and does not
consume another unit. A child that is later canceled still consumed a unit;
otherwise an Agent could bypass the limit by creating and canceling repeatedly.

A new Execution gets its own child budget. The Root unfinished and OPEN limits
remain the global safety boundary across retries.

### Agent-turn structural mutation limit

Every Agent turn has a stable `turn_id`. Task Service records the number of
successful structural mutations for that turn. The following count:

- create a child Task;
- add, remove, or change a Task dependency;
- cancel or reopen a Task;
- change a structural parent or responsibility relation.

The following do not count:

- Workspace revision writes;
- Material publication or reads;
- checker evidence and ordinary execution heartbeats.

An idempotent retry of an already committed operation does not increment the
counter. Once the limit is reached, further structural writes from that turn
return `BACKPRESSURE_TURN_MUTATION_LIMIT`.

## Required Task contract

A child proposal must contain non-empty, bounded fields for:

- `goal`: the responsibility to be completed;
- `expected_output`: the durable result that will be produced;
- `acceptance_condition`: how the child can self-validate;
- `responsibility_key`: a stable scope key used for duplicate detection.

If the task depends on another Task, the dependency expression and the
evidence/result delivery path must be present in the same proposal. Missing or
placeholder contracts fail with `INVALID_TASK_CONTRACT`, before any budget is
consumed.

## Duplicate responsibility

The first version rejects duplicate responsibility. Task Service enforces a
unique `(root_task_id, responsibility_key)` among non-canceled Tasks, and
returns:

```
DUPLICATE_RESPONSIBILITY {
  existing_task_id,
  responsibility_key
}
```

The caller may reuse the existing Task or explicitly propose a separately
named rework responsibility. Automatic merging is out of scope because it
would have to rewrite identity, dependencies, Workspace lineage, and
acceptance evidence in one operation. A future merge operation must be a
separate, reviewable design.

## Aging and fairness

An OPEN Task records `ready_since` when it first becomes claimable. The
claimable projection has two parts:

1. a protected aging floor containing the oldest OPEN Task that has exceeded
   the configured aging threshold;
2. a bounded value-selection set for the Agent's active choice.

If a protected Task exists, Task Service returns it as a required candidate.
A claim for a younger Task is rejected with `FAIRNESS_REQUIRED` until the
protected Task is claimed, canceled with a reason, or otherwise reaches a
terminal state. The claim response names the protected Task. This is the hard
part of the rule: a stream of newly created high-value-looking children cannot
starve an old Task forever.

When no protected Task exists, the daemon may pass a bounded shortlist to its
Agent, which chooses by current value and Context. A successful claim resets
the Task's aging status only because ownership changed; a failed Execution
does not erase the Task's original ready time when it is reopened.

The exact threshold and whether the floor is global or per Root are policy
questions. The invariant is not: an OPEN Task that stays eligible long enough
must eventually become the next required claim.

## Typed backpressure response

Every admission rejection is a normal, structured service result. It includes:

```json
{
  "ok": false,
  "error": {
    "code": "BACKPRESSURE_ROOT_OPEN_LIMIT",
    "dimension": "root_open",
    "observed": 24,
    "limit": 24,
    "retry_when": {
      "event": "task_terminal_or_open_slot",
      "scope": "root",
      "root_task_id": "..."
    }
  }
}
```

The codes are distinct so an Agent can choose the next action:

- `BACKPRESSURE_ROOT_UNFINISHED_LIMIT`;
- `BACKPRESSURE_ROOT_OPEN_LIMIT`;
- `BACKPRESSURE_EXECUTION_CHILD_LIMIT`;
- `BACKPRESSURE_TURN_MUTATION_LIMIT`;
- `FAIRNESS_REQUIRED`;
- `DUPLICATE_RESPONSIBILITY`;
- `INVALID_TASK_CONTRACT`.

Backpressure is not a sleep instruction. The current Execution may continue its
own Task, reuse an existing Task, cancel a proposal, or explicitly declare a
real dependency and release its Task as `BLOCKED`. The service never chooses
among those meanings on the Agent's behalf.

## Concurrency and recovery

The admission check and all writes it authorizes run in one transaction or
equivalent serialized compare-and-swap. Two daemons racing for the last slot
cannot both succeed. A lost race returns the same typed limit error and the
caller rescans.

The operation requires an idempotency key scoped to the proposing Execution.
A repeated key returns the original accepted Task or original rejection result
when the relevant version is unchanged. Stale Task, Execution, or policy
versions return the repository's normal conflict error and do not alter
counters.

## Relationship with the two runtime roles

The Task Controller evaluates dependency expressions, maintains the OPEN
projection, and observes daemon health. It does not rank work or create
children.

A Core Daemon asks for a bounded claimable view. Its Agent chooses a Task and
calls `claim(task_id)`. Task Service enforces leases, the aging floor, and
all admission limits. The daemon then starts one fresh Execution Session and
returns to discovery when that Execution ends.

This preserves active value selection without allowing an Agent to turn
unbounded task creation into a substitute for execution.

