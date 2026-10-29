# Task-oriented Agent Swarm: Task, Execution, Core, and Runtime model

Status: Target model for [Issue #100](https://github.com/LuNa-shi/SwarmEnv/issues/100)

This document defines how the Task-oriented Agent Swarm runs through the
existing Core Daemon and Runtime seams. It is a design target, not a claim that
the current Task Service already implements every operation described here.
Issue #87 defines the Service registration and role-scoped capability boundary;
this document does not redesign that boundary.

## 1. Why the runtime model changes

The current runtime already has useful physical lifecycle seams:

- Task Service persists Tasks, dependencies, Executions, and completion facts.
- Task Controller reconciles claimability and signals idle Core Daemons.
- Core Daemon obtains a bounded shortlist, runs a selection turn, Claims one
  Task, and hands the resulting Execution to Runtime.
- Runtime owns Execution leases, fencing, Session startup, and private
  Workspace materialization.
- Context Service persists shared Materials with source Task and Execution
  provenance.
- Judge validates configured Candidate evidence.

The current Task Service and Agent prompt still organize semantic work as a
Root-led tree. They expose Branch Groups, Required Subtask Groups, parent
review, rework, and several overlapping dependency paths. The latest
Task-oriented model keeps the physical Daemon/Runtime lifecycle but replaces
the semantic control structure with a Mission-scoped Task pool and relation
graph.

The target must answer these questions without making the Root an implicit
manager:

- Which substantial work is already being explored?
- Which Agent owns the current Task attempt?
- Why was a new Task proposed, and how is it different from existing work?
- Which shared Documents changed what another Agent can do?
- Is this Task complete according to its own contract?
- Which Task or Document dependency currently blocks it?
- Which Core is physically available to run the next Task?

## 2. Target architecture

```text
                         Mission
              goal + acceptance + Task pool
                         |
       +-----------------+------------------+
       |                                    |
  Task Service                         Context Service
  Tasks, relations,                   Documents/Materials,
  contracts, state,                    search, versions,
  claimable projection                 source/result links
       |                                    |
       +-----------------+------------------+
                         |
                  Task Controller
             readiness reconciliation/wake
                         |
                 Core Daemon per Core
             shortlist -> selection -> Claim
                         |
                       Runtime
       Execution lease + Session + private Workspace
                         |
                    Bound Agent
       work, publish, propose Task, complete/block
                         |
                    Judge (when required)
```

The boundaries are deliberate:

- **Agent** reasons about the Mission, current Task, Context, and next useful
  action.
- **Task Service** records Tasks, contracts, relations, overlap reviews, and
  self-owned completion.
- **Context Service** stores shared Documents/Materials and their provenance.
- **Task Controller** reconciles persisted readiness and wakes idle Daemons.
- **Core Daemon** selects and Claims one executable Task for one Core.
- **Runtime** starts and fences the Execution and owns the private Workspace.
- **Judge** validates only Task kinds that require an independent check.

No component owns a complete recursive task tree.

## 3. Current implementation versus target model

| Concern | Current implementation | Target for #100 |
|---|---|---|
| Mission scope | `root_id` and one Root Task | Mission containing a flat executable Task pool |
| Task origin | `parent_id`, creation provenance, Branch/Required-Subtask groups | Optional `origin_task_id` and explicit relation graph |
| Task creation | `create_child_task`, `create_branch_group`, `add_required_subtask`, rework | One substantial `task.create` proposal with optional origin |
| Duplicate avoidance | Optional responsibility keys and admission counters | Agent-authored overlap review; Service advisory search, no hidden semantic deduper |
| Claim loop | Core Daemon selection and Task Service Claim | Same physical loop over all Mission Tasks |
| Readiness | Task state plus explicit dependency and legacy structure logic | Only explicit `depends_on` affects Claimability |
| Completion | Completion contract plus generic Material/Candidate/Check paths | Self-owned, Task-kind-specific validation |
| Context | Immutable Material publish/read/consume ledger | Mission-scoped Documents/Materials with Task input/result links |
| Workspace | Runtime-owned private Execution Workspace and revisions | Same boundary; shared results leave through Context references |
| Waiting | Legacy `request_wait`/wake/resume paths remain in code | Normal flow uses typed `task.block`; legacy waiting is not a new Agent concept |
| Prompt | Root/Branch decomposition and legacy lifecycle instructions | Static Swarm SOP plus dynamic Mission/Task/Context/profile projection |

This table is an implementation map. It prevents the design document from
pretending that the current legacy Task API has already become #100.

## 4. Domain model at the Runtime boundary

### 4.1 Mission

A Mission is the scope shared by one problem or project. It owns the objective
and may define a final acceptance contract. It does not own or approve every
Task.

```text
Mission M
├── Task A: final proof attempt
├── Task B: geometric route
├── Task C: Lean API route
├── Task D: Boolean route
└── Task E: non-collinearity route
```

A finalization Task is still an ordinary Task. It may read shared Documents,
propose follow-up work, continue its own Workspace work, and submit a Candidate
when its contract requires it.

### 4.2 Task

Every executable responsibility has one Task shape:

```text
Task
├── task_id
├── mission_id
├── title and summary
├── goal
├── scope boundary
├── expected output
├── acceptance conditions
├── Mission contribution
├── task kind and validation mode
├── source/result Document references
├── origin and relation references
├── state and priority
└── timestamps
```

A Task without an origin relation is a Peer Task. A Task with
`spawned_from = A` can be shown as a Child of A, but it enters the same Mission
queue and has the same permissions and lifecycle.

### 4.3 Task relations

The target relation kinds are:

```text
spawned_from    provenance; never ownership
related_to      useful association; never a blocker
depends_on      explicit prerequisite; affects Claimability
supersedes      newer work replaces an earlier result
contradicts     evidence challenges an earlier result
duplicate_of    Agent-declared duplicate or convergence link
```

Only `depends_on` makes a Task `BLOCKED`. The Service checks dependency cycles
and records relation events. A Child relation alone never blocks the origin
Task and never requires parent approval.

### 4.4 Overlap review

A Task proposal includes a few-sentence description, an in-scope/out-of-scope
boundary, and an Agent-authored comparison:

```text
summary: the problem and intended angle
scope.in: what this Task covers
scope.out: what this Task deliberately excludes
compared_tasks: existing comparable Task IDs
compared_documents: relevant Context Document IDs
distinction: why the proposed work is new or materially different
```

Task Service provides comparable records from its search projection, validates
that referenced records exist, and stores the review. It does not treat a
single exact label as a global lock and does not silently decide whether two
natural-language proposals are equivalent.

### 4.5 Execution

An Execution is one leased attempt to work on one Task. Runtime owns:

- Execution state and state version;
- Core binding;
- lease and heartbeat;
- fencing version;
- Session binding;
- Workspace reference and revision;
- checkpoint and terminal reason.

The target lifecycle is:

```text
Task T: OPEN
  -> Daemon Claim
Execution E1: CREATED -> RUNNING
  -> Agent works
  -> Task complete: E1 terminal, T = DONE
  -> or Task block: E1 terminal, T = BLOCKED
Task T: BLOCKED -> OPEN after dependency reconciliation
Execution E2: new attempt on the same Task lineage
```

A retry has a new Execution identity even if it resumes a prior Workspace
lineage. A Core is never the durable owner of a Task.

### 4.6 Core and Core Daemon

A Core is reusable physical capacity. Its physical states are separate from
Task semantics:

```text
IDLE -> DISCOVERING -> SELECTING -> RUNNING -> STOPPING -> IDLE
```

A Core Daemon is a long-lived supervisor for one Core. It:

1. asks Task Service for a bounded Mission Task shortlist;
2. gives that shortlist to an optional stateless selection Agent;
3. receives exactly one selected Task ID;
4. Calls Task Service Claim once;
5. hands the created Execution to Runtime;
6. supervises the Session until completion, blocking, failure, fencing, or
   cancellation;
7. returns to discovery.

The Daemon does not create Branch Groups, approve Child Tasks, choose semantic
work for the whole Mission, or write a Task Workspace.

### 4.7 Task Controller

Task Controller is deterministic reconciliation, not a second reasoning Agent.
It:

- observes committed Task, dependency, and result-link events;
- computes the claimable projection;
- reopens Blocked Tasks whose typed dependencies are satisfied;
- observes Daemon health;
- signals healthy idle Daemons when work is available.

It never selects a Task for a Daemon and never reviews a Document or Candidate.

### 4.8 Context Document and Material

Context Service stores immutable, versioned Mission-scoped Documents. The
current implementation calls these records Materials. A Document can record a
fact, failure, experience, analysis, decision, artifact, or Candidate.

A Task links Documents as:

```text
input      a Document read as task context
result     a Document produced by the Task
candidate  a proof/artifact Document submitted to Judge
reference  a Document used to justify a proposal
```

Publishing a result makes it visible to the Mission. It does not send a
private message only to an origin Task. Read/use telemetry can be derived later
and is not required as a manual `consume` ritual for Task completion.

### 4.9 Workspace

Workspace is an Execution-private, Runtime-owned capability. Peer and Child
Tasks do not share mutable files. A shared artifact must be represented by a
Context Document or artifact reference containing:

- Task and Execution source;
- Workspace revision;
- relative path;
- content hash;
- artifact role or acceptance reference.

The exact input/output manifest, Bash capability, and Sandbox remain Runtime
design questions. They are not Task Service concepts.

### 4.10 Judge and validation mode

The Task kind selects the completion evidence:

| Mode | Typical kind | Required result |
|---|---|---|
| `judge` | proof or checker-backed implementation | Candidate reference plus applied passing CheckResult |
| `material` | research, analysis, coordination, design | Context Document/Material satisfying the Task contract |
| `artifact` | file-producing implementation without Judge | Workspace artifact reference plus explanatory Document |

Judge is not a universal completion ritual. A research Task must not submit a
meaningless Candidate, and a proof Task must not complete from an unverified
prose Material.

## 5. Runtime lifecycle

### 5.1 Task proposal to Claim

```text
Bound Agent
  -> task.create(summary, scope, overlap review, contract)
Task Service
  -> validates proposal and records OPEN Task
Task Controller
  -> observes committed event and signals idle Daemon
Core Daemon
  -> obtains bounded shortlist
Selection Agent (optional)
  -> selects one Task ID from shortlist
Core Daemon
  -> task.claim(selected Task ID)
Task Service
  -> creates Execution and marks Task RUNNING
Runtime
  -> materializes private Workspace and starts Agent Session
```

A newly proposed Task can be a Peer or a Child in provenance. The Daemon treats
both identically.

### 5.2 Bound Execution

```text
Agent Session
  -> reads current Task, Workspace, and relevant Context Documents
  -> performs useful work
  -> may task.create a substantial Peer/Child Task after overlap review
  -> publishes reusable Documents
  -> continues the current Task
  -> task.complete(result refs) or task.block(typed dependency)
Runtime
  -> ends/fences the Execution and releases the Core
Task Controller
  -> reconciles newly claimable work and wakes a Daemon
```

Creating a Task does not implicitly block or preempt the current Execution.
Publishing a Document does not implicitly complete another Task.

### 5.3 Block and reopen

A bound Agent calls `task.block` only when it has a concrete unresolved
Dependency. It should preserve useful Workspace and publish a blocker Document
before releasing capacity. The Task has no active Execution while Blocked.

Task Controller reopens the Task when the dependency is satisfied. A new Core
can then Claim a new Execution for that Task. The reopen operation is
idempotent and evidence-linked.

The current code still contains legacy `request_wait`, `wake_execution`, and
resumable wait handling for older contracts. The #100 normal flow does not add
those operations to the bound Agent profile.

### 5.4 Complete and self-own

`task.complete` validates the current Task's own contract:

```text
proof Task
  -> Candidate reference
  -> Judge submit
  -> applied PASS
  -> DONE

research Task
  -> accepted result Document
  -> DONE

artifact Task
  -> artifact reference + explanatory Document
  -> DONE
```

No parent review is required. Other Agents can read the result, publish
contradictory evidence, or propose superseding work without mutating the
completed Task.

## 6. Agent prompt and capability model

### 6.1 Static Swarm SOP

The stable prompt should say:

```text
You are an Agent in a shared Task-oriented Swarm.

Complete the current Task's own goal and acceptance conditions. Read the Task,
private Workspace, and relevant Context Documents before choosing the next
useful action.

Propose another Task only when it is substantial, independently verifiable,
and not already covered. Before proposing it, inspect comparable Tasks and
Documents, describe the scope boundary, and record why the work is distinct.
A proposed Task may be a Child in provenance, but it enters the shared Mission
pool. Continue the current Task after proposing it.

Publish reusable facts, failures, decisions, analyses, and artifacts as
Context Documents. Complete the current Task by recording its own result
references. No other Agent accepts your result.

Use typed blocking only for a concrete dependency. Claim, lease, heartbeat,
fencing, Core status, and process lifecycle belong to the Daemon and Runtime.
```

This is guidance, not a prescribed `split -> wait -> integrate` loop. The Agent
can choose to solve the current Task directly, propose work, consume a result,
revise its plan, or complete the Task.

### 6.2 Dynamic Execution projection

Runtime composes the static SOP with:

- Mission goal and final acceptance contract;
- current Task summary, goal, scope, output, and acceptance conditions;
- Task kind and validation mode;
- current private Workspace manifest and revision;
- source/result Context Document references;
- comparable Mission Tasks and unresolved questions;
- role-scoped capabilities from the #87 Service Registry;
- typed blocker and completion instructions for this Task kind.

It must not inject benchmark-specific Branch counts, Required Subtask counts,
repeated decomposition commands, or lease-management instructions into a bound
Task Session.

### 6.3 Role separation

The selection Session may see only bounded Task discovery and selection tools.
The bound Task Session may see Task proposal/view/complete/block, Context
Document operations, private Workspace operations, and Judge operations when
its Task kind requires them. Claim and Runtime lifecycle tools remain behind
the Daemon/Runtime boundary.

## 7. Target Agent-facing interfaces

The normal bound profile is intentionally small:

```text
task.discover
 task.view
task.create
task.complete
task.block
context.search
context.get
context.publish
workspace.list_files
workspace.read_file
workspace.write_file
workspace.diff
judge.submit_candidate        (only when validation mode = judge)
judge.get_check_result        (only when needed)
```

The Daemon/Runtime profile retains:

```text
task.list_claimable
task.claim
execution.heartbeat
execution.release
execution.fence
task.reopen
task.cancel
```

The exact operation names are an implementation decision for #100. The
ownership and visibility boundary is the invariant.

## 8. Observability requirements

Reports must show the flat Mission Task pool and relation graph separately. For
each Task, record:

- proposal summary and scope boundary;
- overlap review and comparable records;
- origin/relation events;
- state transitions;
- Claim and Execution identity;
- source and result Document references;
- Workspace artifact references;
- Candidate and CheckResult references;
- blocker and reopen events.

The report must distinguish:

```text
Task proposed
Task compared with existing work
Task claimed
Execution ran
Document published
Document read or referenced
Task completed its own contract
Document changed another Agent's plan
Judge validated a Candidate
Mission-level result reached
```

Counts of Tasks, Materials, Claims, or tool calls are not proof of useful
collaboration.

## 9. Acceptance seam

The highest-value seam is the production integration path:

```text
Task Service
  -> Task Controller
  -> Core Daemon
  -> Runtime Execution
  -> Agent capability profile
  -> Context / Workspace / Judge
```

Deterministic tests should cover:

1. Peer and Child Tasks appear in one Mission claimable projection.
2. A Child origin relation does not grant parent ownership or approval power.
3. An overlap review records compared Tasks/Documents and a distinction.
4. Task Service returns comparable work as advisory information without hidden
   semantic deduplication.
5. A Task can propose new work and continue its own Execution.
6. A research Task completes with a valid Document and does not invoke Judge.
7. A proof Task cannot complete without Candidate plus Judge PASS.
8. An artifact Task requires an artifact reference and explanatory Document.
9. A Blocked Task releases its Execution and reopens after dependency release.
10. Daemon Claim and Runtime Execution are identical for Peer and Child Tasks.
11. Workspaces are private across Tasks while Context Documents are Mission
    visible.
12. A new Task event wakes an idle Daemon.
13. Prompt composition includes dynamic Task/Context/profile information and no
    fixed decomposition loop.
14. Reports preserve relation, lifecycle, document, workspace, and Judge
    identity separately.

The public real-Agent fixture should show:

```text
Agent A proposes a substantial Task
  -> overlap review records existing comparable work
  -> Core claims Task A
  -> Agent A works in private Workspace
  -> Agent A publishes a Context Document and completes its own Task
  -> Agent B reads the Document and changes its own plan
  -> Agent B proposes a distinct follow-up Task
  -> a proof Task receives Judge PASS, or the run records an honest typed blocker
```

The fixture must not require a fixed number of Branch Groups, Required
Subtasks, parent approvals, or repeated prompt loops.

## 10. Explicit non-goals

- Redesigning the Service Manifest, Registry, adapter, or dynamic capability
  loading defined by #87.
- Treating Workspace as an external registered Service.
- Choosing a Sandbox or Bash implementation.
- Building semantic embeddings, vector search, or a general knowledge graph.
- Adding a central LLM scheduler that plans the Mission.
- Applying an exact `work_scope` lock or opaque semantic duplicate detector.
- Requiring Judge validation for non-proof Tasks.
- Sharing mutable Workspace files between Tasks.
- Preserving Branch Group, Required Subtask, Parent Review, or legacy waiting
  APIs as part of the new Agent model.

## 11. Decisions still requiring explicit confirmation

The target model is clear enough to implement, but these boundaries should be
confirmed before coding begins:

1. Whether the first implementation calls the Mission scope `mission_id` or
   continues exposing `root_id` internally while the public API uses Mission.
2. Whether `task.complete` publishes a Document itself or requires a separate
   `context.publish` immediately before completion.
3. The minimum acceptance schema for `material` Tasks: one Document, a set of
   Documents, or a typed Document kind per Task.
4. Whether an artifact reference is a Context Document subtype or a separate
   Runtime/Workspace record linked from Context.
5. Whether `depends_on` may target only Tasks and Documents initially, or also
   Judge CheckResults.
6. Whether the first real-Agent fixture includes one Mission-final proof Task
   or validates the Swarm lifecycle with a non-proof final Task first.
