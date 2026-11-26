# 06. Trace Viewer and Run evidence

## Historical research tooling

The research tree at `dc011003fa0354a881b7a3ba9ba901fe36cbcac9` preserves benchmark report construction, parallelism accounting, offline research analysis, historical importer and their tests. Historical report fields and results retain the semantics of their recorded source revision.

Historical implementation details remain in the [research observation manual](https://github.com/LuNa-shi/SwarmEnv/blob/dc011003fa0354a881b7a3ba9ba901fe36cbcac9/docs/architecture/06-observability-experiments.md). Formal evidence structure follows the [experiment workflow](../workflows/experiment.md) and [report template](../experiments/TEMPLATE.md).

## Evidence needed for runtime questions

| Question | Evidence needed |
|---|---|
| What did this Agent actually receive? | Exact source/version/profile plus private prompt-send/RPC records for that Session. A bounded execution-insight projection and report hash are insufficient on their own. |
| Was a Task really taken/completed? | Task/Execution rows, versions/fences and the successful domain result; UI event text is secondary. |
| Did a successor reuse prior work? | Material producer/link/consumer identity, saved Workspace/Git lineage, subsequent concrete action and a semantic assessment. |
| Did Judge check the right candidate/environment? | Workspace artifact source/hash/revision, target Task/spec, input snapshot and locked fixture/preflight identity, result/application facts. |
| Was a failure mathematical or operational? | Checker process/result class, diagnostic, retry/health state and whether a source-level result exists. |
| Did the run stop cleanly? | Final durable Execution/Task disposition, process/Core/Workspace cleanup and the report's cleanup errors. |

Missing evidence is `unknown`. Generated docs and schema checks make source changes visible; they cannot create missing historical traces or establish real-Agent acceptance. At a phase/Issue closeout, update the affected implementation chapters and evidence status while retaining the exact experiment baseline. Do not rewrite a past report to appear to have run against the newer implementation.


## Runtime and Harness finalization evidence

Public Core records input admission, events, Service requests and cleanup under their original Runtime/Agent/request identities. The Harness report retains business failure, Core cleanup, cleanup failure and report-save failure independently. An Agent's `settled` event describes its execution boundary. The saved-result and foreground projections expose actual statuses and receipts, including unknown execution and pending cleanup. [Harness reporting](17-harness-reporting.md) explains the storage, redaction and return paths.

## Independent service evidence

The independent-service coordinator exposes remote Context/Judge request observations and peer process identities to its configured logger. Judge peers currently do not receive the coordinator's stage logger. Their durable CheckResult database, phase receipts, private stderr log and checker resource ledger establish peer-side outcomes; a per-stage checker NDJSON stream must not be inferred from coordinator completion records. Raw databases, logs and resource identities stay in ignored experiment storage. Checker cleanup is verified through the peer ledger. Peer shutdown remains part of store close, and its failure propagates to the caller.

## Retired embedded benchmark inputs

The dedicated benchmark CLI, fixed Putnam/FLT/OpenAI Math configurations, embedded mathematical datasets, paper inputs and Pass@K group scheduler have been removed. Their version-bound inputs and operator instructions remain in the [research tree](https://github.com/LuNa-shi/SwarmEnv/tree/dc011003fa0354a881b7a3ba9ba901fe36cbcac9). Historical reports remain preserved on the research branch with their original provenance and metrics. The benchmark runner, fixture/context helpers and parallelism tracker have also been removed. Phase 0005 Harness entry points use the public Core.

## Historical independent-attempt evidence

Retained reports can contain a `pass_k` group summary and paper-condition metadata from the research revision. Interpret their recorded group start, individual acceptance times, validity and input provenance against that exact historical code and configuration. The current tree provides no Pass@K group scheduler or paper selector. Reading an existing aggregate does not execute the retired protocol or establish a comparison for Phase 0005.
