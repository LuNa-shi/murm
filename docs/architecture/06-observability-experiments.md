# 06. Observability, reports and what their evidence means

Observability records and projects execution facts. Task, Execution, Material, Workspace and Judge authority remain with their owning services. This chapter explains the complete evidence path: where a record comes from, how it is stored, what the HTTP/UI layers show, how a report is reconstructed, and where the projection loses information.

The exact observation tables are in [11 Storage](11-storage-reference.md). Startup/configuration and report finalization are covered by [07 Run configuration](07-run-configuration.md); exact prompt sources and send-path limitations are in [08 Prompts](08-prompts.md).

## 1. Evidence sources during a run

| Source | Records produced | Interpretation |
|---|---|---|
| Pi adapter/Agent trace | RPC commands and records, tool starts/results, process/turn events and local conversation data | What was sent/received on the adapter boundary; raw traces are private run evidence. |
| Bridge | Operation, current Task/Execution, request/result/error, response-sent and deferred-lifecycle boundaries | Whether a tool crossed the authenticated bound interface and what returned. |
| Runtime/identity loop | Core/Session/Execution binding, releases, restart, progress, checkpoints, timeouts and cleanup | Physical liveness and the lifecycle action selected by Runtime/runner. |
| Task/Context/Registry | Dispatch starts/completions, durable state/material changes, routing and registration facts | Service outcome; use the database for authoritative current records. |
| Judge/checker | Requests, preflight, checker result/process class, application and feedback | Distinguish compiler source feedback from an unavailable checker. |
| Workspace metadata/Git | Revision, file hashes, checkpoint, lineage and commit references | What was saved for future execution; shell work can exist before a saved revision. |
| Run metadata/report | Repository/provider/prompt/config identity, aggregate outcome and selected evidence references | A generated summary with its own sampling, redaction and compatibility limits. |

`DurableEventLog` appends NDJSON synchronously, adds a timestamp/scope, and redacts sensitive field names by default into `{redacted:true,sha256}`. Agent/checker loggers can use `raw:true`; those files stay in the private experiment directory. The redaction is a field-name transformation, not a proof that arbitrary prose cannot contain sensitive information. A log append failure can surface to its caller; this logger is not an asynchronous remote delivery queue.

The run also appends observations to `ObservationStore`. Each event has an ID, experiment-local sequence, timestamp, source/kind, optional Core/Session/Task/Execution/correlation IDs, visibility, original payload, Agent payload and original payload hash. Sequence has a unique `(experiment_id, sequence)` constraint and normally uses the current maximum plus one. Duplicate IDs/sequences are not silently merged by `append`. Append emits in-process events after writing; the long-lived HTTP observer also reads SQLite because its writer commonly lives in another process.

Sources: [durable logger](../../src/observability/durable-event-log.js), [Observation Store](../../src/observability/observation-store.js), [runner](../../src/benchmark/putnam-runner.js), [Pi adapter](../../src/agent/pi-adapter.js), [Runtime](../../src/runtime/runtime.js).

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

A healthy existing daemon identified by metadata is reused. A requested report can be imported into that daemon's database without starting another server. New daemon metadata is written through temporary-file rename. SIGINT/SIGTERM closes the server/stores and removes metadata only if it still belongs to that process.

The standalone server accepts `--name value` or `--name=value` for these options, plus the bare boolean `--no-raw-logs`. An unknown option fails; this launcher does not implement a `--help` branch.

| Option | Default / meaning |
|---|---|
| `--root` | `experiments`; first explicit value selects the primary root, later values add roots. |
| `--scan-root` | Repeatable additional worktree/repository discovery roots. |
| `--db` | `<primary root>/.observability/observability.sqlite`. |
| `--metadata` | `<primary root>/.observability/server.json`. |
| `--host` | `127.0.0.1`. |
| `--advertise-host` | Null; optional published address distinct from the bind host. |
| `--port` | `8787`; integer 0–65535, with 0 allowing an ephemeral port. |
| `--report` | Null; optional report to import before serving/reusing the daemon. |
| `--experiment-dir` | Null; optional original raw-evidence root for report import. |
| `--no-raw-logs` | Accepted compatibility flag with no effect. This CLI imports report projections without raw logs; only a trusted library caller can opt into raw ingestion. |

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

Client `buildModel` folds observed Task/Execution/Material data and timeline into display objects. `App.jsx` renders overview, Executions, Tasks, Materials, diagnostics, services and detail views; trace primitives render Core lanes. Format helpers, UI components and CSS change presentation, not service authority. Detail responses are cached until reselection/refresh. Material “consumers” are inferred from read/consume/use/action-like event names and references; the UI label should not be treated as a verified useful-reuse metric. Compatibility state labels also remain in the client and may lag the modern domain vocabulary.

Sources: [server projection](../../src/observability/observability-server.js), [React hook](../../src/observability/client/hooks/use-observation.js), [client model](../../src/observability/client/lib/observation.js), [App](../../src/observability/client/App.jsx), [trace](../../src/observability/client/components/ui/trace.jsx), [format](../../src/observability/client/lib/format.js), [dashboard tests](../../test/observability-dashboard.test.js).

## 5. Workspace and imported-run views

`FileWorkspaceProvider` follows only a `workspace_ref` already present in the selected Execution's observed assignment/Workspace events. It reads `.swarm/workspace.json` and numeric revision JSON files, returning file metadata and revision/checkpoint lineage. It does not expose an arbitrary path-reading endpoint. Its initial event lookup is one 1000-row page, so an older/sparse projection can fail to find the latest Workspace. A deleted/moved local Workspace cannot be reconstructed from a path string alone.

`importBenchmarkReport` converts an existing sanitized report into synthetic observations for experiment start, Core/turn intervals, assignments, Execution, Workspace writes, checks and finish. The Observer CLI imports these report projections. A trusted library caller can explicitly request raw ingestion into an isolated analysis store. Import skips an already populated experiment, so rerunning the importer is not incremental reconciliation. Some assignment timestamps use report run start rather than the original take instant. Synthetic sequence order groups reconstructed sources and must not be mistaken for the complete original interleaving of calls.

Sources: [Workspace provider](../../src/observability/workspace-provider.js), [report importer](../../src/observability/benchmark-report-importer.js), [Workspace observer tests](../../test/observability-workspace.test.js), [importer tests](../../test/benchmark-report-importer.test.js).

## 6. Benchmark outcome metrics and their limits

The runner finalizes its report from Task/Execution/Material/check data, Core accounting, cleanup evidence and protocol checks. Important meanings are:

The Workspace audit reads every taken Execution from Task Service after cleanup.
Each materialized Workspace reference must be unique. A missing Execution or a
missing reference invalidates the report, except for the known preparation
failures and a durable `FAILED` budget stop before activation. The latter requires
`started_at` to be explicitly null and the terminal reason to be
`bot-lifetime-budget`, `execution-timebox` or `benchmark_deadline_cleanup`.
A deadline can expire while Workspace creation or binding is still pending;
that path legitimately has no materialized reference. Once activation has been
recorded, those budget reasons do not excuse a missing reference. Duplicate
references remain invalid even for preparation failures. This read-only report
classification does not change admission, timers, cleanup or Agent visibility,
and does not rewrite reports produced by older revisions.

| Report field/family | Current implementation meaning and limit |
|---|---|
| `solved` | The Mission submission coordinator has a persisted accepted submission for the fixed public main and input manifest. This scientific outcome is independent of protocol validity or ordinary source diagnostics; pending cleanup still invalidates the run evidence. See [04](04-services.md). |
| `protocol_valid` | Report/protocol checks passed, including allowed tool surface, placeholder flags and relevant run boundaries. It does not certify research progress. |
| `made_progress` | Broad activity heuristic: Workspace output, nonfailure Material or any recorded non-project check (including failed or infrastructure/request outcomes) can suffice. Whole-project Lean diagnostics are excluded from this flag and from progress work units. Proposals alone do not set it; this is not a measured collaboration benefit. |
| `progress_evidence.proposed_task_count` and `parallelism.proposal_evidence.observed_task_count` | Count all observed Mission proposals, including the first; no root/child split or inferred semantic independence. Totals come from Task Service aggregates independently of the Task detail page. The detail/narrative projection remains bounded to 100 Tasks and `project.task_page` records its total, returned size and completeness. |
| Core occupancy/parallelism | Overlap/interval accounting from recorded states/turns. Production `task_discovery_and_take` also starts an Agent-turn interval, so busy-time metrics can include discovery. |
| Scheduler metrics | Compatibility reporting from the production identity-loop path; they do not imply a `Scheduler` instance is driving that benchmark. |
| `audit.prompt_hashes` | Hashes the Core prompt value initialized from the generic prompt; it is not a digest of every fully composed/delivered per-turn prompt. |
| Judge counts | Separate source failure, infrastructure failure, unassessed and preflight health. Whole-project diagnostics remain mathematically `unassessed` even after a terminal PASS or FAIL; that count is not a pending-check count. Durable late receipts can appear in operator evidence while Bot delivery is fenced; aliases of one check are deduplicated. A request that never ran Lean is not a failed proof attempt. |
| Material/read/consume counts | Publication, retrieval and explicit consumption are different facts; useful integration needs additional semantic evidence. |

`CoreParallelismTracker` records states/intervals, Agent turns, work units, wait and Judge time. The report transforms them into overlap and utilization quantities; a populated lane or many tool calls is not proof of productive concurrency. New reports omit root/child take counts and decomposition claims. `take_count` covers every accepted recorded take; proposal counts alone do not establish independent work. Historical imports may still contain old names. The Task-created observation identifies the actual created Task, while any proposing E is recorded separately. The initial-input audit uses the Mission public Workspace metadata rather than treating the first Task as the benchmark input owner.

Sources: [runner report construction](../../src/benchmark/putnam-runner.js), [parallelism tracker](../../src/benchmark/parallelism.js), [parallelism tests](../../test/parallelism.test.js).

## 7. Offline experiment-analysis pipeline

`node scripts/analyze-experiment.mjs <directory-or-id>` invokes `analyseExperiment`/`analyzeExperiment`. Default mode is `full`, with 5-minute semantic windows; CLI also accepts `sanitized` and 10-minute windows. An experiment ID resolves beneath the configured experiments root. The default output is `<experiment>/analysis/experiment-analysis.md`; callers can override it.

Its flags are `--mode full|sanitized`, `--window-minutes 5|10`, `--experiments-root <path>` (default `./experiments`), `--output <path>`, and `--help`/`-h`. This parser accepts space-separated values, not the server launcher's `--name=value` form. Unknown options and unsupported window sizes fail before analysis.

The implementation follows these steps:

1. Resolve the experiment and read metadata. Inventory ten evidence classes: metadata, Agent, Bridge, Runtime, Service, Judge, SQLite, observation, Workspace and summary. Record missing/unreadable/corrupt/correlation evidence instead of substituting zero.
2. Read project databases and sanitized summaries. Full mode also reads private Workspace and raw-runtime facts; sanitized mode limits analysis to the available exported/bounded evidence. Build Execution intervals from Runtime records to correlate Core traces.
3. Read a configured observation store matching the run/project IDs. When several candidates exist, use the first one with matching facts. Normalize raw logs and domain rows into facts with time, identities, operation, result/diagnostic and source references.
4. De-duplicate semantic facts using kind/time/Task/Execution/Core/operation/entity/correlation keys, preferring the better-priority source and retaining the union of evidence references. This is event normalization, not proof that every producer emitted exactly once.
5. Build per-Execution semantic windows at meaningful boundaries and configured maximum duration. A long silent gap is explicit; it is not automatically classified as useful work.
6. Construct Material publication/consumer/downstream tables, service/tool/error analysis, candidate diagnostics, terminal/cleanup findings, aggregate metrics and recommendations. Render a sanitized Markdown report with evidence references.

Material “downstream effect” inference checks that a later Workspace/candidate/check/review/rework event occurs in the same consuming Execution. It does not prove the Material caused that later operation or that its content was useful. The implementation explicitly labels this as a recorded downstream operation without inferring semantic usefulness. Similar repeated-diagnostic or route-change findings are diagnostic hypotheses, not automatically approved engineering requirements.

Analysis opens each project's available Task, Context and Judge databases read-only. Historical projects can store all three domains in `project.sqlite`. Modern operation receipts provide the public Workspace revision, Material producer IDs and the Material IDs on the returned page, while the bounded Observer lifecycle event records the Task finish disposition separately from Execution termination.

The analyzer caps retained source errors at 20 and bounds many displayed evidence lists. Automated recommendation text can contain compatibility-era concepts; the current approved Issue and architecture remain the review standard. Formal experiment reports should distinguish observed result, explanation and next-step decision, with source code/test/probe/real-Agent evidence identified separately.

Sources: [analysis entry](../../scripts/analyze-experiment.mjs), [analysis engine](../../src/analysis/experiment-analysis.js), [analysis tests](../../test/experiment-analysis.test.js), [formal workflow](../workflows/experiment.md), [report template](../experiments/TEMPLATE.md).

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


The registered Bot report tool policy now admits exactly Pi `read`, `write`, `edit`, and `bash`. `swarmenv_*` extension tools are not accepted in this path. CLI service evidence remains in Bridge/Service logs; a successful Bash command by itself is not proof of a Workspace save, Material publish or Judge result. `bot_prompt_composed` records the exact dynamic body hash and preview revision before dispatch; raw RPC records establish actual transmission. The adapter version manifest identifies the immutable system/skill resources. Local scripted Pi serialization probes are controlled infrastructure evidence, not scientific or remote-provider results.

Registered public Workspace save/merge now reaches the runner's work observer after the durable result. It records public Workspace/revision identity and changed-path counts, deduplicating by operation/Workspace/revision within the Core. Already-included merges do not add writes; unchanged saves do not add changed-file work units. Observer failure is logged separately and cannot turn a committed Workspace result into a failed contribution. These events request Controller reconciliation, while durable public-state tokens prevent same-ID replay from repeatedly starting discovery. A Workspace write is activity evidence, not Mission acceptance or mathematical correctness.

## Bounded finalization evidence

The runner records `cleanup_elapsed_ms` and typed `cleanup_errors` for every unresolved shutdown component. Any such error sets `audit.invalid`, adds `cleanup_pending`, makes `run.protocol_valid=false`. Scientific `run.solved` is independently projected from persisted trusted Mission acceptance; a cleanup failure cannot erase the acceptance record or make the run protocol valid. The timebox bounds orchestration and a shared cleanup deadline bounds its joins; host scheduling, report serialization and filesystem writes are not a real-time guarantee. Timed-out provider operations retain cleanup responsibility instead of being declared stopped.

Report construction no longer creates an operator submission from every historical Material or calls `finish` using its own `solved` flag as a verdict. It only reads an existing Mission submission, within the remaining cleanup allowance. An unavailable result becomes null with explicit pending/invalid evidence. The production coordinator owns preparation, immutable input, bounded checker, accepted state and stopping signals. An accepted row immediately prevents new research admission even before the runner receives its notification. Absence of an accepted submission is not successful Mission acceptance; passing source diagnostics or healthy infrastructure cannot substitute for it.

The benchmark launcher and standalone Observer default to `127.0.0.1`. Local operator
mode uses the loopback peer and local Host header, and rejects forwarded and cross-site
requests. Remote listening requires `SWARMENV_OBSERVABILITY_OPERATOR_PASSWORD` on the
Observer process. The browser uses HTTP Basic authentication with username `operator`.
For remote access, protect the connection with a trusted TLS reverse proxy or encrypted
operator tunnel. Only `GET /health` is anonymous and returns service/access-mode metadata.
The dashboard, SSE streams, reports, and private Execution Workspace restoration all
require operator access before the server reads any experiment state. The launcher's
daemon reuse check verifies the current authentication protocol via health. Daemon
metadata records the access mode and does not include the password.

### Managed private audit retention

The benchmark launcher exclusively creates a new owner-only experiment directory under
the selected experiment root and records its device, inode, PID, process start time,
boot ID and creation time. Timed library runs require the active audit handle for that
same directory. The launcher applies umask 077, and raw NDJSON opens verify a regular,
single-link, owner-owned target and enforce mode 0600 without following a leaf symlink.
Live Service and checker observations carry an event identity and hash in the shared
Observer database. The original logs and authoritative private state stay below the
managed directory.

A timeboxed cleanup error is written into the report. The CLI emits a cleanup-pending
status, waits for real checker, Workspace reconciliation and other tracked work, closes
the borrowed Observation Store, then records audit closure. An execution that has died
without recording closure is eligible for removal after seven days from its creation.
A normally closed execution is eligible seven days after confirmed closure. Active
owners are protected by boot and process-start identity. The sweep skips unmarked
historical experiments, unsafe paths, symlinks, and invalid marker identities.

Install and enable this per-user systemd service and timer before formal use. Choose
the same absolute experiment root passed to the benchmark. The timer checks expiration
every hour while the user manager is running. Configure a persistent user manager
where deletion must occur while the operator is logged out.

```ini
# ~/.config/systemd/user/swarmenv-private-audit.service
[Service]
Type=oneshot
ExecStart=/absolute/path/to/node /absolute/path/to/SwarmEnv/scripts/prune-private-audit.mjs --root /absolute/experiment/root
```

```ini
# ~/.config/systemd/user/swarmenv-private-audit.timer
[Timer]
OnCalendar=hourly
AccuracySec=1s
Persistent=true

[Install]
WantedBy=timers.target
```

Run `systemctl --user daemon-reload`, enable the timer with
`systemctl --user enable --now swarmenv-private-audit.timer`, run the service once
with `systemctl --user start swarmenv-private-audit.service`, and verify the next
scheduled run with `systemctl --user list-timers swarmenv-private-audit.timer`.

Reports describe four independent Core loops per project and the configured number of parallel projects. The registered Task creation event records Mission, Task, producer context and its request outcome without a legacy spawn relationship. The importer leaves a flat or Mission-marked report unrooted, even if an earlier report includes null parent fields on all Tasks. Historical unmarked reports retain their original root import rule.

### Recorded tool output boundary

The analyzer reads raw Pi `tool_execution_end`/`tool_result` events and hashes the JSON encoding of their actual `result.content` array. Normalized facts retain that SHA-256, encoded byte length, tool-call identity and explicit numeric truncation metadata. They do not copy the private output into the report and do not substitute `structuredContent.output`, whose programmatic limit can differ from the model-facing text. An absent truncation flag remains unknown. Raw matching start events preserve read path/offset/limit or the private Bash command; the run's own mounted-resource manifest establishes a skill version, rather than the current analyzer checkout. A completed Pi tool event establishes this local return boundary only. Whether a subsequent provider request included it, transformed it or omitted it requires actual request evidence; the analyzer labels that delivery unestablished by the tool event alone.

## Independent service evidence

The coordinator logs remote Context/Judge request start/completion and records the peer PIDs and HTTP deployment mode. Judge peers currently do not receive the coordinator's stage logger. Their durable CheckResult database, phase receipts, private stderr log and checker resource ledger establish peer-side outcomes; a per-stage checker NDJSON stream must not be inferred from coordinator completion records. Raw databases, logs and resource identities stay in ignored experiment storage. Checker cleanup is verified before terminal report eligibility; peer shutdown subsequently remains part of store close, and a shutdown failure propagates instead of silently confirming process cleanup.

## FLT10 benchmark inputs

Issue #133 adds the complete ten-checkpoint FLT10 ladder as benchmark inputs;
its first authorized observations select Q10 and Q20 individually. The existing
runner and Swarm organization execute them. `config/flt10.json` names the pinned
ContextSwarm fixture commit and original paths, original baseline digests, and
explicit Lean declaration names. Project IDs remain filesystem-safe identifiers;
`declaration_name` selects the namespaced theorem for Mission acceptance and
independent kernel replay. Legacy Putnam manifests still use the project ID.

The loader requires ten entries for `benchmark=flt10` and twelve for the default
Putnam profile, rejects unknown profiles, duplicates, malformed FLT names and
source hash changes, and checks each original file against the pinned Git blob.
Timed execution repeats the fixture check. Generic `fixture_commit` records the
input revision; `putnambench_commit` remains readable for old inputs and reports.

Before initial Workspace creation, `readBenchmarkContext` verifies a host-bound
context manifest and every file digest, rejects traversal, symlinks, duplicates,
Lean source destinations and files outside `benchmark/`, and enforces 2 MiB per
file and 14 MiB total. Failures stop setup and trigger normal project cleanup.
The verified bytes seed the public Workspace with the original target source.
Full graph metadata is split into independently compressed XZ shards. The Python
reader checks each shard and searches statements in memory without extracting the
whole graph to Bot disk. Cut metadata and safe definition text accompany it.
These are public input files, not Tasks or Materials; the usual Workspace revision
history records subsequent research changes. The seeded README explains the exact
target path and metadata query commands. No completed proof or historical run is
seeded. Core scheduling, Task selection and collaboration rules are unchanged.

Root-only FLT preparation and formal readiness are separate observations. The
operator records initial compilation, root identity, a private complete-target
witness and visibility validation per checkpoint. A root `sorry` warning is an
expected initial-state observation, never a solution. A validated private
reference project is engineering evidence and is not Swarm research output.
A timed run requires a receipt bound to its target/context/checker; missing
validation fails before Bot creation. Earlier full-graph FLT reports retain their
original profile. Current root-only work focuses on Q20; Q100 complete-proof
validation and model experiments are deferred. See [run configuration](07-run-configuration.md)
for the receipt and public/private file boundaries.

## Independent-attempt evidence

Pass@K preserves each attempt's normal Mission, Task, Bot, Execution, Workspace, Judge and model-budget evidence. Artifact directory keys append `-attempt-N`; `problem_id` remains the actual benchmark problem. The aggregate `pass_k` section records the group observation window separately from each Mission's active duration, attempt validity, accepted timestamps and late results. `first_success_ms` is measured from the common group start including preparation. One successful, valid attempt establishes the observed group success; validity of all K attempts is reported separately, so a partially invalid group is not a complete valid comparison. A single group is not a statistical estimate over a problem distribution.
