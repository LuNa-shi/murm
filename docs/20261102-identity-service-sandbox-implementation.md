# Identity, Service, Sandbox and Task Continuation

Status: implementation record and design boundary for Issue #111. This document
translates the discussion draft into the current repository language. Items
marked **proposed** remain open design decisions; everything else below is
implemented and covered by deterministic tests on the recorded commit.

## Current operating model

SwarmEnv runs a reusable research identity on one Core. The identity receives a
stable English runtime contract, a capability directory derived from the
installed Registry, and dynamic Mission/Task/Execution context. When it has no
active Execution it may inspect the Mission and call the canonical `task_take`
operation. A successful take keeps the same identity and Session; Runtime binds
the identity to the returned Execution, Workspace and context before exposing
costly tools. An active Execution cannot take another Task.

Shared Mission Tasks may have multiple independent Executions. Ordinary Tasks
are exclusive. Completing or handing off an Execution releases its permissions
and processes but does not terminate a healthy identity. Identity rotation is a
separate operation and must be recorded as a new identity. Judge failure returns
to the same Task/Execution for revision and re-check.

The English stable prompt is assembled by `src/agent/agent-prompt.js`. It no
longer instructs a separate Selection Agent to stop and wait for a second
Session. `GENERIC_AGENT_PROMPT`, `IDLE_AGENT_PROMPT`, and
`RECOVERY_AGENT_PROMPT` are compatibility exports of the same reusable-identity
contract; they are not separate operating modes.

`AgentCoreAdapter` delivers that contract through Pi's real system role using
`--append-system-prompt` (a file, so argv stays bounded). `buildInitialPromptBundle`
records separate `system_prompt_hash`, `dynamic_prompt_hash`, profile hash, and
service-document hashes. A real Pi 1.4.0 probe confirmed the session's leading
system message carries an `addendum` section with the identity contract.

## Stable identity contract (English)

You are a continuous SwarmEnv research identity. Work with the other
identities toward the supplied Mission. Do not lower the original acceptance
requirements or treat a local Task as completion of the Mission.

All research tool calls must belong to the current valid Execution. Without an
Execution, inspect Mission/Task state and permitted public information, then
call `task_take` for one eligible responsibility. If no ordinary Task is
appropriate, a shared Mission may be taken. A failed take is not success. Once
bound, use the returned Workspace, Sandbox and context. Do not manage leases,
Core ownership or processes yourself.

Use only the capabilities shown in the current directory. Service guidance
explains purpose, parameters, results and errors; it does not grant authority.
Keep files and commands inside the bound Workspace/Sandbox and never access
host paths, credentials or another Execution's mutable files.

Treat checker failure as feedback: diagnose, revise the current candidate and
check again. Separate hypotheses, observations, checked conclusions and
unknowns. Publish useful findings and feedback with evidence and limitations.
Use the unified progress operation for checkpoint and handoff. Runtime records
the real file commit and source identity; never invent a commit or claim a
failed save succeeded. Handoff ends the current Execution, not a healthy
identity. Rotation is explicit and must leave a durable successor trail.

## Service documentation boundary (implemented)

Bundles use `services/<id>/service.json`, `SKILL.md`, and optional
`references/`. `service.json` identifies the versioned capability schema,
documentation resources, adapter endpoint and `secret_refs` (only `env:NAME`
references are accepted; embedded credential fields are rejected). `SKILL.md`
describes real inputs, outputs, errors, retries and limits. The loader
(`src/sdk/service-bundle.js`) confines every path to the bundle root, rejects
traversal and symlink escapes, loads and hashes required documents before
registration, and includes those hashes in the manifest metadata.

`help.ref` resolves only through `service://<service>/<resource>`; the Registry
resolver falls back to inline capability help text for programmatic services
and never accepts host paths or arbitrary URLs. Registry profiles carry the
documents, and `composeAgentPrompt` injects them with version/hash binding. A
new service needs a bundle plus adapter/config; the mathlib-search bundle is a
worked example. Capabilities may declare `requires_binding`, enforced at both
the Registry and the HTTP host so a direct adapter/HTTP call cannot bypass the
Agent binding gate.

## Sandbox boundary (implemented)

Workspace persistence and command isolation are distinct responsibilities.
`src/runtime/sandbox-manager.js` provides the first local container backend: a
non-root user, read-only root filesystem, private Workspace at `/workspace`,
validated read-only input mounts, no host-sensitive mounts or Docker socket,
`--cap-drop ALL`, `no-new-privileges`, bounded CPU/memory/pids, explicit
network mode, and bounded command timeout/output. `sandbox_exec` and
`sandbox_job` are Runtime capabilities bound to the active Execution; commands
and jobs are rejected without a valid binding, and the container/jobs are
removed on handoff, fence, release, rotation failure, or shutdown.

The Git-backed WorkspaceManager remains the file/commit authority. Shell edits
share the same `/workspace`; they become a durable revision only when
`execution_progress` commits them. Local compilation is research feedback; the
trusted Judge remains authoritative. Image attestation is enforced when a
digest is configured. Hostile multi-tenant workload isolation is outside this
phase.

## Evidence and cleanup matrix

| Area | Current evidence | State |
|---|---|---|
| Same-identity `task_take` | deterministic bridge/runtime tests; production runner path updated | implemented |
| Git Workspace lineage | exact commit save/restore smoke and runtime tests; Progress records `workspace_commit` | implemented |
| Mission-level completion guard | Task Service tests | implemented for declared final-candidate contracts |
| Service bundle/resource resolver | bundle loader, constrained resolver, profile injection, mathlib bundle, bundle tests | implemented; real provider长跑 pending |
| Isolated Sandbox execution | local container backend + fake-docker tests; binding/cleanup gates | implemented; real-image long run pending |
| True Pi system-role injection | real Pi 1.4.0 session `sections.addendum`; controlled probe SUCCEEDED | verified on the probe |
| Real FAIL→revision→PASS | controlled probe `d5214b5`, same Session/Execution, superseding artifact | verified |
| Compaction fence on real Pi | deterministic tests; no real threshold probe yet | pending real probe |
| Two-hour four-Core comparison | not yet run | pending |
| Legacy Selection/daemon code | Selection/claim/select_task production branches removed; compatibility read filters retained | cleanup complete for the Agent surface |

Retain lifecycle, fencing, idempotency, path and Mission-acceptance tests.
Migrate tests that assert a second Selection Session to same-identity
`task_take` tests. Delete retired Selection/daemon production branches only
after the replacement runner and its integration tests are in place; do not
keep a compatibility alias that bypasses binding.

