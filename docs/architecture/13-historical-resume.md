# 13. Private service history and Workspace publication records

Persistent Task, Context and Judge stores retain private before/after row history alongside their business state. Public Workspace writes retain immutable revisions, request receipts and committed publication events for inspection and interrupted-write recovery. The former benchmark timestamp-selected database and Workspace copy utilities have been retired. Operators inspect the original stores and fixed result identities through the current read entry points.

## Automatic database history

Persistent Task, Context and Judge constructors enable recording after their schema
setup. The `replay_*` tables live in the same private SQLite database as the service.
In-memory fixtures can opt in explicitly. Observation projections and live
ownership/delivery tables are excluded. Adding one of those runtime-only tables
leaves the existing public-table recording interval intact.
Task initializes the manual-review table before enabling capture. The separate
`review-mission.mjs decide` writer also installs transaction tracking; `show` stays
read-only. A new public table enters capture when its service installs history after schema setup. The table catalog records that interval independently.

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
SQLite's statement-stable timestamp. Timestamps have millisecond precision,
with sequence establishing event order within a database. Every explicit
transaction's surviving row events share its recorded commit boundary. Nested savepoints are tracked in order. A name reused
by an inner savepoint resolves to that inner scope on release or rollback. If a
commit fails while SQLite keeps the transaction open, a later repair and successful
retry retain the original transaction marker.

Reinstalling capture records the current table schema and enabled triggers. If a table's schema changes, installation clears that table's incompatible row images and starts its next recording interval. Other tables keep their existing intervals. Invalid domains, installation inside a transaction, a reserved history column or a table lacking a stable row identity fail explicitly. Installation runs its trigger and catalog writes in one transaction and rolls back on error.

This history contains private row payloads. Its database and sidecars follow the service's owner-private storage policy and remain subject to the raw-evidence retention rules. The manual-review CLI checks the canonical directory, regular file, owner, mode and link count before opening the database. Its `show` command opens read-only. Its `decide` command installs capture on its own connection before recording the decision transaction. An unjournaled owner-local database therefore acquires history only when an actual write installs capture. Previously recorded business rows keep their current values.

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

Real SQLite tests inspect typed before/after images, binary attachments, 64-bit integers, transaction markers, rollbacks, shadowed savepoints, prepared control statements, replacement and primary-key changes. A failed commit followed by repair keeps a single committed transaction boundary. Read-only transactions and empty SQL tails keep SQLite's ordinary behavior. Service constructors install capture automatically, runtime-only tables stay excluded, and schema changes clear only incompatible row history. Independent owner-local manual-review CLI tests verify a complete committed decision image, current Mission acceptance, read-only `show`, and capture installed by `decide`. Workspace publication tests cover save versus main, freeze/unfreeze receipts, ordered events, gaps and recovery after an event is written before its head.

Sources: [database history](../../src/replay/service-history.ts), [Workspace repository](../../src/runtime/workspace-repository.ts), [database regressions](../../test/service-history.test.js), [manual-review regressions](../../test/replay-manual-review.test.js), [Workspace publication regressions](../../test/workspace-publication-history.test.js).
