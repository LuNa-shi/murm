# ADR 0008: PutnamBench uses one root Task and reusable workers

Status: accepted. Each PutnamBench problem is one isolated SwarmEnv project
with one root Task and up to four reusable Agent Core slots.

## Decision

The root Task goal is exactly to prove the selected problem. The runner does
not create four proof children and does not claim work on behalf of Agents.
Each worker starts with the reusable Agent prompt, lists the highest-priority
Tasks, explicitly claims one Task, and may create bounded child Tasks when its
route needs decomposition.

The root Workspace contains the pinned formalization and environment metadata.
Materials carry later observations, artifacts, and Judge feedback. A claimed
Execution chooses a clean Workspace or a selected prior revision. Reports
audit the actual Task tree, claims, Workspace lineage, tool calls, candidate
provenance, and report redaction.

## Consequences

Parallelism comes from reusable slots and explicit Task claims. A project can
begin with only the root Task and grow its queue during the run. Unclaimed
worker slots are valid when the current Task list has no available work.
