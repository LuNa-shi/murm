# 04. Services and tools

The Service Registry and Manifest layer gives the Agent one named, documented
surface while keeping domain ownership explicit.

## Built-in services

| Service | Owns or exposes |
|---|---|
| Catalog/Registry | Service manifests, capability profiles, tool schemas, documentation and hashes |
| Task | Mission, Task, Execution projections, claims, provenance, feedback and completion |
| Context | Immutable Material publication, search, reads and consumption records |
| Judge | Checker execution, request/preflight handling and immutable CheckResult/checker outcome; current submission routing is indirect |
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

Workspace operations are Runtime-owned and task-scoped. **Current as-built Judge route** (flat benchmark, `02adbb43`):

1. The Agent calls the registered `submit_candidate` tool through Pi → Services Bridge → Registry.
2. `src/sdk/builtin-registry.js` currently dispatches `judge.submit_candidate` to `TaskService.dispatch('submit_candidate')`. `TaskService.#submitCandidate` validates the source Material and stores `execution.candidate_material_id`.
3. `src/agent/services-bridge.js` invokes the Benchmark Runner's `onSubmitCandidate` callback. `src/benchmark/putnam-runner.js` resolves Candidate source/fixture, calls `JudgeService.judgeCandidate` and applies CheckResult to Task Service.
4. The callback returns bounded diagnostic feedback to the Agent; a source-level FAIL may be revised and resubmitted within the **same** Task/Execution. Checker infrastructure failures are reported separately.

This **does not provide a direct Agent → Judge Service submission adapter**, even though the tool is advertised under Judge. The service ownership is a known architectural defect tracked for human-reviewed redesign in [Issue #117](https://github.com/LuNa-shi/SwarmEnv/issues/117). The desired redesign must not be described as already implemented. Judge checker results are distinct from Task completion and full Mission acceptance.

The public Agent profile should therefore be read as an executable contract,
not as a list of suggestions. A report should compare each important request,
service outcome, returned information and subsequent Agent action.
