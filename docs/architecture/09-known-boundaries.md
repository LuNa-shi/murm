# 09. Known implementation boundaries

These are properties of the [reviewed runtime](INDEX.md), not proposed fixes or new acceptance claims. They are collected here because omitting them would make the main execution narrative misleading. The linked chapters explain the surrounding flow. When an approved change resolves an item, update the implementation and these descriptions together; old behavior remains available in Git history.

## Execution and Task model

| Current boundary | Effect on interpretation | Detailed explanation |
|---|---|---|
| Flat-only normal entry points and retained compatibility are different scopes | CLI and exported runner use flat Mission Tasks and reject removed model selectors. Inspect Runtime, fixture and historical-data entry points separately; neither a historical legacy label nor the flat-only CLI proves which compatibility operations remain callable. | [07 Launch](07-run-configuration.md), [03 Tasks](03-mission-task.md) |
| Shared Mission Task is identified by creation order | The earliest Task in the Mission gets shared semantics; this is not a persisted `shared` type flag that callers can freely assign. | [03 Tasks](03-mission-task.md) |
| Take ordering and take enforcement have different scopes | Mission-wide listing can age/sort Tasks, while take-time fairness uses a Task's root scope. Modern Tasks have their own roots, so this is not a global Mission fairness guarantee. | [03 Tasks](03-mission-task.md) |
| Retained dependency interpretations have different terminal predicates | Modern `depends_on` handling can accept `DONE`/`CLOSED`, while the historical structural-dependency helper uses `DONE`/`SATISFIED`. A closed prerequisite can leave a blocker in that lower-level or historical-data path; this does not make legacy a selectable benchmark model. | [03 Tasks](03-mission-task.md) |
| Session replacement normally preserves Execution identity | A recovery/rotation count is not a count of new research responsibilities. Re-starting durable execution also updates timing/version fields; inspect the path rather than inferring it from the Session count. | [02 Execution](02-execution.md), [05 Continuity](05-workspace-continuity.md) |
| Runner rescan option is not wired to the consumed constructor field | The runner passes `maxTakeRescans`, while IdentityTaskLoop consumes `maxClaimRescans`. Setting the former does not alter that constructor's effective default of one rescan. | [07 Launch](07-run-configuration.md), [02 Execution](02-execution.md) |

## Judge and completion

The named `judge.workspace_check` capability now uses the direct `Bridge → Registry → Judge` route in both in-process and hosted deployments. Bridge supplies the Execution Workspace source and its attestation; Judge owns checking and persistence. Task Service and runner are not submission handlers. This landed boundary is documented in [ADR 0019](../adr/0019-direct-judge-workspace-submission.md), and must not be confused with the future Phase 02 public-revision, final merge-tree or Mission-submission contracts.

LeanChecker validates the locked environment/input and compiles standalone Workspace artifact source. It does **not** compare the Workspace artifact's theorem statement with the Mission through an AST/equivalence check. The runner separately rejects certain placeholder tokens. A PASS establishes the check's actual result; additional take that it proves the original Mission requires goal-binding evidence that compilation alone does not provide.

A direct Judge result does not automatically block or complete a Task, complete the Mission, or mark a benchmark solved. Task Service's explicit modern completion path checks Mission acceptance for the shared Task. Its retained `apply_check_result` operation has its own completion gates when explicitly invoked; it is not an automatic consequence of direct submission. Do not assume every explicit completion operation has identical gates. [Services](04-services.md) and [Tasks](03-mission-task.md) describe the exact paths.

## Prompts and tool exposure

| Current boundary | Effect |
|---|---|
| Composed initial snapshot versus actual send | Normal benchmark `task_take` binds with `sendInitialPrompt: false`; the snapshot event/hash is not evidence that this body was delivered. |
| Discovery versus full composed service documentation | Discovery sends SOP, tool guide and bounded candidate view. Pi registration carries schema/description/short help, while the composer's full authorized Service documentation is path dependent. |
| Two-stage Runtime composition | Runtime can use an already-composed snapshot as the static prefix of another bound composition. Recovery profile/context can therefore appear inside a second wrapper. |
| Session tool registration versus refreshed Bridge profile | The Pi extension registers once per Session, while Bridge can refresh its cached Registry profile. A Registry change does not by itself re-register Pi tools in the current Session. |
| Task instruction versus optional Sandbox profile | The benchmark Task text forbids shell, while an explicitly enabled Sandbox exposes bounded `sandbox_exec` and its help. The manual preserves both actual surfaces instead of inventing a reconciled prompt. |
| Tool-result text cap | Extension text output is capped at 65,536 JavaScript characters. It is not a guarantee that the model received every byte of a large result. |

Full bodies, composition inputs, send sites and raw evidence locations are in [08](08-prompts.md). Provider/Pi internal prompts and a run's evolving private data are not supplied by a repository template catalog. Existing aggregate prompt hashes are not complete conversation hashes.

## Workspace and Sandbox

The benchmark CLI requires the OpenSandbox provider; the local Docker manager remains an explicitly selected compatibility path for library callers and fixtures. Startup preflight runs before Observation Store creation, but its logger now guards a nullable store reference, so the former initialization-order exception is not a current boundary. Provider/worker implementations and deterministic tests still do not establish a particular image's real Pi connectivity, file synchronization or complete process cleanup. [02](02-execution.md) and [07](07-run-configuration.md) identify the implemented provider paths and the evidence needed for a deployed run.

Workspace revision metadata tracks file entries updated through the explicit file-write payload. Saving a revision can also `git add -A`, without rescanning all shell-modified files into that metadata. A Git commit can therefore contain a new/changed shell-written file while Workspace list/diff hashes are absent or stale. Reading a file can return current bytes alongside a stored older hash. Git lineage and Workspace manifest lineage must be distinguished when checking continuation evidence.

The compatibility Docker Sandbox's foreground command wrapper writes the child exit code to an `.exit` file but does not propagate that code as the wrapper's final exit status. A failed child command can consequently produce a zero foreground wrapper status. Background `jobStatus` reads the stored child status. For detached jobs, the launch timeout bounds startup; it does not establish an ongoing job deadline. These wrapper details must not be generalized to the separate OpenSandbox Execd adapter. Container termination/lifecycle cleanup remains a separate boundary. [05](05-workspace-continuity.md) gives the execution and cleanup behavior.

## Interfaces, storage and observation

The service manifests contain JSON Schema declarations, but Registry/Host do not run a general input/output JSON Schema validator on every call. Manifest/envelope/role/binding validation and handler-specific checks are the actual enforcement. Some output declarations are intentionally broad or incomplete relative to actual handler returns. [10](10-service-api-reference.md) preserves exact declarations; [04](04-services.md) describes actual behavior.

Context search/read accepts fields that are not all applied as a server-side bound: the current Material read implementation does not enforce the advertised `limit`, and lexical query behavior uses serialized content/provenance rather than a dedicated summary field. A schema field's presence is not evidence of enforced pagination. Exact semantics appear in [04](04-services.md).

Observation endpoints have different projection and visibility policies. Generic event views force the Agent payload projection; the server has no built-in user authentication, and direct Task/Context, Workspace and report routes are not covered by a universal redaction guarantee. Redaction is based on fields and size bounds, not a semantic guarantee that all sensitive text is removed. Raw-log files are local evidence, not a separate raw-log HTTP endpoint. Use [06](06-observability-experiments.md) to understand the actual exposure and deployment boundary.

## What reports and timing do not establish

| Report/runtime fact | Limit |
|---|---|
| Project report Task list | The runner requests at most 100 Tasks; derived Task/dynamic/decomposition counts can undercount a larger Mission. |
| `made_progress` | True for activity such as a created responsibility, write, nonfailure Material or check. It is not semantic proof progress. |
| `solved` | Derived from runner solve state, protocol audit and the activity predicate; it inherits the Workspace artifact/goal-binding limits above. |
| Agent time/utilization | Produced from recorded turn intervals; production explicitly records discovery turns as well. Busy time is not useful collaboration. |
| Material read/consume counts | Reading and recorded consumption show access or stated use; downstream change and usefulness need additional evidence. |
| Prompt version/hash fields | Identify selected bases/compositions; they do not independently reconstruct every delivered message. |
| `timeboxMs` | Bounds the active-loop target; setup precedes it, polling can cross the deadline, and cleanup has additional grace. |
| Full report at shutdown | Normal cleanup tries to preserve reports; setup errors, propagated single-project errors, abrupt termination or missing evidence can leave them incomplete. |

The detailed definitions and evidence gaps are in [06](06-observability-experiments.md) and [07](07-run-configuration.md). Keep missing evidence unknown; do not manufacture zeros or reinterpret a historical run as verification of later code.
