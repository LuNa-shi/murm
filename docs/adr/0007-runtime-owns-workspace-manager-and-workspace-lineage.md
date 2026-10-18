# ADR 0007: Workspace is the single versioned input and working surface

Status: accepted. Runtime owns Workspace materialization and fencing. Task
initialization and later Execution revisions belong to one Workspace lineage.

## Decision

The root Task stores the authoritative problem codebase and requirements in its
Workspace description. Runtime materializes those files before starting Pi and
records a manifest, revision, checkpoint, and content hash. The generic Agent
prompt is passed to the Pi adapter at startup; Task-specific directions are
read from the claimed Task.

An Execution selects either a clean Workspace or a revision from an earlier
Execution. Resuming creates a new writable directory and records the source
Workspace and revision. Runtime checks the Execution ID and fencing version
before every write.

Context Service stores shared Materials only. It does not own problem input,
claims, Executions, or private filesystem state.

## Consequences

The Agent sees one coherent Workspace model and can inspect its revision
lineage through the Workspace Service tools. There are no separate prompt or
context snapshot files. Input integrity is represented by the Workspace
snapshot hash and the Task's immutable specification.
