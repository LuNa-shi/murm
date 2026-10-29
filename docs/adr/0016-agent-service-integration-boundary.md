# ADR 0016: Separate registered Services from Runtime-owned Agent capabilities

Status: proposed. Tracked by [Issue #87](https://github.com/LuNa-shi/SwarmEnv/issues/87).

## Context

SwarmEnv needs one repeatable way to connect an independently owned Service to
the Agent. A provider should be able to declare an endpoint and its operation
contracts once, after which SwarmEnv can validate the provider, expose the
allowed tools, and describe them in the Agent's initial prompt.

The current catalog lists Task, Execution, Workspace, Context, and Judge as
peer Services. That groups two different ownership models together. Task,
Context, and Judge can have provider contracts; Workspace materialization and
Execution lease/fencing are Runtime responsibilities attached to the current
Task. The current catalog, Pi extension, Bridge, Router, and SDK also maintain
overlapping operation metadata, so the Agent does not receive one reliable
contract.

## Proposed decision

### Registered Services

A registered Service has a versioned Service Manifest containing its identity,
purpose, endpoint or adapter, capabilities, input/output schemas, role scope,
side effects, idempotency, help/SOP references, and structured errors. A
Service Registry validates manifests, resolves an adapter, checks health and
compatibility, and derives role-scoped capability profiles. Pi registration,
Bridge validation, Router dispatch, SDK metadata, and service help are all
projections of the Registry contract.

The first adapter remains the existing in-process/loopback HTTP and JSON
boundary. The manifest and Registry are transport-neutral. MCP may be added as
a later adapter when interoperability is useful; gRPC or another provider
transport may likewise sit behind the adapter. Neither protocol is required to
define the P0 Agent-facing contract.

### Runtime-owned capabilities

Runtime-owned capabilities are scoped to the current Task or Execution and are
not independently registered external Services. Workspace operations can be
exposed to a bound Agent through a task-scoped capability profile, while
materialization, revisions, fencing, and path enforcement remain Runtime-owned.
Claim, lease, heartbeat, fencing, process control, and raw Execution lifecycle
operations remain behind the Core Daemon/Runtime boundary. If a normal-flow
Agent must finish or block a Task, the exposed operation must be a typed
Task-scoped action rather than a lease-management API.

### Initial prompt

Each Agent Session receives a profile matching its role. The initial prompt is
composed from a static Runtime SOP, the profile's dynamic service/capability
directory, the Task contract, and Workspace or recovery context. The directory
contains only callable capabilities, concise usage guidance, and help/schema
references, together with a version or hash for replay. Full schemas are
available through the discovery/help surface when needed.

## Consequences

- A provider has one registration seam instead of separate catalog, extension,
  Bridge, Router, and SDK operation lists.
- Agents see a truthful, role-scoped surface and do not need to operate the
  Execution lease or infer Workspace ownership.
- Workspace remains attached to Task/Execution while retaining safe Agent
  tools for file and artifact work.
- MCP and gRPC remain optional transport choices rather than architecture
  commitments. The Registry contract can support them later.
- Existing catalog entries and compatibility calls need a migration or an
  explicit adapter; the current accepted Service Catalog decision in ADR 0010
  should be read as superseded for the Workspace/Execution classification once
  this proposal is accepted.

## Non-goals

This proposal does not redesign Context into a shared experience/knowledge
store, select a sandbox technology, add native Bash, or change Task
decomposition and root convergence semantics.
