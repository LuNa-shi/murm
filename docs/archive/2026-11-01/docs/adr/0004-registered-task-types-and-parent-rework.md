# Registered task types define outputs and parent rework

Status: accepted. The MVP uses a small versioned registry of Task types. An Agent may create only a registered `default`, `research`, `proof`, or `implementation` Task. The type supplies the minimum output and completion contract; it does not add a new core object.

## Decision

`task_type` and `task_type_version` are fields on Task. The registry is configuration loaded by Task Flow, not another domain object. `create_child_task` must include the type, version, local goal, expected output, acceptance conditions, parent relation, and an idempotency key. Task Flow rejects proposals that omit required fields or use a type-specific contract incorrectly.

The MVP starts with four types:

- `default` is the fallback type. The creator must provide explicit output and acceptance conditions; it has no default Judge.
- `research` produces sourced research material and waits for `parent_review`; it does not require a Judge by default.
- `proof` produces a proof Artifact and requires a matching trusted CheckResult from the configured checker.
- `implementation` produces code, documentation, or another executable Artifact. It may require a configured check; otherwise the parent accepts it under the contract.

When a parent requests rework, Task Flow appends an immutable `steer` Material, increments the instruction version, and resumes the waiting Execution from its checkpoint. The original Task specification, workspace, context snapshot, and checkpoint lineage remain available. If the original Execution has already been fenced or expired, a new Execution takes over the same lineage.

## Consequences

The Agent must express work in a form that Task Flow can validate and the parent can review. A type is a validated creation rule, not a completion declaration. Research, default, and unchecked implementation delivery can use parent review; proof and checked implementation can use CheckResult. Rework is a continuation of the existing responsibility rather than a new Task, while new child Tasks remain available for genuinely separate responsibilities.

The MVP allows any registered type as a root or direct child and does not maintain an allowed-child matrix. Adding a type later requires defining its required inputs, output schema, acceptance rule, and Judge policy before it can be used by an Agent. A child Task is reviewed by its Parent Task; a root Task is reviewed by the actor identified by `owner_ref`.
