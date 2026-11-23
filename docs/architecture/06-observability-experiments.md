# 06. Observability, reports and what their evidence means

Observability records and projects execution facts. Task, Execution, Material, Workspace and Judge authority remain with their owning services. This chapter explains the complete evidence path: where a record comes from, how it is stored, what the HTTP/UI layers show, how a report is reconstructed, and where the projection loses information.

The exact observation tables are in [11 Storage](11-storage-reference.md). Startup/configuration and report finalization are covered by [07 Run configuration](07-run-configuration.md); exact prompt sources and send-path limitations are in [08 Prompts](08-prompts.md).

## 1. Evidence sources during a run

| Source | Records produced | Interpretation |
|---|---|---|
| Pi adapter/Agent trace | RPC commands and records, tool starts/results, process/turn events and local conversation data | What was sent/received on the adapter boundary; raw traces are private run evidence. |
| Bridge | Operation, current Task/Execution, request/result/error, response-sent and deferred-lifecycle boundaries | Whether a tool crossed the authenticated bound interface and what returned. |
| Runtime/identity loop | Core/Session/Execution binding, releases, restart, progress, checkpoints, timeouts and cleanup | Physical liveness and the lifecycle action selected by Runtime or its caller. |
| Task/Context/Registry | Dispatch starts/completions, durable state/material changes, routing and registration facts | Service outcome; use the database for authoritative current records. |
| Judge/checker | Requests, preflight, checker result/process class, application and feedback | Distinguish compiler source feedback from an unavailable checker. |
| Workspace metadata/Git | Revision, file hashes, checkpoint, lineage and commit references | What was saved for future execution; shell work can exist before a saved revision. |
| Run metadata/report | Repository/provider/prompt/config identity, aggregate outcome and selected evidence references | A generated summary with its own sampling, redaction and compatibility limits. |

`DurableEventLog` appends NDJSON synchronously, adds a timestamp/scope, and redacts sensitive field names by default into `{redacted:true,sha256}`. Agent/checker loggers can use `raw:true`; those files stay in the private experiment directory. The redaction is a field-name transformation, not a proof that arbitrary prose cannot contain sensitive information. A log append failure can surface to its caller; this logger is not an asynchronous remote delivery queue.

The run also appends observations to `ObservationStore`. Each event has an ID, experiment-local sequence, timestamp, source/kind, optional Core/Session/Task/Execution/correlation IDs, visibility, original payload, Agent payload and original payload hash. Sequence has a unique `(experiment_id, sequence)` constraint and normally uses the current maximum plus one. Duplicate IDs/sequences are not silently merged by `append`. Append emits in-process events after writing; the long-lived HTTP observer also reads SQLite because its writer commonly lives in another process.

Sources: [durable logger](../../src/observability/durable-event-log.js), [Observation Store](../../src/observability/observation-store.js), [Pi adapter](../../src/agent/pi-adapter.js), [Runtime](../../src/runtime/runtime.js).

## 2. Store, redaction and projections

The Observation database uses WAL, foreign keys and a 5-second busy timeout. Experiment status is `CREATED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED` or `FINISHED`; it is not a Task state. `registerExperiment` updates an existing nonconflicting root/status but does not replace all metadata. `finishExperiment` stamps end/status. A shared database connection allows an observation insert to compose with an existing caller transaction.

Each observation stores two payload columns. Agent projection recursively redacts sensitive keys, bounds strings to 4000 characters, and keeps at most 100 array elements plus a truncation marker. `visibility` (`private`, `operator`, `agent`) is descriptive metadata: an Agent-view query selects `agent_payload_json`, and does not exclude every row labeled private. Direct operator-view reads obtain the original payload. The generated report has another separate sanitization pass.

| Query | Implemented bounds and behavior |
|---|---|
| `listEvents` | Ascending sequence after a cursor; optional Execution/Task/Core/Session/source/kinds; 1–1000 results. Reads limit+1 to report `has_more` and `next_cursor`. |
| `listRecentEvents` | Tail query in descending SQL order, then returned ascending; up to 2000 events. |
| `listLatestEntityEvents` | Latest matching row per Task, Execution and Core, de-duplicated and capped; seeds state from entities older than the recent window. |
| `listActiveTimelineEvents` | Latest assignments without a later release plus latest Core states; bounded seed set for long-lived active work. |
| `getEvent`/operator API | Can request either stored payload form directly; this is a local store API, not the default generic HTTP event stream. |

An `ObservationStoreCollection` discovers several stores and supplies a read projection. The experiment list de-duplicates IDs using newer metadata, but event retrieval uses the first store containing the experiment; it does not merge two complete histories with the same experiment ID. This matters when copying/importing the same run into several roots.

Sources: [store and collection](../../src/observability/observation-store.js), [store tests](../../test/observation-store.test.js).

## 3. Server lifecycle and complete HTTP surface

The persistent entry is `scripts/serve-observability.mjs`. It defaults to `experiments`, loopback host, port 8787, database `<root>/.observability/observability.sqlite`, and metadata `<root>/.observability/server.json`. Repeated `--root` and `--scan-root` add roots; conventional `.worktrees`/`.worktree` paths are inferred even before they exist. Discovery scans for `observability.sqlite` to depth 5, excluding `.git` and `node_modules` directories. This keeps worktree-local historical runs visible to one server.

A healthy existing daemon identified by metadata is reused when its host, access mode and authentication version match the requested listener. Reuse returns that daemon's metadata with `reused: true` and exits without importing files or changing its registered observations. A new server returns its listener, database and discovery roots. New daemon metadata is written through temporary-file rename. SIGINT/SIGTERM closes the server/stores and removes metadata only if it still belongs to that process.

The standalone server accepts `--name value` or `--name=value` for these options. Unknown options, including the retired `--report`, `--experiment-dir` and `--no-raw-logs` import flags, fail during argument parsing before creating database or metadata directories. This launcher does not implement a `--help` branch.

| Option | Default / meaning |
|---|---|
| `--root` | `experiments`; first explicit value selects the primary root, later values add roots. |
| `--scan-root` | Repeatable additional worktree/repository discovery roots. |
| `--db` | `<primary root>/.observability/observability.sqlite`. |
| `--metadata` | `<primary root>/.observability/server.json`. |
| `--host` | `127.0.0.1`. |
| `--advertise-host` | Null; optional published address distinct from the bind host. |
| `--port` | `8787`; integer 0–65535, with 0 allowing an ephemeral port. |

Healthy-daemon reuse returns the existing metadata and exits; passing a different bind address to this invocation does not reconfigure that existing process.

The HTTP server accepts GET only; writes return 405. Defaults remain read-only: there is no HTTP action to take, complete, restart or modify a Task. Static assets are served from `src/observability/public/`, the Vite build output of `client/`. The dev Vite server proxies `/api` to localhost:8787; the production observer serves the built files directly.

### Routes

| GET route | Main result |
|---|---|
| `/health` | Observer liveness. |
| `/api/experiments?limit=...` | Experiment summaries and registry revision hash. |
| `/api/experiments/stream` | SSE registry updates named `experiments`. |
| `/api/experiments/changes?since=...` | Long request waiting for registry revision change or timeout. |
| `/api/experiments/<id>` | Sanitized experiment metadata, event count, Core IDs, latest sequence. |
| `/api/experiments/<id>/events` | Cursor page with common filters and forced Agent payload. |
| `/api/experiments/<id>/overview` | Bounded seed/tail events, timeline, tool counts and truncation metadata. |
| `/api/experiments/<id>/stream` | SSE observations after explicit cursor, optional compact `overview=1`. |
| `/api/experiments/<id>/timeline` | Core lanes, states and assignment/release segments. |
| `/api/experiments/<id>/execution-detail?execution_id=...` | Bounded lifecycle and tool start/result records for one Execution. |
| `/api/experiments/<id>/execution-insight?execution_id=...` | Best-effort initial prompt/Task instructions/Workspace/tool-surface projection. |
| `/api/experiments/<id>/tasks/<task_id>` | Reconstructed Task fields, Execution IDs and truncation indicator. |
| `/api/experiments/<id>/materials/<material_id>` | Readable Material summary/preview plus provenance from stored events. |
| `/api/experiments/<id>/report` | Report summary, selected raw summary fields, and adjacent analysis Markdown/text. |
| `/api/executions/<execution_id>?experiment_id=...` | Execution projection plus filtered observations. |
| `/api/executions/<execution_id>/workspace?experiment_id=...` | Runtime/observed Workspace metadata, file inventory and revision list. |
| `/api/tasks/<task_id>` | Attached Task Service's Task/children/Executions, or an event projection requiring experiment ID. |
| `/api/context/materials` | Attached Context Service read, or published-Material projection requiring experiment ID. |
| `/api/services` | Static built-in catalog service summaries, not a captured per-run dynamic Registry/profile. |

Common event filters include `after_sequence`, `execution_id` on the event route, `task_id`, `core_id`, `session_id`, `source`, comma-separated `kinds`, and `limit`. Invalid cursor/limit produces an error. The generic HTTP event surface always uses Agent projection, even when `view=operator` is requested. Unknown experiment is 404; malformed query/handler failure generally returns 400. An unmatched subroute beneath an existing experiment currently falls back to its summary.

### Exposure boundary

Operator admission covers event, detail, report and owner-service routes. Direct attached Task/Context routes can return owner-service data, Workspace projections can include path metadata, and report analysis Markdown is capped at 80,000 characters per file. Operator access grants access to those route-specific projections.

Sources: [server](../../src/observability/observability-server.js), [daemon entry/discovery](../../scripts/serve-observability.mjs), [Vite configuration](../../src/observability/vite.config.js), [server tests](../../test/observability-server.test.js), [worktree discovery tests](../../test/observability-worktree-discovery.test.js).

## 4. Bounds, SSE and client updates

The initial overview combines the last 2000 relevant events, at most 750 latest-entity seeds, and a recent tool projection. It compacts records and caps the overview at 50,000 events/4,000,000 bytes; its normal candidate set is much smaller because of the tail/seed limits. Returned metadata distinguishes payload truncation, history-window truncation, start/end sequence, seed count and whether tool counts are windowed. Tool counts deduplicate start/end records by Execution plus tool-call ID in the server's recent window. They are not necessarily all-run counts.

The timeline combines the last 1000 lifecycle events with up to 1000 active assignment/latest-state seeds, so an Execution assigned long before the recent tail can remain visible. Core-state intervals and assignment/release segments are reconstructed independently. Missing historic releases/assignments and imported synthetic timestamps can limit precision.

Execution detail scans at most 10,000 observations and returns selected lifecycle/tool events within 4,000,000 bytes, with explicit truncation metadata. Execution insight uses a bounded scan and recognizes older tool-return shapes such as `swarmenv_task_get` and `swarmenv_execution_get`; it is not a canonical concatenation of every prompt sent to the model. Modern flows, redaction, omitted calls or window limits can leave its prompt/instruction fields empty. Use the prompt catalog and private adapter records for exact send-path analysis.

SSE reads SQLite every 250 ms in batches of up to 1000 new events and sends a keepalive every 15 seconds. This crosses process boundaries that an in-memory EventEmitter would miss. The cursor is the explicit `after_sequence` query; the stream does not implement a complete Last-Event-ID protocol. The browser may replay records on reconnect, and the client de-duplicates by sequence. The overview stream selects only the overview event kinds; it is not a full transcript export.

Registry updates use filesystem watches debounced by 50 ms, plus a 2-second rescan while subscribers/waiters exist. SSE publishes registry revision changes; the fallback long request waits up to 25 seconds. Watches are advisory and can miss an inaccessible/removed path; rescan/restart supplies later recovery.

The React hook initially requests the experiment summary and overview, then opens the stream. It batches pending events every 300 ms, keeps the latest 4000 client events, and refreshes timeline after lifecycle events with a 450 ms debounce. Requests time out at 15 seconds. Registry SSE falls back after errors or 8 seconds without an initial event; failed fallback requests wait 2 seconds before retrying. The client's 15-second request timeout is shorter than the server's 25-second long-wait timeout, so an unchanged registry can time out on that fallback path rather than receiving the nominal server timeout response.

The shared observation projection folds bounded Task, Execution and Material observations plus the timeline into display objects. `src/observability/observation-projection.js` derives queues, correlates tool calls and creates Core traces. It uses plain JavaScript format helpers. The dashboard hook imports the same functions used by the Node projection tests. `App.jsx` renders overview, Executions, Tasks, Materials, diagnostics, services and detail views; trace primitives render Core lanes. Format helpers, UI components and CSS change presentation, not service authority. Detail responses are cached until reselection/refresh. Material “consumers” are inferred from read/consume/use/action-like event names and references; the UI label should not be treated as a verified useful-reuse metric. Compatibility state labels also remain in the client and may lag the modern domain vocabulary.

Sources: [server projection](../../src/observability/observability-server.js), [React hook](../../src/observability/client/hooks/use-observation.js), [observation projection](../../src/observability/observation-projection.js), [App](../../src/observability/client/App.jsx), [trace](../../src/observability/client/components/ui/trace.jsx), [format](../../src/observability/format.js), [projection test](../../test/observation-projection.test.js).

## 5. Workspace views

`FileWorkspaceProvider` follows only a `workspace_ref` already present in the selected Execution's observed assignment/Workspace events. It reads `.swarm/workspace.json` and numeric revision JSON files, returning file metadata and revision/checkpoint lineage. It does not expose an arbitrary path-reading endpoint. Its initial event lookup is one 1000-row page, so an older/sparse projection can fail to find the latest Workspace. A deleted/moved local Workspace cannot be reconstructed from a path string alone.

Sources: [Workspace provider](../../src/observability/workspace-provider.js), [Workspace observer tests](../../test/observability-workspace.test.js).

## Historical research tooling

The research tree at `dc011003fa0354a881b7a3ba9ba901fe36cbcac9` preserves benchmark report construction, parallelism accounting, offline research analysis, historical importer and their tests. Current observation queries read actual registered event stores. They no longer synthesize observations from benchmark JSON. Historical report fields and results retain the semantics of their recorded source revision.

Historical implementation details remain in the [research observation manual](https://github.com/LuNa-shi/SwarmEnv/blob/dc011003fa0354a881b7a3ba9ba901fe36cbcac9/docs/architecture/06-observability-experiments.md). Formal evidence structure follows the [experiment workflow](../workflows/experiment.md) and [report template](../experiments/TEMPLATE.md).

## 8. What must be captured to answer a runtime question

| Question | Evidence needed |
|---|---|
| What did this Agent actually receive? | Exact source/version/profile plus private prompt-send/RPC records for that Session. The dashboard's initial-prompt card and report hash are insufficient on their own. |
| Was a Task really taken/completed? | Task/Execution rows, versions/fences and the successful domain result; UI event text is secondary. |
| Did a successor reuse prior work? | Material producer/link/consumer identity, saved Workspace/Git lineage, subsequent concrete action and a semantic assessment. |
| Did Judge check the right candidate/environment? | Workspace artifact source/hash/revision, target Task/spec, input snapshot and locked fixture/preflight identity, result/application facts. |
| Was a failure mathematical or operational? | Checker process/result class, diagnostic, retry/health state and whether a source-level result exists. |
| Did the run stop cleanly? | Final durable Execution/Task disposition, process/Core/Workspace cleanup and the report's cleanup errors. |

Missing evidence is `unknown`. Generated docs and schema checks make source changes visible; they cannot create missing historical traces or establish real-Agent acceptance. At a phase/Issue closeout, update the affected implementation chapters and evidence status while retaining the exact experiment baseline. Do not rewrite a past report to appear to have run against the newer implementation.


## Runtime and Environment finalization evidence

Public Core records input admission, events, Service requests and cleanup under their original Runtime/Bot/request identities. The Environment report retains business failure, Core cleanup, cleanup failure and report-save failure independently. A Bot's `settled` event describes its execution boundary. The saved-result and foreground projections expose actual statuses and receipts, including unknown execution and pending cleanup. [Environment reporting](17-environment-reporting.md) explains the storage, redaction and return paths.

The standalone Observer defaults to loopback. Remote binding requires its operator credential before state is read. Daemon reuse checks the current health/authentication protocol, and metadata omits the password. Its actual access policy and API routes are described above.

The retained private-audit library and `scripts/prune-private-audit.mjs` manage explicitly marked local audit directories. A caller creates and closes the owner record. The sweep validates path, inode and process-start identity, protects active owners and skips unmarked historical directories. Expiration is measured from creation for dead unclosed owners or from confirmed closure for closed records. Automatic creation and closure by the retired benchmark launcher have been removed. [Private audit implementation](../../src/observability/private-audit-retention.js) defines the component contract.

## Independent service evidence

The independent-service coordinator exposes remote Context/Judge request observations and peer process identities to its configured logger. Judge peers currently do not receive the coordinator's stage logger. Their durable CheckResult database, phase receipts, private stderr log and checker resource ledger establish peer-side outcomes; a per-stage checker NDJSON stream must not be inferred from coordinator completion records. Raw databases, logs and resource identities stay in ignored experiment storage. Checker cleanup is verified through the peer ledger. Peer shutdown remains part of store close, and its failure propagates to the caller.

## Retired embedded benchmark inputs

The dedicated benchmark CLI, fixed Putnam/FLT/OpenAI Math configurations, embedded mathematical datasets, paper inputs and Pass@K group scheduler have been removed. Their version-bound inputs and operator instructions remain in the [research tree](https://github.com/LuNa-shi/SwarmEnv/tree/dc011003fa0354a881b7a3ba9ba901fe36cbcac9). Historical reports remain preserved on the research branch with their original provenance and metrics. The benchmark runner, fixture/context helpers and parallelism tracker have also been removed. Phase 0005 Environment entry points use the public Core.

## Historical independent-attempt evidence

Retained reports can contain a `pass_k` group summary and paper-condition metadata from the research revision. Interpret their recorded group start, individual acceptance times, validity and input provenance against that exact historical code and configuration. The current tree provides no Pass@K group scheduler or paper selector. Reading an existing aggregate does not execute the retired protocol or establish a comparison for Phase 0005.
