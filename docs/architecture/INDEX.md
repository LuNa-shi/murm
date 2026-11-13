# SwarmEnv implementation manual

> Current implementation reference: integration [`7c5836f`](https://github.com/LuNa-shi/SwarmEnv/commit/7c5836f). This manual originated in PR #116 at [`02adbb43d39e0b23befb7f2ffc4b19ffb386a36d`](https://github.com/LuNa-shi/SwarmEnv/commit/02adbb43d39e0b23befb7f2ffc4b19ffb386a36d); that original review remains historical context. The inventory baseline pins the current runtime reference, including the flat Task model, OpenSandbox-only benchmark path, fixed worker entrypoint, direct Workspace checks, bounded event-stream recovery, orphan quarantine and removal of the legacy Task lookup route documented below. The source fingerprints in [the coverage reference](12-code-coverage.md) identify the current mapped files; neither a baseline label nor regenerated fingerprints alone establish full branch verification. Later runtime changes must update this manual in their implementation PR.

This directory is written for the owner who wants to understand the implementation **without reading source code**. The narrative explains execution order and behavior; the reference pages contain full repository-controlled prompts, tool contracts and storage definitions. Source and test links are evidence for maintainers, not required reading to fill in missing explanations.

The benchmark CLI and exported runner now use only the flat Mission Task model and reject the removed model selectors. The Agent-facing `judge.workspace_check` path reads an Execution Workspace file through Bridge and calls Judge directly through Registry; Task completion remains a separate explicit operation, as recorded in [ADR 0019](../adr/0019-direct-judge-workspace-submission.md). The tree also contains OpenSandbox provider/worker, isolated service deployment and Bash CLI implementations. These changes are present in the referenced code tree, independently of whether their originating Issue or PR is closed. Remaining Runtime, fixture, historical-state and deployment compatibility boundaries are documented where they still apply; a flat-only normal entry point does not prove all compatibility code is absent.

The [Task–Material–Workspace design](../phases/0002-task-material-workspace/README.md), tracked in [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122), is the current implementation baseline for this integration. The narrative below describes the executable behavior at `d61165d`; it does not retain retired public lifecycle or terminology entry points.

## Reading map

Read 00 first, then 07 for the actual launch and outer loop. Read 01–06 for the mechanisms inside that run. Use 08–12 as full references and a review checklist.

| Chapter | Questions it answers |
|---|---|
| [00 System and a complete run](00-overview.md) | Who owns which facts? What happens from launch through collaboration, checking, handoff and shutdown? |
| [01 Agent Core](01-agent-core.md) | How is Pi launched? What does a reusable identity receive? How are tools installed, authorized and routed? |
| [02 Execution and control loops](02-execution.md) | How do Controller, identity loop, Runtime and compatibility Scheduler interact? Which states, versions, timers and recovery rules apply? |
| [03 Mission and Task](03-mission-task.md) | What fields are persisted? How are shared and ordinary Tasks recognized, admitted, claimed, completed, blocked and closed? |
| [04 Services](04-services.md) | What happens inside a named call? How do Context, Judge, Registry, remote services and Mathlib search work? |
| [05 Workspace and continuity](05-workspace-continuity.md) | How do files, revisions, Git, snapshots, Sandbox, compaction, recovery and handoff preserve work? |
| [06 Observability and evidence](06-observability-experiments.md) | What do the database, logs, HTTP/SSE API, dashboard, metrics and analysis pipeline actually record? What cannot be inferred? |
| [07 Launch, configuration and finalization](07-run-configuration.md) | Benchmark CLI flags, programmatic options, defaults, environment routes, startup order, active loop and shutdown paths |
| [08 Prompt reference and delivery](08-prompts.md) | Full prompt bodies and tool guidance, repository send sites, dynamic values, complete synthetic examples and actual-delivery evidence |
| [09 Known implementation boundaries](09-known-boundaries.md) | Current discrepancies and limits that would otherwise make the manual misleading |
| [10 Service and tool reference](10-service-api-reference.md) | Complete advertised capabilities, schemas, audience, binding, help and compatibility catalog entries |
| [11 Storage reference](11-storage-reference.md) | Complete database definitions, keys, indexes, ownership and persistence boundaries |
| [12 Source coverage](12-code-coverage.md) | Runtime/configuration/build source files, their role, chapter ownership and fingerprints; explicit generated/test/data classifications |

## What complete means here

For every running subsystem the manual must describe its entry point, callers, inputs/defaults, guards, mutation order, durable and in-memory state, outputs, error/retry/timeout paths, cleanup and observation. Successful paths alone are insufficient. Compatibility behavior still executable in the reviewed tree must be labeled and covered until removed.

The prompt reference includes full repository-controlled text, ordering and conditional assembly, exact tool guidance and safe complete examples with synthetic dynamic data. It cannot contain every future Mission, tool result, external service bundle or provider-generated string in advance. Those variable fields are identified with their origin. Pi/provider internal context is outside this repository; actual messages for a particular private run must be reconstructed from that run's retained evidence. A composed snapshot, prompt version or hash is not by itself a complete transcript.

Source coverage is an inventory, not a formal proof that every branch is correct. Generated references reproduce code-controlled facts; a human-readable explanation and review are still required. The [known boundaries](09-known-boundaries.md) are part of understanding this implementation.

## Documentation responsibilities

| Artifact | Owns | Update point |
|---|---|---|
| Approved GitHub Issue / accepted Agent Brief | Intended change, scope, resources and acceptance | Human decisions and meaningful implementation progress |
| Numbered phase design | Complete target design attached to an Issue, including proposed prompts and migration | Design PR review; exact approved revision linked from the Issue |
| Architecture | Current reviewed implementation and explicit discrepancies | In the same PR as behavior changes; complete reconciliation at stage closeout |
| Experiments | Inputs and observations of a particular version/run | Registration and evidence-backed reporting |
| ADR | Durable decision rationale and tradeoffs | Only when a significant decision warrants a lasting record |

Implementation progress and handoffs stay in the originating Issue/PR. Phase designs are versioned attachments to that approval process, with target behavior explicitly separated from the current implementation. An approved Issue may change the existing baseline within its agreed scope; an unreviewed implementation or regenerated reference cannot silently change the intended contract.

## Required update and verification procedure

1. Identify every affected runtime/configuration/CLI/UI/service file in [source-map.json](source-map.json), and inspect the corresponding complete flow rather than only the edited function.
2. Update the explanatory chapters, including changed defaults, fields, state transitions, errors, prompt-delivery paths and limitations. Keep present behavior and approved future work explicit.
3. Run `npm run docs:generate`. Review the full prompt, API, storage and source-fingerprint diffs. Regeneration cannot write the required explanation for you.
4. Run `npm run docs:check` and `git diff --check`, plus the behavior checks appropriate to the code change. `docs:check` runs offline: it checks generated drift, unmapped/missing source files, chapter ownership and local documentation links. It does not call a model, launch a real experiment or prove semantic correctness.
5. In the PR, provide a short code-area → architecture-chapter mapping, validation results and remaining limitations. At Issue/stage closeout, reconcile this directory with the final merged revision and acceptance evidence linked from the Issue/PR. Do not close out with a known stale implementation manual.

The runtime baseline and raw experiment version are separate. Updating this manual never changes historical results in [Experiments](../experiments/INDEX.md), and documentation review alone does not establish successful scientific collaboration.
