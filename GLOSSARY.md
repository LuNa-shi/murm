# SwarmEnv Glossary

**Mission** is the shared objective scope for one problem or project. It
contains a pool of ordinary Tasks and may contain final acceptance conditions.

**Task** is one durable responsibility in a Mission. Every Task has the same
shape and lifecycle: summary, goal, expected output, acceptance conditions,
optional relations, timebox, Material links, and state.

**Task summary** is the few-sentence description of the work and its boundary.
Agents search existing summaries before proposing new work. The Service does
not require a separate overlap form or an opaque semantic duplicate lock.

**Task relation** has two target kinds. `spawned_from` records proposal
provenance and does not grant ownership. `depends_on` records a prerequisite
Task and is the only relation that affects Claimability.

**Material** is immutable, versioned shared work published through Context
Service. Every Agent-published Material carries producer Task/Execution
provenance, even when it has no Task link. It can be linked to zero, one, or
several Tasks.

**Response Material** is a result intended for another Task. The link names the
receiving Task. The receiving Task may explicitly accept it and close the
producing Task when its own contract requires that acknowledgement.

**Handoff Material** is the durable summary of unfinished work, evidence,
checkpoint information, open questions, and a recommended next step. It is
required before a voluntary handoff, release, or block.

**Experience Material** is reusable knowledge that may help many Tasks. It
does not require one receiving Task and may remain unlinked or gain links later.

**Task Material link** is a durable reference from a Task to a Material. It
records a role such as `input`, `response`, `handoff`, or `experience` and does
not copy the Material content.

**Task state** is one of `OPEN`, `RUNNING`, `BLOCKED`, `DONE`, `CLOSED`, or
`CANCELED`. `DONE` is self-owned completion. `CLOSED` is explicit downstream
acceptance of a linked Response Material and is used only when that acceptance
matters. A task without a Response Material contract can remain `DONE`.

**Execution** is one bounded attempt to work on one Task. Runtime binds it to a
Core, Agent Session, and private Workspace, and assigns a handoff warning and
execution deadline.

**Handoff** ends an unfinished Execution after its Agent publishes and links
Handoff Material. `task.handoff` and `task.block` use the same release protocol;
normal handoff returns the Task to `OPEN`, while a blocked handoff leaves it
`BLOCKED` with a typed dependency until reopening. Timeout cleanup does not
create a system Handoff Material.

**Notification** is a durable, keyed update addressed to a Task or Execution.
Active Sessions receive it as a queued follow-up prompt; inactive Sessions see
it in the next initial prompt.

**Workspace** is the private, versioned working surface of an Execution. The
Runtime creates a common scaffold and adds Task-specific inputs when provided.
Workspace is not the shared collaboration store.

**Execution fencing** is an internal Runtime mechanism that invalidates writes
from an old Session after restart, timeout, or ownership transition. It is not
an Agent-facing operation. The existing internal `FENCED` state is distinct
from a normal Agent handoff.

**Core slot** is reusable physical worker capacity. It has no semantic Task
ownership.

**Core Daemon** is the long-lived supervisor for one Core. It asks for a
bounded `OPEN` Task shortlist only while the Core is idle, Claims one Task,
starts its Execution, waits for terminal cleanup, and returns to discovery.

**Task Controller** reconciles durable Task, dependency, Material-link, and
notification facts. It reopens eligible blocked Tasks and signals idle Core
Daemons; it does not select or Claim semantic work.

**Judge** independently validates Candidate Material for Task contracts that
require a checker.

**Service** is an independently owned capability provider with a versioned
interface, schemas, usage guidance, side-effect declarations, and structured
errors. Issue #87 defines Service registration and dynamic capability
discovery.

**Lease** is the Runtime's bounded physical ownership record for an Execution.
Heartbeat/liveness bookkeeping is internal Runtime behavior.

**Experiment** is one observed run of one Mission, including Tasks,
Executions, Materials, Workspaces, Judge results, notifications, and Service
activity.

**Core lane** is the timeline identity of one reusable Core slot over an
Experiment.

**Interaction** is one ordered Agent-facing exchange: a message, capability
call, result, follow-up notification, lifecycle event, or diagnostic.

**Observation Event** is append-only evidence for monitoring and diagnosis. It
does not replace domain truth held by Task, Runtime, Context, Judge, or
Workspace.

**Diagnostic Finding** is an evidence-linked, typed conclusion about an
Experiment or one of its parts.

**Eligible window** is a reporting interval with enough independent unfinished
work for the configured Core slots to execute concurrently.

**Deterministic test scenario** is a bounded fixture used to exercise the
production lifecycle with known inputs, calls, notification conditions, and
acceptance states.
