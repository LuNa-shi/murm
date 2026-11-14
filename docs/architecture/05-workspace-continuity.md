# 05. Workspace, Sandbox and continuity

This chapter describes the current filesystem and process behavior, including
the direct Workspace-to-Judge input boundary added for Issue #117.
[Execution](02-execution.md)
explains durable ownership; [Mission and Task](03-mission-task.md) explains how a
successor obtains responsibility. This chapter explains which files, commits,
checkpoints, process state and feedback survive that transition.

## 0. Mission Workspace repository (public revision path)

`MissionWorkspace` owns the Mission's public versions; `WorkspaceRepository` owns Git object creation, exclusion, commit intent and recovery. This is separate from the Execution-local `WorkspaceManager` described below. New repositories have `format_version:2`. Creation imports the supplied complete initial tree into Git and publishes `0.1` with a real `main` ref. Saved versions have their own complete commit/tree and actual Git parents; saving leaves main unchanged. Internal `refs/swarm/revisions/<revision>` protect every published commit from becoming unreachable. These are neither Bot branches nor tags.

`save` accepts an actual complete tree from its trusted caller, validates paths and byte types, and defaults its parent to the supplied base or current main. Explicit multiple parents must include the base. It creates raw blobs with Git filters disabled and assembles an isolated temporary index, so `.gitattributes` cannot change stored bytes; project files never include repository metadata. Limits match the current provider copy boundary: 2 MiB per file and 16 MiB per tree. Dot/traversal/empty path segments, `.git`, `.pi`, `.swarm`, `.swarm-*`, `.env*` and `node_modules` are rejected. Binary Buffers retain their bytes. Reads return UTF-8 text or explicitly base64-encoded binary bytes, hash, byte count and truncation. Historical format repositories retain read access but cannot save/merge/freeze through the new writer.

`merge` fixes source R and current main M, uses Git ancestry and `merge-tree` to construct the final combined tree, and gives that tree to an optional trusted checker. An ancestor already included in main returns a no-op without another checker charge. Conflicts preserve main and identify paths. A checker must return literal true or verdict PASS; a truthy failed result is insufficient. The checker runs outside the writer critical section. On return, the writer checks freeze, its synchronous authorization callback and the same M, creates a commit with M/R parents, then checks authorization again immediately before the synchronous commit boundary. `MAIN_MOVED` means a new attempt must merge/check against the new main; `MISSION_SUBMITTING` rejects a merge while frozen. An unconfigured checker does not invent a scientific gate.

Public reads and materialization snapshot selection, as well as writes, pass through a per-repository in-process queue and an OS `flock` held by a helper whose stdin belongs to the coordinator. A second coordinator receives `WORKSPACE_BUSY`; process loss closes the pipe and releases the OS lock. The built-in service image installs `util-linux` for this dependency. Each entry first recovers any pending journal. main/index disagreement closes the operation with `WORKSPACE_RECONCILIATION_REQUIRED` instead of guessing which version won.

The final commit boundary is synchronous: write/fsync/rename the intent, conditionally update main with its old commit, retain the revision ref, atomically publish revision/index metadata and the request receipt, then remove the journal. No checker runs here. Recovery uses actual refs: a merge still at the old main is explicitly aborted and its original request returns `WORKSPACE_REQUEST_ABORTED`; a ref already at the new main completes metadata and the original receipt. Neither old nor new closes the write path for reconciliation. An interrupted save can complete its retained immutable version without advancing main. The tests cover injected boundaries and actual coordinator SIGKILL after the ref update; this is process-crash evidence, not a machine-power-loss claim.

Request IDs are Workspace-scoped. Same-ID concurrent operations join one in-process promise. A per-request OS lock excludes another coordinator throughout checking; it receives retryable `WORKSPACE_BUSY`. Before checker execution, the request fingerprint, source and fixed main are persisted. If that process disappears before a result, a later owner aborts the old attempt with `WORKSPACE_REQUEST_ABORTED` rather than checking again or selecting a newer main. Changed input is rejected, and persisted success or definitive rejection is replayed without another checker attempt. An I/O failure after durable intent returns retryable `WORKSPACE_RESULT_UNKNOWN`; recovery decides the original request rather than recording a false rejection. If a live checker fails before commit, the initial caller and replay receive the same recorded canonical outcome. Failure to record that outcome returns retryable `WORKSPACE_RESULT_UNKNOWN`, which instructs the caller to query or retry the original ID. Revision numbers are allocation order; ancestry comes from Git parents. `get` omits the repository's private path. `candidateFileRef` remains only `(workspace_id, revision, path)`.

This repository slice does not establish the entire Workspace contract. Existing Runtime/public service adapters still need trusted complete-tree export, fixed project permissions, contribution authorization, schema translation and full save/apply/merge integration. `materialize` rejects repository descendants, symlink traversal and nonempty targets, holds an OS lock for the target, writes a private sibling staging tree, and atomically renames it over the still-empty target. Failed copying removes its staging tree and leaves the original target empty for retry; concurrent callers cannot mix revisions. A process killed during copying can leave an unpublished staging directory for operator cleanup, but no partial tree is published. `apply` currently remains that initialization helper; it does not yet provide same-Execution three-way installation or finish interlocking. Pagination, all-history CLI and source/conflict lineage also remain to be reconciled. The presence of the new repository API is not evidence that a Bot has used it through the final approved flow.

[MissionWorkspace](../../src/runtime/mission-workspace.js), [WorkspaceRepository](../../src/runtime/workspace-repository.js).

## 1. What a Workspace represents

Every `Runtime.startExecution` or `bindAgentExecution` prepares a private
Workspace before starting the durable Execution. A Task need not expose file or
Sandbox tools to its Agent for that support directory to exist: capability
selection and materialization are separate decisions. Independent participants
in the compatibility Task path receive independent writable directories. In
the Issue #122 path Mission has no owner and the persistent Mission Workspace
repository is separate from each Execution directory; no Core or Bot receives
a shared mutable checkout.

The default location is `<workspaceRoot>/<execution_id>`. The generated path
segment must match `[A-Za-z0-9][A-Za-z0-9._-]*`; an explicitly provided Workspace
must resolve strictly below the configured root. Runtime and Task Service
retain the Execution's path, revision and hash; WorkspaceManager retains the
local owner, fence, file index and history. Neither one replaces the other.
[Implementation: Runtime workspace preparation and WorkspaceManager](../../src/runtime/runtime.js),
[WorkspaceManager](../../src/runtime/workspace-manager.js).

| Local item | Meaning and lifetime |
| --- | --- |
| Project files | Actual mutable working directory contents, shared between the file tools and that Execution's container mount. |
| `.git/` | Local repository and commits; a resumed Execution receives an independent clone. Runtime does not push these commits to GitHub. |
| `.swarm/workspace.json` | Current owner, fencing version, revision, indexed file hashes, contract, commit, checkpoint and release state. |
| `.swarm/revisions/<n>.json` | Metadata for revision `n`. |
| `.swarm/revisions/<n>/files/` | Copies of the files in that revision's metadata index. |
| `.swarm/checkpoints/<id>.json` | Execution/revision plus caller checkpoint data; content hash is stored in Workspace metadata and then Task Service. |
| `.swarm/pi-session/` | Pi session directory used by Runtime-created Sessions. Reusable identity Sessions can be created elsewhere by the runner; see [startup](07-run-configuration.md). |
| `README.md`, `workspace-manifest.json`, `runtime-manifest.json` | Initial Task description, Task/input contract and Runtime/adapter manifest, respectively. |
| `.pi/settings.json` | Runtime-installed Pi compaction/retry settings where the preparation path ensures the file. |

A public Workspace view has `workspace_ref`, `execution_id`,
`fencing_version`, `workspace_revision`, `content_hash`, `git_commit`,
`git_worktree`, parent Workspace/revision, Task and manifest fields,
`workspace_contract`, `input_snapshot`, checkpoint reference/hash,
`changed_files` and `released_at`. Some fields are deliberately nullable.
For example, clean creation writes Task and input manifests into the support
file but does not populate the equivalent optional top-level metadata fields;
cloning does populate them. A null public `task_id` or `input_snapshot`
therefore does not mean the Execution has no Task or input snapshot.

## 2. Workspace contracts and file access

A Task's `workspace` object supplies the following normalized contract.
During cloning the source contract is used as fallback and the new Task's
fields override it. Contract `version` is a string, default `"1"`.
[Contract implementation](../../src/runtime/workspace-contract.js).

| Field | Accepted form and actual meaning |
| --- | --- |
| `required_inputs` (alias `input_paths`) | Array of relative paths or descriptors `{path, content_hash}`; hash aliases are `contentHash` and `sha256`. Hashes must be 64 hexadecimal characters and normalize to lowercase. |
| `problem_file` | Automatically added to required inputs unless already present. |
| `allowed_outputs` (aliases `output_paths`, `artifact_paths`) | Array of exact relative output paths. Absent/null means normal outputs are unrestricted; `[]` declares no normal writable outputs. |
| `forbidden_paths` | Exact path matches, not recursive directory exclusions or glob patterns. |
| `internal_runtime_outputs` | Runtime adds `.pi/settings.json`, which is writable independently of the normal output list. |

Normalization converts backslashes to slashes and rejects absolute paths, NUL,
any `..` segment, an empty normalized path and `.swarm` or its descendants.
Duplicate normalized entries and overlaps between required inputs, outputs and
forbidden paths are errors. `.git` is **not** specially forbidden by this
normalizer. File operations also reject symbolic-link targets/ancestors and
non-regular-file targets; Workspace-root ownership checks reject a root or
Workspace symlink.

The file API classifies a path as `required_input`, `allowed_output`,
`runtime_internal`, `forbidden` or `undeclared`. Required inputs are
read-only through this API. Reads can also access an existing undeclared
normal file; output declaration is a write restriction, not an allowlist for
every read. A required input missing from the metadata index is reported
missing, even if an unindexed file happens to exist at that path.

| Failure | Error code and consequence |
| --- | --- |
| Missing required input during preparation/read | `WORKSPACE_INPUT_MISSING`; repair the fixture or materialization. |
| Required input hash differs at initial validation | `WORKSPACE_INPUT_HASH_MISMATCH`; details contain expected and observed hash. |
| File API writes a required input | `WORKSPACE_INPUT_READ_ONLY`. |
| File API writes an undeclared output | `WORKSPACE_OUTPUT_NOT_DECLARED`. |
| Forbidden metadata/traversal/path | `NOT_ALLOWED`, with path class/remediation where supplied by the contract helper. |
| Invalid descriptor, path/content shape, duplicate or overlap | `INVALID_CONTRACT`. |
| Wrong owner / old fence / released Workspace | `NOT_ALLOWED` for wrong owner; `FENCED` for stale fence or released writes. |
| Expected revision differs | `STALE_VERSION`. |

Initial seeding uses safe-path checks but does not apply the allowed-output
restriction to each generated support file. Later saves do apply it.
Consequently, a restrictive output contract must permit
`runtime-manifest.json` when the Runtime-created Session path updates that
file; only `.pi/settings.json` has an explicit internal-output exemption.
Required-input validation uses the supplied file manifest; it is not a
continuous monitor that prevents later shell writes.

## 3. Clean creation and existing binding

For a registered Bot with a public Mission Workspace, the benchmark passes a trusted `missionWorkspaceId` into Runtime. During take preparation, `exportRevision` resolves the fixed Task `workspace.revision`, or main when omitted, once under the repository recovery barrier and exports every file plus immutable revision/commit/tree/content and per-file hashes. Runtime verifies the Mission and rejects a conflicting Task Workspace ID. A concurrent main advance does not change the selected input. If no trusted Workspace ID is configured, an explicit Task Workspace ID is required and its Mission is still checked.

The host Execution directory receives those exact project files, including binary data and the existing `.gitignore`/README. This path adds no Task README, runtime manifest, workspace manifest or `.pi` settings to project files. Host bookkeeping stays in private `.swarm` and `.git`. Creation holds a target lock, builds a sibling staging directory, verifies every file against the public manifest, imports raw Git blobs without ignore/attribute conversion, and publishes the completed directory by rename. Exact matching retries reuse its original input; a different input/fence or a nonempty partial target is rejected, never overlaid. The initial local Git tree therefore matches the public Git tree. The OpenSandbox transfer receives the trusted manifest, copies exactly those paths using base64 chunks of at most 65,536 characters into a per-file guest temporary path, verifies the complete received file with SHA-256, then renames it into place. This stays below Linux single-argument limits even for the 2 MiB maximum file. Failed copies best-effort remove their temporary file and fail preparation; `.environment` and other allowed names are not silently omitted by the legacy traversal filter. It rejects source symlinks and bytes differing from the pinned manifest. This per-file verification is not yet a writer-pause or protected-directory guarantee. The initial public input identity is recorded in both private Workspace metadata and `executions.workspace_input_json` before activation, and cannot be changed by later local revision saves. Reports include this initial public reference separately from the older local integer revision/commit fields. This establishes complete input selection/transport and audit identity; it does not establish the still-pending protected `/workspace/project` transfer/grant contract or same-E apply.

Unregistered compatibility Executions retain the older formal-source and generated-manifest creation path. A take cannot select another Execution's private revision, source path, checkpoint or directory.

If an Execution already has its own Workspace, Runtime reads its current metadata under the current fence and continues from that binding. Matching retries are idempotent; a different owner, fence, revision, or content hash is rejected. Workspace saves advance exactly one revision and persist the file manifest and content hash before the corresponding Execution reference is recorded.

The initial README, manifest, ignore rules, Pi settings and runtime manifest are generated by Runtime. These writes may create successive revisions, so revision one is the materialization boundary rather than a promise about the first model turn.


## 4. File operations, revisions and their precise limits

Runtime's file-read/list/diff methods resolve the Execution's saved Workspace
and fence. The write method additionally requires a `CREATED` or
`RUNNING` Execution with an active Runtime process, a string path/content,
and a positive expected revision (defaulting to the Execution's saved
revision). The lower-level manager enforces the owner/fence/release and path
contract. The Runtime write result includes updated `workspace`, `file`,
an `artifact_ref` with path/revision/hash, metadata `diff` and updated
`execution`.
[Runtime file methods](../../src/runtime/runtime.js),
[WorkspaceManager operations](../../src/runtime/workspace-manager.js).

| Operation | Actual data source and result |
| --- | --- |
| `getWorkspace` | Current public metadata plus all numeric revision metadata; without a Workspace returns `{workspace: null, revisions: []}`. |
| `listWorkspaceFiles` | Sorted metadata-index entries, optionally exact path/subtree prefix; does not scan the directory. |
| `readWorkspaceFile` | Actual live file bytes, UTF-8 content truncated to `max_bytes`; default 1,000,000, allowed integer 1–10,000,000. Returns full actual byte count, truncation flag and an indexed hash if present, otherwise a newly computed hash. |
| `saveWorkspaceRevision` | Applies the supplied files map, updates those indexed hashes/lengths, stages Git changes, saves revision+1 metadata and indexed file copies. |
| `workspaceDiff` | Compares metadata hashes/lengths at two revisions; default previous (minimum 1) to current. Returns added/removed/modified entries with before/after metadata, not a text diff. |
| `listRevisions` | Numeric revision JSON entries with path, revision, hash, checkpoint, commit/worktree and changed-file list. |
| `saveCheckpoint` | Writes checkpoint JSON/hash and updates current/revision metadata at the same revision; does not increment revision or create a Git commit. |

A revision save accepts strings or Buffers at manager level (Runtime's single
file tool requires a string). It preserves the old index, replaces entries
only for explicitly supplied paths, and records those paths in
`changed_files`, even when the supplied bytes are unchanged.
`git add -A` stages all nonignored working-tree changes; Git creates a commit
only when staged status is nonempty. The Workspace revision always increases,
and its aggregate hash includes that revision number, so an unchanged file map
can have a new aggregate hash while retaining the same Git commit.

**The metadata index is not a complete live filesystem index.** A Sandbox
command can create, modify or delete files without updating it. A checkpoint
with `files: {}` can commit such shell changes to Git while retaining old
indexed hashes and omitting newly created files from `workspace_list_files`
and metadata diffs. Snapshot copying reads the actual bytes of indexed paths,
so an externally modified indexed file can be copied with a stale recorded
hash; an externally deleted indexed file can make snapshot copying fail.
`workspace_read_file` likewise reads live bytes but returns the recorded
hash for an already indexed path. Do not interpret a successful Git save as
proof that every file-list/hash API has been reconciled with shell changes.

Task Service stores the first positive Workspace revision, then expects the
next reference update to advance by exactly one; the path becomes immutable.
Runtime retries a stale Execution state-version CAS up to three times while
saving that reference. This handles heartbeat races, not arbitrary divergence
between filesystem revision and database revision. Files, Git commit,
metadata, snapshot, database reference, checkpoint and Material writes remain
separate steps with separately observable failure.

### Direct Judge reads of a Workspace file

`swarmenv_judge_submit_candidate` requires a relative `path` in the current
Execution Workspace. Its optional `workspace_revision` and `content_hash`
are expected-value guards. Bridge reads through `Runtime.readWorkspaceFile`,
rejects mismatched supplied values as `STALE_VERSION`, and sends the returned
content, revision and hash with an authenticated Task/Execution/path
attestation to Judge. This call does not save a revision, export an old Git
commit, require a Workspace artifact Material, or route submission through Task Service.
Judge uses its own configured fixture/checker and persists the resulting check;
Task completion is separate. See [the direct submission contract](04-services.md#the-as-built-submission-route)
and [ADR 0019](../adr/0019-direct-judge-workspace-submission.md).

This boundary inherits the live-file behavior above. An optional revision
checks the current metadata revision; it does not request bytes from that
historical revision. Bridge uses the file-read default of 1,000,000 bytes and
forwards its content/hash, without a separate full-file snapshot or truncation
branch. Judge recomputes the supplied content's SHA-256 before checking, so a
stale indexed hash or truncated source with a full-file hash fails request
validation. Direct submission therefore does not remove the current
metadata-index limitations or establish the phase-02 immutable shared-revision
contract.

Sources: [Bridge source preparation](../../src/agent/services-bridge.js),
[Runtime read boundary](../../src/runtime/runtime.js),
[Workspace live-file read](../../src/runtime/workspace-manager.js),
[Judge source validation](../../src/judge/judge-service.js).

## 5. Progress and handoff persistence

`execution_progress` accepts `kind: checkpoint | handoff` (default
`checkpoint`) and requires all four substantive fields:
`completed_work`, `findings`, `open_questions`, `next_step`. See
[03](03-mission-task.md) for Task semantics and
[tool contracts](10-service-api-reference.md) for the complete inputs.

For an active `CREATED/RUNNING` Execution the implementation:

1. Remembers the previously durable Workspace/revision/hash/checkpoint as
   `last_valid_snapshot`.
2. If a Workspace exists, attempts one revision save, saves its Task Service
   reference, writes a checkpoint containing caller data plus progress, then
   saves that checkpoint reference in Task Service.
3. Publishes an `experience` Material with scope `execution_progress`,
   evidence state `observed`, progress fields and the attempted revision/Git
   commit. Provenance records source Execution and save status.
4. Links that Material to the Task as `experience`.
5. For checkpoint returns `disposition: continued`; for handoff delegates to
   `handoffExecution` with `skipWorkspaceSave: true`, carrying the result
   evidence so there is no second disk-save attempt.

The result includes `progress_material`, `progress_link`, `workspace`,
`checkpoint`, `save_status`, `last_valid_snapshot`, `loss`, Task and
Execution. No Workspace means disk save is `not_applicable`, but progress
Material publication can still occur. A nonactive state returns
`already_terminal`/`not_applicable` (including `WAITING` in this method).

Filesystem/checkpoint errors become `save_failed` and a
`loss: {unsaved_progress: true, phase, error_class}`; handoff still proceeds.
Material publication or linking failure is also logged and reflected in loss;
a Material may already exist if linking was the failing step. These operations
are not rolled back together, and `save_status` must be read with the
returned evidence rather than inferred from the word “checkpoint”.

### Generic handoff order

`handoffExecution` coalesces concurrent requests for the same Execution.
Already terminal and already waiting states return without a new transition.
For a live Execution it marks the process closing, drains queued compaction
saves and stops its Sandbox **before its own save attempt**. It then attempts
Workspace/checkpoint persistence once, records `save_status`,
`last_valid_snapshot` and loss, and asks Task Service to end the attempt as
`FENCED` or `EXPIRED`. A timeout adds `timeout_type: TIMEBOX_EXPIRED`
and whether a linked handoff Material was missing.

Durable fencing happens before best-effort physical Workspace fencing and
Session/Core cleanup. If the metadata fence succeeds the Workspace is marked
released; the directory and Git history remain. A failed physical cleanup does
not undo the durable fence. The reusable identity Session can remain alive for
its next Task; this is distinct from leaving the old Execution authorized.
[Runtime handoff and progress](../../src/runtime/runtime.js).

Two boundaries matter when interpreting a saved revision:

- The `execution_progress(kind: handoff)` path saves **before** calling the
  generic handoff method. Because that delegate skips another save, the
  Sandbox stop in generic handoff does not precede this path's snapshot.
  Compaction checkpointing also does not stop shell jobs. A running background
  writer can therefore overlap those saves.
- Semantic `execution_progress`/`task_finish(outcome=blocked)` validate and optionally link their
  referenced handoff Material, then release ownership. They do not
  automatically create a fresh disk checkpoint. The Bridge's
  `task_create followed by task_take` performs a separate progress checkpoint before
  the atomic Task switch, and post-switch Runtime binding is another step.

Runtime's common physical-release path retains a `CLOSING` Core and resource binding when Session, provider deletion, or Workspace release fails. It reconciles an older Workspace fence against the durable Execution fence before retrying release. Concurrent provider deletes share one pending deletion; HTTP 202 requires a follow-up GET confirming absence before the resource record can be discarded. [02](02-execution.md) distinguishes this retry behavior from the still-pending durable closing protocol and Bot-initiated finish ordering.

## 6. Fence, release, restart and retained state

A normal Workspace write requires the same Execution ID, current fence and no
`released_at`. `releaseWorkspace` verifies owner/fence and idempotently retries both metadata writes, retaining the original release timestamp after a partial write failure. It records a release timestamp without
deleting data. `reopenWorkspace` permits that same owner and fence to clear
the release flag when a waiting Execution wakes. `fenceWorkspace` requires
the current owner/fence and a strictly larger integer new fence, records it and
clears release state; Runtime subsequently releases or reuses it as appropriate.

Database authority and local metadata are separate. A stale Session cannot
successfully issue Task Service writes with an old fence; physical filesystem
fencing and container termination are attempted separately. A host process or
container that retains raw filesystem access is not stopped merely because a
JSON fence changed. Read/list APIs check ownership and fence but do not require
an unreleased Workspace.

Session restart normally keeps the same Execution ID and Core. Runtime stops
the previous actual Session, removes its identity-session registration, frees
the in-memory Core, advances the Workspace and durable Execution fences via
recovery, and starts another Session on the existing Workspace. Recovery
increments session/attempt generations and recalculates attempt timing while
retaining any global run deadline. That path does not create a new independent
checkout. A Task handoff followed by another take does.
[Execution restart and recovery](02-execution.md).

Feedback also survives through durable Task/notification records rather than
Pi memory alone: delivery, reading, consumption and handling are distinct
writes. A successor can receive pending Task feedback after rebinding. A
prompt-delivery mark is not proof that the feedback was accepted or used.
The selection and deduplication rules are in
[Task notifications](03-mission-task.md) and the exact injected text is in
[Prompts](08-prompts.md).

## 7. Compaction and identity rotation

Compaction accounting is in Runtime memory, keyed by the identity lane
(Core ID where available, otherwise owner/Execution fallback). Ordinary Task
release/rebind on that lane carries the count forward; explicit rotation and
session recovery reset it. It is not a durable database counter restored
across a host-process crash.

Defaults are `maxCompactions = 3`,
`handoffWindowRatio = 0.8` and
`compactionCheckpointReminder = true`. The ratio is a fraction of context
window capacity. Event usage accepts the supported snake/camel-case window and
token fields, with percentage fallback; missing or nonpositive token/window
values do not become an invented zero. At `turn_end` and
`compaction_end`, Runtime requests `getSessionStats` with a 5-second timeout
when available and uses a valid measured value.

| Event/condition | Runtime action |
| --- | --- |
| `compaction_start` when count is already at the configured maximum | Start identity rotation immediately with reason `compaction_limit`. |
| Successful `compaction_end` with result and not aborted | Increment lane count; queue one persistence attempt for this event in arrival order. |
| At/above max after successful compaction, postcompaction usage unknown | Rotate conservatively with `compaction_window_unknown`. |
| At/above max after successful compaction, known ratio at/above 0.8 | Rotate with `compaction_window_threshold`. |
| At/above max, later `turn_end` with ratio at/above threshold | Rotate. |
| At/above max, later `turn_end` with unknown usage | Log `continue_until_boundary`; this particular event does not immediately rotate. |
| Successful compaction below both stopping conditions | Continue the current Bot only while its Execution remains active; after a lifecycle boundary a fresh Bot reads public state. |
| Failed/nonaborted compaction without result | Enter the session-failure/recovery path described in [02](02-execution.md). |

When available, `estimatedTokensAfter` /
`estimated_tokens_after` is preferred for the postcompaction ratio.
A `compaction_start` event is the earliest portable signal this code uses to
prevent a fourth compaction; the implementation does not prove that an
external provider has not begun internal compaction before emitting it.
Do not turn this event-based intervention into a stronger provider guarantee.

### Each successful compaction queues a checkpoint

Saves are serialized behind the previous compaction save, including after a
previous failure. If supported, Runtime waits up to 30 seconds for the Session
to settle, verifies the Execution is still active and has a Workspace, saves a
revision with an empty files map, then saves a checkpoint containing
`kind: compaction`, reason, count, identity, tokens before and estimated
tokens after. No Workspace or a no-longer-active Execution makes the save
`not_applicable`; persistence errors log `save_failed` without blocking
all later saves or stranding the lifecycle.

With reminders enabled and no closing/rotation in progress, Runtime queues a
follow-up prompt asking the current Bot to write substantive
`execution_progress`; the prompt has a 30-second timeout. Compaction metadata
alone is not converted into invented findings. The full reminder and exact
send path appear in [08](08-prompts.md).

Rotation coalesces concurrent requests and drains the already queued compaction
save; a `compaction_start` rotation does not wait for a new settle event from
the compaction it is interrupting. It calls
`restartSession(reason: compaction_rotation)`, logs old/new identity IDs and
resets the replacement count to zero. Normally the Execution ID stays the
same, while Session identity, fence and recovery generation change. It is
therefore an identity/Session replacement, not a Task handoff.
[Runtime event, checkpoint and rotation implementation](../../src/runtime/runtime.js).

## 8. Sandbox provisioning and execution

The benchmark uses `OpenSandboxManager` for every Agent Execution. Runtime creates one provider sandbox with the fixed worker entrypoint, authenticates the worker with a per-Execution token, copies bounded Workspace files into guest `/workspace`, and deletes the sandbox at release. `sandbox_exec` and `sandbox_job` are bound Runtime capabilities; they cannot address host paths or an unbound Execution. The worker event stream is sequence-based; retryable SSE failures switch to bounded history polling and replay deduplication. Controller restart reconciliation never revives an old Pi or shell: a sandbox whose worker token cannot be recovered is recorded as unrecoverable, quarantined/deleted, and replaced by a fresh Bot/Execution that resumes from public Workspace and Material state.

[OpenSandbox manager](../../src/runtime/opensandbox-manager.js), [OpenSandbox Agent adapter](../../src/agent/opensandbox-agent-adapter.js), and [Runtime Sandbox binding](../../src/runtime/runtime.js) define the provider boundary. The shipped image is the only trusted worker entrypoint; ordinary callers cannot provide a custom entrypoint.

## 9. Evidence needed to assess continuity

A continuity take should join the records below, rather than rely on the
presence of the word “resume”, “checkpoint” or “handoff” in a log:

| Question | Evidence |
| --- | --- |
| What did the predecessor actually save? | Save result/status/loss, durable Workspace and checkpoint pointers, Git commit, selected revision metadata and relevant file bytes. |
| What did the successor start from? | Take `workspace_selection`, source Execution/path/revision, target parent lineage and target commit. |
| Did old authority end? | Execution terminal/fencing transition, operation/CAS outcome, Core release and physical cleanup logs. |
| Was substantive work preserved? | Linked progress/handoff Material and its provenance; a token-count checkpoint alone is insufficient. |
| Was feedback carried forward? | Notification recipient/delivery/read/handling rows and consumption/response links, not only a prompt-delivery event. |
| Did rotation respect the measured threshold? | Identity IDs, compaction count, usage source/window ratio, checkpoint outcome, rotation reason and new Session generation. |
| Are file hashes trustworthy for a shell-edited artifact? | Actual bytes and Git commit checked against the recorded index; account for the current index-refresh limitation. |

Relevant focused tests are
[Workspace contracts](../../test/workspace-contract.test.js),
[Workspace contract](../../test/workspace-contract.test.js),
[SandboxManager](../../test/sandbox-manager.test.js). They cover public seams
and use controlled/mock collaborators in several paths; their existence is
not a take that this documentation change reran a live Docker/provider run.
For persisted field definitions, see [storage reference](11-storage-reference.md).

## Source ownership

| Implementation | Responsibility described here |
| --- | --- |
| [workspace-contract.js](../../src/runtime/workspace-contract.js) | Path normalization/classes, contract aliases, read/write restrictions and input validation. |
| [workspace-manager.js](../../src/runtime/workspace-manager.js) | Workspace creation, Git commits/clones, indexed revisions, snapshots, file reads/writes, checkpoints, release/reopen/fence. |
| [sandbox-manager.js](../../src/runtime/sandbox-manager.js) | Container/image setup, mount/env/command validation, foreground/background jobs, cancellation and cleanup. |
| [runtime.js](../../src/runtime/runtime.js) | Preparation order, file/Sandbox façade, progress/handoff persistence, compaction queue, rotation and lifecycle cleanup. |
| [task-service.js](../../src/task/task-service.js) | Durable Workspace/checkpoint references, resume selection, Execution fences and successor authority. |
