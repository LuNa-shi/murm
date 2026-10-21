# SwarmEnv Context

SwarmEnv is a local first runtime for durable, checkable Agent work. The
system has one Task model, one Workspace model, shared Materials, and named
Services. This file is the domain vocabulary for the MVP.

**Task** is a durable responsibility with a goal, expected output, acceptance
conditions, a completion contract, a priority, and a Workspace description.

**Root Task** is the single Task created for one problem. For a PutnamBench
project its goal is to prove that problem. The root does not describe the
number of workers or preassign proof routes.

**Child Task** is a direct responsibility created by an active Agent when work
needs a separate research, proof, or implementation path. Child Tasks enter
the same root Task queue and inherit the parent Workspace description unless
they provide a more specific one.

**Task list** is the query of claimable Tasks, normally ordered by priority,
creation time, and ID. Agents browse the list and explicitly claim the Task
they choose. `claim_next` remains only as a compatibility operation and is not
the normal Agent workflow.

**Execution** is one leased attempt to carry out a Task. Claiming a Task
creates an Execution, and a Task may have multiple active Executions up to its
`parallel_quota`. Later attempts may continue a prior Workspace revision or
materialize a clean Workspace. Execution owns the lease, fencing version,
checkpoint, candidate binding, and revision reference.

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
list, claim one Task, work on its Execution, wait or finish, and then be used
again.

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

**Waiting** means an active Execution has saved its checkpoint and released
physical process capacity. **Blocked** means the Task cannot currently be
claimed. These states are distinct projections of the same lifecycle.

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

**Execution segment** is the continuous assignment of an Execution to one Core
lane. A timeline segment refers to the same durable Execution ID and also
records the Agent Session that carried it during that interval.

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
