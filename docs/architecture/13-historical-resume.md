# 13. Private service history and Workspace publication records

Persistent services retain transaction history for explicit offline database reads. Public Workspace writes retain immutable revisions, request receipts and committed publication events for inspection and interrupted-write recovery. The benchmark timestamp-based Workspace reconstruction utility has been retired with its callers. The database reader is an internal file-level utility. Its output is a new private database file, with the caller responsible for any later use.

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
uses SQLite's own parsed statement boundaries. An anchored scan stops at the first
executable token. When the tail contains only whitespace, separators or comments,
the wrapper delegates it to SQLite's native exec. This avoids Node 22's finalized
empty-statement handles. SQLite still validates
the complete tail, so invalid SQL and closed connections raise their native errors.
Ordinary autocommit statements use
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

## Workspace publication records

Every normal public Workspace commit appends an immutable event under
`.swarm-history/`, including create, save, merge, freeze/unfreeze and request receipts.
Each event records its sequence, predecessor, commit time and public Workspace record.
The existing `.swarm-journal.json` remains the interrupted-write intent. Finishing
that intent durably writes the event and history head. Recovery preserves an event
already written before a crash instead of duplicating it, including its original
commit time. Events in the same millisecond retain their sequence order.

The current Workspace APIs read a named immutable revision or current main.
Saving a new revision leaves main at its earlier revision until an explicit merge.
`readWorkspaceHistory` reads the committed event chain and validates consecutive
sequences, predecessor identity, monotonic timestamps and the final history head.
A missing event or inconsistent head raises `REPLAY_HISTORY_INCOMPLETE`.
Reading and recovering the current Workspace use its existing repository and
publication intent. Historical experiment assembly and timestamp-selected copies
are outside these entry points.

## Verification seams

Real SQLite tests cover overwritten/deleted rows, binary data, transaction rollback, a cutoff during a transaction, replacement, quoted savepoints, prepared control statements and source preservation, including WAL sidecars. An unjournaled real Task database returns `REPLAY_HISTORY_MISSING`, leaves source bytes intact and leaves no destination or staging directory. Independent manual-review writer tests verify decisions before/after commit and the exact automatic-history boundary. Workspace publication tests cover save versus main, freeze/unfreeze receipts, ordered events, gaps and recovery after an event is written before its head. These deterministic checks establish record integrity and current-state recovery.

Sources: [database history](../../src/replay/service-history.js), [Workspace repository](../../src/runtime/workspace-repository.js), [database regressions](../../test/service-history.test.js), [manual-review regressions](../../test/replay-manual-review.test.js), [Workspace publication regressions](../../test/workspace-publication-history.test.js).
