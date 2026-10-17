# Task state is a projection of execution and scheduling facts

Status: accepted. SwarmEnv keeps one `Task.state` and one optional `block_reason`. `WAITING` means an existing Execution deliberately retained responsibility while releasing physical resources, whereas `BLOCKED` means no Execution can currently claim the Task. The MVP does not expose a second Task status axis.

## Considered options

- Merge waiting and blocking into one ambiguous status.
- Persist two independent Task status axes and require every consumer to interpret their combinations.
- Keep one Task state and use `block_reason` to explain why a blocked Task cannot run.

## Consequences

The MVP must reject impossible combinations such as `WAITING` with a blocking reason or a terminal Task with an active Execution. `block_reason` is meaningful only when no active Execution owns the Task; a wait condition belongs to the active Execution.
