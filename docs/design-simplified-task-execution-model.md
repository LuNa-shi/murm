# Task-oriented Agent Swarm: Task, Execution, Core, and Runtime model

Status: Target model for [Issue #100](https://github.com/LuNa-shi/SwarmEnv/issues/100)

This document describes the Runtime-facing part of the Task-oriented Agent
Swarm. It is a design target, not a claim that the current Task Service
already implements every operation below. Issue #87 remains the Service
registration and role-scoped capability boundary; this document does not
redesign it.

## 1. What is changing

The current repository already has useful physical seams:

- Task Service persists Tasks, Executions, completion contracts, and Materials
  referenced by Tasks.
- Task Controller reconciles claimability and signals idle Core Daemons.
- Core Daemon obtains a bounded shortlist, runs an optional selection turn,
  Claims one Task, and hands the resulting Execution to Runtime.
- Runtime creates a private Workspace, starts an Agent Session, tracks liveness,
  and performs terminal cleanup.
- Runtime already has a configurable execution deadline and a handoff warning;
  the warning is sent to the active Session as a queued follow-up prompt.
- Context Service persists immutable Materials with Task and Execution
  provenance.
- Judge validates Candidate Materials for checker-backed contracts.

The current semantic model still exposes Root, Branch Group, Required Subtask,
Parent Review, rework, and legacy wait operations. The target keeps the
physical Core/Daemon/Runtime lifecycle and replaces the Agent-facing semantic
model with one Mission-scoped pool of identical Tasks.

The target must make these facts explicit:

- A Task created during an Execution does not automatically stop or block that
  Execution.
- A Core Daemon selects work only when its Core is idle. A new `OPEN` Task waits
  in the queue when all Cores are busy.
- An Agent must leave durable Handoff Material before voluntarily handing off,
  blocking, or releasing an unfinished Execution.
- A finished Task becomes `DONE` from its own Agent's action. A receiving Task
  may later accept a linked Response Material and move that producing Task to
  `CLOSED`.
- Runtime can send a deadline warning and a Material-available notification to
  a running Session without starting a concurrent turn.
- Runtime fencing is an internal stale-owner protection mechanism. It is not a
  normal Agent operation and it is not the same thing as handoff.

## 2. Target architecture

```text
                              Mission
                   goal + Task pool + acceptance
                              |
       +----------------------+----------------------+
       |                                             |
  Task Service                                  Context Service
  Tasks, two relations,                    Materials, versions,
  contracts, status,                       search, provenance
  Material links                                  |
       |                                             |
       +----------------------+----------------------+
                              |
                       Task Controller
              claimability, reopen, notification routing
                              |
                   Core Daemon when Core is idle
                    shortlist -> selection -> Claim
                              |
                            Runtime
           Execution deadline + Session + private Workspace
                              |
                         Bound Agent
      work, create Task, publish Material, complete/handoff/block
                              |
                  Judge when the Task contract requires it
```

The responsibilities are separate:

- **Agent** decides what useful work to do, whether to create another Task,
  what Material to publish, and whether its own Task is complete or needs a
  handoff.
- **Task Service** records Task summaries, the two Task relations, status,
  Task Material links, completion, handoff, block, and downstream close.
- **Context Service** stores and searches Materials. It does not own Task
  status or Workspace files.
- **Task Controller** reconciles durable facts and wakes idle Daemons. It does
  not choose semantic work.
- **Core Daemon** selects and Claims one `OPEN` Task for one idle Core.
- **Runtime** starts and stops the Execution, enforces the deadline, maintains
  liveness, owns the private Workspace, and delivers notifications.
- **Judge** checks Candidate Materials only when the Task contract requires it.

No component owns a recursive Task tree.

## 3. Current implementation versus target

| Concern | Current implementation | Target for #100 |
|---|---|---|
| Mission scope | `root_id` and one Root Task | Mission containing one pool of identical Tasks |
| Task origin | `parent_id`, creation provenance, Branch/Required-Subtask structure | Optional `spawned_from` provenance relation |
| Task creation | `create_child_task`, Branch Group, Required Subtask, rework | One `task.create` with a short summary and optional relation |
| Similar work | Responsibility keys and admission counters exist in legacy code | Agent searches Task summaries; no hidden semantic duplicate lock |
| Task relations | Several structure and dependency paths | Only `spawned_from` and `depends_on` are semantic Task relations |
| Claim loop | Daemon shortlist, selection, Claim | Same physical loop across the Mission Task pool |
| Core availability | Daemon waits after a handoff and Controller wakes idle Daemons | New Tasks remain `OPEN` until an idle Core can Claim them |
| Handoff | Runtime has deadline, reminder, checkpoint, and handoff code | Handoff Material and Task Material link are required before voluntary release/block |
| Notifications | Same-Execution handoff reminder exists; no durable cross-Task Material inbox | Material-available notifications to active Sessions plus pending delivery |
| Completion | Completion contract, Materials, Candidate/Check, and legacy parent acceptance | `DONE` is self-completion; `CLOSED` is downstream acceptance of Response Material |
| Context | Immutable Material publish/read/consume ledger | Mission-scoped Materials with explicit Task links and three collaboration roles |
| Workspace | Runtime-owned private Execution Workspace and revisions | Keep private; make it optional for Task contracts and remove artifact Task mode |
| Fencing | Runtime/Task Service use fencing versions and `FENCED` terminal state | Keep internal for stale-owner safety; remove from Agent-facing vocabulary |
| Prompt | Root/Branch decomposition and legacy lifecycle instructions | Small Swarm SOP plus dynamic Task/Material/deadline/notification context |

The table is an implementation map. It deliberately says which existing
surfaces are retained internally and which Agent-facing concepts are retired;
it does not pretend that the current legacy Task API already implements #100.

## 4. Minimal domain model

### 4.1 Mission and Task

A Mission is the scope of one problem or project. Every executable
responsibility is one ordinary Task:

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
├── Task Material links
└── state and timestamps
```

The summary is a few sentences. It should state the question, intended angle,
and boundary clearly enough for another Agent to search for similar work. The
Agent searches before creating a Task; the Task Service does not require a
separate overlap form and does not decide natural-language equivalence through
an opaque lock.

A final proof Task is still an ordinary Task. It can read Materials, create a
new Task, continue its own work, publish a result, and submit a Candidate when
its contract requires one.

### 4.2 The only two Task relations

The first Task Service keeps only the relations needed for scheduling and
provenance:

```text
spawned_from  proposal provenance; never ownership or approval
depends_on    prerequisite Task; the only relation that affects Claimability
```

`A spawned_from B` says that B's work led Agent A to propose A. It does not
make B a controller, reviewer, scheduler, or owner of A. The UI may describe B
as the source Task or parent for navigation, but A is still the same Task type
with the same permissions and lifecycle.

`A depends_on B` says that A cannot be claimed until the dependency condition
on B is satisfied. A dependency is explicit, cycle-checked, and visible in the
Task view. A source relation alone never blocks a Task.

Contradictions, superseding conclusions, and repeated ideas are represented by
Material versions and Material links in the first version. They do not require
more Task relation kinds. Similarity is handled by Task summary search and
Agent judgment rather than a hidden global deduper.

### 4.3 Material roles and Task links

Context Service stores one Material abstraction. Every Agent-published Material
records where it came from, even when no Task link is added. At minimum the
record contains `material_id`, `mission_id`, `producer_task_id`,
`producer_execution_id`, `created_at`, the Material role, and the immutable
content/version. The producer Execution is mandatory for Material published by
an Execution; an optional Agent Session/actor identifier makes the source even
more precise. The collaboration role is explicit in the Task link when a link
exists:

| Role | Meaning | Required link |
|---|---|---|
| `response` | result prepared for another Task | producer Task/Execution and receiving Task |
| `handoff` | unfinished reasoning and state needed by a later attempt | current Task and current Execution |
| `experience` | reusable insight for the Mission or wider library | producer Task/Execution; Task links optional |

Each Task has a queryable Materials area. A link records `task_id`,
`material_id`, role, producer provenance, and optional receiving Task. A
Material may have no Task link at all, or may later be linked to several Tasks;
that choice does not erase its producer provenance. The Material remains
immutable and shared; linking it does not copy or mutate its content.

Response Material is optional. If a Task was created to produce a result for
another Task, its completion contract requires a response link. If it was
created to contribute a reusable insight, an Experience Material may remain in
the shared library without any Task link. If it cannot finish, Handoff Material
is required before the Execution is released.

### 4.4 Task states and downstream acceptance

The target Task states are:

```text
OPEN -> RUNNING -> DONE
  |        |       |
  |        |       +-> CLOSED when a receiving Task accepts a Response Material
  |        +-> OPEN after a valid handoff
  |        +-> BLOCKED after a valid typed blocker and handoff
  +-> CANCELED by an explicit decision
```

`DONE` is self-owned completion. The current Execution satisfies its own
contract and links the required Materials. No other Agent is needed to make
that result durable.

`CLOSED` is different. It is used only when another Task explicitly needed a
Response Material and its current Execution accepts that Material. The
receiving Task may call the close operation against the producing Task after
checking the linked response. Tasks that publish Experience Material or only
finish their own local contract stay `DONE`; they do not need a meaningless
close step.

## 5. Initialization, Claim, and Execution lifecycle

### 5.1 Mission initialization

Initialization happens before any Agent Execution is started:

1. The benchmark or caller creates a Mission with its goal and final
   acceptance conditions.
2. It creates one or more initial `OPEN` Tasks with summaries, expected output,
   acceptance conditions, timeboxes, and initial Material links.
3. Task Service commits those Tasks and emits Task-created events.
4. Task Controller reconciles the claimable projection.
5. No Execution exists until an idle Core Daemon Claims a Task.

An initial Mission can start with one final Task or several independent Tasks.
There is no mandatory Root decomposition step.

### 5.2 Core availability and Claim

The Core Daemon runs this loop:

1. If its Core is busy, it does not select another Task.
2. When its Core is idle, it asks Task Service for a bounded `OPEN` shortlist.
3. An optional selection turn chooses one Task ID from that shortlist.
4. The Daemon calls Claim. Task Service is the ownership boundary.
5. A successful Claim marks the Task `RUNNING` and creates one Execution.
6. Runtime materializes the private Workspace and starts the Agent Session.
7. The Daemon waits until the Execution completes, hands off, blocks, expires,
   fails, or is canceled, then releases physical Core capacity.
8. The Daemon returns to idle discovery.

If a running Agent creates another Task, the new Task is simply `OPEN`. The
current Task and Execution remain `RUNNING`. Task Controller may wake a
different idle Core, but it never interrupts the current Agent. If no Core is
idle, the new Task waits in the queue.

Creating work is therefore independent from releasing work. The current Agent
continues unless it explicitly completes, hands off, blocks, or reaches its
deadline.

### 5.3 Bound Execution and task creation

Once Runtime starts an Execution, the Agent receives:

- the current Task summary, goal, expected output, acceptance conditions, and
  timebox;
- the Task's linked input, response, handoff, and experience Materials;
- the private Workspace state when the Task uses Workspace;
- pending notifications for the Task;
- the small role-scoped capability profile.

During the turn, the Agent may:

1. work directly on the current Task;
2. search Task summaries and create another Task when a substantial uncovered
   question is worth independent work;
3. publish Response or Experience Material, including intermediate findings
   when they are useful to another Agent;
4. consume a notification and revise its plan;
5. complete, hand off, or block the current Task.

Creating another Task does not create a nested Execution immediately. The
Daemon and Core availability determine when that Task is claimed.

## 6. Timeboxes, handoff, release, and fencing

### 6.1 Timebox and warning

Every Execution has a bounded execution deadline and an earlier handoff
warning. The first benchmark fixture uses a 30-minute Execution timebox and a
warning at 25 minutes, five minutes before expiry. The Mission wall-clock
timebox remains independent (the current full run is two hours). Runtime keeps
the duration configurable so a generic deployment can retain its existing
60-minute/55-minute defaults until the benchmark profile is selected.

At the warning, Runtime persists that the warning was sent and queues a
follow-up prompt to the active Session:

```text
This Execution is approaching its deadline. Publish Handoff Material now if
useful work is unfinished. Include what was tried, evidence, current state,
open questions, and the recommended next step. Continue only if the remaining
time is likely to produce a useful result.
```

The follow-up is queued after the current Agent turn. Runtime never starts a
second concurrent prompt for the same Session.

### 6.2 Voluntary handoff and block

The target Agent-facing lifecycle has two explicit unfinished paths:

```text
task.handoff(handoff_material_id)
  -> Execution terminal as HANDED_OFF (new target state)
  -> Task returns to OPEN
  -> Core becomes idle

task.block(blocker, handoff_material_id)
  -> Execution terminal as HANDED_OFF (new target state)
  -> Task becomes BLOCKED with a typed dependency
  -> Core becomes idle
```

Both operations are release-and-takeover operations: they end the current
Execution and return the Core to the Daemon. They require a Handoff Material
linked to the current Task and Execution. The Material must contain the useful
exploration, current reasoning, evidence, checkpoint reference when applicable,
open questions, and a recommended next step. A bare release without this link
is rejected.

Their only semantic difference is readiness after release:

- `task.handoff` means the Task is unfinished but another Execution may try it
  now. The Task returns to `OPEN` and is claimable when a Core is idle.
- `task.block` means a concrete typed dependency prevents useful progress. The
  Task becomes `BLOCKED` and is not claimable until the dependency is satisfied
  and Task Controller reopens it. `task.block` is therefore a specialized
  handoff outcome, not a second ownership model.

The existing Runtime code has `handoffExecution`, checkpoint persistence,
deadline sweeping, and Workspace cleanup. Its current persistence uses the
legacy `FENCED` terminal state for some handoff paths. #100 introduces the
typed `HANDED_OFF` terminal state/reason for voluntary handoff and block, while
retaining `FENCED` for stale-owner and forced-cleanup protection. The Agent-
facing contract makes the Handoff Material link mandatory and visible in Task
state and reports.

At the deadline, Runtime may force expiry to release physical capacity when the
Agent did not hand off. The resulting `EXPIRED` Execution is recorded with a
typed timeout reason, the last durable checkpoint, and
`handoff_missing=true` when appropriate. Runtime does not synthesize a system
Handoff Material. If the Agent published none, there is no Handoff Material;
the report records that absence explicitly. Forced expiry must not be reported
as a successful handoff.

### 6.3 What heartbeat, release, and fence mean

These are Runtime internals, not normal Agent tools:

- **Heartbeat** refreshes the liveness lease while Runtime owns a running
  Execution. The Session or Runtime adapter can perform it automatically.
- **Release** stops the Agent process and releases the private Workspace after
  Task Service has already recorded a terminal transition. It is physical
  cleanup, not a semantic decision about Task work.
- **Fence** increments the ownership version so a stale process cannot write
  after a restart, timeout, or handoff. For example, if Session E1 is stalled
  and Runtime starts a replacement, E1's late Workspace write carries the old
  version and is rejected. The Agent never chooses a fence.

The existing internal `FENCED` Execution state remains useful for stale-owner,
restart, and forced-cleanup paths. #100 removes `execution.heartbeat`,
`execution.release`, and `execution.fence` from the normal Agent profile; it
does not delete the Runtime safety mechanisms.

## 7. Material delivery and runtime notifications

### 7.1 Material flow

The three Material roles define the collaboration flow:

```text
Response Material
  producer Task -> linked to receiving Task
  receiving Execution reads it -> may accept -> producer Task CLOSED

Handoff Material
  current Task/Execution -> linked to itself
  next Execution reads it -> continues the Task from durable state

Experience Material
  producer Task/Execution -> Mission Context library
  any Agent searches it -> changes its own plan or proposes work
```

The Task link is the meaning of “贴到 Task 上”. It is a durable reference,
not a copy of the Material and not a private return value visible only to a
parent.

### 7.2 Notification mechanism

The target adds a small Runtime notification path rather than a general Agent
chat service:

```text
Task/Context event
  -> Notification record with delivery key and recipient Task
  -> Task Controller/Runtime checks recipient Execution
  -> active Session receives a queued follow-up prompt
  -> inactive Task receives the notification in its next initial prompt
```

The first notification types are:

1. `handoff_warning`: generated five minutes before the Execution deadline;
2. `material_available`: generated when a Response Material is linked to a
   Task that has an active Execution;
3. `task_reopened`: generated when a typed blocker is satisfied and a Task is
   claimable again.

Notifications are at-least-once with a stable delivery key. The recipient
Agent must be able to read the Material itself; the notification only tells it
where the new information is and why it may matter. If a receiving Task is
running, Runtime uses the existing safe `followUp` prompt behavior. If it is
not running, the notification is stored until the next Execution starts.

The first version does not expose an arbitrary `send_message` tool to Agents.
System-generated lifecycle and Material notifications cover the required
coordination path while keeping the Agent tool surface small.

## 8. Workspace boundary and initialization

Workspace is private Runtime state, not a shared Material store and not an
external Service under #87.

The current Workspace Manager initializes every new Execution with a common
scaffold: `README.md`, `workspace-manifest.json`, `runtime-manifest.json`,
metadata/revision directories, and Pi settings. A Task can add specific inputs
such as a formal source file and problem path. The current implementation does
not create a fully customized environment for each mathematical route.

For #100:

- Workspace remains available for private scratch files, formal inputs, and
  checker operations when a Task needs them.
- Materials remain the primary collaboration path for research and proof
  reasoning.
- A Task does not need a Workspace artifact in order to complete.
- There is no separate `artifact` validation mode or `artifact Task` in this
  issue. If a file or checker output matters, the Agent publishes it as a
  Material with the relevant Workspace revision/path metadata.
- Sandbox and Bash decisions remain outside this issue.

This explicitly removes the proposed `artifact` Task validation path from
#100. It does not delete the existing `artifact` Material kind or the Runtime
Workspace file operations; those are retained until a later, explicit Runtime
change decides otherwise.

## 9. Agent prompt and capability model

### 9.1 Static Swarm SOP

The stable prompt should say:

```text
You are an Agent in a shared Task-oriented Swarm.

Complete the current Task's goal and acceptance conditions. Read the Task's
summary, linked Materials, pending notifications, and private Workspace state
before choosing the next useful action.

Before creating a Task, search existing Task summaries. Create work only when
the question is substantial, has a clear expected output and acceptance
condition, and is not already covered. A new Task may record spawned_from
provenance, but every Task uses the same queue and lifecycle.

After creating a Task, continue the current Task unless you explicitly hand
off or block it. Publish useful Material during the work whenever you reach a
durable result, important fact, failed approach, decision, or reusable
experience; do not defer all materialization until the deadline reminder.
Publish Response Material for a receiving Task, Handoff Material before
unfinished release/block, and Experience Material for reusable knowledge.
Complete your own Task; another Agent closes it only when a linked Response
Material requires downstream acceptance.

Claim, heartbeat, lease, release, fencing, Core status, and process lifecycle
belong to the Daemon and Runtime. Use the Task handoff/block operations when
unfinished work must leave the Core.
```

This is guidance, not a fixed decomposition loop. The Agent may solve the
current Task directly, create another Task, publish Material, respond to a
notification, revise its plan, complete, or hand off according to the current
evidence.

### 9.2 Dynamic Execution projection

Runtime composes the SOP with:

- Mission goal and final acceptance conditions;
- current Task summary, goal, expected output, acceptance conditions, and
  deadline;
- linked Materials and pending notifications;
- private Workspace manifest and revision only when the Task uses Workspace;
- available Task summaries for the Mission;
- role-scoped Service capabilities from #87;
- the valid completion, handoff, and block operation for this Task.

It must not inject Branch counts, Required Subtask counts, parent-review loops,
artifact completion requirements, or lease-management instructions into a
normal Task Session.

### 9.3 Role separation

The selection Session sees only a bounded Task shortlist and selection
operation. The bound Task Session sees Task proposal/view/complete/handoff/
block/close, Material operations, optional Workspace operations, and Judge
operations when the Task contract requires them. Claim, heartbeat, release,
fence, Core status, and process lifecycle remain behind the Daemon/Runtime
boundary.

## 10. Target Agent-facing interfaces

The exact names remain an implementation choice, but the normal semantic
surface is:

```text
task.list                 list Mission Tasks and search summaries
task.view                 read one Task, status, relations, and Material links
task.create               create a substantial Task with a short summary
task.complete             self-complete the current Task
task.handoff              publish-linked unfinished handoff and return to OPEN
task.block                publish-linked handoff and record a typed blocker
task.close                receiving Task accepts a linked Response Material

context.search_materials  search shared Materials
context.get_material      read one Material
context.publish_material  publish a response, handoff, or experience Material

workspace.*               available only when the Task needs private files
judge.*                   available only when the Task contract requires it
```

The Agent does not call `task.claim`, `execution.heartbeat`,
`execution.release`, or `execution.fence`. The Daemon and Runtime use those
internal boundaries to enforce physical ownership and cleanup.

## 11. Observability requirements

Reports must show the Mission Task pool and the two-relation graph separately.
For each Task, record:

- summary, expected output, acceptance conditions, and timebox;
- `spawned_from` and `depends_on` events;
- Task state transitions and Execution identity;
- each Material link, role, producer, and receiving Task;
- handoff warning, handoff Material, timeout, and blocker evidence;
- notification creation, delivery, and acknowledgement;
- Workspace revision only when it is part of the Task evidence;
- Candidate and Judge results when required.

The report must distinguish:

```text
Task created
Task claimed while a Core was idle
Execution worked
Task created additional work
Material published and linked
Material notification delivered or queued
Task completed itself -> DONE
Receiving Task accepted Response Material -> CLOSED
Task handed off or blocked with Handoff Material
Execution expired with or without handoff evidence
Mission-level result reached
```

Counts of Tasks, Materials, Claims, or tool calls are not proof of useful
collaboration.

## 12. Acceptance seam

The highest-value integration path is:

```text
Mission initialization
  -> Task Service OPEN Task pool
  -> idle Core Daemon shortlist and Claim
  -> Runtime Execution + private Workspace
  -> Agent creates work or publishes Material
  -> handoff/complete/block and Material links
  -> notification to a running or future Execution
  -> receiving Task reads a Response Material and may close its producer
```

Deterministic tests should cover:

1. Mission initialization creates `OPEN` Tasks without starting Executions.
2. A new Task remains `OPEN` while every Core is busy.
3. An idle Core claims Tasks with and without `spawned_from` through the same
   queue.
4. A running Agent creates another Task and continues its current Execution.
5. Only `depends_on` blocks claimability; `spawned_from` never does.
6. A voluntary handoff without linked Handoff Material is rejected.
7. A valid handoff returns the Task to `OPEN` and releases the Core.
8. A valid block requires Handoff Material, records a typed dependency, and
   leaves the Task `BLOCKED` and unclaimable until reopening.
9. Handoff and block both end the current Execution through the same release
   protocol; only the post-release readiness differs.
10. A deadline warning is delivered once, five minutes before expiry, without a
    concurrent prompt.
11. An expired Execution records whether Handoff Material was missing and does
    not create a synthetic system Handoff Material.
12. Response, Handoff, and Experience Material records retain producer Task and
    producer Execution provenance; Experience may be unlinked or linked later.
13. A Response Material notification reaches an active Session as a follow-up
    and reaches an inactive Task on its next start.
14. A Task completes itself as `DONE`; a receiver can close it only through an
    accepted Response Material.
15. A proof Task still requires Candidate plus Judge PASS; research work uses
    Material completion without an artifact validation mode.
16. Runtime rejects a stale Workspace write carrying an old fence version.
17. Reports preserve Task, Execution, Material, notification, Workspace, and
    Judge identity separately.

The public real-Agent fixture should show:

```text
Mission creates initial OPEN Tasks
  -> idle Core claims one Task
  -> Agent creates another Task and continues
  -> Agent publishes Experience or Response Material
  -> recipient receives a notification
  -> Agent completes or hands off with Handoff Material
  -> next idle Core claims the remaining OPEN Task
  -> receiver accepts a Response Material when required
  -> proof Task receives Judge PASS or the run records an honest typed blocker
```

The fixture must not require fixed Branch Groups, Required Subtasks, separate
Peer/Child Task types, parent-review loops, artifact validation, or a repeated
decomposition prompt.

## 13. Explicit removals and non-goals

The #100 implementation must explicitly retire these Agent-facing legacy
concepts and code paths:

- Branch Group and Required Subtask creation;
- Parent Review and rework as the normal completion path;
- the separate `overlap review` payload and vocabulary;
- Peer Task and Child Task as distinct Task types;
- the `artifact` Task validation mode and any requirement that completion use a
  Workspace artifact; file evidence remains representable as Material;
- normal-Agent access to `execution.heartbeat`, `execution.release`, and
  `execution.fence`.

The implementation must retain these internal Runtime safety mechanisms unless
a later issue explicitly replaces them:

- liveness heartbeat and lease expiry;
- physical process/Workspace release after a durable terminal transition;
- fencing versions and the internal `FENCED` state for stale-owner and
  restart cleanup;
- the existing Workspace file safety checks;
- the current Context Material storage and Judge checker boundary.

Also outside this issue are Service Manifest/Registry changes in #87, a
central semantic scheduler, exact `work_scope` locking, embeddings/vector
retrieval, Sandbox technology, native Bash exposure, and shared mutable
Workspaces.

## 14. Resolved boundaries and implementation defaults

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

The first acceptance run uses two layers rather than an ambiguous choice about
one proof flow:

1. A deterministic lifecycle fixture exercises Task creation while an
   Execution is running, progressive Material publication, Response delivery,
   active/inactive notifications, voluntary handoff, typed block, reopening,
   `DONE`, and downstream `CLOSED`.
2. A proof fixture separately exercises Candidate Material plus Judge PASS (or
   records an honest typed blocker). It does not make Response acceptance a
   hidden prerequisite for every proof Task.

The service boundary is concrete: the Agent first calls Context Service to
publish Handoff Material, then calls Task Service with its `material_id`.
Task Service atomically validates that the Material exists, has the current
Task and Execution as producer, links it, records the terminal transition, and
releases the Execution. A missing or foreign Material rejects the transition.
If the second call fails, the Material remains an auditable but unlinked
Material; the system does not synthesize a replacement. Notification delivery
uses at-least-once semantics with a stable idempotency key. The first typed
blocker set remains limited to real Task dependencies; broader external-
condition taxonomies can follow after this lifecycle is verified.
