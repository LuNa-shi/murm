# Task structure uses ordinary Tasks with explicit parallel-work relations

Status: accepted. Issue #56 supersedes the strict parent-child interpretation
for parallel work while preserving the existing Task, Execution, Workspace,
Material, and Judge records. The Task Service stores creation provenance,
alternative Branch groups, jointly required subtask groups, and explicit
execution dependencies as separate relations over ordinary Task IDs.

## Decision

- A Branch or subtask is a semantic role, not a new entity type. Branch members
  and required subtasks are independently claimable through the shared Task
  flow. Membership alone never creates an Execution wait or claim blocker.
- A Branch Task may add required subtasks but cannot create another Branch
  group. The Task Service returns the stable
  `BRANCH_TASK_CANNOT_CREATE_BRANCH` error before any structural write.
- A Task's completion contract names the Branch and required-subtask groups it
  needs. Branch groups use an any-member satisfaction rule; required-subtask
  groups use an all-member rule. Satisfying a group does not complete the Task
  without the Task's own contract and, for proof work, a passing formal
  CheckResult.
- Only explicit Task, Material, or CheckResult dependencies block claimability.
  Task dependencies are cycle-checked and every structural write carries a
  version check plus an append-only event record.
- A revision creates a new rework Task linked to the prior Task, feedback,
  source Materials, and Workspace lineage. The creator may be the prior Task,
  its parent, or another active consumer in the same root, provided the
  operation is bound to that consumer's current Execution and any supplied
  Workspace source belongs to the prior Task. It does not reopen the prior
  Execution implicitly. Parent or creator identity is not a universal approval
  rule; `parent_review` is an explicit contract field.
- `propose_structure_change` accepts the same branch and required-subtask
  membership operations as the direct tools, plus explicit dependency edits.
  A proposal may carry validated source Material IDs; those references are
  retained in the structural event so a new Material can explain why the
  additive change was made.

The structural version is intentionally separate from Task `state_version`,
Task `spec_version`, and Execution `state_version`. An active Execution keeps
its lifecycle responsibility while an Agent adds parallel work. Additive
structure changes are preferred; retiring a dependency is explicit and keeps
the event history.

## Consequences

The Task Service can explain alternatives, required subtasks, dependencies,
provenance, and readiness in one query without reconstructing relationships
from low-level records. Existing direct-child creation remains available for
ordinary work, while the new semantic operations provide parallel work without
turning child creation into an implicit AND barrier. ADR 0001's restriction of
cross-tree relationships to descriptive metadata is superseded for these
explicit, validated execution dependencies; no unrestricted planner or
semantic graph is introduced.
