# Runtime owns Workspace Manager and Initial Context is frozen per Execution

Status: accepted. Context Service is the shared Material service used by Agent Cores. Runtime owns the private Workspace Manager. Initial Context is the frozen input bundle for one Execution and must not be confused with the live shared Material view.

## Decision

Context Service maintains immutable, versioned Material that can be read and published by Agents through the Services SDK. It owns shared information and its provenance; it does not claim Tasks, schedule Executions, or create, save, restore, or fence private Workspaces.

When Task Service creates an Execution, it freezes an Initial Context manifest containing the Task specification, the initial prompt, selected Material references and hashes, the input snapshot hash, and the service/environment information needed by that run. Later Material published to Context Service does not change that Execution's Initial Context. A parent rework appends a steer Material and increments the instruction version; it does not replace the original input snapshot.

Runtime owns Workspace Manager. Before starting an Agent Core, Runtime asks Workspace Manager to create or restore the Execution's isolated Workspace and writes the Initial Context and initial prompt into it. Workspace Manager persists workspace revisions, checkpoint references, and hashes, and rejects writes from a fenced execution. Agent Core accesses the Workspace through its normal files and tools and uses Services SDK for Context Service; it has no Workspace Manager API.

The MVP keeps Workspace, Initial Context, checkpoint, and lease as Execution fields and Runtime mechanisms rather than new core domain objects. `initial_context_ref`, `input_snapshot_hash`, `workspace_ref`, `workspace_revision`, and `checkpoint_ref` are the authoritative references needed for recovery.

## Consequences

The first implementation must build the Agent Core and Services SDK seam early, then implement Task/Execution creation and Initial Context freezing, Context Service Material operations, and Runtime/Workspace Manager lifecycle operations. A resumed or replacement Agent can reconstruct its input from persisted records and its private files without relying on the previous Pi session. Shared Material can evolve without silently changing a running Execution, and Workspace persistence remains outside the Agent-facing SDK.
