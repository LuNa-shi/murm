# 13. Private service and Workspace history

The retained history modules record and reconstruct individual domain databases and public Workspace state. They are internal file-level utilities, not exports of the public Core package. The experiment importer, archived service-schema conversion and composed fresh-run handoff have been removed. These readers do not start Bots, issue model/checker requests, allocate resources or restore a running Environment.

## Service reader entry and failure boundary

`restoreServiceDatabaseAt({sourcePath, destinationPath, domain, at})` accepts one quiescent SQLite source, a new destination, a domain (`task`, `context` or `judge`) and an explicit timestamp with timezone. `parseReplayTime` normalizes the timestamp to UTC; ambiguous local times and invalid domains are rejected. The source is resolved to a real file, source and destination must differ, and exclusive destination creation rejects an existing output without changing it. The function creates destination parent directories as needed.

The reader reserves the new destination and stages the source files beside it. It compares source file identities, sizes and timestamps before and after copying and rejects a source that changes during capture. SQLite backup then creates the destination from that staged copy. The caller must keep the source quiescent; this check does not lock another service process. The reader validates and rewinds only current automatic history. Missing domain history, an unsupported history format or a cutoff before the recorded compatible interval returns `REPLAY_HISTORY_MISSING`, rather than projecting receipts or converting an archived schema. Incomplete capture, table schemas or transaction boundaries also fail with that code and relevant details.

Success returns the domain, normalized cutoff, `mode: journal`, covered interval, reverted-event count and warnings. On failure it closes opened connections, removes the reserved destination and SQLite WAL/shared-memory sidecars, and removes temporary staging. Source files remain untouched. The reader does not coordinate multiple service copies, check cross-domain references, retire historical ownership, write `resume.json` or provide an active-run continuation contract. A caller owns any later use of the copied data.

## Automatic database history

Persistent Task, Context and Judge constructors enable recording after their schema
setup. The `replay_*` tables live in the same private SQLite database as the service.
In-memory fixtures can opt in explicitly. Observation projections and live
ownership/delivery tables are excluded. Reconstruction does not normalize runtime
ownership or assemble a new Environment. Adding a runtime-only table does not move the public history boundary.
Task initializes the manual-review table before enabling capture. The separate
`review-mission.mjs decide` writer also installs transaction tracking; `show` stays
read-only. A public table without capture makes journal reconstruction fail with
its table name, rather than silently carrying its final values into the past.

| Table | Meaning |
|---|---|
| `replay_tables` | Captured table columns, row identity and the start of its compatible history interval |
| `replay_domains` | Service domain, history format and covered tables |
| `replay_events` | Stable sequence and complete before/after row values for inserts, updates and deletes |
| `replay_transactions` | Explicit transaction start and recorded commit time |
| `replay_control` | Current writer's transaction marker, cleared before commit |

Row capture triggers run inside the business write. Rolling back a transaction also
rolls back its history. Binary attachments and SQLite integer types are retained;
deletes retain their old row. Recording is below `dispatch`, so internal changes
such as finish finalization and dependent-Task reconciliation are included.

The connection records explicit transaction completion, including prepared control
statements and savepoint transactions. It allocates a transaction marker only when
the first write occurs; read-only transactions remain reads. Compound `exec` input
uses SQLite's own parsed statement boundaries. Ordinary autocommit statements use
SQLite's statement-stable timestamp. Timestamps have millisecond precision. A cutoff
includes all recorded commits at or before that time, with sequence establishing
order within a database. A transaction cannot be split by choosing a time between
its individual row writes. Nested savepoints are tracked in order. A name reused
by an inner savepoint resolves to that inner scope on release or rollback. If a
commit fails while SQLite keeps the transaction open, a later repair and successful
retry retain the original transaction marker.

The offline reader copies the quiescent source's database, WAL and rollback-journal
files into temporary storage before opening SQLite. Source files must stay stable
during this copy. SQLite recovery and backup operate only on the temporary copy, so
even the original shared-memory sidecar remains untouched. For a covered time,
it undoes later row changes in reverse
sequence. It verifies table shapes, capture coverage and transaction boundaries.
Capture is removed before the offline rewrite. If a caller later opens the copy
with a persistent service constructor, it installs a new recording interval. A schema change begins a new exact-history interval rather than
silently interpreting older row images using different columns.

This history is private run data, not a sanitized observation log. Keep the source
databases and referenced file objects while offline historical reads are needed; the
existing raw-evidence retention rules still apply.

An unjournaled database remains usable through its ordinary service API. Installing capture records a new compatible interval; it does not establish earlier history. The manual-review CLI's `show` command leaves an unjournaled database unchanged, while `decide` starts capture before its transaction. A cutoff before that capture boundary is rejected, and a covered later cutoff restores the committed decision through the journal.

## Workspace history and main selection

Every normal public Workspace commit now appends an immutable event under
`.swarm-history/`, including create, save, merge, freeze/unfreeze and request receipts.
The existing `.swarm-journal.json` remains the interrupted-write intent. Finishing
that intent durably writes the event and history head; recovery preserves an event
already written before a crash instead of duplicating it.

For recorded history, the Workspace reader selects the committed event prefix and its public
Workspace record. It creates a new repository containing only the then-visible
revisions and their reachable Git objects. Past unmerged saves remain available for
Material references; future revisions and receipts are excluded. The new repository
supports ordinary subsequent save and merge operations.

For old Workspaces, immutable revision metadata and main's first-parent ancestry can
identify an earlier main. A newer save is not necessarily main. This path reports
that old revision timestamps describe creation rather than an independently recorded
publication commit. Old freeze state and undated request attempts are handled as
new-run ownership state, not guessed from the final Workspace record. Missing Git
objects, ambiguous ancestry or missing committed history produce explicit errors.

The standalone entry is `restoreWorkspaceAt({sourceRoot, destinationRoot, workspaceId, at})`. It requires a safe Workspace identifier, a separate new destination and a timezone-qualified timestamp. An unsettled publication intent, incomplete history, changed source or unavailable Git identity fails explicitly. It removes its partial output on failure. Workspace history is independent of SQLite capture; its immutable-revision fallback remains supported and does not revive service-schema conversion or experiment assembly.

## Verification seams

Real SQLite tests cover overwritten/deleted rows, binary data, transaction rollback, a cutoff during a transaction, replacement, quoted savepoints, prepared control statements and source preservation, including WAL sidecars. An unjournaled real Task database returns `REPLAY_HISTORY_MISSING`, leaves source bytes intact and leaves no destination or staging directory. Independent manual-review writer tests verify decisions before/after commit and the exact automatic-history boundary. Workspace tests cover save versus main, missing history, crash recovery, excluded future Git objects and new writes after restoration. These are offline deterministic checks, not evidence of active long-running collaboration.

Sources: [database history](../../src/replay/service-history.js), [Workspace history](../../src/replay/workspace-history.js), [database regressions](../../test/service-history.test.js), [manual-review regressions](../../test/replay-manual-review.test.js), [Workspace regressions](../../test/workspace-history.test.js).
