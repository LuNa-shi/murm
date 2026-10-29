# Task-oriented Agent Swarm and Task Service

Status: Published design draft; tracked by [Issue #100](https://github.com/LuNa-shi/SwarmEnv/issues/100)

This document defines the next Task Service model for SwarmEnv. It is a
clean-slate design for a task-oriented multi-agent system. It does not attempt
to preserve the current Branch Group, Required Subtask, Parent Review, or
compatibility APIs.

Issue #87 is the accepted boundary for registering Services, deriving
role-scoped capability profiles, and composing dynamic Agent prompts. This
document does not redesign that Service integration layer. It defines the
domain contract that the Task Service exposes through that layer.

## 1. Purpose

SwarmEnv is intended to run an Agent Swarm, not a root Agent with a recursive
subagent tree.

The system must let several Agents independently examine one Mission from
different perspectives, claim non-conflicting work, publish durable shared
documents, and create new work when shared knowledge exposes a useful next
question. A Task can originate from another Task, but its origin must not give
the originating Task ownership over it.

The central loop is:

```text
Mission and shared Context
          |
Agent discovers an uncovered question or work area
          |
Agent proposes a substantial Task
          |
Task Service records the proposal and returns comparable existing work
          |
Core Daemon claims it from the Mission task pool
          |
Runtime starts one Execution with a private Workspace
          |
Agent works, publishes Documents, and may propose more Tasks
          |
Agent completes its own Task with result Document references
          |
All Agents see the new shared knowledge and adapt their work
```

The system is deliberately decentralized at the work-planning layer. The
Task Service validates and records decisions; it does not centrally plan a
complete task tree. The Core Daemon schedules executable work; it does not
decide the semantic value of every Task. Runtime owns the physical Execution
and Workspace lifecycle; it does not own the Mission's reasoning.

## 2. Evidence for the redesign

The latest two-hour run persisted 47 Tasks, 62 Executions, 75 Materials, 35
consumption rows, and 3 Candidate/Check results. The run demonstrated that the
control plane can claim, bind, execute, and release work, but it did not turn
the work into a verified Mission result.

The structure records show five Root-created Branch Groups, 34
`add_required_subtask` operations, and 46 descendant Tasks. A concrete chain
was:

```text
Root
└── 3a602519 Lean/API route
    └── 16416244 Required Subtask Group
        ├── b489ed56 theorem/API search
        ├── 5f75854d candidate structure check
        ├── b071af0f Boolean reduction
        └── 530cb8e2 candidate skeleton
```

Another chain nested a required group below a required-subtask member:

```text
Root
└── b0e7cf63 synthetic route
    └── 822f1216 Required Subtask Group
        ├── cb66797d reflection identity
        └── f96baa84 propagation step
            └── d2aa1890 Required Subtask Group
                ├── a0270ec5 first propagation step
                └── 7aa10dca second propagation step
```

The records are durable; the difficulty is that the public model makes an
Agent reason about parent ownership, Branch Groups, Required Subtask Groups,
explicit Dependencies, rework, and review as separate mechanisms. The
semantic benchmark prompt also required a Root to create a Branch Group and a
Branch member to create Required Subtasks. The Root was reclaimed seven times,
so a one-time decomposition instruction was repeatedly presented as if it were
still required. The result was repeated structural expansion rather than a
shared task pool.

The current catalog exposes 34 named tools across Task, Execution, Workspace,
Context, Judge, and Catalog. The current generic and bound prompts are also
large and contain instructions for legacy wait, Branch, Required Subtask,
Parent Review, rework, scheduler inspection, and Execution lease handling.
The redesign removes those unrelated concepts from the normal Agent profile.

The sanitized experiment analysis records the measured Task, Material, and
Candidate outcomes; it does not treat Task count or Material count as proof of
useful collaboration.

## 3. Design principles

### 3.1 Every executable responsibility is a Task

There is one Task entity. Root, Child, Peer, research, proof, and finalization
are views or labels over the same entity, not different structural types.

The only special property of a Mission-final Task is its completion contract.
It is still claimed and executed through the same queue as every other Task.

### 3.2 Task origin is not Task ownership

A Task may be proposed because another Task, Agent, or Document exposed a useful
question. That origin is recorded as provenance:

```text
Task B --spawned_from--> Task A
```

The relation does not make A responsible for B, does not require A to approve
B, and does not prevent B from creating further Tasks.

### 3.3 Only explicit dependencies affect readiness

The following relations are informational and do not block execution:

- `spawned_from`
- `related_to`
- `uses_document`
- `supersedes`
- `contradicts`

Only `depends_on` can make a Task unavailable. A dependency must identify the
fact required to continue, such as a Task result, a Context Document, or a
Judge result.

### 3.4 A Task owns its own acceptance

The Agent executing a Task is responsible for satisfying that Task's contract.
No parent Agent accepts a completed Child by default. A parent, peer, or later
Agent can consume the result and create a follow-up Task, but cannot rewrite the
historical result or silently turn it into a failure.

### 3.5 Tasks must be substantial enough to produce a useful result

The Service does not enforce a duration or token quota as a proxy for size.
Instead, a proposed Task must have:

- one coherent goal;
- a concise description of the problem and intended angle;
- a standalone expected output;
- an observable acceptance condition;
- a clear in-scope and out-of-scope boundary;
- an overlap review against comparable Tasks and Documents;
- an explanation of how the result can change a Mission decision or enable
  another useful action.

“Search one theorem name” is too small unless the accepted output is a reusable
API document that resolves a named proof or implementation obligation.

### 3.6 Shared documents are the collaboration medium

Execution-local files live in a private Workspace. Durable cross-Agent
knowledge lives in Context Documents. A Task result is a pointer to one or
more Documents or Workspace artifacts, not an informal reply hidden in an
Agent session.

### 3.7 Scheduling is separate from reasoning

The Core Daemon and Task Controller keep physical worker capacity and Task
claimability correct. They do not replace Agent judgment about which research
angle is valuable. Agents discover and propose work; the Daemon claims it.

## 4. Domain model

### 4.1 Mission

A Mission is the shared objective scope for one problem or project. It contains
the final goal and, optionally, a Mission-level acceptance contract.

The current `root_id` concept should be understood as this scope. It does not
mean that one Task owns every other Task. A Mission may have one finalization
Task, but finalization is a responsibility, not a central coordinator role.

```text
Mission M
├── Task A: final proof attempt
├── Task B: geometric route
├── Task C: Lean API route
├── Task D: Boolean route
└── Task E: non-collinearity verification
```

### 4.2 Task

```text
Task
├── task_id
├── mission_id
├── title
├── goal
├── summary
├── scope_boundary
├── overlap_review
├── expected_output
├── acceptance_conditions
├── source_document_refs
├── result_document_refs
├── origin_task_id (optional provenance)
├── state
├── priority
├── created_by
├── contract_version
└── timestamps
```

`origin_task_id` is optional. A Task without it is a direct Mission-level
proposal. A Task with it is commonly displayed as a Child, but remains a peer
in the execution pool.

`task_kind` is not a structural discriminator. If a domain needs labels such as
`proof`, `research`, or `implementation`, they are metadata used for search and
prompt context. A Task kind may select a validation mode: proof Tasks require a
Judge result, while research and coordination Tasks require a Material or
Document result. Kind does not alter who may create Tasks or whether a Task is
a Child or Peer.

### 4.3 Task relations

```text
TaskRelation
├── relation_id
├── from_task_id
├── to_task_id
├── relation_kind
├── source_execution_id
├── source_document_refs
└── created_at
```

The initial relation kinds are:

```text
spawned_from
related_to
depends_on
supersedes
duplicate_of
contradicts
```

`spawned_from` replaces the ownership meaning of a traditional parent link.
`depends_on` is the only relation that changes claimability. The Service must
reject dependency cycles and must preserve all other relations as audit data.

### 4.4 Execution

An Execution is one leased attempt to work on one Task. It is owned by Runtime
and bound to one Core during its active segment.

```text
Task T
  Execution E1: claim → work → DONE
```

If T is blocked and later reopened:

```text
Task T
  Execution E1: claim → block → release
  Task T: BLOCKED → OPEN
  Execution E2: claim → continue → DONE
```

Execution does not own Task relations and does not decide whether a new Task
is a Child or a Peer. A bound Agent may propose a Task through Task Service,
but Runtime remains the authority for lease, heartbeat, fencing, and process
lifecycle.

### 4.5 Context Document

A Context Document is an immutable, versioned, Mission-scoped record of a
claim, observation, failure, experience, artifact, candidate, or decision.

```text
ContextDocument
├── document_id
├── mission_id
├── version
├── kind
├── scope
├── content_ref
├── content_hash
├── evidence_state
├── source_task_id
├── source_execution_id
├── topics
├── open_questions
├── supersedes
└── timestamps
```

A Task stores document references. It does not copy document content into its
own row.

### 4.6 Task validation mode

Task decomposition and Task validation are separate decisions. A Task may be a
Child or Peer regardless of its kind, but its acceptance path depends on what
the Task promises to produce.

The initial validation modes are:

| Validation mode | Typical Task kinds | Required completion evidence |
|---|---|---|
| `judge` | proof, executable candidate, checker-backed implementation | Candidate reference and an applied passing Judge result |
| `material` | research, analysis, coordination, design, failure investigation | One or more Context Documents satisfying the Task contract |
| `artifact` | implementation or file-producing work without a configured Judge | Workspace artifact reference plus a Context Document describing it |

The Task proposal records the selected mode and the expected evidence. The
Task Service validates the shape of the contract. The Judge validates proof
Tasks; it is not required for every research or coordination Task.

This keeps the model honest: proof work cannot be marked complete from prose,
while a research Task is not forced to manufacture a meaningless proof
Candidate merely to satisfy a universal completion rule.

### 4.7 Workspace

Workspace is a Runtime-owned capability attached to the current Task
Execution. It is not an independently registered Service under the #87
boundary.

Each Execution receives a private Workspace revision. Peer and Child Tasks do
not share mutable files. They share durable results through Context Documents
and artifact references containing the Workspace revision, relative path, and
content hash.

The exact Workspace output contract remains intentionally narrow in this
design. The invariant is that Workspace is private and execution-scoped; a
file becomes shared only after the Agent publishes a Material or artifact
reference. Input manifests, allowed output paths, Bash, and Sandbox require a
separate Runtime design and must not be smuggled into the Task Service model.

### 4.8 Core and Core Daemon

A Core is reusable capacity. A Core Daemon owns the discovery, shortlist,
selection, Claim, and handoff loop for that capacity. It has no semantic Task
ownership.

The Daemon may run a small selection Agent over a bounded shortlist. That
selection Agent chooses one Task for the Daemon to Claim. It does not create a
Task hierarchy and does not inspect claimed-only state.

## 5. Task state model

The normal Task states are:

| State | Meaning | Claimable | Terminal |
|---|---|---:|---:|
| `OPEN` | Admitted and has no unsatisfied dependency or active Execution | yes | no |
| `RUNNING` | One Execution currently owns the Task lease | no | no |
| `BLOCKED` | The Task recorded a concrete unresolved dependency | no | no |
| `DONE` | The Task's own acceptance contract and result delivery are satisfied | no | yes |
| `CANCELED` | The Task was deliberately abandoned or invalidated | no | yes |
| `CLOSED` | Optional administrative archive state | no | yes |

There is no normal-flow `WAITING` Task or `parent_review` state. Waiting for a
child is not a general Task behavior. A Task either continues independently,
records a real `depends_on` relation and becomes `BLOCKED`, or completes its
own type-specific contract.

## 6. Task Service interface

The interface is inspired by GitHub Issues: a Task has a title, description,
labels, status, assignee/Execution, links, timeline, and durable artifacts. It
is adapted for Agent collaboration by adding an acceptance contract, an
Agent-authored overlap review, immutable Context references, type-specific
validation, and self-owned completion.

### 6.1 Agent-facing operations

The normal bound Agent profile exposes only these Task operations.

#### `task.discover`

Returns a bounded Mission view:

```json
{
  "mission_id": "putnam_2025_b1",
  "goal": "Prove the selected problem",
  "open_tasks": [],
  "running_tasks": [],
  "recent_documents": [],
  "comparable_tasks": [],
  "unresolved_questions": []
}
```

It is a read operation. It does not Claim work and does not expose Core
health or lease internals.

#### `task.view`

Returns one Task, its own contract, origin/provenance, relevant relations,
result pointers, blockers, and a bounded list of comparable and related Tasks.

The response should include enough information for an Agent to decide whether
to continue, propose new work, consume a result, or complete the current Task.
There is no separate `get_task_structure` or `explain_task_readiness` tool.

#### `task.create`

Creates a substantial peer Task. The caller may include `origin_task_id` and a
relation kind of `spawned_from`, but the new Task enters the same Mission queue.

Required fields:

```json
{
  "mission_id": "...",
  "title": "Check the circumcenter API",
  "goal": "...",
  "summary": "Determine whether the locked Lean environment exposes the declarations needed to construct and characterize the relevant Simplex.",
  "scope": {
    "in": ["Simplex construction", "circumcenter declarations"],
    "out": ["the final geometric proof"]
  },
  "expected_output": "A reusable API document",
  "acceptance_conditions": {
    "must_contain": ["exact declaration or typed obstruction"]
  },
  "mission_contribution": "Enables a proof candidate or rules out this route",
  "overlap_review": {
    "compared_task_ids": [],
    "compared_document_refs": [],
    "distinction": "Initial proposal for this Mission area"
  }
}
```

Optional fields include `origin_task_id`, `source_document_refs`, labels,
priority, task kind, validation mode, and explicit dependency references. The
`overlap_review` is required for every proposal. The Agent must list the
comparable Tasks and Documents it inspected and explain why the proposed work
is distinct. An initial proposal may use an empty comparison set with an
explicit explanation.

Task Service validates that the referenced comparison Tasks and Documents
exist, records the review, and may return likely comparable work from its
search projection. It does not decide semantic equivalence with an exact key
or a hidden duplicate detector. The proposing Agent is responsible for
distinguishing the new work and may choose to relate the proposal to an
existing Task.

#### `task.complete`

The current Execution completes its own Task by supplying result references:

```json
{
  "task_kind": "research",
  "result_document_refs": ["document-id"],
  "completion_note": "The API is available, but the circumcenter lemma is missing",
  "workspace_artifact_refs": []
}
```

The Service validates the Task's own type-specific acceptance contract, records
the result links, and changes the Task to `DONE`. A proof Task must supply a
candidate reference and an applied passing Judge result. Research, analysis,
coordination, and other non-proof Tasks must supply an accepted Material or
Document result and do not require Judge submission. If the Task has an origin
Task, the origin is recorded as provenance; no parent approval is required.

#### `task.block`

Records a concrete blocker and releases the current Execution:

```json
{
  "reason": "The required theorem is absent from the locked API",
  "dependency_refs": ["document-id or task-id"],
  "checkpoint_ref": "..."
}
```

An empty queue, uncertainty, or a desire to wait for more ideas is not a
blocker. The Agent should publish its current finding and complete the Task if
it has produced a valid result, or continue working.

### 6.2 Daemon/Runtime operations

These operations are not in the normal bound Agent profile:

```text
task.list_claimable
task.claim
execution.heartbeat
execution.release
execution.fence
task.reopen
task.cancel
```

The Daemon and Runtime use them through the Service boundary. A bound Agent
does not Claim itself, inspect Core capacity, renew its own lease, or manipulate
fencing state.

### 6.3 Context operations

Context exposes a small document API:

```text
context.search(filters)
context.get(document_id)
context.publish(document)
```

There is no mandatory Agent-facing `context_consume` step. Task completion and
document references establish delivery. Read and use telemetry can be added
later as derived evidence, but it is not part of the basic completion ritual.

### 6.4 Workspace capability

The bound Agent receives task-scoped Runtime capabilities:

```text
workspace.list_files
workspace.read_file
workspace.write_file
workspace.diff
```

Workspace materialization, revision selection, path safety, fencing, Bash, and
Sandbox remain Runtime concerns. Bash and Sandbox are not required for this
Task Service design.

### 6.5 Judge capability

Candidate submission is a separate Judge capability. A synchronous
`judge.submit_candidate` returns a CheckResult. A separate result lookup is
only needed when a checker is asynchronous or a later Execution must inspect a
persisted result.

## 7. Admission and non-conflicting self-organization

Task proposals are decentralized, but they are not unbounded.

Task Service admission checks:

1. The caller is bound to a valid current Execution for the Mission.
2. The Task has a goal, concise summary, scope boundary, expected output,
   acceptance conditions, and Mission contribution.
3. The proposal includes a concise description, scope boundary, and overlap
   review against comparable Tasks and Documents.
4. Mission and per-Execution proposal budgets are available.
5. Explicit dependencies do not create a cycle.
6. The idempotency key has not already produced a different Task.

The Service does not decide whether a mathematical idea is good or whether two
natural-language proposals are semantically identical. The proposing Agent
must inspect existing work, explain the distinction, and publish enough detail
for later Agents to challenge that decision. The Service's search projection
can warn about comparable work, but it cannot replace Agent judgment.

A Task may create another Task while all Cores are busy. The new Task is queued
for later Claim. Creating it does not release or block the current Execution.

## 8. Daemon and Runtime integration

### 8.1 Claim path

```text
Agent calls task.create
  -> Task Service validates and records an OPEN Task proposal
  -> Task Controller observes a durable Task event
  -> Controller signals an idle Core Daemon
  -> Daemon asks for a bounded claimable shortlist
  -> Selection turn chooses one Task ID from that shortlist
  -> Daemon calls task.claim
  -> Task Service creates one Execution and marks Task RUNNING
  -> Runtime materializes the Task Workspace
  -> Runtime starts the bound Agent Session
```

The shortlist is flat within a Mission. It may include a Task that originated
from another Task, but the Daemon does not treat that Task differently.

### 8.2 Execution path

```text
Bound Agent reads Task and dynamic Context
  -> works in its private Workspace
  -> calls task.create for substantial peer/Child work after overlap review
  -> publishes Documents during the work
  -> calls task.complete or task.block
  -> Runtime ends the Execution and releases the Core
  -> Controller wakes the next claimable work
```

The Agent can continue its current Task after proposing a new Task. The
Daemon does not automatically preempt the current Execution because a Child
was created.

### 8.3 Reopening and dependency release

If a Task calls `task.block` with a typed dependency, Task Service stores the
dependency and Runtime releases the Execution. Task Controller reopens the
Task when the dependency is satisfied and signals a Daemon. A new Execution
then continues from the Task's Workspace lineage.

The same mechanism works for peer and Child Tasks. There is no special
parent-review wake path.

## 9. Initial prompt design

The initial prompt has a stable SOP plus dynamic projections. It must explain
the behavior that is always valid without prescribing a fixed sequence.

### 9.1 Static SOP

```text
You are an Agent in a shared Task-oriented Swarm.

Your responsibility is to complete the current Task's goal and acceptance
conditions. Read the Task, its Workspace, and relevant Context Documents before
choosing your next action.

You may propose a new Task when the work is substantial and independently
verifiable. Before proposing it, inspect comparable Tasks and Context
Documents. Describe the problem in a few sentences, state the in-scope and
out-of-scope boundary, explain why the work is distinct, and provide a goal,
expected output, acceptance condition, and Mission contribution. Creating a
Task does not replace work on the current Task.

During execution, publish reusable facts, failures, decisions, and artifacts as
Context Documents. A Task is complete only when its own contract is satisfied
and its result Document references are recorded. No other Agent accepts your
Task for you.

When another Agent publishes a relevant Document, use it to revise your own
plan or propose a new Task. Do not propose work that is already covered without
explaining the difference in scope or method. If progress is genuinely
blocked, record the concrete dependency and release the Task.

Use only the registered capabilities in your current role profile. Claim,
lease, heartbeat, fencing, Core status, and process lifecycle are managed by
Runtime and the Core Daemon.
```

### 9.2 Dynamic projection

The Runtime adds:

```text
Mission goal and final acceptance contract
Current Task title, goal, summary, scope boundary, output, and acceptance conditions
Current Task state and Execution Workspace manifest
Relevant source and result Document references
Active Tasks and comparable work areas in the Mission
Recent unresolved questions and failures
Role-scoped Task, Context, Workspace, and Judge capabilities
```

The prompt must not contain benchmark-specific instructions such as “create
two branches”, “create two subtasks”, or “repeat this sequence after every
reclaim”. Those are policy or test fixture concerns, not Task semantics.

## 10. Agent usage examples

### 10.1 Continue without decomposition

An Agent reads the current Task and finds that it can complete the proof route
itself. It works in Workspace, publishes one Document, and calls
`task.complete`. No Child is required.

### 10.2 Propose a Child with peer scheduling

An Agent discovers that API verification is independently verifiable:

```text
task.create(
  origin_task_id = current_task,
  relation = spawned_from,
  summary = "Determine whether the locked Lean environment exposes the declarations needed to construct and characterize the relevant Simplex.",
  scope = "Simplex construction and circumcenter declarations",
  expected_output = reusable API document,
  mission_contribution = enables candidate construction,
  overlap_review = compared Tasks and Documents, with the distinction recorded
)
```

The returned Task is a Child in provenance views and a Peer in the Mission
queue. The current Agent continues its own Task.

### 10.3 Create a new task from shared knowledge

An Agent reads a Document saying that the API exists but a non-collinearity
lemma is missing. It proposes a new Task with:

```text
scope = geometry/noncollinearity
source_document_refs = [the API Document]
origin_task_id = the Task that published the finding
```

The new Task is not nested under the original Task for scheduling purposes.

### 10.4 Consume a result without parent approval

An Agent sees a completed Child result in `task.discover` or `context.search`,
reads the Document, and changes its own proof route. The original Child remains
DONE and self-owned. The consuming Agent may publish a new Document or propose
a follow-up Task if it disagrees.

## 11. Completion and self-responsibility

Every Task must be able to answer:

```text
What was I asked to do?
What output did I promise?
What makes the output acceptable?
What Documents or artifacts prove what I did?
What can another Agent do with this result?
```

The Task Service records this as a self-contained contract. A Task cannot be
marked DONE only because it published a vague note or because its origin Task
accepted it. It must satisfy its own contract.

Other Agents may:

- read the result;
- cite the result in a new Task;
- publish contradictory evidence;
- create a superseding or follow-up Task;
- submit a new Candidate using the result.

They do not mutate the original result or change its historical completion
decision.

## 12. Observability and evidence

Reports must show both the flat Mission pool and the relation graph.

For every Task, the report should expose:

- Task state transitions;
- origin and relation events;
- Claim and Execution identity;
- proposal summary, scope boundary, overlap review, and comparable work;
- source and result Document references;
- Workspace artifact references;
- Candidate and CheckResult references;
- blocker and reopen events.

The report must distinguish:

```text
Task was created
Task was claimed
Task produced a Document
Document was read
Task completed its own contract
Document changed another Task's plan
Mission-level Candidate passed
```

Task count, Document count, and Claim count are not evidence of useful
collaboration by themselves.

## 13. Relationship to the Issue tracker

This design is tracked by [Issue #100](https://github.com/LuNa-shi/SwarmEnv/issues/100).
The earlier Root-convergence decomposition plan in #88 and its child Issues
#92, #93, #94, and #95 were closed as superseded after the new Issue was
published; their useful evidence has been incorporated into this design.

Issue #87 remains the Service registration and role-scoped capability
foundation. The Task Service design here supplies the domain manifest and
Agent-facing operations that #87 registers; it does not redefine #87.

## 14. Non-goals

This design does not decide:

- which Sandbox implementation Runtime will use;
- whether Bash is exposed to the Agent;
- semantic retrieval or embedding technology for Context;
- a central LLM scheduler that ranks all Mission work;
- a mandatory number of Tasks or Cores;
- a special Branch Task or Required Subtask type;
- parent approval or human review as a normal completion path.

The next design review should focus on the exact Task relation names,
overlap-review fields, task-kind validation modes, and the `task.complete`
result contract.
