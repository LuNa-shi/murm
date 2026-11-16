# 09. Known implementation boundaries

These limits apply to the reviewed runtime. Each linked chapter explains the relevant call sequence, persistent state and failure handling. Historical evidence belongs to its original code revision.

| Area | Current behavior and limit |
|---|---|
| Mission and Task | The normal benchmark starts one Mission, a public Workspace and four reusable Cores with an empty Task pool. A fresh Bot can propose and take, take existing work, or exit unbound. The creator of a proposal has no exclusive claim. The word “goal” describes the Mission purpose or local Task objective. There is no separate Goal runtime object. [Core and Bot](01-agent-core.md) · [Mission and Task](03-mission-task.md) |
| Historical paths | Trusted lower-level APIs retain historical Task relations, internal Session recovery and old data projections. The protected registered Bot CLI grants one Execution per Bot and uses only public continuity. New research starts with a fresh Mission. Additive schema compatibility and report import do not provide a general migration or hot upgrade of active historical research state. [Execution](02-execution.md) · [Mission and Task](03-mission-task.md) · [Observability](06-observability-experiments.md) |
| Runtime and provider cleanup | Finish and stop retain Core and Task ownership until process isolation is confirmed and pending Workspace requests are reconciled. Startup compares durable Bot identity and provider labels. If a dispatched create has an unknown outcome, a listing without a match cannot confirm safe release. The network and storage controls apply to the supported local Docker-backed OpenSandbox configuration. Another provider, image or topology requires its own verification. [Execution](02-execution.md) · [Run configuration](07-run-configuration.md) |
| Service authority and cost | Timed runs default to independently hosted repository-owned Context/Judge peers with separate state and explicit Task-owned durable authorization gates; Task/Mission/Workspace remain one coordinator. Legacy standalone HTTP and arbitrary plugins do not acquire that authority implicitly. The timed profile still rejects arbitrary remote/custom providers without its verified lifecycle/resource contract. Model gateway bounds and unknown financial-cost reporting remain unchanged. [Services](04-services.md) · [Run configuration](07-run-configuration.md) |
| Public files and Material | A save captures the actual guest tree and does not advance main. Apply requires an active E and checks its private changes. Merge preserves ancestry and enforces configured combined-tree checks. Ordinary Material and Task queries are bounded. A cursor indicates unvisited scope, even after an empty filtered page. Recorded Material consumption establishes a stated use of a fixed version. Scientific usefulness requires separate evidence. [Services](04-services.md) · [Workspace](05-workspace-continuity.md) |
| Judge and final acceptance | The registered source diagnostic checks a fixed Workspace project revision (or an explicitly selected file path) within isolated process limits. A source PASS does not advance main, complete a Task or prove the original theorem. The fixed Putnam Mission checker evaluates the submitted main tree against the pinned statement and axiom policy. For a Mission without a checker, the configured manual route can hold a bounded review and requires a trusted reviewer. Failed or timed-out submissions release only their own freeze. Persisted acceptance determines scientific solved status independently of protocol validity. [Services](04-services.md) · [Mission and Task](03-mission-task.md) |
| Prompt and tools | The registered Bot uses four native Pi tools and four fixed on-disk skills. Its first message comes from live Mission, Bot and Workspace state. Trusted compatibility compositions have their own sender and tool surface. Asset receipts and composed message hashes establish identity. Actual transmission and skill use depend on recorded RPC and tool evidence. Pi or provider internal text may be unavailable. [Prompts](08-prompts.md) |
| Observation and reporting | The report includes the total proposed Task count with a bounded detail page. Busy time and recorded activity do not measure scientific utility. Raw audit retention and observer HTTP access have separate policy boundaries. Field-level redaction cannot remove all sensitive prose. Startup failure, forced shutdown or incomplete historical evidence can leave fields unknown. [Observability](06-observability-experiments.md) |
| Experiment evidence | Local scripted model traffic exercises named provider and Service paths. Deterministic fault tests and Docker probes verify other individual boundaries. [EXP-20261116-07](../experiments/EXP-20261116-07-centralized-judge-1h.md) exercised independent services and Judge-only Lean feedback with `gpt_proxy` / `gpt-6.1-sol`, reaching trusted acceptance in a 19m09.763s project interval. Ordinary checks exhausted the 20-request limit; separate merge/final paths continued, and a burst of upstream HTTP errors interrupted four Executions before recovery. The observed check budget is not a global compiler-work budget. EXP-04 remains earlier version-bound evidence. Both were early successes within one-hour maxima, not full-hour endurance results; untested providers/fault sequences remain unknown. The current runner explicitly rejects the old parallel-mode selector. Its treatment labels remain historical report data. [Run configuration](07-run-configuration.md) · [Validation design](../phases/0002-task-material-workspace/07-validation-and-research.md) |

## Fresh-start migration and restore rehearsal

Keep the old release, deployment configuration, and database locations pinned. Stop
the old writer, verify the Pi/process and provider Sandboxes are stopped or isolated,
revoke old contribution credentials, and reconcile any externally accepted operations
and their costs. Database terminal states alone cannot establish those facts. Archive
the supporting operator evidence separately and prepare an owner-private JSON file
with string references named `old_writer_stop`, `provider_isolation`, and
`external_operations_accounted`.

Use canonical paths. A legacy shared database can be supplied explicitly to multiple
domain flags. The Workspace path is the public repository directory that contains
`.swarm-workspace.json`; the revision must be a specific published `major.minor`.
Create a private parent directory with `mkdir -m 700 /absolute/rehearsal` before
creating the backup or restore directory.

```sh
node scripts/preview-migration.mjs preview \
  --task /old/task.sqlite --context /old/context.sqlite --judge /old/judge.sqlite \
  --workspace /old/public/workspace-id --revision 0.3

node scripts/preview-migration.mjs backup \
  --task /old/task.sqlite --context /old/context.sqlite --judge /old/judge.sqlite \
  --workspace /old/public/workspace-id --revision 0.3 \
  --run-manifest /old/run-manifest.json --external-evidence /private/isolation.json \
  --out /absolute/rehearsal/backup

node scripts/preview-migration.mjs restore-verify \
  --backup /absolute/rehearsal/backup --out /absolute/rehearsal/restored
```

The preview opens each database read-only. It reports SQLite's `user_version`, a
SHA-256 fingerprint of the schema definitions, and the inspected table columns.
These identify the supplied schema for comparison; they do not certify writer
compatibility. The preview reports missing authority tables or columns, nonterminal
Bot/Execution/check work, duplicate active owners, and legacy or
unknown Task states. It reports historical roles, missing producer references, corrupt
or missing Material/attachment bytes and external/private content references. Each
domain shows up to 250 findings and an untruncated count. Blocked previews still
emit their JSON report and exit with status 2. The selected public
revision is a candidate for explicit operator selection. The tool resolves its
retained Git ref, verifies the commit/tree and published content hashes, and rejects
conflicts, dangling publication journals, and private or nonregular paths.

Backup refuses active records and missing authority in the enumerated domain tables. It does not inspect `service_commit_gate`, `judge_peer_phases` or the external checker ownership ledger/systemd resources. Operators must separately confirm peer gates, phases and resources are settled before capture. It uses the SQLite backup API
for each domain and records their schema/classification, the checked public
snapshot with file modes and bytes, the run manifest, and the supplied external
evidence references. Cross-domain consistency depends on the operator maintaining
quiescence throughout capture. The tool detects observed changes and keeps
`external_isolation_verified` false. The target is a new owner-private directory
with a SHA-256 manifest. Restore rehearsal verifies all hashes, copies into a
different new directory, rechecks the copies and runs SQLite integrity checks.
This rehearsal retains the selected public input and database archives; it does
not capture the private worktree, provider resource, full Git repository, or
referenced external blobs. It never opens an archive with an old or new writer.

Start a fresh Mission under the new release with independent paths and an explicit
approved initial input. The owner can review the verified public snapshot and
choose its files as initial input when composing the new Mission. This workflow
imports no Tasks, Materials or Executions. A selective historical import would
require its own explicit decision and provenance. To roll back the release, stop
new writers, reconcile their resources and costs, and point the pinned legacy
release only at its separately verified old-format state. Preserve new-format
history and already-published results.
