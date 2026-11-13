# 05. Workspace, Sandbox and continuity

This chapter describes the current filesystem and process behavior, including
the direct Workspace-to-Judge input boundary added for Issue #117.
[Execution](02-execution.md)
explains durable ownership; [Mission and Task](03-mission-task.md) explains how a
successor obtains responsibility. This chapter explains which files, commits,
checkpoints, process state and feedback survive that transition.

## 0. Mission Workspace repository (public revision path)

`MissionWorkspace` (`src/runtime/mission-workspace.js`) is the runtime-owned
repository seam for the Issue #122 Workspace contract. It is distinct from the
legacy execution-local `WorkspaceManager` described below. `create` creates a
Mission/Workspace pair with different IDs, an external revision `0.1`, and a
Git `main` branch outside any Sandbox. `files`, `read`, and `search` resolve a
fixed immutable revision and require no Execution lease, so an unbound Bot or a
successor can inspect public files before take. `materialize` copies a selected
revision into a new Execution directory without exposing `.git` or repository
metadata.

`save` requires a complete file tree and records a new revision with explicit
parent lineage; it does not move `main`. `merge` checks the caller's expected
main revision, optionally runs the configured final-tree checker, commits the
whole source revision, and advances `main` with a compare-and-swap guard. A
stale expected revision returns `STALE_VERSION`; the source revision and all
files remain readable. `candidateFileRef` is only the tuple
`(workspace_id, revision, path)`; there is no Workspace artifact object or storage
record. The older execution-local path remains executable for compatibility and
is explicitly owner/fence bound; it must not be interpreted as the public
Mission Workspace authority.
[MissionWorkspace](../../src/runtime/mission-workspace.js)

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

Every current `task_take` creates or reuses only the clean Workspace bound to that Execution. Runtime validates the Task contract, materializes the declared formal source and required inputs, initializes the Workspace revision, records its content hash, and then launches the Session. A take cannot select another Execution's revision, source path, checkpoint, or private Workspace.

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

## 6. Fence, release, restart and retained state

A normal Workspace write requires the same Execution ID, current fence and no
`released_at`. `releaseWorkspace` records a release timestamp without
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

The optional `ContainerSandboxManager` owns one Docker container per bound
Execution. Runtime requires an active, nonclosing `CREATED/RUNNING`
Execution with a materialized Workspace before `sandbox_exec` or job
operations. Absence of the manager is `SERVICE_UNAVAILABLE`.
The manager is not a general host-shell tool.
[SandboxManager](../../src/runtime/sandbox-manager.js),
[Runtime Sandbox binding](../../src/runtime/runtime.js).

| Setting | Manager default / requirement |
| --- | --- |
| Docker command | `docker` |
| Image | Required; optional expected image digest |
| Workspace root | Required |
| Extra read-only roots | Empty list |
| Network | `none`; accepts `bridge`, `host` or a named network when configured |
| User | `1000:1000` |
| Memory / CPUs / process limit | `2g` / `2` / `256` |
| Temporary filesystem | `/tmp`, size `256m`, `rw,noexec,nosuid,nodev` |
| Command timeout | 120,000 ms; per-call positive finite value up to 3,600,000 ms |
| Output limit | `maxOutputBytes = 1,048,576` (implementation qualification below) |
| Command size | At most 32 Ki characters |
| Image preflight | Local `docker image inspect`, default 20 seconds; no image pull |

Preflight records image ID/time and optionally compares the configured digest.
Provisioning checks the Workspace is a directory within the configured root,
removes a previous deterministic container name best effort, then runs a
detached idle shell. It labels Execution/fence, mounts the whole Workspace
read/write at `/workspace`, uses the configured user/resources/network,
drops all capabilities, enables `no-new-privileges` and makes the container
root filesystem read-only. Optional read-only mounts must originate within an
approved root and target `/inputs/`; the normal Runtime ensure call does
not supply extra mounts. Docker startup has a 60-second bound.

An already cached container record is returned without comparing a newly
requested binding version. Correct lifecycle therefore depends on Runtime
stopping the old container on release/recovery before rebinding; the cache is
not itself a fence-version validator. Container/job records are in memory,
not durable rows.

### Command and job results

A command is either a nonempty bounded shell string or a nonempty array of
strings. String commands run through `sh -lc`; argv elements are shell-quoted.
Default working directory is `/workspace`. The current check is a lexical
`startsWith('/workspace')` plus rejection of `..` segments; it does not
canonicalize the path or require a slash boundary, so a path such as
`/workspace-other` passes this specific validation if it exists.

The environment contains `HOME=/tmp`, the host process's PATH (or a fallback
PATH), plus explicit validated entries. It does not copy the entire host
environment. Keys must be uppercase environment identifiers; values must be
strings at most 4096 characters. Names matching token/secret/password/API-key/
credential/private-key patterns are rejected, except the safe names
`PATH`, `HOME`, `LANG`, `LC_ALL`, `TERM`, `TMPDIR`. This is a key-name
filter, not inspection of every value for secret content.

Each command receives a UUID job ID. A `setsid` wrapper writes a process
group ID under `/tmp/swarmenv-jobs` and writes the child's exit status into a
job-specific `.exit` file.

| Operation | Result / timing |
| --- | --- |
| Foreground exec | Execution/job/binding IDs, exit code, `timed_out`, `truncated`, duration, stdout and stderr. On timeout the Docker client is killed, then process-group cancellation is attempted. |
| Background exec | Starts `docker exec --detach`; bounds the launch call by the lesser of requested timeout and 30 seconds, then returns a running job view. |
| Job status | For running/cancelled jobs reads the `.exit` file, marks completed when an integer appears and returns IDs, state, exit code, times, cancellation reason and command. |
| Cancel | Attempts TERM on the recorded process group, marks cancelled and records reason/time; does not wait for a proven process exit. |
| Release/stop | Cancels recorded running jobs, attempts `docker rm -f`, removes the in-memory container entry and logs stop. |

There are three material limits to the current command implementation:

1. The wrapper writes the child's exit status to `.exit` but does not end
   with `exit $code`. Foreground `exit_code` comes from the Docker wrapper
   process and can be zero even when the child failed. Background status reads
   the stored child code. A completed foreground job is returned from memory,
   so querying it does not automatically correct that wrapper status.
2. A background call's timeout bounds launch, not the detached job's lifetime.
   There is no per-job timer after launch; the job runs until it exits, is
   cancelled or its Execution/container is stopped. Background stdout/stderr
   are not returned by the job-status view.
3. Although named `maxOutputBytes`, output collection compares JavaScript
   string lengths and applies the limit separately to stdout and stderr.
   It is not one exact byte budget shared by both streams.

### What the Sandbox does and does not enforce

The Docker options restrict the container environment and mounted host scope.
They do not apply Workspace file contracts to shell filesystem operations.
Because the entire Workspace is mounted writable, shell code can modify a
required input, Git metadata or Runtime's `.swarm` files within that mount;
the file API's read-only-input and metadata-path checks do not intercept those
writes. Git ignore rules likewise do not prevent access. Deployment must
provide a compatible image/user and writable mount permissions; this code does
not repair ownership automatically.

Runtime logs Sandbox-stop errors and continues durable release. The manager
also suppresses several Docker removal/cancel errors. Consequently, “Execution
fenced” is durable authority evidence, whereas “container physically gone”
requires its own observed cleanup evidence.

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
