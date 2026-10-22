# SwarmEnv Glossary

**Task** is a durable unit of responsibility. It owns a goal, output contract,
priority, state, and Workspace description.

**Root Task** is the one problem-level Task in a project. A PutnamBench root
has one purpose: prove the selected problem.

**Task list** is the ordered set of claimable Tasks. Agents inspect the list,
select a Task, and call the explicit claim operation.

**Execution** is a leased attempt for one Task. It may continue a previous
Workspace revision or start from a clean revision.

**Workspace** is the versioned working surface containing the problem input,
requirements, edits, checkpoints, and revision metadata. Task initialization
and later Execution revisions are parts of one Workspace lineage.

**Core slot** is reusable worker capacity. It is not a Task and is not tied to
a permanent child.

**Child Task** is a direct Task created by an active parent Execution when a
separate responsibility is useful.

**Material** is immutable shared work or evidence published through Context
Service.

**Service** is a named group of tools. Agents can use the Service Catalog to
list Services, inspect a Service's metadata, and list all named tools before
choosing work.

**Lease** is the time-bounded ownership period of an Execution. Heartbeats
extend it; expiry fences the old owner and makes the Task claimable again.

**Experiment** is one complete observed run of one Root Task, identified by a
run ID. It includes the Core slots, Agent Sessions, Executions, Tasks,
Materials, Workspace revisions, and Service activity observed during that run.

**Core lane** is the time-ordered view of one reusable Core slot. A Core slot
can own several Agent Sessions and Executions over the life of an Experiment.

**Agent Session** is one Pi process session started on a Core slot. A session
may be an unbound worker that browses and claims a Task, or a session bound to
one Execution after a claim succeeds.

**Execution segment** is one continuous interval in which an Execution is
assigned to a Core lane. The same Execution can have multiple segments when it
waits, resumes, or moves to another Core slot.

**Interaction** is one ordered exchange in an Agent Session, such as an Agent
message, a Service tool call, a tool result, a lifecycle notification, or a
process diagnostic.

**Observation Event** is an immutable record of a fact emitted by a Runtime,
Agent Session, Service, Judge, or Workspace operation. Observation Events
support monitoring and diagnosis; they do not replace Task, Execution,
Material, or Workspace truth.

**Diagnostic Finding** is a typed conclusion about an Experiment or one of its
parts, with a severity, evidence references, and a current status. Findings
may be produced by a human or an Agent analysis pass.

**Eligible window** is a set of intervals in an Experiment during which the
configured scenario has enough independent, unfinished work that the
available Core slots could execute it concurrently. It is a reporting aid for
interpreting parallelism; it is not a claim that every problem should provide
that amount of work or a standalone success criterion.

**Deterministic test scenario** is a bounded Experiment setup whose Tasks,
expected Agent interactions, and completion conditions are known in advance.
It supplies controlled work to exercise the production Runtime and Services;
it does not decide whether a research result is semantically useful.
