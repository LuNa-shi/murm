# murm implementation manual

This directory describes how the current tree runs. It is the authoritative implementation narrative for the Core SDK, backend, Harnesses, domain Services and retained compatibility paths. The [user documentation](../INDEX.md) introduces those capabilities through runnable workflows; this manual explains their ownership, call order, stored state, failure paths and observable results.

Start with [00 System overview](00-overview.md). For an SDK application, continue with 15, 16 and 17. TaskPool adds the Mission/Task/Material/Workspace model described in 01–05; that model is not a prerequisite for another Harness.

## SDK and shared runtime

| Chapter | Questions it answers |
| --- | --- |
| [00 System overview](00-overview.md) | What does the Harness own, what does Core own, and how does one Run progress from assembly to finalization? |
| [15 Core Runtime](15-core-runtime.md) | What are the public entries, Profiles, Agent controls, input receipts, file operations and observation contracts? |
| [24 Durable recovery and Kubernetes](24-runtime-recovery.md) | How are allocations, controller ownership, recovery, long polling, retention and cluster verification bounded? |
| [16 OpenSandbox backend](16-pi-opensandbox-backend.md) | How do Pi and Codex run in a Sandbox? How are model access, guest transport, stop, archives and deletion handled? |
| [04 Services](04-services.md) | How do manifests, adapters, Bridge authorization, local and external Services work? How do the domain Services apply their own state rules? |
| [17 Runtime evidence and Harness reports](17-harness-reporting.md) | How do SDK finalization, Messages, Notes, Subagents and foreground hosts record inputs, outputs, errors and cleanup? |
| [23 Project Harness entry](23-project-harness.md) | How does the installed CLI load a Harness, capture a project, run or stop it, and report results? |
| [07 Launch and configuration](07-run-configuration.md) | How are the package, Worker, host, model endpoints, CLI, local setup and optional Services configured? |
| [06 Trace Viewer and evidence](06-observability-experiments.md) | How are saved and active Runs inspected, and what do those records establish? |
| [09 Known boundaries](09-known-boundaries.md) | Which current limitations would otherwise make the SDK or architecture misleading? |

## Collaboration mechanisms and domain behavior

| Chapter | Questions it answers |
| --- | --- |
| [01 Agent startup and domain integration](01-agent-core.md) | How are Agent tools, instructions and authenticated domain calls assembled, including retained Pi/domain paths? |
| [02 TaskPool execution and control](02-execution.md) | How do TaskPool ownership, Core-backed file handoff, timers, continuation and the retained domain Runtime behave? |
| [03 Mission and Task](03-mission-task.md) | How are independent Tasks proposed, taken, finished and closed? What are the persisted domain fields and guards? |
| [05 Workspace and continuity](05-workspace-continuity.md) | How do private files, public revisions, Git, publication, compaction and handoff preserve work? |
| [13 Private history](13-historical-resume.md) | Which service row journals and Workspace publication records remain, and what recovery paths are no longer provided? |
| [18 PeerMesh](18-peermesh-harness.md) | How do peer accounts, messages, Board work, Git integration and shutdown compose? |
| [19 Substrate](19-substrate-harness.md) | How do fixed peers publish, search and reuse contributions? How do generic and FATE configurations differ? |
| [20 Lead-Worker](20-lead-worker-harness.md) | How do fixed and dynamic lead/helper teams use Board transactions, direction, feedback, scoped management and Git deliveries? |
| [21 Native acceptance and benchmark registration](21-hour-matrix.md) | Where is version-bound evidence retained, and how do current formal benchmarks enforce private registration and pinned source/image checks? |

Subagents is explained in chapter 17 and its [user guide](../en/harnesses/subagents.md). The [five-Harness comparison](../en/harnesses/index.md) is the short route for choosing a mechanism.

## Complete references and documentation system

| Chapter | Contents |
| --- | --- |
| [08 Prompts](08-prompts.md) | Full repository-controlled prompt bodies, composition conditions, dynamic field origins and actual send paths. |
| [10 Service/API reference](10-service-api-reference.md) | Advertised Service schemas, capabilities, help and public TypeScript declarations. |
| [11 Storage reference](11-storage-reference.md) | Database definitions, keys, indexes, ownership and persistence boundaries. |
| [12 Source coverage](12-code-coverage.md) | Source-to-chapter ownership and reviewed fingerprints from [source-map.json](source-map.json). |
| [22 Documentation website](22-website.md) | Shared Markdown sources, rendering, search, bilingual links, build checks and deployment. |

## What this manual establishes

For a runtime flow, explain its entry point, callers, inputs and defaults, guards, mutation order, persistent and in-memory state, outputs, retries, timeouts, cleanup and evidence. Source links support the explanation; a reader should not need to reconstruct the flow from source alone. Label compatibility paths while they remain executable.

The prompt reference includes repository-controlled text and the conditions under which it is composed and sent. Future task input, external Service content and executor/provider internals are not fixed repository templates. A composed snapshot or prompt hash does not establish the complete conversation of a particular Run.

Generated references and fingerprints are coverage aids. They reproduce code-controlled facts and identify source bytes; they do not prove semantic completeness, successful model execution or scientific progress. Acceptance evidence stays in the relevant Issue/PR, and historical results stay in their fixed-revision [experiment reports](https://github.com/LuNa-shi/murm/blob/207be6356c16e5fb60c4b3c5b236d7a98383f991/docs/experiments/INDEX.md).

## Current architecture and future changes

Current behavior is maintained here and in the user guides. Human-approved Issues and explicit user instructions define intended changes and their acceptance. A linked design describes a future target until implementation and validation establish it. The [dynamic Lead-Worker design](../designs/dynamic-lead-worker.md) describes the target requirements. The [implemented dynamic and project paths](20-lead-worker-harness.md) document the current enablement and permissions.

Superseded phase plans and migration requirements are retained in Git history, rather than beside this manual as competing current contracts. Documentation cleanup does not change an ongoing Issue's approved acceptance or resource budget.

The [repository migration](../designs/repository-layout.md) records the ownership changes and acceptance scope. The five applications use the [public Harness author contract](23-project-harness.md#authoring-an-example) and own their concrete coordination and Services under `examples/`. See the [example index](../../examples/README.md) and [deployment guide](../../deploy/README.md) for their required facilities.

## Updating and checking the manual

1. Inspect each affected flow and its ownership in [source-map.json](source-map.json).
2. Update the explanatory chapter, user-facing English and Chinese guides, and affected example READMEs. Include changed defaults, state transitions, errors, prompts and limitations.
3. Run `npm run docs:generate` and review the prompt, API, storage and fingerprint changes.
4. Run `npm run docs:check` and `git diff --check`, plus the behavior checks relevant to the change. Build the website when changing guides, routes or rendering.
5. Link the changed code areas, documentation, validation results and remaining gaps in the PR. Reconcile the final merged implementation and acceptance evidence at Issue closeout.

`docs:check` is offline. It detects generated drift, missing or unmapped sources, chapter ownership and local documentation links. The website build checks rendered routes, assets, anchors and locale parity. Neither check calls a model or establishes a research result.
