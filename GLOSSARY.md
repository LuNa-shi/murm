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
