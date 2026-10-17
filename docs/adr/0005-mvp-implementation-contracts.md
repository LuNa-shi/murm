# MVP uses SQLite and explicit operation contracts

Status: accepted. The first executable slice uses one SQLite database in WAL mode, one Runtime, multiple worker processes, isolated local workspace and checkpoint directories, a local NuRouter/Pi Agent Core Adapter, and a deterministic local ScriptExecutor/Judge Adapter used as a protocol test double. This keeps the deployment small while preserving the transactional CAS, unique-constraint, fencing, and recovery semantics required by the Task and Execution model.

## Decision

`documents/SwarmEnv_Design_v1.2.md` is the implementation source of truth. Earlier architecture material remains under `documents/archive/` for reference and does not define the MVP.

The MVP supports four registered Task types: `default`, `research`, `proof`, and `implementation`. Any registered type may be a root or direct child. The registry does not introduce an allowed-child matrix in the first slice. Root acceptance uses the Task `owner_ref`; a child is accepted or sent back for rework by the current execution owner of its Parent Task.

All public writes use an operation envelope containing `operation_id`, `actor_ref`, the applicable Task and Execution identifiers, `spec_version`, `state_version`, and, for execution writes, `fencing_version`. `propose_task`, `create_child_task`, `request_wait`, `accept_task`, `request_rework`, and `submit_check_result` have the required type, checkpoint, review, or checker fields described in the design. Repeated operations return the original result; stale versions, old fences, invalid contracts, and unauthorized actors return explicit errors.

The MVP accepts only the fixed `completion_contract` fields `required_children`, `required_materials`, `required_candidate`, `required_check`, and `parent_review`. Unknown fields are rejected. SQLite transactions cover claim, Execution transitions, wait registration, review decisions, CheckResult application, and the corresponding Task projection. Large workspace and Artifact content remains in isolated local directories, while authoritative records retain references, revisions, and hashes.

The first end-to-end fixture is a locked PutnamBench Lean4 input. The protocol test may use the deterministic ScriptExecutor, while the real Agent Core path uses the local NuRouter/Pi Adapter and a local Lean checker adapter. The fixture manifest records the benchmark commit, problem-file hash, Lean toolchain, Mathlib version, checker version, and environment reference before the run. Multi-machine deployment follows the golden path rather than expanding its initial scope.

## Consequences

The first implementation has a concrete seam: Task Flow owns the public operation and transaction rules, Runtime owns process and capacity effects, Context Store owns immutable Material and local content references, and the Judge Adapter returns only normalized CheckResult data. SQLite and local directories are replaceable adapters behind those interfaces, but changing them must preserve the same operation and state invariants.
