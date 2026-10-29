# Task-oriented Agent Swarm Task Service

Status: Target design for [Issue #100](https://github.com/LuNa-shi/SwarmEnv/issues/100)

This document defines the Task Service domain contract for the next SwarmEnv
Task-oriented Agent Swarm. The Runtime lifecycle and physical ownership details
are in `docs/design-simplified-task-execution-model.md`.

Issue #87 remains the accepted boundary for Service registration, manifests,
role-scoped capability profiles, and dynamic Agent prompt composition. This
Issue defines the Task Service that #87 registers; it does not redesign the
Service integration layer, choose MCP/gRPC/HTTP, or turn Workspace into an
external Service.

## 1. Purpose and evidence

SwarmEnv must support several Agents examining one Mission from different
perspectives, publishing durable shared Materials, and creating useful new work
when shared knowledge exposes the next question. Every executable
responsibility is the same Task type. A Task may record that another Task led to
its proposal, while scheduling and completion remain independent.

The latest two-hour run persisted 47 Tasks, 62 Executions, 75 Materials, and 3
Candidate/Check results. The control plane claimed and ran work, while the
Root ended `BLOCKED` without a proof-relevant Candidate. The run also recorded
five Root Branch Groups and 34 Required Subtask operations. This evidence points
to an overloaded semantic model and a missing last-mile handoff/acceptance
path, not a missing ability to create more structural records.

The current catalog exposes 34 tools across Task, Execution, Workspace,
Context, Judge, and Catalog. Current prompts include Branch, Required Subtask,
Parent Review, legacy wait, scheduler inspection, and Execution lease details.
#100 removes these unrelated concepts from the normal Task Agent profile.

## 2. Design principles

### 2.1 One Task model

Mission, research, proof, finalization, and coordination are labels or
contracts over one Task entity. There are no Peer Task or Child Task types. If
one Task is proposed from another, the UI may show a source/parent navigation
link, but the new Task has the same permissions, queue, and lifecycle as every
other Task.

### 2.2 Minimal Task relations

The first Task Service has only two Task relations:

```text
spawned_from  proposal provenance; never ownership or approval
depends_on    prerequisite Task; the only relation that affects Claimability
```

`spawned_from` explains why a proposal appeared. It does not make the source
Task responsible for the new Task, able to accept it, or able to schedule it.

`depends_on` means that the dependent Task cannot be Claimed until the
prerequisite condition is satisfied. Dependencies are explicit, visible,
cycle-checked, and part of readiness.

The first version does not add `related_to`, `duplicate_of`, `supersedes`, or
`contradicts` as general Task relations. Material versions and links carry
those meanings when they are needed. Similar work is found by searching short
Task summaries; the Service does not apply an exact `work_scope` lock or a
hidden semantic duplicate detector.

### 2.3 A short summary before creation

A Task proposal must contain a few sentences describing:

- the question and intended angle;
- expected output;
- acceptance condition;
- the boundary that keeps the work from duplicating a known Task;
- optional `spawned_from` and `depends_on` references.

The Agent searches existing summaries before calling `task.create`. The Service
may return likely similar summaries as advisory data. There is no separate
`overlap review` object or required comparison form.

### 2.4 Shared Materials are the collaboration medium

Workspace files remain private to an Execution. Durable cross-Agent information
is published as Material and linked to the relevant Tasks. A Material link is a
pointer, not a private return value and not a copy of the Material content.

### 2.5 Completion has two stages when a directed result is needed

An Agent completes its own Task as `DONE`. If that Task produced a Response
Material for a receiving Task, the receiving Task may later accept that linked
result and move the producing Task to `CLOSED`. Tasks that publish only
Experience Material do not require a downstream close step.

### 2.6 Scheduling is separate from reasoning

Agents decide what work is valuable and when to create it. The Task Controller
maintains readiness. A Core Daemon selects and Claims only when its Core is
idle. Runtime owns the physical Execution and Workspace lifecycle.

## 3. Domain model

### 3.1 Mission

A Mission contains one problem or project goal, optional final acceptance
conditions, a pool of Tasks, Task relations, and Material links. It does not
assign one Task as a central coordinator.

The initial Mission setup creates one or more `OPEN` Tasks before any Agent
Execution starts. A Mission may begin with one final proof Task or several
independent questions; there is no mandatory Root decomposition step.

### 3.2 Task

```text
Task
├── task_id
├── mission_id
├── short summary
├── goal and expected output
├── acceptance conditions
├── optional spawned_from relation
├── optional depends_on relations
├── execution timebox
├── Material links
├── state
└── timestamps
```

The Task contract must be large enough to produce a standalone useful result.
The Service does not use a token count or child quota as a proxy for quality.
The summary and acceptance condition are the Agent's explanation of why the
work deserves a queue slot.

### 3.3 Material roles

Context Service stores one Material abstraction. Every Agent-published Material
records its producer Task and producer Execution, even when no Task link is
added. At minimum this includes `material_id`, `mission_id`,
`producer_task_id`, `producer_execution_id`, `created_at`, role, and immutable
content/version; an Agent Session or actor identifier may add further
provenance. The Task link gives it one of three collaboration roles when a link
exists:

| Role | Purpose | Link requirements |
|---|---|---|
| `response` | directed result for another Task | producer Task/Execution and receiving Task |
| `handoff` | unfinished state for a later attempt | current Task and current Execution |
| `experience` | reusable Mission or library knowledge | producer Task/Execution; Task links optional |

A Task's Materials area is a queryable set of links with roles such as
`input`, `response`, `handoff`, and `experience`. A Material may remain
unlinked, or gain links to several Tasks later, without losing producer
provenance. The Context Service keeps the Material immutable and versioned.
Task Service keeps the links and uses them in completion and notification
decisions.

A Response Material may contain mathematical reasoning, a candidate, a
failure, a fact, or file/checker evidence. The first Task Service does not make
a separate `artifact` validation mode. File evidence can be represented in
Material metadata with its Workspace revision and path when that evidence is
actually needed.

### 3.4 Task state

The new lifecycle uses:

```text
OPEN -> RUNNING -> DONE
  |        |       |
  |        |       +-> CLOSED after receiving Task accepts Response Material
  |        +-> OPEN after valid handoff
  |        +-> BLOCKED after valid blocker and handoff
  +-> CANCELED by explicit decision
```

- `OPEN`: claimable when its `depends_on` conditions are satisfied.
- `RUNNING`: a Core has Claimed it and Runtime owns an active Execution.
- `BLOCKED`: a concrete typed dependency is recorded and no Execution is active.
- `DONE`: the current Execution satisfied the Task's own contract and linked
  its required Materials.
- `CLOSED`: a receiving Task explicitly accepted a linked Response Material. It
  is not a generic administrative archive state.
- `CANCELED`: an explicit cancellation decision.

A Task with no directed Response Material can remain `DONE`. A source relation
never gives another Task the authority to reject its result.

## 4. Agent-facing Task Service

The normal bound Task Agent receives a small semantic surface:

```text
task.list       list Mission Tasks and search summaries
task.view       read one Task, relations, state, Execution, and Material links
task.create     create a substantial Task with a short summary and contract
task.complete   self-complete the current Task
task.handoff    link Handoff Material and return the Task to OPEN
task.block      link Handoff Material and record a typed blocker
task.close      accept a linked Response Material and close its producer
```

`task.create` accepts:

```json
{
  "mission_id": "mission-1",
  "summary": "A few sentences covering the question, angle, and boundary",
  "expected_output": "A result another Task can use",
  "acceptance_conditions": ["A concrete condition that can be checked"],
  "spawned_from": "optional-source-task-id",
  "depends_on": ["optional-prerequisite-task-id"],
  "timebox_ms": 3600000
}
```

The Agent searches `task.list` before creation. A proposal can be a direct
Mission Task or have `spawned_from` provenance; the API does not expose a
second type name.

`task.complete` validates the current Task contract:

- proof/checker-backed Task: Candidate Material plus an applied Judge PASS;
- research/analysis/coordination Task: required Material links;
- a directed Task: required Response Material link to the receiving Task.

`task.handoff` and `task.block` are both release-and-takeover operations. They
require Handoff Material linked to the current Task and Execution, end the
current Execution, and release the Core through the same Runtime protocol. A
normal handoff returns the Task to `OPEN` so another Execution may claim it.
`task.block` records a concrete typed dependency and leaves the Task
`BLOCKED` and unclaimable until reopening. It is a specialized handoff outcome,
not a second ownership model. A bare `execution.release` is not an Agent
option. `task.close` can be called only by the receiving Task's current
Execution after it checks the linked Response Material. The producer cannot
close itself; the receiving operation moves it from `DONE` to `CLOSED` and
records the acceptance evidence.

Context Service exposes only the Material operations needed by the profile:

```text
context.search_materials
context.get_material
context.publish_material
```

Task Material links are created as part of the relevant Task operation or a
small Task Service link operation; the design does not require a manual
`consume_material` ritual for completion.

## 5. Initialization, Claim, and Runtime lifecycle

### 5.1 Initialization

1. The caller creates a Mission.
2. The caller creates initial `OPEN` Tasks with summaries, contracts, timeboxes,
   and initial Material links.
3. Task Service emits Task-created facts.
4. Task Controller computes the claimable projection.
5. No Execution starts until an idle Core Daemon Claims a Task.

### 5.2 Idle Core selection

A Core Daemon only runs selection when its Core is idle:

1. Request a bounded `OPEN` shortlist from Task Service.
2. Optionally run a stateless selection turn.
3. Claim exactly one selected Task.
4. Task Service marks the Task `RUNNING` and creates one Execution.
5. Runtime creates the private Workspace and starts the Agent Session.
6. Daemon waits for completion, handoff, block, expiry, failure, or cancel.
7. Runtime releases physical capacity and Daemon returns to discovery.

A new Task created while all Cores are busy remains `OPEN`. Creating it does
not preempt or block the current Task. If another Core is idle, Task Controller
wakes that Core's Daemon; if none is idle, the Task waits in the queue.

### 5.3 Running Task creates more work

The current Agent may create another Task while continuing its own Execution.
The new Task has no Execution until a Core Daemon later Claims it. The current
Task remains `RUNNING` until the Agent completes, hands off, blocks, reaches its
deadline, fails, or is canceled.

This is the key distinction from a parent-controlled tree: Task creation and
Execution release are separate decisions.

## 6. Timebox, handoff, and notifications

### 6.1 Deadline and warning

Every Execution receives a bounded execution deadline and an earlier handoff
warning. The first benchmark profile uses a 30-minute Execution timebox and a
warning at 25 minutes. The Mission wall-clock timebox remains separate (the
full experiment may still run for two hours), and Runtime keeps the duration
configurable. The generic Runtime's existing 60-minute/55-minute defaults can
remain in place until the benchmark profile is selected.

Runtime persists the warning and queues a follow-up prompt after the current
Agent turn:

```text
This Execution is approaching its deadline. Publish Handoff Material now if
useful work is unfinished. Include what was tried, evidence, current state,
open questions, checkpoint information, and the recommended next step.
```

Runtime must not start a concurrent second turn for the same Session.

### 6.2 Explicit handoff

```text
task.handoff(handoff_material_id)
  -> Execution terminal as HANDED_OFF (new target state)
  -> Task returns to OPEN
  -> Core becomes idle

task.block(blocker, handoff_material_id)
  -> Execution terminal as HANDED_OFF (new target state)
  -> Task becomes BLOCKED
  -> Core becomes idle
```

A Handoff Material is mandatory before voluntary handoff, block, or unfinished
release. It must capture the exploration, reasoning, evidence, checkpoint
reference when applicable, open questions, and recommended next step. The Agent
should publish useful Response or Experience Material throughout the work when
it reaches a durable finding, failed approach, decision, or reusable insight;
the warning is a last chance to hand off, not the first time Material should
be written.

At the deadline Runtime may force `EXPIRED` cleanup when the Agent did not
handoff. The report records a typed timeout, the last durable checkpoint, and
`handoff_missing=true` when no Handoff Material exists. Runtime never creates a
synthetic system Handoff Material. Forced cleanup is not treated as a
successful handoff.

The current Runtime already has deadline sweeping, handoff reminder,
checkpoint, and physical cleanup seams. Its current persistence uses the
legacy `FENCED` terminal state for some handoff paths. #100 adds a typed
`HANDED_OFF` terminal state/reason for voluntary handoff and block, retains
`FENCED` for stale-owner and forced-cleanup protection, and makes the mandatory
Task Material link visible in Task state and reports.

### 6.3 Notifications

The first notification path is system-generated and keyed, not an arbitrary
Agent chat tool:

```text
Task/Context event
  -> Notification addressed to recipient Task/Execution
  -> active recipient Session receives safe follow-up prompt
  -> inactive recipient sees the notification in the next initial prompt
```

Initial notification types:

- `handoff_warning`: generated before the Execution deadline;
- `material_available`: a Response Material was linked to a receiving Task;
- `task_reopened`: a typed blocker was satisfied and the Task became claimable.

Notifications are at-least-once with a stable delivery key. The Agent reads the
Material through Context Service; the notification gives its location and why
it may matter. A durable pending notification is required when no recipient
Execution is active.

## 7. Runtime internals and Workspace

### 7.1 Heartbeat, release, and fencing

These operations are physical Runtime boundaries, not normal Agent tools:

- **Heartbeat** refreshes liveness while Runtime owns a running Execution. It
  may be automatic.
- **Physical release** stops the Session and releases the private Workspace
  after Task Service has recorded a terminal transition.
- **Fencing** increments an ownership version so a stale Session cannot write
  after restart, timeout, or handoff. A late write with an old version is
  rejected.

The existing internal `FENCED` Execution state remains for stale-owner,
restart, and forced-cleanup paths. #100 explicitly removes normal-Agent access
to `execution.heartbeat`, `execution.release`, and `execution.fence`; it does
not delete the internal safety code.

### 7.2 Workspace initialization

The current Workspace Manager creates a common scaffold for every Execution:
`README.md`, Workspace and Runtime manifests, metadata/revision directories,
Pi settings, and Task-provided inputs such as formal source when available.
It does not create a complete customized environment for every mathematical
route.

#100 keeps Workspace private and optional. Materials carry the shared reasoning.
A Task does not require a Workspace artifact to complete. Sandbox and Bash are
separate Runtime decisions. File or checker evidence can be published as
Material metadata with a Workspace revision/path when needed.

## 8. Prompt and capability guidance

The static prompt should say:

```text
You are an Agent in a shared Task-oriented Swarm.

Complete the current Task's goal and acceptance conditions. Read the Task
summary, linked Materials, pending notifications, and relevant private
Workspace state before choosing the next useful action.

Before creating another Task, search existing Task summaries. Create work only
when the question is substantial, has a clear expected output and acceptance
condition, and is not already covered. Continue the current Task after creating
work unless you explicitly complete, hand off, or block it.

Publish Response Material for a receiving Task, Handoff Material before
unfinished handoff/block, and Experience Material for reusable knowledge.
Publish useful Material during the work when a durable result, important fact,
failed approach, decision, or reusable experience is worth preserving; do not
defer all publication until a deadline reminder. Complete your own Task. A
receiving Task closes a producer only when it accepts a linked Response
Material.

Claim, heartbeat, lease, physical release, fencing, Core status, and process
lifecycle belong to the Daemon and Runtime.
```

Runtime adds dynamic information:

- Mission goal and final acceptance conditions;
- current Task summary, expected output, acceptance conditions, and deadline;
- linked Materials and pending notifications;
- available Task summaries;
- optional private Workspace state;
- role-scoped Service capabilities from #87;
- valid complete, handoff, block, and close operations.

The prompt must not inject Branch counts, Required Subtask counts,
parent-review loops, artifact completion requirements, or lease-management
instructions.

## 9. GitHub Issue-inspired surface

The Task Service can borrow these useful Issue concepts:

- Task summary/body provides the goal and acceptance contract.
- Mission provides project scope.
- Labels may describe Task kind or validation mode.
- Current Execution is the physical assignee; Agent identity is not permanent
  Task ownership.
- The two Task relations and Material links replace Branch/Parent structure.
- Append-only Task events provide a timeline.
- `DONE` is self-owned completion; `CLOSED` records explicit acceptance of a
  Response Material.

Human review and approval assumptions are not copied into every Task.

## 10. Acceptance and observability

Use the production boundary through Task Service, Task Controller/Core Daemon,
Runtime Execution, Context Material, notification delivery, Workspace, and
Judge. Do not validate this design only through private database helpers.

Deterministic acceptance must show:

1. Mission initialization creates `OPEN` Tasks without starting Executions.
2. A new Task waits `OPEN` while all Cores are busy.
3. Tasks with and without `spawned_from` use the same queue and Claim path.
4. Only `depends_on` affects Claimability.
5. A running Agent creates another Task and continues its current Execution.
6. Handoff or block without Handoff Material is rejected.
7. Valid handoff returns the Task to `OPEN` and releases the Core.
8. Valid block leaves the Task `BLOCKED`, records a typed dependency and the
   Material link, and prevents claim until reopening.
9. Handoff and block use the same release protocol; only post-release readiness
   differs.
10. Deadline warning is delivered once without a concurrent prompt.
11. Expiry records whether Handoff Material was missing and creates no
    synthetic system Material.
12. Response, Handoff, and Experience records retain producer Task and
    producer Execution provenance; Experience may be unlinked.
13. Response Material notification reaches active and inactive recipients using
    the two delivery paths.
14. A Task completes itself as `DONE`; a receiver can move it to `CLOSED` only
    through accepted Response Material, never by producer self-close.
15. Proof completion requires Candidate Material plus Judge PASS. Research and
    coordination complete through Material without an artifact mode.
16. Runtime rejects a stale Workspace write carrying an old fence version.
17. Reports distinguish Task, Execution, Material, notification, Workspace,
    and Judge identity.

The real-Agent fixture should show:

```text
Mission creates initial OPEN Tasks
  -> idle Core Claims one Task
  -> Agent creates another Task and continues
  -> Agent publishes Response or Experience Material
  -> recipient receives a notification when appropriate
  -> Agent completes or hands off with Handoff Material
  -> another idle Core Claims remaining OPEN work
  -> receiving Task accepts Response Material when required
  -> proof Task gets Judge PASS or the run records an honest typed blocker
```

The first acceptance run has two layers:

1. A 30-minute deterministic lifecycle fixture (warning at 25 minutes) covers
   creation while an Execution is running, progressive Material publication,
   Response delivery, active/inactive notification, handoff, block, reopening,
   `DONE`, and downstream `CLOSED`.
2. A proof fixture separately covers Candidate Material plus Judge PASS, or
   records an honest typed blocker. Response acceptance is not silently made a
   prerequisite for every proof Task.

## 11. Explicit removals and non-goals

The #100 implementation must explicitly retire these Agent-facing concepts and
code paths:

- Branch Group and Required Subtask creation;
- Parent Review and rework as the normal completion path;
- the `overlap review` vocabulary and payload;
- Peer Task and Child Task as distinct Task types;
- the `artifact` Task validation mode and any completion requirement based on a
  Workspace artifact; file evidence remains representable as Material;
- normal-Agent access to `execution.heartbeat`, `execution.release`, and
  `execution.fence`.

The implementation must retain these internal mechanisms unless a later issue
explicitly replaces them:

- liveness heartbeat and lease expiry;
- physical process/Workspace release after a durable terminal transition;
- fencing versions and internal `FENCED` cleanup state;
- existing Workspace path safety and revision checks;
- current Context Material storage and Judge checker boundary.

Also outside #100 are #87 Service Manifest/Registry changes, a central semantic
scheduler, exact `work_scope` locking, embeddings/vector retrieval, Sandbox
technology, native Bash exposure, shared mutable Workspace, new physical Core
states, and a general Agent chat service.

## 12. Resolved boundaries and implementation defaults

The feedback review resolves the semantic choices that were previously listed
as open:

1. `task.handoff` and `task.block` both release the current Execution and make
   takeover possible. Handoff returns the Task to `OPEN`; block records a typed
   dependency and leaves it `BLOCKED` until reopening.
2. A producer Task cannot close itself. Only the receiving Task's current
   Execution can accept a linked Response Material and close the producer.
3. Every Agent-published Material records its producer Execution. Response and
   Handoff roles require the relevant Task link; Experience may have no Task
   link or gain links later.
4. Timeout cleanup never creates a system Handoff Material. It records the
   timeout, last checkpoint, and explicit missing-handoff fact when no Material
   exists.
5. The first benchmark Execution profile is 30 minutes with a warning at 25
   minutes. The Mission wall-clock timebox remains separate, and generic
   Runtime defaults remain configurable.

The service boundary is concrete: the Agent first calls Context Service to
publish Handoff Material, then calls Task Service with its `material_id`.
Task Service atomically validates that the Material exists, has the current
Task and Execution as producer, links it, records the terminal transition, and
releases the Execution. A missing or foreign Material rejects the transition.
If the second call fails, the Material remains an auditable but unlinked
Material; the system does not synthesize a replacement. Notifications use
at-least-once delivery with a stable idempotency key, and the first blocker
taxonomy is limited to real Task dependencies.
