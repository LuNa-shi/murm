# 02. Execution

An Execution is the durable authorization for one identity to work on one
Task. It is distinct from the Pi Session that happens to carry the model turn.

## Lifecycle

The current flow is:

```text
Task admission
  → task_take in caller identity/Core lane
  → durable Execution and Workspace preparation
  → Runtime bind and ordered Agent turns
  → checkpoint / feedback / Judge / handoff / completion / block
  → release, fence or terminal cleanup
```

Task Service state and Runtime process state are related but not one database
transaction. A preparation failure must roll back the provisional binding;
late or fenced writes must not modify a successor Execution.

## Identity and ownership

Semantic Task transitions use the current Execution's authenticated
`owner_ref`, such as `agent:core-1`. Runtime daemon references such as
`runtime:core-1` describe physical cleanup and are not the Agent's semantic
authority. This distinction was central to the Issue #113 lifecycle repairs.

An identity may finish or hand off one Execution and then take another Task on
the same Core lane. A Mission with several Executions does not imply several
independent responsibilities; reports must separate shared-Mission concurrency
from ordinary-Task decomposition.

## Terminal meanings

- **SUCCEEDED/DONE/CLOSED**: a particular Execution or Task reached its own
  terminal contract; it does not prove Mission success.
- **HANDED_OFF**: this Execution released its authority while responsibility
  remains unfinished.
- **FENCED**: stale writes from this Execution are rejected.
- **EXPIRED**: the timebox or watchdog ended this Execution; it is not by
  itself a mathematical or scheduler conclusion.
- **BLOCKED**: the Task has a typed dependency or external condition and must
  not be repeatedly claimed while the condition is unchanged.

The exact state projection belongs to the Task Service code and capability contract;
reports must preserve the recorded state and terminal reason rather than
normalizing all non-success outcomes into one failure label.

## Execution evidence

An Execution report should include its durable ID, Task ID, owner, Core, Session
segments, Workspace revision, predecessor/source evidence, terminal state and
reason, and the concrete actions that changed its next state. If source or
successor lineage is absent, record it as unknown rather than infer it from a
similar timestamp or Core.
