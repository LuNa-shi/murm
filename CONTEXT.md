# SwarmEnv Context

SwarmEnv is a local-first runtime for durable, checkable Agent work. The
Task-oriented Agent Swarm model is defined by [Issue #100](https://github.com/LuNa-shi/SwarmEnv/issues/100)
and the design document `docs/design-task-oriented-agent-swarm-task-service.md`.
The simplified Runtime model in
`docs/design-simplified-task-execution-model.md` describes how that Task model
runs through the Core Daemon and Runtime.

The vocabulary below describes the target Task-oriented Swarm model. The
current implementation already has the Core Daemon, Task Controller, Runtime
Execution, private Workspace, Context Material, and Judge seams. It still
exposes legacy Root/Branch/Required-Subtask Task operations; those are
implementation surfaces to be replaced by the #100 Task Service rather than
part of the target Agent model.

**Mission** is the shared objective scope for one problem or project. It owns
an overall goal and may have a final acceptance contract. A Mission contains a
pool of ordinary Tasks and a relation graph. It does not make one Task the
owner of every other Task.

**Task** is one durable responsibility in a Mission. It has a concise summary,
goal, scope boundary, expected output, acceptance conditions, Mission
contribution, source and result Document references, validation mode, priority,
and lifecycle state. Every executable responsibility uses this model.

**Peer Task** is a Task with no `spawned_from` origin relation. It enters the
same Mission pool as every other Task.

**Child Task** is a Task with an origin relation such as `spawned_from`. The
relation preserves why the Task was proposed, but does not grant the origin
Task ownership, approval authority, scheduling priority, or control over the
Child. Child and Peer Tasks use the same Claim and Execution lifecycle.

**Task relation** records provenance or coordination between Tasks. The target
relation kinds are `spawned_from`, `related_to`, `depends_on`, `supersedes`,
`duplicate_of`, and `contradicts`. Only `depends_on` affects Claimability.

**Overlap review** is the Agent-authored comparison attached to a new Task
proposal. It names comparable Tasks and Context Documents and explains why the
new Task is distinct. Task Service provides search and validates the references;
it does not use an exact scope key or hidden semantic duplicate detector.

**Task kind** is a domain label such as `proof`, `research`, `analysis`,
`coordination`, or `artifact`. A kind selects the validation mode but never
changes Task topology or permissions.

**Validation mode** describes the evidence required for Task completion. Proof
or checker-backed Tasks require a Candidate and an applied passing Judge result.
Research, analysis, and coordination Tasks require Context Documents or
Materials satisfying their contracts. Artifact Tasks require a Workspace
artifact reference and an explanatory Document.

**Task completion** is self-owned. The current Execution must satisfy the
Task's own contract and record its result references. An origin Task, parent,
peer, or later Agent may read the result and create follow-up work, but does
not accept or rewrite the completed Task.

**Task list** is the Mission-scoped query of Tasks that can be claimed. It is a
bounded view of Task state, explicit dependencies, priority, age, and current
ownership. It is not a recursive parent tree.

**Execution** is one leased attempt to carry out one Task. Runtime binds it to
one Core, Session, and private Workspace revision. A later attempt may use the
same Workspace lineage but has a new Execution identity.

**Blocked** means a Task has recorded a concrete, typed unresolved dependency
and has no active Execution. The Task Controller may reopen it when the
condition is satisfied. An empty queue is `IDLE`, not `BLOCKED`.

**Workspace** is the private, versioned working surface of an Execution. It
contains inputs, edits, checkpoints, and artifacts for that attempt. Peer and
Child Tasks do not share mutable Workspace files. A file becomes shared only
when the Agent publishes a Context Document or artifact reference containing
its revision, path, and content hash. Workspace is Runtime-owned, not an
independently registered external Service.

**Context Document** is an immutable, versioned, Mission-scoped record of a
fact, failure, decision, experience, analysis, artifact, or candidate. The
current Context Service stores this collaboration record as a Material; the
Task-oriented model adds explicit Task–Document links for inputs and results.
Context is the shared cognition layer, not a parent-only handoff mailbox.

**Judge** is the independent validator for Task kinds that require a checked
Candidate. A Judge `CheckResult` is evidence for a specific Candidate,
Workspace snapshot, Task, and checker environment. Research and coordination
Tasks do not invoke Judge merely to become complete.

**Core slot** is reusable physical worker capacity. It has no semantic Task
ownership and no Task-level blocked state.

**Core Daemon** is the long-lived supervisor for one Core slot. It obtains a
bounded Mission Task shortlist, runs an optional stateless selection turn,
Claims one Task, starts the Runtime Execution, releases the Session when that
Execution ends, and returns to discovery. It does not plan the Swarm or approve
Task results.

**Task Controller** is the deterministic reconciliation loop. It observes
committed Task and dependency changes, maintains the claimable projection,
reopens eligible Blocked Tasks, and signals idle Core Daemons. It never ranks
semantic work or Claims a Task for a Daemon.

**Agent Session** is one Agent process session. A bound Session belongs to one
Execution and receives a role-scoped capability profile. The Session reads the
current Task, Workspace, and relevant Context Documents; it does not manage
Core leases or process lifecycle.

**Service** is an independently owned capability provider with a versioned
public contract. Issue #87 defines Service registration, manifests, role-scoped
profiles, and dynamic prompt capability discovery.

**Runtime-owned capability** is an operation attached to the current Task or
Execution rather than an independently registered external Service. Workspace
operations and Execution lifecycle enforcement remain Runtime-owned under the
#87 boundary.

## Observability and diagnosis

**Experiment** is one complete observed run of one Mission. It includes Core
slots, Agent Sessions, Executions, Tasks, Context Documents/Materials,
Workspace revisions, Judge results, and Service activity.

**Core lane** is the time-ordered view of one reusable Core slot during an
Experiment. A lane may host selection, a bound Execution, and later another
Execution.

**Execution segment** is one continuous assignment of an Execution attempt to
one Core lane. Core occupancy, Agent Session intervals, and Task lifecycle are
reported separately.

**Interaction** is one ordered exchange in an Agent Session, including Agent
messages, capability calls, results, lifecycle notifications, and diagnostics.

**Observation Event** is append-only evidence for monitoring and diagnosis. It
is correlated with Mission, Core, Agent Session, Task, and Execution IDs when
known. Domain Services remain authoritative for Task, Execution, Context,
Judge, and Workspace state.

**Diagnostic Finding** is a typed, evidence-linked conclusion about an
Experiment or one of its parts. A diagnostic Agent can create a normal Task and
publish its conclusion through Context; diagnostics do not replace domain
truth.

**Eligible window** is a reporting interval in which the configured scenario
has enough independent unfinished work for the available Core slots to execute
concurrently. It helps interpret parallelism; it is not a solve criterion.

**Deterministic test scenario** is a bounded fixture with known Tasks,
expected capability calls, and completion conditions. It exercises production
Task, Runtime, Context, Workspace, and Judge seams without deciding whether a
research result is mathematically valuable.
