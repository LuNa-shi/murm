# 13. Continue an experiment from a historical time

Historical continuation takes a finished experiment and a time selected after that
experiment ended. It reconstructs the public research data at that time, then starts
four fresh Core loops using the ordinary runner. The input consists of the original
experiment directory and `--at`; no operator snapshot call or preselected checkpoint
is required. [Issue #149](https://github.com/LuNa-shi/SwarmEnv/issues/149) owns this scope.

## Entry and startup order

The existing benchmark CLI accepts `--resume-from <experiment-directory>` together
with `--at <ISO timestamp with timezone>`. Supply one existing `--problem`, the
original compatible problem/checker deployment, and a new `--experiment-dir`.
The source must have completion metadata and, when managed private audit was used,
its cleanup completion record. The selected time must be inside that experiment's
recorded interval. Pass@K is not a historical continuation mode.

Before opening live services, `prepareExperimentResume` creates a temporary project
directory beside the new destination. It reconstructs `project.sqlite`,
`context.sqlite`, `judge.sqlite` and `mission-workspace/`. It checks the original
problem identity, Mission binding, file/input hash and public cross-service
references. The completed directory is published by rename; failures remove the
temporary output. Source and destination must be separate and existing destinations
are rejected.

The runner then opens the reconstructed services, retains the Mission, Task,
Material and Workspace IDs, and skips initial Mission/Workspace seeding. It checks
the final verifier identity against the original Mission. It starts the normal four
Core loops with new Bot/Execution/sandbox identities and credentials. Private Pi
conversations and unfinished private computation are not loaded. New Bots read the
public history through the existing service tools.

Offline reconstruction happens before the new run's default start clock. Subsequent
setup, sandbox startup and Bot reading follow the normal runner's timebox rules.
The new run has a fresh model-budget database and new checker admission budgets;
existing proof/check results remain research data. No historical provider resource
is adopted, stopped or deleted by this import.

## Automatic database history

Persistent Task, Context and Judge constructors enable recording after their schema
setup. The `replay_*` tables live in the same private SQLite database as the service.
In-memory fixtures can opt in explicitly. Observation projections and live
ownership/delivery tables are excluded; the fresh-run handoff resets those runtime
records. Adding a runtime-only table does not move the public history boundary.
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
its individual row writes.

The offline reader copies the finished source's database, WAL and rollback-journal
files into temporary storage before opening SQLite. Source files must stay stable
during this copy. SQLite recovery and backup operate only on the temporary copy, so
even the original shared-memory sidecar remains untouched. For a covered time,
it undoes later row changes in reverse
sequence. It verifies table shapes, capture coverage and transaction boundaries.
Capture is removed before the offline rewrite; the new live service starts its own
recording interval. A schema change begins a new exact-history interval rather than
silently interpreting older row images using different columns.

This history is private run data, not a sanitized observation log. Keep the source
databases and referenced file objects while historical continuation is needed; the
existing raw-evidence retention rules still apply.

## Existing experiments without the new history tables

The importer also understands the existing service receipts and immutable records.
It does not reject an old experiment solely because `replay_*` is absent.

- Task operation receipts retain command inputs and results, including original IDs.
  Contract revisions and finish intents supplement them. A finish becomes a completed
  Task fact at `closed_at`, not merely when its request was accepted. Historical
  dependency facts determine blocked/open status.
- Context retains immutable Material bodies and attachment bytes. Relation events
  and operation receipts restore supersession, dispute and revocation at the selected
  time. Later Materials, consumptions and corrections are excluded.
- Judge result receipts identify when a verdict existed. A check requested before
  the cutoff but completed afterwards cannot bring its later PASS into the restored
  state.
- Mission submission records retain creation and completion times. Acceptance after
  the cutoff must not stop an earlier continuation; acceptance already present at
  the cutoff remains a completed Mission. Without an independently recorded preparation
  time, an old request completed after the cutoff retains only its initial request
  metadata; its final Workspace/Material selection and result are not imported.

The importer projects recorded facts; it never resends old commands to live services
or reruns model/checker calls to recreate their outcomes. It checks required evidence
and fails with an entity/table-specific history error when it cannot support a
historical value. Final database values are not substitutes for missing old values.

Legacy reconstruction preserves supported public research facts. Its report identifies
derived fields and limitations, including fields whose exact old runtime version
counter cannot be established. Tests of this path use old-format service fixtures;
they do not certify every archived schema or a particular external experiment directory.

## Workspace history and main selection

Every normal public Workspace commit now appends an immutable event under
`.swarm-history/`, including create, save, merge, freeze/unfreeze and request receipts.
The existing `.swarm-journal.json` remains the interrupted-write intent. Finishing
that intent durably writes the event and history head; recovery preserves an event
already written before a crash instead of duplicating it.

For recorded history, the importer selects the committed event prefix and its public
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

## Fresh-run handoff

After reconstructing the historical facts, the importer performs a separately
recorded handoff in the destination:

- Old Bots no longer occupy Cores, and unfinished Executions no longer own Tasks.
  Their public provenance remains. Accepted finish intents can be finalized as part
  of this handoff; this is recorded as a new import action, not backdated to the cutoff.
- Completed/cancelled Tasks and real dependency blocking remain. Services recompute
  eligibility using the restored public facts before new takes.
- In-flight checks/submissions with no historical terminal result are marked as
  interrupted. Old peer phases, gates, notifications and observer delivery state
  are not replayed into live provider calls. Checker environment preflight starts fresh.
- An already accepted Mission is rejected as a continuation starting point. Its
  acceptance is not silently removed.

The public reconstruction and this operational handoff are distinct in `resume.json`.
That private file records the source, requested time, per-service history mode,
Workspace history selection, inherited counts, warnings and changes made for fresh
ownership. The report records inherited Materials separately and does not count them
as newly produced progress. It emits `mission_resumed_from_history` instead of claiming
an empty Task start.

## Verification seams

The automatic-history tests cover overwritten/deleted rows, binary data, transaction
rollback, a cutoff during a transaction, replacement, quoted savepoints, prepared
control statements and source preservation. Legacy tests exercise real Task/Context/
Judge APIs before reconstructing their old-format outputs. Workspace tests cover
save versus main, missing history, crash recovery, excluded future Git objects and
new writes after restoration. Resume integration tests reconstruct a completed
fixture, then exercise fresh Bot registration, take/start and Material reads across
four Cores; a zero-timebox runner probe verifies service composition without model
calls. Paid research outcomes require a separately authorized run.

Sources: [database history](../../src/replay/service-history.js),
[legacy projector](../../src/replay/legacy-service-state.js),
[Workspace replay](../../src/replay/workspace-history.js),
[resume preparation](../../src/replay/resume-experiment.js),
[runner](../../src/benchmark/putnam-runner.js).
