# SwarmEnv Context

SwarmEnv is a local-first runtime for durable, checkable Agent work. The
Task-oriented Agent Swarm model is defined by [Issue #100](https://github.com/LuNa-shi/SwarmEnv/issues/100)
and `docs/design-task-oriented-agent-swarm-task-service.md`. The Runtime
boundary and lifecycle proposal are described in
`docs/design-simplified-task-execution-model.md`.

The vocabulary below describes the target model. The current implementation
already has Task Service, Task Controller, Core Daemon, Runtime Execution,
private Workspace, Context Material, and Judge seams. It still exposes legacy
Root/Branch/Required-Subtask operations. Those are code surfaces to retire in
#100; they are not the target Agent model.

**Mission** is the shared objective scope for one problem or project. It owns a
goal, optional final acceptance conditions, and a pool of ordinary Tasks. A
Mission does not make one Task the manager of all other Tasks.

**Task** is one durable responsibility in a Mission. Every Task uses the same
model and lifecycle. A Task has a short summary, goal, expected output,
acceptance conditions, optional source relation, optional Task dependencies,
timebox, and Material links. A Task may create another Task while it is
running; that does not change the current Task's ownership or lifecycle.

**Task summary** is the few-sentence description used to understand what a
Task covers and what it deliberately leaves open. Agents search existing Task
summaries before creating new work. The Service does not require a separate
overlap form or decide semantic duplication through a hidden lock.

**Task relation** has only two target forms:

- `spawned_from` records which existing Task led to a proposal. It is
  provenance, not ownership, approval, or scheduling control.
- `depends_on` records a prerequisite Task whose result is required before the
  dependent Task can be claimed. It is the only Task relation that affects
  Claimability.

Contradictory conclusions, superseding conclusions, and repeated ideas are
represented through Material content and links. They do not need additional
Task relation kinds in the first Task Service.

**Material** is immutable, versioned shared work stored by Context Service. A
Material can be linked to one or more Tasks and has producer Task/Execution
provenance. The three collaboration roles are:

- **Response Material** is a result prepared for another Task. Its link names
  the receiving Task. A receiving Task may later accept the response and close
  the producing Task when that response is part of the receiving contract.
- **Handoff Material** records unfinished exploration, reasoning, evidence,
  checkpoint information, open questions, and a recommended next step. It is
  linked to the producing Task and Execution. A voluntary release or block
  requires this Material first.
- **Experience Material** is reusable knowledge for the Mission or wider
  Context library. It may be useful to many Tasks and does not require one
  receiving Task.

**Task Material links** are the Task's durable materials area. A link records
the Material, its role (`input`, `response`, `handoff`, or `experience`), the
source Task/Execution, and, for a Response Material, the receiving Task. A
link is a reference; it does not copy Material content into the Task.

**Task states** are `OPEN`, `RUNNING`, `BLOCKED`, `DONE`, `CLOSED`, and
`CANCELED`. `DONE` means the current Agent has satisfied the Task's own
contract. `CLOSED` means a receiving Task has explicitly accepted a linked
Response Material; it is used when downstream acceptance matters and is not a
generic administrative cleanup state. A Task with no Response Material
contract can remain `DONE` without being `CLOSED`. `BLOCKED` means the Task has
a concrete typed dependency and no active Execution. An empty queue is
`IDLE`, not `BLOCKED`. Older state spellings remain readable as migration
evidence until the legacy implementation is retired.

**Execution** is one bounded attempt to work on one Task. Runtime binds it to a
Core, Agent Session, and private Workspace. Runtime assigns a start time,
handoff-warning time, and execution deadline. A normal handoff ends the
Execution and returns its Task to `OPEN`; a blocked handoff ends the Execution
and leaves the Task `BLOCKED`. A timeout ends the Execution as expired and
records whether a required Handoff Material was missing.

**Handoff** is an explicit transfer of useful unfinished work. Before a
voluntary handoff, release, or block, the Agent publishes Handoff Material and
links it to the current Task and Execution. `task.handoff` returns an unfinished
Task to the claimable queue. `task.block` records a typed dependency and leaves
the Task blocked. Runtime may force an expiry at the deadline when the Agent
did not hand off; the report must distinguish that forced cleanup from a valid
handoff.

**Notification** is a runtime-delivered update associated with a Task or
Execution. The first target notifications are a handoff warning and a
Response Material available event. If the recipient Execution is active,
Runtime queues a follow-up prompt after the current Agent turn. If it is not
active, the notification remains pending and is included in the next initial
prompt. Delivery has a stable key so retries do not create duplicate logical
messages.

**Core slot** is reusable physical worker capacity. It has no semantic Task
ownership and no Task-level blocked state.

**Core Daemon** is the long-lived supervisor for one Core slot. It asks Task
Service for a bounded `OPEN` shortlist only when its Core is idle, optionally
runs a stateless selection turn, Claims one Task, starts the Runtime
Execution, waits for that Execution to end, and then returns to discovery. A
new Task created while all Cores are busy remains `OPEN`; it does not preempt a
running Execution.

**Task Controller** is the deterministic reconciliation loop. It observes
committed Task, dependency, Material-link, and notification events, updates
the claimable projection, reopens eligible blocked Tasks, and signals idle Core
Daemons. It never chooses semantic work or Claims a Task.

**Runtime** owns Execution deadlines, Session startup, Workspace access,
heartbeat/liveness bookkeeping, terminal cleanup, and notification delivery.
Runtime lifecycle operations are not normal Agent tools.

**Workspace** is the private, versioned working surface of an Execution. The
current Workspace Manager creates a common scaffold (`README.md`, manifests,
runtime settings, and metadata) for each Execution and adds Task-specific
inputs such as formal source when provided. Workspace is useful for private
scratch files and checker inputs; shared collaboration happens through
Materials. No Task completion contract requires a separate artifact Task in
this model.

**Execution fencing** is an internal Runtime safety mechanism. When an old
Session may still write after a restart, timeout, or ownership transition,
Runtime increments a fencing version and rejects writes carrying the old
version. `FENCED` is an internal Execution terminal state/reason, not an Agent
decision and not the name of a normal handoff operation. The #100 Agent profile
does not expose `execution.fence`.

**Judge** independently validates a Candidate Material for Task kinds that
require a checker. A passing result is bound to the Task, Execution input, and
checker environment. Research and coordination Tasks complete through their
Material contracts without an unnecessary Judge call.

**Service** is an independently owned capability provider with a versioned
public contract. Issue #87 defines Service registration, manifests, role-scoped
profiles, and dynamic capability discovery. Task Service defines Task state,
relations, Material links, completion, handoff, blocking, and close operations.

## Observability and diagnosis

**Experiment** is one complete observed run of one Mission. It includes Core
slots, Agent Sessions, Executions, Tasks, Materials, Workspace revisions,
Judge results, notifications, and Service activity.

**Core lane** is the time-ordered view of one reusable Core slot. Core
occupancy, Agent turn time, Handoff time, notification delivery, and Task
lifecycle are reported separately.

**Interaction** is one ordered exchange in an Agent Session, including Agent
messages, capability calls, results, follow-up notifications, lifecycle
events, and diagnostics.

**Observation Event** is append-only evidence for monitoring and diagnosis. It
is correlated with Mission, Core, Agent Session, Task, Execution, Material,
and notification IDs when known. Domain Services remain authoritative for
Task, Execution, Material, Judge, and Workspace state.

**Diagnostic Finding** is an evidence-linked, typed conclusion about an
Experiment or one of its parts. A diagnostic Agent can create a normal Task
and publish its conclusion as Experience Material.

**Eligible window** is a reporting interval with enough independent unfinished
work for the configured Core slots to execute concurrently. It helps interpret
parallelism; it is not a solve criterion.

**Deterministic test scenario** is a bounded fixture with known Tasks,
expected capability calls, notification conditions, and completion states. It
exercises production Task, Runtime, Context, Workspace, and Judge seams
without deciding whether a research result is mathematically valuable.
