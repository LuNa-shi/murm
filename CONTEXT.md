# SwarmEnv Context

SwarmEnv is a local first runtime for durable, checkable Agent work. The
system has one Task model, one Workspace model, shared Materials, and named
Services. This file is the domain vocabulary for the MVP. The simplified
Task/Execution model is defined in
`docs/issue-70-runtime-architecture-design.md`; legacy ADRs that retain
Execution `WAITING` or `parent_review` remain applicable only to legacy
contracts.

**Task** is a durable responsibility with a goal, expected output, acceptance
conditions, a completion contract, a priority, and a Workspace description.

Normal Task states are `OPEN`, `RUNNING`, `BLOCKED`, `DONE`, `CLOSED`, and
`CANCELED`. `DONE` means the Task's own completion contract is satisfied;
`CLOSED` is administrative cleanup; and `CANCELED` is an explicit terminal
decision. Legacy `SATISFIED` and `CANCELLED` records remain readable.

**Root Task** is the single Task created for one problem. For a PutnamBench
project its goal is to prove that problem. The root does not describe the
number of workers or preassign proof routes.

**Child Task** is a direct responsibility created by an active Agent when work
needs a separate research, proof, or implementation path. Child Tasks enter
the same root Task queue and inherit the parent Workspace description unless
they provide a more specific one.

**Branch membership** is a semantic relation over ordinary Task IDs. A Branch
group contains alternative Tasks for one owner objective; each member remains
independently claimable. A Task that is a Branch member may create required
subtasks, but it may not create another Branch group.

**Required-subtask membership** is a semantic relation over ordinary Task IDs
that are jointly required only when the owner Task's completion contract names
the group. Membership does not put the owner Execution into a wait state.

**Execution dependency** is an explicit prerequisite on a Task result,
Material, or CheckResult. It is the only Task-structure relation that blocks
claimability. **Creation provenance** records who proposed a Task and which
prior evidence or Workspace lineage informed rework; it does not grant an
exclusive claim or universal approval authority.

Task structure mutations have their own monotonic structural version and an
append-only event record. This version is separate from the Task and
Execution lifecycle versions, so adding parallel work does not invalidate a
currently running Execution.

**Task list** is the query of claimable Tasks, normally ordered by priority,
creation time, and ID. Agents browse the list and explicitly claim the Task
they choose. The Task Service never chooses a Task on an Agent's behalf.

**Task Controller** is the deterministic reconciliation loop. It observes
committed Task Service changes, checks dependency and admission conditions,
reopens eligible blocked Tasks, and signals idle Core daemons. It never ranks
or claims Tasks.

**Execution** is one leased attempt to carry out one Task. Claiming a Task
creates an Execution. An Execution ends when its Task is completed, canceled,
failed, or released because the Task is blocked. A later retry creates a new
Execution and may continue the prior Workspace lineage. Execution owns the
lease, fencing version, candidate binding, and revision reference for that
attempt.

**Workspace** is the single versioned working surface for a Task and its
Executions. The initial codebase contains the problem formalization and task
requirements. Later revisions contain Agent edits, generated artifacts, and
checkpointed files. A Workspace lineage can be selected by revision and is
represented by metadata and revision records in the same way a Git history
records versions. Shared Materials remain the collaboration channel; they do
not silently modify Workspace files.

**Agent prompt** is the reusable prompt passed to Pi when a Core slot starts.
It describes the worker protocol and Service discovery. Task-specific goals,
proof requirements, constraints, and completion rules are read from the
claimed Task.

**Core slot** is reusable worker capacity. A slot can browse the root Task
list, claim one Task, work on its Execution, finish or release it, and then be
used again. A Core has no semantic `WAITING` state.

**Core daemon** is the long-lived supervisor for one Core slot. It maintains
the discovery and claim loop, starts a Task Session for a claimed Execution,
releases that Session when the Execution ends, and returns to discovery.

**Material** is immutable shared work, evidence, feedback, or an artifact
published through Context Service. Materials carry source Task and Execution
provenance and can be read by other Agents.

**CheckResult** is the Judge's structured result for a candidate Material under
the Task's Workspace snapshot and locked checker environment.

**Service** is a named collection of related Agent tools. The catalog exposes
all Services, each Service's metadata, and its named tools. Task, Execution,
Workspace, Context, Judge, and Service Catalog are separate public capability
groups. Runtime keeps process capacity, fencing, and filesystem enforcement
behind the bridge.

**Blocked** means a Task cannot currently be claimed because it has declared an
unfinished dependency. The Task has no active Execution while blocked. The
Task Controller reopens it when its dependency expression is satisfied. The
legacy MVP uses Execution `Waiting`; the simplified model removes that state
from the normal Task flow.

## Observability and diagnosis

**Experiment** is one complete observed run of one Root Task. A benchmark
runner may start several Experiments over time, but the Core count and Core
assignments belong to the Experiment's Runtime configuration rather than to
the Root Task goal.

**Core lane** is the display and query identity of one reusable Core slot over
an Experiment. A lane can host an unbound worker Agent Session, a bound
Execution, a waiting interval, and later another Execution.

**Agent Session** is one Pi process session. It is distinct from an Execution:
the worker session can claim an Execution and hand off to a new bound session,
and a later Core can resume the same Execution after a durable wait.

**Execution segment** is the continuous assignment of one Execution attempt to
one Core lane. A later retry of the same Task has a new Execution ID, even when
it continues the prior Workspace lineage.

**Interaction** is the ordered Agent-facing conversation and runtime exchange
within an Agent Session, including assistant messages, Service tool calls,
tool results, lifecycle notifications, and process diagnostics.

**Observation Event** is append-only evidence for monitoring and diagnosis. It
is correlated with Experiment, Core, Agent Session, Task, and Execution IDs
when those identities are known. Domain Services remain authoritative for
Task, Execution, Material, Judge, and Workspace state.

The observation layer has two projections. The local operator projection may
read the complete private transcript for an Experiment. The Agent analysis
projection is structured, bounded, and redacted; the first implementation
exposes it through the `view=agent` query surface, leaving a stable seam for
named read-only Observability tools. An Agent can use those findings to create
a normal diagnostic Task and publish a conclusion as a Material through the
existing Task and Context Services.
