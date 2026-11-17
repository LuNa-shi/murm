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

Registered Bot merge admission is implemented below. The benchmark connects the independent final-tree checker through the Mission submission coordinator. The internal `materialize` initialization helper rejects repository descendants, symlink traversal and nonempty targets, stages a complete tree and renames it over a still-empty target under a target lock. Normal Bot apply uses the separate active-project installation path below; caller-selected host `target_dir` routes reject. The Task/Mission/Workspace coordinator remains the sole owner of public Git publication; independent Context/Judge peers do not open its database or repository. Their authority protocol is described in [Services](04-services.md).

[MissionWorkspace](../../src/runtime/mission-workspace.js), [WorkspaceRepository](../../src/runtime/workspace-repository.js).

## Public browsing and comparison

A Mission has one Workspace repository within its configured storage root. Create serializes on the root lock, recovers any journaled repository it inspects, and rejects a different Workspace ID already owned by that Mission. Retrying the same Mission and Workspace ID returns the existing record. A Workspace ID already owned by another Mission rejects.

An unbound Bot may use `workspace files --at R [path]`, `workspace read path --at R`, `workspace search query --at R`, `workspace diff --from R1 --to R2`, and `workspace history --all`. Bridge pins the configured Workspace ID and checks its Mission against the authenticated Bot; registry and Router also check Mission ownership for a registered Bot. Workspace paths use the same relative public-tree restrictions as saved revisions.

Files returns lexical paths, directory entries and file sizes and hashes, with a default and maximum page size of 100. Search returns literal, case-sensitive path hits and UTF-8 text hits with line numbers and text excerpts, up to 100 by default and 500 per page. The response counts binary files skipped for text matching. Exact read returns bytes or UTF-8 according to its encoding field, with total size, hash and truncation. Public pair diff returns fixed from/to revisions, Git commit and source metadata, main reachability at the first page, and up to 100 paths with added/deleted/modified indications and before/after hash and size. It covers unmerged published revisions. Use `workspace read` for the contents of a change.

The first request resolves each omitted or `main` revision under the repository lock. Files, search and pair diff return `next_cursor` when more matching rows exist. The cursor retains the selected revision(s), comparison main, position and a fingerprint of the operation, Workspace and normalized filters. Follow it with the same query or prefix and an omitted/`main` selector or the fixed revision already returned. Switching to a different Workspace, operation, query, prefix or explicit revision rejects. Main changes between requests do not change the selected snapshots. The cursor carries no permissions. Search currently traverses the bounded immutable tree and page responses do not imply an index.

## 0.1. Current Bot project snapshot and public save

Registered Bots invoke `swarm workspace status`, `diff` without a revision pair, or `save` through their protected Bridge. Status and diff inspect the current guest project; save takes no file/tree, parent, path, source or identity arguments. The Bridge resolves the capability first and derives Bot/Task/E/fence from the durable binding, then calls `Runtime.dispatchExecutionWorkspace`. Caller-supplied project trees are rejected. Standalone Registry/Router save requests cannot supply a trusted guest export and return `NOT_ALLOWED`. Public `view`, `history`, `files`, `read` and `search` remain available before take within the configured Mission Workspace. Registered Bots cannot use the legacy host Workspace read/write/diff, root sandbox or private Execution-progress APIs.

Runtime requires the current durable Bot to be ACTIVE, its E to be RUNNING with the expected fence, its original live Session and Core binding, and an unexpired Bot/E deadline. The E's immutable `workspace_input` must reference Runtime's configured public Workspace. These checks run before and after the guest read and synchronously immediately before Git publication. The final guard and Git intent/publication execute under one SQLite `BEGIN IMMEDIATE` writer transaction, so a second Task Service process cannot accept finish between authorization and publication. SQLite writer contention returns `WORKSPACE_BUSY` with the original captured request retained for retry. A short per-E OS lock excludes concurrent status/diff/save and cleanup reconciliation across processes. A competing operation receives `WORKSPACE_BUSY`; the caller can retry.

The manager sends an authenticated `/project/snapshot` to the original bound worker with E and fence. The worker shares its writer gate with project grant. It enumerates the Bot UID and current Pi PID, stops each process with SIGSTOP, and requires two stable passes in which all processes are stopped. This includes detached descendants and writers with pre-opened descriptors. The pause attempt is bounded to two seconds. With writers stopped, the project helper checks ACTIVE identity and traverses only `/workspace/project`, reading complete bytes. It refuses symlinks, hardlinks, special files, ambiguous decoded filenames (including invalid UTF-8 aliases), forbidden configuration/repository paths, files over 2 MiB and trees over 16 MiB. Traversal is limited to 10,000 entries per pass and a ten-second capture window. It compares two canonical manifests while processes remain stopped. The pause establishes the stable window; two hashes alone do not. Numeric filenames use the same lexical canonical encoding as the controller. A successful response contains full base64 files, hashes/sizes, total bytes and E/fence; deletion is represented by absence from the complete tree.

The worker resumes stopped processes after export or a recoverable error. If closure began, it stops the Bot instead. A pause/window failure returns structured `WORKSPACE_BUSY` through the manager; no revision is claimed. HTTP timeout is 30 seconds, and losing the HTTP response does not authorize another snapshot for an already captured save. The manager rechecks the original live binding after the response. Runtime independently validates identity, canonical hash, strict base64, paths, sizes and entry bounds before accepting the capture.

`ExecutionWorkspace` owns two private SQLite tables, separate from public Git storage. `execution_workspace_state` retains immutable initial revision plus last saved revision, baseline manifest, parents, applied/conflict metadata and a CAS version. The latter two lists derive from the actual initial revision and subsequent explicit apply operations. A pending-apply flag distinguishes unsaved source/parent changes even if file bytes happen to be unchanged. Status compares a fresh authenticated snapshot against the saved baseline, returning dirty, changed paths and actual lineage. Current-E diff adds before/after hash and size metadata for each changed path; it is not a textual patch or public revision-pair diff.

`execution_workspace_requests` keys saves by E/request ID with a payload fingerprint and phases `capturing`, `captured`, `done` or `failed`. A completed request replays its exact result without rereading a changed guest tree. Reuse for a different operation/payload rejects. Before capture, the request is recorded as capturing; after a validated export its exact bytes, parents, source and E-state version are persisted as captured. Git save receives this immutable input with a derived internal request ID. Only after Git's result is durable does one SQLite transaction advance E's saved head/manifest/parents and store the completed receipt. The initial input never changes; consecutive saves parent the last saved revision and leave main unchanged.

If capture fails, the first response and replay return the same terminal error, asking for a new request ID. Busy retains its typed error; a lost capture owner becomes `WORKSPACE_REQUEST_ABORTED`. A captured request with a known definitive rejection is failed, allowing later operations to proceed. Unknown Git/I/O outcomes retain the exact capture and block unsafe replacement until receipt reconciliation. Cleanup, hard stop, fencing and registered-Bot lease expiry stop resources, then reconcile before the E terminal transition or Task/Core release. Reconciliation failure retains ownership for cleanup retry. Lease expiry records an EXPIRED stop intent in the same SQLite transaction that rechecks the lease cutoff; a renewal committed before that check leaves the Bot active. A persisted expiry intent cannot be changed by a later cleanup retry. A committed Git receipt can be acknowledged even after E closes; that path can only read/reconcile an existing save. If no receipt exists, the ordinary active authorization is still required for publication, so closure first prevents a new revision. SQL CAS failure leaves reconciliation required; other post-Git SQL acknowledgement failures return retryable `WORKSPACE_RESULT_UNKNOWN` while retaining the capture. Neither retry nor cleanup substitutes newer guest bytes for a captured request.

`save --resolved` checks the recorded conflict alternatives and generated markers as described below. Ordinary save preserves unresolved conflict metadata. Save receipts include canonical content hash, Git tree, changed paths and captured Task/E/Bot/fence source, identically on replay. Public history defaults to revisions reachable from its pinned main; `--all` includes unmerged revisions. It exposes source, changed paths, parents and reachability, supports `--task`, `--execution` and `--path` filters, and returns 25 items by default (1–100 configurable) plus a cursor. The cursor pins the history horizon, main and filters so later saves or merges do not shift a page. History does not emit complete file manifests, and retains at most eight metadata trees while traversing. The returned page is bounded even when filtered ancestor scanning requires more reads; raw capture contents remain in the private database only while reconciliation is pending and are removed when the request finishes. This path does not save Pi sessions, runtime logs, credentials or the private host support directory. The CLI/Bridge/Runtime/Git tests cover binary content, numeric filenames, deletions, parent continuity, replay and close/commit races. The network-disabled container probe additionally exercises actual UID process pausing, a detached writer with a pre-opened descriptor, rejection/recovery and worker cleanup; it is not a provider/model experiment.

[Coordinator](../../src/runtime/execution-workspace.js), [worker](../../scripts/opensandbox-agent-worker.mjs), [project helper](../../scripts/sandbox-project.mjs), [integration tests](../../test/bot-runtime.test.js), [container probe](../../test-support/sandbox-project-probe.mjs).

## 0.2. Same-E apply, held installation and conflict resolution

`swarm workspace apply --from R/main` is an execution-bound Bridge operation with no caller-selected Workspace, host directory, source identity or file map. Runtime takes the same E operation lock used by save. A stable guest capture must match the last saved revision and have no unsaved apply metadata; otherwise the request returns `WORKSPACE_BUSY` and asks the Bot to save first. Under the public repository lock, `planApply` pins a requested `main` to its actual revision, checks Git ancestry and computes a three-way merge of the saved base and incoming revision. The immutable plan records exact files, before/after hashes, parents, changed paths and conflict provenance in the private request capture. It neither publishes a revision nor changes main.

Git planning uses the structured NUL-delimited `merge-tree` output, including stage objects and typed multi-path messages. It explicitly reads attributes from the current input commit with `--attr-source`, so conflict marker widths and binary classifications come from that pinned project. This requires a controller Git with that option and modern `merge-tree --write-tree`; unsupported Git fails planning rather than silently changing semantics. Files remain raw bytes when imported/saved, with filters disabled. See [Git merge-tree](https://git-scm.com/docs/git-merge-tree) and [Git attribute source](https://git-scm.com/docs/git#Documentation/git.txt---attr-sourcetree-ish).

An already-included source does not add a spurious parent or mark an unchanged tree dirty. A new input records both saved base and incoming revision as actual parents, even if the content merge is empty. Text conflicts retain Git's editable marker-bearing ordinary files. A collision-safe `workspace-conflicts-<id>` project directory contains exact base/current/incoming stage bytes, including binary and rename/delete alternatives, plus a short Runtime-authored README. Conflict records retain involved paths, stages, types/messages, original labels and exact generated marker lines. This is ordinary project content, not a private candidate store. If all alternatives exceed existing tree byte bounds, planning rejects before installation. Full README text and its actual read condition are catalogued in [prompt guidance](prompts/06-tool-return-guidance.md).

Before sending installation, one SQLite transaction rechecks the current E and records the request as `installing`. Task Service checks this same table inside its finish transaction: `installing` or `installed` returns retryable `WORKSPACE_BUSY`, with no accepted finish side effects. A finish accepted before this intent prevents installation; an installation intent accepted first must settle before normal finish. Hard-stop intent still rejects new contributions immediately and proceeds to physical process termination; `CLOSING` is a durable intent, not a claim that a networked worker has already stopped. The owner/Core are not released until physical stop and reconciliation finish.

The worker's authenticated `/project/install` shares the writer gate and all-Bot-process pause with snapshot. Payload size is bounded to 32 MiB; decoded files retain the snapshot file/tree bounds. It checks its active E/fence, request fingerprint, exact current preimage hash and file/directory collisions. A fixed immutable helper runs as the Bot UID with a clean environment, no capabilities and no model-controlled program text. Its bounded JSON input travels over stdin, avoiding per-argument operating-system size limits. This permits `/proc` inspection without granting `CAP_SYS_PTRACE`: it verifies paused PIDs, cwd, open descriptors and mapped files. A replaced file pinned by an FD or mapping, a cwd inside a replaced directory, or an inconclusive inspection returns `WORKSPACE_BUSY`. Both literal and kernel-decorated ` (deleted)` names are checked. Unchanged file/directory inodes stay usable; `/workspace/project` itself is never renamed.

`ProjectInstaller` persists a root-only write-ahead capture and receipt outside the project before mutation. The immutable capture contains complete preimage/target bytes, file modes and original directory topology/ownership/modes; the receipt contains identity, hashes and phase. It changes only affected files, removes directories only where a target file requires that replacement, fsyncs changed files/parents and verifies the complete target. The write pass is bounded to 15 seconds. Failure restores changed bytes and modes plus directory topology, including empty directories, then checks both tree hash and topology before allowing resume. If restoration cannot be verified, writers remain held and the Bot stops; a partial tree is never reported as a completed apply. Tests inject partial and complete write failures in both file-to-directory and directory-to-file transitions.

The large target/preimage capture is written once in root-private storage; subsequent phase transitions atomically replace only a small receipt. Committed or verified failed operations delete the capture. Two 16 MiB trees are exercised in a 64 MiB project/control filesystem; exhaustion before mutation rejects without claiming installation.

A verified install is durably recorded as `installed`, but the worker keeps all Bot writers paused. It returns metadata only. Runtime acknowledges the exact plan in one SQL transaction: applied-source history, parents, conflicts, pending-apply flag, E state CAS version and a draft operation result are committed together. It then sends `/project/install-confirm` with the same request and target hash. The worker records and directory-fsyncs `committed` before releasing writers. If rename succeeds but directory fsync fails, the held receipt still queries as `installed`; the same confirmation retries persistence before clearing the hold. Runtime finally marks the request done and clears its private capture. Confirmation and an actual worker `beginClose` are ordered in the worker event loop: close first forbids resume; confirm first may complete an already-authorized operation, but subsequent hard-stop completion still requires killing every Bot process and revoking the project before releasing the Task/Core. Normal accepted Task finish cannot fall into this window because of the durable install interlock.

Install/result/confirm HTTP requests have five-second timeouts. An unknown response preserves the same plan; `/project/install-result` is a receipt query that does not inspect or reinstall a newer guest tree. Runtime schedules one-second reconciliation retries independently of the paused CLI, up to eleven scheduled attempts, then attempts a hard stop. The worker also stops the Bot if a held install lacks acknowledgement for 30 seconds. These are separate controls; HTTP timeout does not itself resume a held Bot. A stopped worker returns its private install receipt summaries with `/stop`; the manager retains them through Sandbox deletion and drops that cache only after E reconciliation/release. If confirmation committed but its response was lost, closed-E reconciliation preserves the original result while this manager retains the stop receipt. This cache is process-local: losing the stop response or crashing the controller after Sandbox deletion can leave the final worker outcome unknown; the interrupted operation exposes that uncertainty rather than claiming a verified rollback. Cross-process durable stop receipt recovery remains a stage gap. Otherwise closure records a terminal interrupted operation with the known installation phase and any already-recorded lineage; it does not claim a verified rollback or a surviving worktree. It never confirms/resumes a closed E.

Existing changed files retain their private mode bits on successful installation; newly introduced files default to 0644. Public snapshots and Git imports currently version bytes and paths as regular files, not executable bits; modes do not survive transfer to a fresh E. This is a current limitation, not complete Git mode preservation.

Successful apply does not save or complete the Task. Status keeps the immutable take revision, last saved revision and applied source records separate; unsaved apply changes remain dirty until save. The next save uses the recorded real parents and conflict metadata. Public revision export and new-E initial input retain unresolved conflicts; changing Bots does not clear them. Merge rejects an unresolved saved revision. `save --resolved` requires removal of the recorded alternatives directory and actual generated conflict markers at the involved ordinary paths, including non-default marker widths and separators left after removing the labeled borders. Marker provenance records the preexisting count of identical ordinary lines, so legitimate separators already present in the input are allowed. Deleting a conflicted path or selecting one binary side is permitted as an explicit Bot resolution. Clearing this tracked state is an acknowledgement of the Bot's decision, not a scientific PASS; a required check remains independent.

[Plan and public metadata](../../src/runtime/mission-workspace.js), [E coordinator](../../src/runtime/execution-workspace.js), [worker installer](../../scripts/project-install.mjs), [process inspection](../../scripts/project-processes.mjs), [Git cases](../../test/workspace-apply.test.js), [rollback probe](../../test-support/project-install-rollback-probe.mjs).

## 0.3. Registered Bot merge admission and final publication

`swarm workspace merge --from R --request-id ID` accepts only a fixed public revision. Bridge supplies the current Bot/Task/E/fence and invokes `Runtime.mergeExecutionWorkspace`; callers supply no Workspace, main version, source identity, checker or verdict. Standalone Registry/Router merge calls reject because they lack this Runtime authorization. The original request is namespaced by E; its persisted Workspace fingerprint includes the chosen source, trusted contribution identity and check policy. The repository pins current main under its writer lock, then uses actual ancestry to construct the final combined tree. A changed main at final commit produces `MAIN_MOVED`, without changing the saved source or current E worktree.

Before planning and again at final publication, Runtime requires a live bound Bot/E and rejects merge after a durable soft-closeout reminder or handoff deadline. Successful publication, including a no-op receipt, runs the final guard and synchronous Git journal/ref/index/receipt writes inside the Task Service SQLite write transaction. A different process cannot accept finish between that guard and main publication. Finish or freeze accepted during checking prevents later main advancement. Every newly acquired freeze increments a durable epoch (legacy records start at zero); final publication compares the pinned epoch even if that submission has already released its freeze. Repeating the same active freeze does not increment it. The shared `publishWorkspace` helper protects both save and merge. Lock contention is `WORKSPACE_BUSY`; if Git publication completed but SQLite confirmation fails, `WORKSPACE_RESULT_UNKNOWN` requires the original ID, whose durable Git receipt resolves the result. Rollback failure never masks the original error. The source metadata records the actual Mission/Task/E/Bot/fence and `operation: merge`; history can attribute the merged revision to its contributor.

Runtime accepts an operator-configured `workspaceMergeChecker` with fixed `checker_ref`, `checker_version`, `environment_ref`, positive `timeoutMs` and `check(plan)` callback. The callback receives the combined file tree, actual Git tree, fixed source/main revisions, trusted source identity, an AbortSignal and deadline. The configured checker must satisfy the Mission's persisted `merge_required_check` and any Task delivery check explicitly required for main. Missing or incompatible required checker configuration rejects with `SERVICE_NOT_READY`. Mission final acceptance and ordinary Task completion checks are evaluated at their respective submission and finish boundaries. With no explicitly configured merge check, the merge still verifies authorization, file integrity, conflict state, freeze and main CAS, and its check receipt is null. With locked project checking enabled, the Putnam runner sets a project-build merge policy: all in-scope Lean files in the combined tree compile, with diagnostic warnings allowed while the Mission theorem remains unresolved. Compatibility deployments without project checking retain no additional semantic merge policy. Mission submit keeps the locked final theorem checker. An already-included source produces a no-op without checker work.

Checking runs outside the repository and SQL publication locks. Its deadline is the smaller of the configured timeout and remaining pre-closeout execution time. Timeout rejects before signaling cancellation, and the result is time-checked again, so an abort handler resolving a late PASS cannot win the race. The adapter contract requires its promise to settle only after owned resources have stopped. Timeout returns durable `SERVICE_TIMEOUT` on the first call and same-ID replay, requests abort, and retains the Runtime-wide checker slot until that promise settles; new IDs cannot accumulate checks behind an uncooperative checker. Shutdown also requests abort. This process-local slot is not restart reconciliation or evidence that an external resource stopped; a production adapter still needs durable operation/cleanup integration. The returned public check summary contains verdict, bounded CheckResult ID and diagnostic (256/2048 characters), checked Git tree, checker identity and policy. A failed verdict returns these with pinned source/main revisions so the Bot can repair a specific tree. Final authorization/CAS remains independent of that verdict. A success advances only public main; the Bot synchronizes its own worktree with explicit apply/save.

Focused CLI/Git tests cover disjoint contributions in the actual checked combined tree, replay/no-op without duplicate checking, unchanged private worktree, contribution history, Task-only/conflicting/absent check policies, failed-check feedback, freeze-then-release, cross-process lifecycle exclusion, post-Git SQLite failure, retained timeout occupancy, and finish/soft-closeout/late-PASS races. This is controlled checker integration evidence, not validation of a benchmark theorem or whole-stage acceptance.

## 1. What a Workspace represents

The registered Bot starts in a protected Sandbox before take; after take Runtime materializes the selected immutable Mission revision into its guest project. Public continuity uses explicit save/apply/merge as described above.

The compatibility `Runtime.startExecution` or `bindAgentExecution` path prepares a private
WorkspaceManager support directory before starting the durable Execution. A Task need not expose file or
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

A compatibility WorkspaceManager view has `workspace_ref`, `execution_id`,
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

The host Execution directory receives those exact project files, including binary data and the existing `.gitignore`/README. This path adds no Task README, runtime manifest, workspace manifest or `.pi` settings to project files. Host bookkeeping stays in private `.swarm` and `.git`. Creation holds a target lock, builds a sibling staging directory, verifies every file against the public manifest, imports raw Git blobs without ignore/attribute conversion, and publishes the completed directory by rename. Exact matching retries reuse its original input; a different input/fence or a nonempty partial target is rejected, never overlaid. The initial local Git tree therefore matches the public Git tree. The OpenSandbox transfer receives the trusted manifest, copies exactly those paths using base64 chunks of at most 65,536 characters into a per-file guest temporary path, verifies the complete received file with SHA-256, then renames it into place. This stays below Linux single-argument limits even for the 2 MiB maximum file. Failed copies best-effort remove their temporary file and fail preparation; `.environment` and other allowed names are not silently omitted by the legacy traversal filter. It rejects source symlinks and bytes differing from the pinned manifest. Per-file hashing establishes transport integrity. Protected PREPARED input and process-paused grant are additional implemented worker boundaries described below; hashing alone does not establish them. The initial public input identity is recorded in both private Workspace metadata and `executions.workspace_input_json` before activation, and cannot be changed by later local revision saves. Reports include this initial public reference separately from the older local integer revision/commit fields. This establishes complete input selection/transport and audit identity; protected guest preparation/grant follows the flow below; same-E apply uses the captured guest transaction and confirmation protocol described above.

Unregistered compatibility Executions retain the older formal-source and generated-manifest creation path. A take cannot select another Execution's private revision, source path, checkpoint or directory.

If an Execution already has its own Workspace, Runtime reads its current metadata under the current fence and continues from that binding. Matching retries are idempotent; a different owner, fence, revision, or content hash is rejected. Workspace saves advance exactly one revision and persist the file manifest and content hash before the corresponding Execution reference is recorded.

In the compatibility preparation path, Runtime generates the initial README, manifest, ignore rules, Pi settings and runtime manifest. Registered public input materialization instead preserves the exact supplied project tree as described above. These writes may create successive revisions, so revision one is the materialization boundary rather than a promise about the first model turn.


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

For a registered Bot, `swarm judge check --revision R --path P` exports exactly R from the public Mission Workspace and checks the complete file. Runtime revalidates its E before and after export, and rejects path traversal, foreign Workspaces, binary content, missing files and moving `main` references. The response exposes the actual public revision, file hash and Git commit/tree. Unsaved guest changes and the host support Workspace do not affect this input. The historical unregistered Bridge route still reads its current private Workspace with optional stale-value guards. Neither path saves files or creates a Material implicitly.
Judge uses its own configured fixture/checker and persists the resulting check;
Task completion is separate. See [the direct submission contract](04-services.md#the-as-built-submission-route)
and [ADR 0019](../adr/0019-direct-judge-workspace-submission.md).

The historical unregistered Bridge file route instead reads the current private Workspace with optional stale-value guards. Its revision check compares current metadata rather than exporting historical bytes. It retains the 1,000,000-byte read default and metadata-index limits; Judge recomputes content hashes and rejects inconsistent inputs. These are compatibility-route limits, not registered numeric-revision file/project limits. Neither route implicitly saves a revision or publishes Material.

Sources: [Bridge source preparation](../../src/agent/services-bridge.js),
[Runtime read boundary](../../src/runtime/runtime.js),
[Workspace live-file read](../../src/runtime/workspace-manager.js),
[Judge source validation](../../src/judge/judge-service.js).

## 5. Progress and handoff persistence

This section describes unregistered compatibility APIs. Registered Bots cannot call `execution_progress` or switch Tasks within the same Bot. They explicitly save public revisions, publish/link Materials and call `task_finish`; no automatic private checkpoint is their public handoff. Registered finish retains ownership through physical cleanup as described in [Mission and Task](03-mission-task.md#accepted-finish-and-safe-release).

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

Runtime's common physical-release path retains a `CLOSING` Core and resource binding when Session, provider deletion, or Workspace release fails. It reconciles an older Workspace fence against the durable Execution fence before retrying release. Concurrent provider deletes share one pending deletion; HTTP 202 requires a follow-up GET confirming absence before the resource record can be discarded. [02](02-execution.md) distinguishes this retry behavior from the durable closing protocol and Bot-initiated finish ordering.

## 6. Fence, release, restart and retained state

The WorkspaceManager metadata and same-E restart APIs below are compatibility mechanisms. The registered path uses immutable public inputs, retained cleanup ownership and fresh Bot/E authority; `restartSession` rejects a registered Bot. Public revisions survive independently of its private directory.

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

Compatibility Session restart keeps the same Execution ID and Core. Runtime stops
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
| Successful `compaction_end` with result and not aborted | Increment lane count and queue handling in arrival order: registered Bot reminder/observation, or compatibility private checkpoint. |
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

### Registered Bot compaction and rotation

After successful compaction, Runtime waits for settlement (up to 30 seconds), verifies the current active Bot/E/deadline and optionally sends the fixed compaction reminder. During soft closeout the phase selector substitutes save/publish/finish guidance. It records `runtime.bot_compaction_recorded` with `public_save:false` and returns `not_saved`; Pi compaction does not publish the guest tree, a Material or a private checkpoint as public progress. A closing/rotating Bot receives no reminder. At a rotation boundary Runtime stops E as `HANDED_OFF` with reason `compaction_rotation`, confirms physical cleanup and allows a later fresh Bot to continue from explicitly published state. It does not call same-E Session restart.

### Compatibility automatic checkpoints

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

Compatibility rotation coalesces concurrent requests and drains the already queued compaction
save; a `compaction_start` rotation does not wait for a new settle event from
the compaction it is interrupting. It calls
`restartSession(reason: compaction_rotation)`, logs old/new identity IDs and
resets the replacement count to zero. Normally the Execution ID stays the
same, while Session identity, fence and recovery generation change. It is
therefore an identity/Session replacement, not a Task handoff.
[Runtime event, checkpoint and rotation implementation](../../src/runtime/runtime.js).

## 8. Sandbox provisioning and execution

Production benchmarks use OpenSandbox for registered Bots. Runtime creates each Bot sandbox before selection and keeps its worker credential out of Pi. Take associates that resource with E and prepares/grants the pinned project. Native Pi Bash runs as the non-root Bot user in `/workspace/project`; explicit save publishes files. Registered Bots cannot use root `sandbox_exec`. Trusted diagnostic/compatibility transport still supports bounded Execd commands/jobs. The worker event stream uses sequences, bounded polling and replay deduplication. Restart reconciliation cannot recover the credential or revive old private context; it deletes/quarantines the resource. Fresh Bots continue only from public state. Physical stop and provider deletion are distinct cleanup evidence.

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


## Protected guest preparation and grant

Registered Bot transfers target `/workspace/project`; trusted unregistered diagnostic transport retains `/workspace`, but cannot start a research Agent. Runtime refuses Bot preparation without a pinned public snapshot. The worker starts the project empty and unwritable by UID 10001. `/project/prepare` accepts Execution/fence plus the trusted manifest, rejects unsafe paths, symlinks and special files, enforces 2 MiB/file and 16 MiB/tree bounds, reads and hashes every actual file, and compares the complete set before recording PREPARED. Identical prepare replay is allowed while PREPARED; changed binding/input and preparation after ACTIVE/closing are rejected. Directories/files remain root-owned 0555/0444. `/project/grant` matches the exact prepared Execution/fence, first pauses all Bot processes and closes root traversal, changes ordinary files/directories to UID 10001 with 0644/0755, opens the root last, and records ACTIVE only if no closing flag arrived. The worker resumes paused writers only after successful completion; partial grant failure closes and stops them. The parent directory remains root-owned so writable scratch or the project itself cannot replace it. Runtime owns the authority to call grant only after Task Service activation; the worker bearer never goes to Pi.

Guest scratch, expanded model catalog, Session history and system prompt now live under `/workspace/runtime`. Worker stop kills the dedicated UID's full process population before revoking project directory permissions; changing modes alone is not used as proof that open writer descriptors are stopped. The network-disabled local container probe is `node test-support/sandbox-project-probe.mjs`. It validates this image/worker behavior without a model call, including a detached writer that retains a pre-opened descriptor during grant. `--grant-failure` injects a guest filesystem fault to verify fail-closed stopping and root ownership restoration. This is distinct from live OpenSandbox management-plane isolation or stable save/apply export acceptance.

### Explicit delivery and Material use

A Task proposal may declare `completion_contract.workspace_delivery` with one to twenty distinct
project paths, optional `require_main`, and optionally the precise checker reference, version and
environment in `check`. A `task finish --outcome done --workspace-revision R` resolves that fixed
revision from trusted Workspace metadata during the Task lifecycle write. The revision must be
published by the current Task Execution under its current fence, contain the declared paths,
and carry no unresolved conflicts. When `require_main` is true, the revision must be produced
by a successful main merge. A requested final-tree check must be the recorded PASS for that
merge's exact tree. For a saved, unmerged delivery, a declared check applies to one declared
path and the caller supplies `--check-result-id`; Task checks the actual file hash, commit,
tree, and checker/environment before accepting finish. The accepted intent records the
verified delivery metadata. Tasks with no such declaration retain their existing completion
contract. Missing delivery blocks only the done outcome.

To link a Material's actual use to a file tree, record `material consume --action workspace`
with a concrete impact, then supply the relevant IDs to `workspace save --material-ids`.
Runtime resolves them to this Execution's exact consumption records before completing the
stable capture. The published revision source records the immutable content identity and
recorded impact. A merge records the source revision’s explicit uses, while parents preserve broader lineage. A later correction does not edit the revision. Query potentially affected
direct revisions with `workspace history --all --material-id ID`, and inspect Material
corrections and the affected files before deciding whether they require revalidation.

## Lean projects across public revisions

In a deployment with locked project checking, multiple Bots can save distinct Lean modules and integrate them through ordinary apply/save/merge. The complete fixed revision supplies imports; public main changes never alter a check already in flight. A project merge check compiles the actual combined tree, including unreferenced in-scope Lean modules, before the existing conditional main publication. It permits diagnostic warnings for unfinished work so auxiliary contributions can merge before the Mission theorem is complete. Final Mission verification still uses a frozen complete tree and the trusted theorem/proof check. An unmerged saved revision can be checked in the same way without advancing main. [Services](04-services.md#locked-lake-project-preparation-and-compilation) defines module roots, scope and failure classification.

A project merge receipt retains `checked_paths` alongside its count and tree identity. When a Task requires a checked delivery on main, Task Service verifies each required path appears in this compilation coverage; mere existence of a README or ignored configuration file in the tree cannot satisfy checked Lean delivery. There is one active merge check per Runtime/Core, separate from the ordinary Judge admission pool and the single final Mission checker. With four Cores this is not a global two-process compilation limit. Each compiler still has its fixed resource bound. For a three-minute merge check, the CLI can wait with `--timeout-ms 210000`; after response loss, replay the original source/request ID to recover its durable operation.

## Sandbox tools and centralized Lean checks

The fixed worker image installs Bash, Git, Node.js, curl, jq, Python 3 (with the `python` alias), and ripgrep. These executables run through native Pi Bash under the existing non-root Bot UID and filesystem controls. The image provides no Lean, Lake or Mathlib runtime. Its actual-worker contract test checks both general-tool availability and absence of Lean/Lake/elan. The system addendum and Workspace skill direct Bots to use Judge for all Lean compilation and execution checks, and prohibit installing a local toolchain to bypass that boundary.

Development feedback follows edit → public Workspace save → Judge check of that immutable revision → diagnostic → repair and another saved/checkable revision. A source-error version may be saved and checked before merge; FAIL is ordinary development feedback. The check binds its source revision and environment, while Task completion and Mission acceptance remain separate decisions. Network-unknown outcomes reuse the original request identity; busy capacity is retryable with bounded waiting, and exhausted Mission check budget does not authorize local compilation or an unverified PASS claim.

Lean, Mathlib and precompiled libraries are provisioned once on the trusted checker side and exposed read-only to each bounded checker process. Ordinary Judge requests have no cumulative quota and default to 4 running, 8 queued and a 120-second queue wait; the actual configured policy is persisted in Judge state. Each trusted process retains the fixed 4 GiB/no-swap/2 CPU profile and existing timeout. Merge checks and final Mission acceptance keep their distinct configured policies; they do not turn diagnostic success into acceptance. See [Services](04-services.md) for admission, retries and cleanup.

The optional Bot-local Lean image was removed following the Issue #130 owner decision. Sandbox CPU/memory/disk limits remain unchanged. Centralization bounds simultaneously admitted checks; it does not by itself establish lower total compute cost or acceptable feedback latency. [EXP-20261116-07](../experiments/EXP-20261116-07-centralized-judge-1h.md) observed natural source repair and final acceptance, with a 15.3-second median persisted ordinary-check interval, one busy rejection and five budget-exhausted rejections. This one run does not establish latency or capacity sufficiency for other work.
