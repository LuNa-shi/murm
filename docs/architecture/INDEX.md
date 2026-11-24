# SwarmEnv implementation manual

This manual describes the implementation in this tree. Generated fingerprints identify the mapped source files. The associated GitHub Issues and PRs record the revisions used for acceptance, integration and release.

This directory is written for the owner who wants to understand the implementation **without reading source code**. The narrative explains execution order and behavior; the reference pages contain full repository-controlled prompts, tool contracts and storage definitions. Source and test links are evidence for maintainers, not required reading to fill in missing explanations.

The programmable [Core Runtime](15-core-runtime.md) and [Pi/OpenSandbox backend](16-pi-opensandbox-backend.md) implement the Phase 0005 resource and input boundaries. Environment modules own collaboration and domain policies. The [foreground host](17-environment-reporting.md#foreground-environment-control) reuses flat and agensh assembly for input, status and stop. The standalone Notes example uses installed public exports. Their actual verification and remaining acceptance conditions belong to the linked implementation Issues.

The flat domain services retain the Mission/Task/Execution/Material/Workspace contract described by chapters 01–05. Whole-project diagnostics, checked merges and trusted Mission acceptance have separate authorities. Legacy domain Runtime and per-domain private history readers remain directly callable components; experiment reconstruction and archived service-schema conversion have been removed. The benchmark runner, fixed mathematical datasets and historical report importer have been removed and are preserved in the fixed research revision. Historical experiment evidence retains its recorded implementation baseline.

## Reading map

Read 00 first, then 07 for current entry points. Read 15–20 for the programmable Core and Environment flows, and 01–06 for shared and legacy domain mechanisms. Use 08–12 as full references and a review checklist.

| Chapter | Questions it answers |
|---|---|
| [00 System and a complete run](00-overview.md) | Who owns which facts? What happens from launch through collaboration, checking, handoff and shutdown? |
| [01 Agent Core](01-agent-core.md) | How is Pi launched? What does a fresh Bot receive? How are tools installed, authorized and routed? |
| [02 Execution and control loops](02-execution.md) | How do the flat controller, Core-backed ownership and retained domain Runtime handle Execution states, timers and recovery? |
| [03 Mission and Task](03-mission-task.md) | What fields are persisted? How are independent Mission Tasks proposed, taken, completed, blocked and closed, and which historical paths remain executable? |
| [04 Services](04-services.md) | What happens inside a named call? How do Context, Judge, Registry, remote services and Mathlib search work? |
| [05 Workspace and continuity](05-workspace-continuity.md) | How do files, revisions, Git, snapshots, Sandbox, compaction, recovery and handoff preserve work? |
| [06 Observability and evidence](06-observability-experiments.md) | What do the database, logs, HTTP/SSE API, pure projections and retained evidence actually record? What cannot be inferred? |
| [07 Launch, configuration and finalization](07-run-configuration.md) | Current host entries, configuration, startup/stop, optional service deployment and checker resources |
| [08 Prompt reference and delivery](08-prompts.md) | Full prompt bodies and tool guidance, repository send sites, dynamic values, complete synthetic examples and actual-delivery evidence |
| [09 Known implementation boundaries](09-known-boundaries.md) | Current discrepancies and limits that would otherwise make the manual misleading |
| [10 Service and tool reference](10-service-api-reference.md) | Complete advertised capabilities, schemas, audience, binding, help and compatibility catalog entries |
| [11 Storage reference](11-storage-reference.md) | Complete database definitions, keys, indexes, ownership and persistence boundaries |
| [12 Source coverage](12-code-coverage.md) | Runtime/configuration/build source files, their role, chapter ownership and fingerprints; explicit generated/test/data classifications |
| [13 Private history](13-historical-resume.md) | How are service database history and current Workspace publication records retained and verified? |
| [15 Programmable Core Runtime](15-core-runtime.md) | How does a host assemble and run a Task-free Bot, subscribe to input results and close the run? |
| [16 Pi/OpenSandbox backend](16-pi-opensandbox-backend.md) | How does Core connect its identity, a guest, a Pi Session and separately confirmed stop and destruction? |
| [17 Runtime evidence and Environment reports](17-environment-reporting.md) | How do the foreground host, Notes and subagents run? How do reports record input, events, Service operations and cleanup failures? |
| [18 Single-peer Agensh Environment](18-agensh-environment.md) | How does one Core peer use separately bound Git, message and board accounts across continuous turns and retain private work? |
| [19 Fixed scaleMAS peer pool](19-scalemas-environment.md) | How does a fixed pool publish immutable content, adopt ranked references and continue its Sessions without Tasks? |
| [20 Fixed lead-helper Environment](20-lead-helper-environment.md) | How do Board transactions, restricted Git identities, direction adoption and cleanup work? |

## What complete means here

For every running subsystem the manual must describe its entry point, callers, inputs/defaults, guards, mutation order, durable and in-memory state, outputs, error/retry/timeout paths, cleanup and observation. Successful paths alone are insufficient. Compatibility behavior still executable in the reviewed tree must be labeled and covered until removed.

The prompt reference includes full repository-controlled text, ordering and conditional assembly, exact tool guidance and safe complete examples with synthetic dynamic data. It cannot contain every future Mission, tool result, external service bundle or provider-generated string in advance. Those variable fields are identified with their origin. Pi/provider internal context is outside this repository; actual messages for a particular private run must be reconstructed from that run's retained evidence. A composed snapshot, prompt version or hash is not by itself a complete transcript.

Source coverage is an inventory, not a formal proof that every branch is correct. Generated references reproduce code-controlled facts; a human-readable explanation and review are still required. The [known boundaries](09-known-boundaries.md) are part of understanding this implementation.

### Earlier Judge queue evidence

The Judge queue adjustment in PR #132 introduced unlimited ordinary checks, concurrency four and a bounded FIFO queue. EXP-20261116-08 observed 33 ordinary admissions, trusted acceptance and verified cleanup on that revision. Concurrency peaked at three and no request queued. The saturation and ordering evidence comes from controlled tests. EXP-20261116-07 exercised revision `e18c7ae` with an ordinary-check limit of 20 and concurrency two. [Queue adjustment](https://github.com/LuNa-shi/SwarmEnv/commit/1c2d5d5825d3511aa47d0964c11f44d107d28da5) · [EXP-20261116-08](../experiments/EXP-20261116-08-judge-queue-1h.md) · [EXP-20261116-07](../experiments/EXP-20261116-07-centralized-judge-1h.md)

## Documentation responsibilities

| Artifact | Owns | Update point |
|---|---|---|
| Phase 0005 design on `main` | This stage's target behavior, decisions, scope and acceptance | Reviewed design PR; update derived tickets to cite the exact revision |
| Approved GitHub Issue / accepted Agent Brief | Intended change, scope, resources and acceptance outside Phase 0005; task graph and evidence for every phase | Human decisions and meaningful implementation progress |
| Other numbered phase designs | Versioned target design attached to the authority Issue, including proposed prompts and migration | Design PR review; exact approved revision linked from the Issue |
| Architecture | Current reviewed implementation and explicit discrepancies | In the same PR as behavior changes; complete reconciliation at stage closeout |
| Experiments | Inputs and observations of a particular version/run | Registration and evidence-backed reporting |
| ADR | Durable decision rationale and tradeoffs | Only when a significant decision warrants a lasting record |

Implementation progress and handoffs stay in the originating Issue/PR. Apply approved changes through the authority for the affected phase. Architecture describes the resulting implementation, with verification tied to the revision and environment that produced the observed result.

## Required update and verification procedure

1. Identify every affected runtime/configuration/CLI/UI/service file in [source-map.json](source-map.json), and inspect the corresponding complete flow rather than only the edited function.
2. Update the explanatory chapters, including changed defaults, fields, state transitions, errors, prompt-delivery paths and limitations. Keep present behavior and approved future work explicit.
3. Run `npm run docs:generate`. Review the full prompt, API, storage and source-fingerprint diffs. Regeneration cannot write the required explanation for you.
4. Run `npm run docs:check` and `git diff --check`, plus the behavior checks appropriate to the code change. `docs:check` runs offline: it checks generated drift, unmapped/missing source files, chapter ownership and local documentation links. It does not call a model, launch a real experiment or prove semantic correctness.
5. In the PR, provide a short code-area → architecture-chapter mapping, validation results and remaining limitations. At Issue/stage closeout, reconcile this directory with the final merged revision and acceptance evidence linked from the Issue/PR. Do not close out with a known stale implementation manual.

The runtime baseline and raw experiment version are separate. Updating this manual never changes historical results in [Experiments](../experiments/INDEX.md), and documentation review alone does not establish successful scientific collaboration.
