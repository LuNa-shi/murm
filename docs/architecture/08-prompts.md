# Prompts and model-visible instructions

## Phase 0005 Core

The generic backend uses the host's complete `Profile.prompt` verbatim. The trusted Worker writes it to `/workspace/runtime/profile-prompt.txt` and starts native Pi with `--append-system-prompt` pointing to that file. Pi provides the original tool instructions for `read`, `write`, `edit`, and `bash`. This path disables ambient extensions, skills, prompt templates and context files. Bot creation performs startup and readiness calls. A subsequent host `send` passes the entire supplied input string as the Pi RPC `prompt` message with the selected `steer` or `followUp` behavior. Core adds no template text to the Profile prompt or input. [Core Runtime](15-core-runtime.md) explains host assembly and [Pi/OpenSandbox backend](16-pi-opensandbox-backend.md) explains the actual launch and send paths.

Custom Service instructions reach a generic Bot when it runs `swarm service view <id>` or `swarm <service> [<operation>] --help` through native Bash. The Bridge derives the visible capabilities from the frozen Profile.services and registered manifest. The CLI composes the usage line with the chosen Service ID, manifest purpose, each allowed operation's description/help.when, side_effect/idempotent, serialized input/output schemas and declared errors. This is command output returned through Pi's Bash result, not an extra system prompt or independent model turn. Unrequested metadata is not automatically inserted into Profile.prompt. The full composition is in `src/cli/swarm-cli.js` and the actual dispatch/authorization path is described in [Core Runtime](15-core-runtime.md).

The installed Notes Environment gives the writer and reader their role prompts at spawn. It sends one publication input to the writer. After the host verifies the write, it sends a retrieval input to the reader, verifies the read and sends a follow-up on the same reader. Each input uses explicit `followUp` through the host helper. The fixed key is `core-service-boundary`. The configured source observation is `review-input.json`, provided at spawn and read through native tools. The writer additionally receives `note-request.json` containing the fixed key and the observation as a JSON string field; its publication input explicitly uses `--input note-request.json` to preserve that field type. Notes exposes put only to the writer and get only to the reader. The complete role and turn text is generated from the host example. [Notes prompts](prompts/07-notes-environment.md)

## Existing flat and solver paths

The existing registered Swarm Bot and independent solver contracts use Pi's native `read`, `write`, `edit`, and `bash` tools. Swarm operations are typed CLI calls made through Bash. Pi starts with the configured native tools and versioned prompt resources.

## Resources and startup

`agentContract` in [bot-contract.js](../../src/agent/bot-contract.js) chooses the system addendum, protocol version and pinned resource hashes. Normal Bot mode includes `system.txt` and the four `plan-task`, `use-material`, `use-workspace`, and `finish-task` skill resources. Solver mode includes `solver-system.txt` and no Swarm skills. The OpenSandbox worker validates resource bytes and permissions, disables ambient resource discovery, and launches Pi with explicit native tools, system and skill paths. The system addenda append to Pi's own system input; repository files cannot reconstruct Pi/provider-owned rendering.

A normal Session starts UNBOUND. After readiness, the benchmark sends `buildBotStartupMessage` with the durable Bot/Core/Session identity, Mission goal and acceptance conditions, Workspace main preview, budgets/deadlines, project boundary, available CLI Service directory and an explicitly incomplete eligible Task page. Values come from current Task/Runtime/Workspace state. The preview does not grant a writable Execution directory. Take prepares the actual pinned revision and returns its identity; when that differs from preview, the response requires rereading. Task-local instructions and completion contracts are ordinary public Task state, not a second system prompt. Repeated discovery refreshes state and marks the message as continued selection.

The startup directory contains CLI namespace names, permission summaries, manifests and documentation references from the configured Registry. Full optional Service documentation enters context when the Bot fetches it using Service metadata/help commands. Full skill text enters context when read through Pi's skill/native read path. Resource presence, a manifest hash or a composed example does not prove the model read its body.

## Continuations, notifications and lifecycle feedback

The benchmark only sends another bound turn after rereading the current Session, Bot, Execution, Mission stop gate and deadlines. Ordinary continuation uses `BOT_CONTINUATION_MESSAGE`; a reached soft-closeout boundary substitutes the closeout notice and `BOT_SOFT_CLOSEOUT_MESSAGE`. The same phase selection applies after compaction. Compaction is not a Workspace save, Material publication or Task delivery.

Runtime delivers Task notifications to a live bound Session using `buildBotNotification`. Handoff warnings name the Execution and remaining deadline allowance. Material notifications identify producer, Material and notification IDs and require reading and explicit feedback. Dependency updates direct the Bot to inspect Task state. None grants ownership, establishes correctness or completes the current Task. Notification delivery can fail if the Session has closed; durable public state remains the authority on later reads.

Bridge command responses include structured results/errors and lifecycle notices. Native Bash carries these back into the model conversation; the Bridge does not create a separate turn for a tool response. Workspace conflicts also write an ordinary README artifact: it becomes model input only when read. Judge results carry actual checker diagnostics; successful request transport is not proof acceptance. Fixed guidance fields are catalogued separately from dynamic Task, Material, provider and checker content.

On historical continuation, the runner reads the restored Mission, Task page and public main for each fresh Bot. Its startup message sets `project.input_policy` to `original locked formalization and public research state reconstructed at the selected historical time`. A replacement Bot follows the same discovery send path. [Historical continuation](13-historical-resume.md)

For the opted-in Seymour paper round, the launcher supplies the fixed `project.local_lean_tools` discovery field to every Bot. Its text is `After taking a Task, run lean-check --swarmenv-workspace PATH.lean to compile a module in your current project. Search /opt/mathlib-source/Mathlib with rg, and use #check in a local Lean file for exact signatures. The local check supplies feedback. Use swarm for shared Workspace and final Mission submission.` The launcher records the same text in the private launch inputs. The field is absent from ordinary launches.

With `OPENAI_MATH_SEYMOUR_MATCHED_BRIEF=1`, the single-project Seymour paper launcher sets the Mission goal to `Prove the original Lean theorem in <problem_file> in the shared Workspace. Formalize the supplied manuscript in benchmark/paper.pdf (text in benchmark/paper.txt). The pinned Lean libraries are available offline through lean-check. Work autonomously, split work as you discover it, and merge checked Lean sources to main.` The target path comes from the verified fixture. The launcher records the rendered goal in `launch-inputs.json`. The runner stores it in the Mission and includes the Mission in every discovery prompt, including for replacement Bots. The discovery input policy names the pinned public manuscript. The initial Task list is empty, and Bots propose and take responsibilities through the existing Task flow.

## Complete text and reproducible source inventory

| Reference | Contents |
|---|---|
| [System addenda](prompts/01-system-identity.md) | Complete Bot and solver resource text |
| [CLI directory and provider documents](prompts/02-task-loop-and-tools.md) | Actual startup directory fixtures and available optional bundle documents |
| [Benchmark turns](prompts/03-benchmark-turns.md) | Complete synthetic startup, continuation, compaction and notification bodies |
| [Runtime notifications](prompts/04-runtime-messages.md) | Exact current notification builder output |
| [Tool-result guidance](prompts/06-tool-return-guidance.md) | Fixed executable hint/remediation/guidance fields and delivery conditions |
| [Bot skills](prompts/08-bot-skills.md) | Complete immutable skill resources |
| [Source manifest](prompts/source-manifest.json) | Source hashes, extraction anchors, send sites and generated-body hashes |

`generate-architecture-prompts.mjs` runs offline with explicit synthetic identities and timestamps. It enumerates repository `.prompt` send sites and instruction fields and fails when an unlisted source introduces one. Run `npm run docs:generate`, inspect generated and explanatory changes, then `npm run docs:check`. Fingerprints establish source alignment, not actual delivery or compliance. Actual claims about what a Bot saw require private Session/RPC evidence. Public reports must not contain raw conversations, proof candidates, credentials or personal paths. Full model request replay also needs external Pi/provider context and compaction state, which this repository does not capture as a canonical request.

## Phase-sensitive bound follow-up

Both benchmark continuation paths call `buildBotContinuationMessage`; `runTurn` rereads the original E after `waitForReady` and replaces any earlier ordinary body if the durable soft boundary has been reached. A changed Session/E, stopping Core, non-RUNNING E, durable Bot other than ACTIVE or with a different E, or elapsed Bot hard deadline prevents the send. Registered compaction follow-up uses the same phase selector with the normal compaction text as its ordinary body. The selector reads only `handoff_deadline`, `handoff_reminder_sent_at` and current time; no model-written field decides the phase. The generated benchmark-message reference includes the complete closeout body. It directs save/publish/finish, forbids new proposals/apply/check/merge, and distinguishes accepted request replay from new work. It does not claim OS enforcement from a prompt alone.

Trusted startup context includes the Bot’s actual `coordination_permissions`. Service-directory prose advertises the implemented Mission submission, checked merge and narrow correction/Task repair routes, with the applicable grants for submission, merge and Material correction. Open unowned Task revise/cancel instead use the UNBOUND and version guards described above. A soft-closeout continuation explicitly prohibits new Mission acceptance work as well as Judge/apply/merge work. Actual continuation dispatch also checks the durable Mission stop gate after Session readiness, so accepted Missions do not receive another research turn.

## Lifecycle and result feedback

The registered Bot Bridge sends Chinese `notice` fields on the same CLI response that carries the result or typed error. These are results of commands already issued in the Session. The Bridge does not send an extra Pi turn. The phase’s [fixed wording](../phases/0002-task-material-workspace/06-prompts-and-skills.md#必须有定义的运行消息) is instantiated from these sources:

| Branch | Input evidence and delivery |
|---|---|
| Take race, unknown response, changed initial revision | The Task claim supplies the competing Execution/quota outcome. The CLI assigns and transmits a stable request ID before the HTTP call, and reports that ID when the outcome is unclear. A successful take compares the recorded preview with the revision that actually prepared the directory. |
| Contribution rejected, selection expired, hard stop | The Bridge combines its authorized operation profile with the durable Bot/E state and deadline. The Task Service rejects early exit in an open Mission with remaining time. The Bridge returns the `discovery_required` phase and guidance to diagnose the public gap and propose work. Once the selection deadline elapses, an unbound Bot without a pending take can use the budget-exit path. A live request may receive the hard-stop response if the connection still exists. |
| Save failure, dirty apply, conflicted apply | The response names a definitive Workspace save failure, or uses `dirty`/`active_writer` from a rejected apply before project replacement. Installed conflicts use the source revision and returned conflict paths. |
| Merge check failure or moved main | The merge error carries the pinned main/source revision and checked-tree diagnostic, or the observed and actual main revisions from the failed compare-and-swap. The message includes the corresponding bounded recovery steps. |
| Mission submission | The submit and submission-view responses include the fixed submitted revision and Material IDs, the durable verdict and, on failure, the observed current main and freeze owner. See [Mission submission](03-mission-task.md). |
| Soft closeout and finish | The soft-closeout body names the E and the milliseconds remaining against its persisted deadline at composition. It is available in an already scheduled continuation or handoff notification. A finish response identifies the durable request and E admitted to closing before physical release. |

The `use-workspace` skill directs ordinary local-proposition iteration to save a fixed revision and select `--check-mode lean-module --path P`. It explains that P selects a complete module and its dependencies, rather than an individual declaration within a multi-declaration file, and permits independently useful lemmas/definitions to be organized in imported modules. A revision-only call still requests full-project diagnostics; a full-mode path binds Task delivery evidence. Local receipts do not satisfy a full delivery requirement. It explains imports under the locked source directory, actual module coverage, warnings and the separate Mission proof check. The skill remains an image resource discovered through the existing manifest and sent through the existing skill-read path; it does not grant new authority or require a particular research decomposition. The command help distinguishes deployments with project checking from compatibility source-only deployments.

### FLT10 Mission context

The benchmark runner retains the ordinary Swarm Mission goal template
`Solve ${problem.id} through independent, shared Task work.` Explicit solver mode uses
`Solve ${problem.id} independently.` Both append the same optional instruction pointer. When `instructions_path` is configured it appends ` Read ${config.instructions_path} for the benchmark task and input contract.` This goal enters the same Mission
and discovery context paths described above. The README is verified public
Workspace input and explains the pinned original target, proof-placeholder
restriction, complete compressed statement graph queries and safe definition
references. It is not automatically expanded into every turn. No ContextSwarm
Agent prompt, collaboration policy or scheduler instruction is imported.

## Root-only benchmark task instructions

The generic Mission goal appends `Read <instructions_path> for the benchmark
task and input contract.` only when the benchmark config supplies that path.
The value is validated during config loading. The startup composer includes the
Mission goal in its ordinary discovery message; no new model send path or Core
role assignment is introduced. The README body is delivered only if the Bot
reads the corresponding Workspace file, and that read is ordinary tool evidence.
For `flt10-subtree-v1`, the complete repository-controlled body is
[the root-only task instruction file](../../benchmarks/flt10/subtree-instructions.md).
Preparation replaces the single `{{target_path}}` field with the configured
checkpoint path (`q20/Target.lean` for Q20) before hashing the public README. It permits new
definitions/lemmas/modules, explains the existing save/check/integrate workflow,
and states final correctness constraints without listing a decomposition.

The complete root-only README template is:

```markdown
# Formal proof project

Prove the target theorem in `{{target_path}}`. Its original mathematical statement
and the supplied foundation are fixed. The initial proof contains `sorry`; this
makes the starting project elaboratable but is not a completed proof.

You may develop your own definitions, intermediate lemmas and Lean modules in
the target directory and its subdirectories. Import those modules from the
root proof as needed. Use public Mathlib and the supplied foundation; readable
foundation source is under `benchmark/foundation/`. The Judge provides the
pinned compiled dependencies. The Bot does not have a local Lean installation.

Use Task to coordinate responsibilities and Material to share explanations,
evidence and references to exact Workspace revisions and paths. Save your code
before asking Judge to check a revision. Incomplete intermediate revisions can
be used for diagnostics. Integrate the needed files into Workspace main before
Mission submission; source compilation alone is not final acceptance.

Final acceptance checks the unchanged mathematical target against its trusted
challenge, checks proof assumptions, and replays the proof through the kernel.
The final project must have no remaining proof holes or extra axioms. Private
answers, previous runs and external network access are unavailable. There is no
prescribed decomposition, list of helper lemmas or assignment of Core roles.
```

## Pass@K prompt delivery

The generated [system reference](prompts/01-system-identity.md) includes the complete independent solver addendum, and [benchmark reference](prompts/03-benchmark-turns.md) includes its continuation and soft-closeout text. The adapter selects these only for explicit solver mode and verifies the pinned worker resource. Swarm's skills are not loaded. After the host binds the real Execution, the initial user prompt appends JSON containing `problem` and `target_path` from the verified fixture, the fixed `/workspace/project` path and the group deadline from run state. These are actual send inputs, using the same verified immutable resource contract. The next ordinary turns and compaction follow-up reuse solver continuation; soft closeout substitutes save-only guidance. No Task/Material tool instructions are sent by these solver paths.

The Workspace skill also distinguishes the default 30-second CLI HTTP wait from the checker execution limit. Its 630000 ms example assumes an already-ready preflight, no queue wait and a ten-minute source allowance; queue/cold-preflight time is additional, and no client timeout extends lifecycle deadlines. This text is included through the same protected skill read path.

## Native Agensh math team

The pinned Agensh entrypoint renders its upstream collaboration template with worker identity, team size, channel and the four math fragments (focus, objective, work_cycle, delivery). The native router sends kickoff, idle and budget reminders through the ProgramBench lifecycle. The brief receives TASK, REPO, Mattermost IDs and TARGET_FILE from the verified seed. PAPER_BRIEF is empty by default. With the pinned Seymour paper it expands to ` Formalize the supplied manuscript in benchmark/paper.pdf (text in benchmark/paper.txt).` Snapshot text does not establish delivery. The native session archives and router state record actual turns. [Upstream template](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/prompts/agents.txt)

### deadline_45m

```text
@all **45 minutes left.** Concentrate on integrating and checking existing work on the default branch. Land the open PRs; report any blockers.
```

### deadline_5m

```text
@all **5 minutes left.** Merge ready work, verify the original theorem on main and report the final state.
```

### delivery

```text
Commit the Lean sources to main. From the directory containing the original theorem, run lean-check Helper.lean before checking a module that imports Helper. Keep generated .olean files out of Git. The final checker rebuilds from source and checks the fixed declaration.
```

### focus

```text
proving the original theorem
```

### idle

```text
Inspect current main and the live board, find an open proof obligation and choose the next piece of work.
```

### idle_delivery

```text
Verify and merge completed work on the default branch, resolve integration issues and report blockers. Keep the current scope.
```

### objective

```text
Prove the original declaration in the seeded Lean file. New helper modules can be added under the directory containing the declaration. Keep the original statement and trusted assumptions. The external checker grades the delivered main tree.
```

### task_brief

```text
Prove the original Lean theorem in ${TARGET_FILE} in ${REPO}.${PAPER_BRIEF} The pinned Lean libraries are available offline through lean-check. Work autonomously, split work as you discover it, and merge checked Lean sources to main. Mattermost team ${MM_TEAM_ID}, channel pbench-task ${TASK_CHANNEL_ID}.
```

### work_cycle

```text
1. Read the current main and explore an open mathematical question.
2. Announce the area you are taking as a CLAIM on the shared context board.
3. Start from current main and develop the proof or a reusable lemma.
4. Run lean-check on the changed modules and their dependents. Check the actual premises of each statement.
5. Push, open a PR and merge to main. If refused, merge latest main into your branch, re-check and push again.
6. Share a PATCH_SUMMARY with files, idea and evidence on the board, then choose the next area.
```

### Flat take preview notice

`src/environments/flat/prepare-inputs.js` composes one additional tool-result notice only when a host-recorded Task view preview differs from the authoritative public revision selected during take:

```text
Execution ${execution.execution_id} starts from ${snapshot.revision}, different from preview ${preview.revision}; reread the affected project files.
```

The Execution ID comes from TaskService's accepted reservation; selected revision comes from MissionWorkspace.exportRevision; preview revision comes from the same trusted Bot's earlier Task view. Flat stores the notice with immutable Workspace input provenance. On successful take it travels through the Service-v2 response and original Bash tool result; it is not independently injected as a model message. Core prepare/grant consumes only canonical file bytes and never composes this notice. `flatResearcherProfile` forwards the host-supplied prompt unchanged and supplies readonly resource defaults; it adds no repository prompt template.
The built-in Core Bot Service adds no child startup prompt or business result template. Its manifest help describes child admission, initialInput and pending cleanup; the Bridge exposes only permitted capabilities and the CLI renders the discovered text and schemas. Parent-supplied `input` goes unchanged through the shared Core input ledger with default steer or explicit followUp, after child identity/parentId and backend events are installed. The target Profile supplies the child's existing system prompt composition. Core does not copy the parent conversation, bindings or secretEnv, and does not automatically send child output back to a parent. See [built-in Bot control](15-core-runtime.md#built-in-bot-control).

## Public-Core Agensh peer

`createAgenshEnvironment` installs the following complete Profile prompt before spawn. It is passed through the ordinary Core Worker/native Pi system-prompt path. It is not a turn input.

```text
You are one Agensh peer in a persistent private project directory. Work only on your unique WORK_BRANCH. Use Bash and swarm Service commands; discover each operation with swarm <service> <operation> --help. Clone RUN_REPOSITORY into the current project root (git clone "$RUN_REPOSITORY" .), then preserve this checkout across turns. Use your native Git credential helper; never print or persist credentials. Read the run issue, publish useful facts and detailed evidence to the shared board, and notify the run channel. Board CLAIM is a soft coordination note, not an exclusive Task lease. A follow-up arrives only after your current turn settles. No mid-turn notices or automatic continuation are provided. Do not merge or change main. Follow the fixed acceptance input and report actual results.
```

The nonsecret dynamic environment fields come from the successfully prepared run: RUN_REPOSITORY is its credential-free Gitea repository URL; WORK_BRANCH is `peer-${runId}`; GITEA_USERNAME and all Git author/committer name/email fields derive from the provisioned peer username. RUN_OWNER/RUN_REPO/RUN_ISSUE identify the fixed run repository and issue; RUN_CHANNEL/RUN_BOARD identify its actual channel and board. Only the peer Git token is supplied as secretEnv; it is not composed into a prompt. Core supplies its regular v2 Bash discovery/tool guidance.

The opt-in controlled acceptance explicitly sends these two complete turn inputs, in order after each accepted/started/completed wait: `FIXED_AGENSH_PEER_FIRST` and `FIXED_AGENSH_PEER_SECOND`. The local fixture in `test/fixtures/agensh-peer-upstream.js` supplies fixed Bash function calls and final outputs `PEER_1_OK` / `PEER_2_OK`; these are controlled verification responses, not evidence of hosted model reasoning. Ordinary hosts supply their own explicit runInput text, which is not reconstructed from this template. No extra startup, queue, nudge, rejection, continuation or mid-turn notice prompt is added by this Environment. Shared runInput errors remain host-side errors; Core lifecycle/CLI error responses retain their documented paths.

## Fixed lead-helper instructions

The lead and helper Profile prompts and four fixed round instructions are fully reproduced in [the generated lead-helper reference](prompts/08-lead-helper-environment.md). The Environment serializes each instruction with the host goal/supplement or actual helper IDs and invokes the shared exclusive followUp helper. Helpers must read the public direction and keep permanent owner identities; the lead converts actual read feedback and the trusted user input into a public adjustment. This path has no busy steer, dynamic expansion or implicit continuation. See [the complete Environment flow](19-lead-helper-environment.md).
