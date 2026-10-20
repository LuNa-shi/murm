# Issue 28: scope and acceptance plan

Status: proposed execution plan

This document freezes the functional scope for Issue 28. It is the working
contract for implementation and acceptance; changes outside this scope must
be opened as a separate issue or explicitly approved as a scope change.

## 1. Problem statement

Issue 28 is about making four reusable Agent Core slots execute queued Task
work with observable, auditable scheduling. It is **not** a project to improve
PutnamBench solve rate, redesign the Task/Workspace model, or continuously tune
Agent prompts.

The acceptance question is:

> When independent Task work exists, can four reusable Cores consume it
> without accidentally serializing the root, and can the report prove what
> each Core was doing?

## 2. Frozen functional scope

### 2.1 Task creation

- A project starts with exactly one Root Task.
- The runner does not pre-create proof children.
- An Agent may create a direct child whenever it discovers a real independent
  sub-goal with a concrete goal, expected output, acceptance condition, and
  required result.
- Child creation is **not gated by current Core capacity**. The Task queue may
  accumulate work; four Cores claim work as slots become available.
- The system must reject empty, cosmetic, duplicate, or contract-incomplete
  child Tasks.

### 2.2 Core ownership

There are exactly four reusable Core slots for a project.

- A Core with no claimable Task is `IDLE` (possibly using bounded backoff or an
  event-driven retry). Empty work is not semantic `WAITING`.
- A Core does not create a new permanent Agent for every Task. A reusable
  discovery session claims work; Runtime then starts a bound Agent Execution in
  the selected Workspace.
- A successful claim transfers one Task/Execution responsibility to one Core.
  Concurrent claims are resolved transactionally; losing claims are structured
  conflicts and must not cause unbounded rapid retry.
- When a Task is released, the Core returns to the global ready pool and may
  claim any other ready Task in the same root tree.

### 2.3 Parent and child execution

Creating a child does not, by itself, require the parent to call
`request_wait`.

The normal flow is:

```text
parent runs
  -> creates independent child
  -> parent continues its own work
  -> child runs independently
  -> child publishes a Material/candidate/result
  -> parent receives an observable notification
  -> parent reads and integrates the child result
```

`request_wait` is reserved for a concrete blocking dependency. A parent may
wait for a child only when it cannot make useful independent progress, or when
its completion contract explicitly requires that dependency. A newly-created
child alone is not sufficient reason to wait.

Child completion must produce a durable Task Service event or equivalent
observable result. The minimum required behavior is:

- a running parent observes the result on a subsequent turn;
- a parent without an active turn receives a scheduler follow-up turn;
- a parent in semantic `WAITING` is resumed only when its typed wait condition
  is satisfied;
- the parent consumes the child result and performs the existing review action
  (`accept_task` or `request_rework`) when the contract requires review.

This is a focused completion-notification mechanism, not a general event bus.

### 2.4 Waiting and scheduling

The existing Runtime-owned wait model remains authoritative:

- `request_wait` persists a checkpoint and typed dependency;
- Runtime releases the physical Core capacity;
- the waiting responsibility is not claimable by another Agent;
- child or other ready Tasks can use released capacity;
- the same Execution lineage is woken/resumed when its condition is met;
- an unsatisfied wait must not be bypassed by creating a replacement root
  Execution.

`IDLE`, `WAITING`, and `RUNNING` must remain distinct in both behavior and
reports.

## 3. Metrics and evidence

### 3.1 Hard metric: Agent Time utilization

Issue 28 has one hard performance metric:

```text
agent_time_utilization_v0
  = sum(valid Agent turn time across all Cores)
    / (core_count * measured experiment elapsed time)
```

A valid Agent turn is time during which a bound Agent session is actively
executing a Task turn. The following are excluded:

- empty-queue discovery and scheduler polling;
- Task claim conflicts and transport/handoff;
- `IDLE` and semantic `WAITING`;
- Judge/checker time, which is reported separately;
- cleanup after the experiment deadline.

The numerator must come from non-overlapping, per-Core audited
`agent_turn_intervals`; the broader `core_state_intervals` remain the slot
lifecycle evidence. The metric must satisfy these deterministic cases:

- four Cores active for the complete window: `1.0`;
- two Cores active for the complete window: `0.5`;
- one Core doing serial work while three are idle/waiting: `0.25`.

A low value must be explainable as either insufficient ready work or unused
capacity. It must not be inflated by keeping an idle Execution or Pi process
alive.

### 3.2 Supporting diagnostics

These are diagnostic evidence, not additional success metrics:

- `ready_work_ms`: time for which claimable work existed;
- `ready_unassigned_ms`: time for which ready work existed without enough Core
  assignment;
- `core_state_intervals`: per-Core `IDLE`, `ASSIGNED`, `RUNNING`, `WAITING`,
  and `STOPPING` slot intervals;
- `agent_turn_intervals`: non-overlapping intervals for effective bound Agent
  turns, which are the source for `agent_time_ms`;
- `concurrency_histogram_ms` and active-Core counts;
- scheduler polling, claim conflicts, Judge time, and turn occupancy;
- wait/wake/resume and parent-review lifecycle events;
- deterministic work-unit and output fingerprints, including `duplicate_of`.

The two ready-work fields must distinguish a supply problem from a scheduler
problem. They must not be used to claim successful parallelism on their own.

### 3.3 Repository provenance

Every experiment and sanitized report must record, at minimum:

- SwarmEnv repository commit captured at experiment start;
- clean/dirty state captured at experiment start;
- PutnamBench commit and problem hash;
- Lean, Mathlib, checker, provider/model, Core count, timebox, and report path.

The report must be independently attributable to the code that produced it.

## 4. Implementation plan and gates

### Gate 1: Freeze documentation and provenance

- Update README and benchmark walkthroughs to describe one Root Task and
  Agent-created children.
- Remove language claiming that the runner pre-creates four children.
- Add repository commit and dirty-state fields to experiment metadata and
  sanitized reports.
- Add tests for report provenance.

Exit condition: documentation and report schema agree with the implementation,
and a report can be traced to one clean commit.

### Gate 2: Correct Core-time measurement

- Separate active bound Agent turn intervals from process lifetime,
  discovery, polling, WAITING, and Judge time.
- Ensure per-Core intervals do not overlap or silently leave unexplained gaps.
- Export the intervals and derived utilization in the report.
- Add deterministic tests for `1.0`, `0.5`, and `0.25` utilization and for
  excluded time categories.

Exit condition: utilization can be recomputed from `agent_turn_intervals`
and the slot intervals within the documented timestamp precision.

### Gate 3: Queue and Core scheduling

- Remove any child-creation capacity precondition.
- Keep a global ready queue; allow queue accumulation.
- Keep empty Cores IDLE with bounded backoff/event-driven retry.
- Allocate ready Tasks globally per scheduler cycle.
- Ensure released capacity can claim existing child work without replacing a
  still-waiting parent responsibility.

Exit condition: a deterministic fixture with one Root and at least three
independent children produces simultaneous work on multiple Cores without
pre-created children or unbounded claim conflicts.

### Gate 4: Parent continuation and child notification

- Make parent continuation the default after child creation.
- Add the minimal durable child-completion notification/follow-up path.
- Wake/resume a waiting parent only for a satisfied typed dependency.
- Ensure the parent can read the child result and perform accept/rework.
- Preserve Task, Execution, checkpoint, and Workspace lineage.

Exit condition: a deterministic fixture demonstrates parent work continuing
while a child runs, child completion becoming visible to the parent, and
correct review without a replacement root claim.

### Gate 5: Controlled real-Agent validation

Run a short real-Agent experiment from a clean, recorded commit only after
Gates 1–4 pass. The experiment is evidence of integration, not a mathematical
solve-rate benchmark.

It must demonstrate, where the selected problem produces independent work:

- Agent-created children, not runner-created children;
- multiple child claims and multiple Core contributions;
- explainable IDLE/RUNNING/WAITING intervals;
- at least one child-result notification and parent review;
- at least one candidate -> Judge -> CheckResult -> follow-up cycle;
- `protocol_valid=true` and no boundary/placeholder violations.

If the problem naturally supplies no independent route, the report must record
that fact and must not manufacture cosmetic children to improve utilization.

## 5. Explicit non-goals and scope freeze

The following are out of scope for Issue 28:

- guaranteeing that a Putnam problem is solved;
- optimizing mathematical proof strategy or model quality;
- changing the number of Cores beyond four;
- pre-creating children to manufacture parallelism;
- adding semantic/model-based duplicate-proof judgment;
- redesigning Task, Workspace, Material, Judge, or Agent Core primitives;
- replacing Runtime-owned WAITING semantics with an unrelated mechanism;
- adding a general-purpose event bus;
- using more polling, heartbeats, duplicate candidates, or extra prompts to
  inflate utilization;
- changing #26 waiting semantics or #27 review semantics except where needed
  to integrate them into this scheduler;
- adding new performance targets after implementation begins without recording
  an explicit scope change.

Issue 28 is complete only when the deterministic gates pass, provenance and
parallelism evidence are present, and the controlled real-Agent run confirms
the integrated behavior. A successful or unsuccessful mathematical solve is
not the completion criterion.

## 6. Required validation commands

```sh
npm test
npm test -- --runInBand
```

The focused scheduler, utilization, report, wait/resume, notification, and
parent-review tests must also be runnable independently. Real-Agent reports
must be generated from a clean dedicated worktree and linked to the exact
commit recorded in their metadata.
