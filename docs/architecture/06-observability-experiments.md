# 06. Trace Viewer and Run evidence

## Process and read boundary

The standalone `@murm/trace-viewer` package provides the thin `murm` host command. Selecting `trace` loads the reader and HTTP server. A Run root is required via `--root <dir>` or as the first positional argument, and `--port` defaults to 8787. Port 0 asks the OS to select an available port. `--open` opens the local URL in the host browser when not running inside an SSH session. The server binds IPv4 loopback (`127.0.0.1`) and prints its URL; when an SSH session is detected (`SSH_CONNECTION` or `SSH_CLIENT`), it also prints the matching `ssh -N -L` port-forwarding command. Run the Viewer on the machine with the Run files and forward the port with the browser machine's SSH client. Core's package and Sandbox's Agent-side `swarm` CLI install independently. The package exports `@murm/trace-viewer/command` for a host dispatcher. `runTraceCommand(args)` accepts the arguments after `trace`, prints the listening URL and returns a close handle. The standalone bin registers that handle for process signals.

Each browser request must use a loopback Host header. Browser cross-site requests and differing Origins are rejected. The viewer serves GET, with no cross-origin sharing or runtime mutation surface. Records are inserted into the DOM as text. The browser's content security policy restricts loaded assets and connections to the viewer origin. SIGINT and SIGTERM close the listener and active connections. The viewer can start after the Harness has exited, model access has ended, and its Sandboxes have been deleted.

## Reader and API

The reader discovers `runtime.json` in the configured directory and its nested Run output directories. It caches a rebuildable in-memory metadata index per opened Run and retains the Runtime identity plus each indexed record's relative file and byte or line reference. The reader decodes schema 1, including the historical `bots`, `botId` and `environment-report.json` fields and current `agents`, `agentId` and `harness-report.json` fields. Legacy records without native timing or archive data expose those gaps. Unknown Service operations keep their generic identities and raw evidence.

The reader allows file access to discovered evidence. Raw detail rejects an invalidated source identity after truncation, replacement or changed record bytes. It rejects path escapes, symlinks, hard links and non-regular files. The Viewer server runs on Linux and checks the opened descriptor's path via `/proc/self/fd` to enforce containment after opening a file. Browsers connect over HTTP from any OS. See [Runtime evidence and Harness reports](17-harness-reporting.md) for producer details.

All routes are relative to the viewer origin. Run and record IDs are URL-encoded path segments.

| GET route | Data |
| --- | --- |
| `/api/runs` | Run summaries discovered below the root |
| `/api/runs/:id` | Runtime identity, Agent lanes, intervals, collaboration, status, gaps and file references |
| `/api/runs/:id/events` | Paged record metadata, optionally filtered by `agentId` or `type`, limited to 1,000 per page |
| `/api/runs/:id/records/:recordId` | A selected source record, links to related raw files and available cross-record evidence |
| `/api/runs/:id/files?path=…` | A bounded range of a known evidence file read as UTF-8 text |
| `/api/runs/:id/live` | Resumable SSE batches plus periodic report and file refresh notifications |

The event API cursor is opaque. Start with no cursor and pass the returned cursor to request the next page. For live subscriptions the server pulls up to 250 new records per batch, then waits 500 ms once it reaches the indexed tail. SSE includes an event ID suitable for `Last-Event-ID`. On reconnect that header takes precedence over the query cursor. Quiet streams get a `refresh` event every ten seconds so the browser can pick up report and archive changes. The listener waits for a slow client to drain its response before sending another batch. New complete JSONL lines are indexed incrementally and incomplete trailing lines wait for their newline. The index has no file writes in the source Run.

## Timeline and evidence inspection

The viewer shows execution, tool, model, Service and input activity against a common time scale with explicit per-Agent sub-tracks (`Input`, `Model`, `Tools`, and `Service` when present). An overview minimap navigator and NLE-style pointer controls (wheel to zoom around the cursor, horizontal swipe or drag to pan, `W`/`S`/`A`/`D`/`0` shortcuts, plus `Duration` and equal-width `Sequence` modes) let operators inspect dense multi-hour runs without visual bar overlap; dense back-to-back spans at wide zoom merge into click-to-zoom sequential clusters instead of overlapping. Agent filters, the window-synced trajectory list, and the paged events table keep individual records selectable. Run summaries include up to 1,000 timeline entries total across recorded intervals, open intervals and point observations. Points include accepted Core inputs and, for historical runs without native tool boundaries, archived Session `toolResult` timestamps. The timeline indicates when entries fall outside that view and the event pages retain their records. Clicking an interval, point or event opens its associated source records in a Structured / Raw JSON evidence inspector. Clicking a collaboration link opens its evidence and model-context matches. Files and report contents are retrieved only when selected. The Run status, business outcome and cleanup receipts are distinct views.

The execution layer uses native `agent_start` and `agent_settled` observations for intervals. Each boundary retains its timestamp source. Agent input admission, readiness and settlement observations remain separately visible. A Run with no native start evidence can still show actual recorded model and Service activity. An accepted input does not establish execution or consumption. Unknown records, missing edges and ledger or Worker trace gaps remain explicit.

Subagents links use authenticated caller and parent or destination identities, and matching request, input, operation or message IDs where the records supply them. For a returned child result, the reader matches the archived destination Session envelope to the original accepted Core input and the child's original event sequence. This relationship becomes available when the destination Session archive is readable. A message receipt is independent of evidence that its payload entered the recipient's model context. Selecting the handoff checks structured message identities in the recipient's saved model inputs and links the original requests. This lookup reads at most 8 MiB per candidate request and skips unavailable or larger bodies. Inspect the model request and final artifact or checker result separately to assess adoption. All other Service operations remain inspectable as generic calls.

The [offline demo](../operations/trace-viewer.md#replay-the-included-demo) exercises this path with a synthetic Subagents Run. The same reader opens the fixture's Core ledger, Service calls, raw model exchanges, Session archives and final file directly from disk.

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

The dedicated benchmark CLI, fixed Putnam/FLT/OpenAI Math configurations, embedded mathematical datasets, paper inputs and Pass@K group scheduler have been removed. Their version-bound inputs and operator instructions remain in the [research tree](https://github.com/LuNa-shi/SwarmEnv/tree/dc011003fa0354a881b7a3ba9ba901fe36cbcac9). Historical reports remain preserved on the research branch with their original provenance and metrics. The benchmark runner, fixture/context helpers and parallelism tracker have also been removed. Harness entry points use the public Core.

## Historical independent-attempt evidence

Retained reports can contain a `pass_k` group summary and paper-condition metadata from the research revision. Interpret their recorded group start, individual acceptance times, validity and input provenance against that exact historical code and configuration. The current tree provides no Pass@K group scheduler or paper selector. Reading an existing aggregate does not execute the retired protocol or establish a comparison for the current SDK.
