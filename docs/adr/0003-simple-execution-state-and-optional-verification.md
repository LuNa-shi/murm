# Execution keeps a small lifecycle state; verification is optional

Status: accepted. The MVP keeps one simple `Execution.state` rather than exposing separate claim, runtime, and protocol axes. `WAITING` covers any durable wait condition, including a child Task, a parent review, a timer, or a requested CheckResult. Judge participation belongs to the Task's completion contract, so research Tasks use parent review rather than entering a verification state.

## Considered options

- Add separate claim, runtime, and protocol state axes to the MVP.
- Keep one small Execution lifecycle state and treat process start and stop as Runtime internals.

## Consequences

`WAITING` retains the Task's logical responsibility while releasing physical resources, regardless of what caused the wait. A pending CheckResult is represented as a wait condition rather than a second Execution state. Heartbeats and process observations cannot by themselves complete or fail a Task; they only drive the existing lease and fencing rules.
