# 04. Services and tools

The Service Registry and Manifest layer gives the Agent one named, documented
surface while keeping domain ownership explicit.

## Built-in services

| Service | Owns or exposes |
|---|---|
| Catalog/Registry | Service manifests, capability profiles, tool schemas, documentation and hashes |
| Task | Mission, Task, Execution projections, claims, provenance, feedback and completion |
| Context | Immutable Material publication, search, reads and consumption records |
| Judge | Candidate submission and immutable CheckResult/checker outcome |
| Workspace/Runtime | Task-scoped files, revisions, fencing, Sandbox and process lifecycle |
| Mathlib Search | Optional registered research capability with its own manifest and version |

`src/sdk/service-catalog.js` defines the named operations and their schemas;
`src/sdk/builtin-registry.js` turns them into Service Manifests and adapters;
`src/agent/services-bridge.js` enforces the bound Agent boundary.

## Request contract

Every request is evaluated with the current actor, Task, Execution, spec/state
versions and fencing information. The response should expose a stable error
code, retryability and an actionable next step. A capability that is not in
the current profile is not available merely because another internal catalog
entry exists.

The same request key is idempotent. Reusing a key with different content is a
conflict. Service errors, checker infrastructure failures and mathematical
source failures remain separate result classes.

## Workspace and Judge boundary

Workspace operations are Runtime-owned and task-scoped. Judge receives a
versioned Candidate Material plus input/checker/environment bindings. The
Agent reads the resulting CheckResult and may revise the same responsibility;
the checker does not create a new research Task for it.

The public Agent profile should therefore be read as an executable contract,
not as a list of suggestions. A report should compare each important request,
service outcome, returned information and subsequent Agent action.
