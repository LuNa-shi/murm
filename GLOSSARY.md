# SwarmEnv Glossary

This repository uses the following terms for the root task queue and the four
core slot benchmark.

**Task** is a durable unit of responsibility in the root task tree. It owns a
goal, completion contract, queue state, initial prompt, and initial Workspace
input. A Task may have zero or more direct child Tasks.

**Root Task** is the one Task created for a problem. Every child Task belongs
to the same root through its `root_id`. A project does not create one root per
core.

**Task queue** is the set of claimable `OPEN` Tasks that have no active
Execution. Queue order is durable and claiming is serialized by the Task
Service.

**Core slot** is reusable worker capacity. A slot claims whichever Task is
available, executes it for a leased period, releases the slot on wait,
completion, failure, or expiry, and may then claim another Task in the same
root tree.

**Claim** is the atomic Task Service operation that selects a Task, verifies
its versions and lease, and creates exactly one Execution for that Task.

**Execution** is one leased attempt to carry out a Task. It carries the
fencing version, lease, checkpoint lineage, candidate binding, and the
materialized runtime Workspace. It is created by claim and can be replaced
after expiry or fencing.

**Workspace** is the Task-owned initial input bundle plus the private files
materialized for one Execution. The initial problem statement and initial
prompt belong to the Task Workspace. Runtime owns the private materialization
and its lifecycle; Context Service does not own the problem input.

**Subtask** is a direct child Task created by the current parent Execution when
the parent needs another unit of work. Child creation is idempotent and is
bounded by the parent contract; a proof child must not be created with
`max_children: 0` when it may need to decompose its work.

**Material** is immutable shared work, evidence, feedback, or an artifact
published through Context Service. Materials may be read by other Executions,
but they do not replace a Task's frozen initial Workspace.

**Context Service** stores Material revisions and optional compatibility
snapshots for existing integrations. It does not claim Tasks, create
Executions, or manage private Workspaces.

**Lease** is the time bounded ownership period of an Execution. Heartbeats
extend it; expiry fences the old owner and releases the core slot so another
worker can claim the Task according to its retry policy.
