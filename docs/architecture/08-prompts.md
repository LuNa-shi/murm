# Prompts and model-visible instructions

## Phase 0005 Core

Before starting Pi, Core renders a sandbox preamble, the enabled native `read`, `write`, `edit` and `bash` tools, and an automatically generated `<services>` directory. It uses purpose and operation descriptions from the frozen registry after the same Profile grant filtering used by `swarm service list` and `swarm service view`. The prompt and CLI share the command aliases. Added System Prompt defaults to empty. A nonblank `Profile.prompt` adds an Environment-specific role or constraint. Keep Service purpose and operation descriptions in the owner’s manifest, and task text in the separate user input. The Worker stages the rendered text at `/workspace/runtime/profile-prompt.txt` and passes it to Pi with `--system-prompt`. Normal startup omits Pi's coding-agent documentation and disables ambient extensions, skills, prompt templates and context files. Pi can still append its working directory. [Exact Core template](prompts/01-core-startup.md) · [Core Runtime](15-core-runtime.md) · [Pi/OpenSandbox backend](16-pi-opensandbox-backend.md)

Core stages this text at spawn. The host sends task input separately through Pi RPC using the requested input mode. `runtime.json` records `stagedSystemPromptSha256` for the full staged text and preserves `promptSha256` for the optional Profile text. Check the actual provider request to verify Pi additions and user message delivery.

Built-in command help is offline. Operations without built-in help use the authorized Service manifest and include the purpose, operation description, schemas and error metadata. Help enters the model's conversation as Bash output. The directory reflects the frozen Profile grants. Each invocation still checks trusted caller state, including any active Execution that TaskPool requires.

The installed Notes Harness uses the Core startup prompt for the writer and reader, with role-specific Notes grants and an empty Added System Prompt. It sends one publication input to the writer. After the host verifies the write, it sends a retrieval input to the reader, verifies the read and sends a follow-up on the same reader. Each input uses explicit `followUp` through the host helper. The fixed key is `core-service-boundary`. The configured source observation is `review-input.json`, provided at spawn and read through native tools. The writer additionally receives `note-request.json` containing the fixed key and the observation as a JSON string field; its publication input explicitly uses `--input note-request.json` to preserve that field type. Notes exposes put only to the writer and get only to the reader. The complete task inputs are generated from the host example. [Notes prompts](prompts/07-notes-harness.md)

The fixed Substrate Harness stages the same peer prompt for all three Agents and sends a peer/cycle header, the host question and the cycle instruction through the exclusive `runInput` helper. Its complete text and dynamic field provenance are in [Substrate prompts](prompts/09-substrate-harness.md); [the Harness chapter](19-substrate-harness.md) describes ordering and failure gates.

## TaskPool messages and Core startup

[bot-contract.js](../../src/agent/bot-contract.ts) composes the current TaskPool continuation, soft-closeout and domain notification messages and projects Service metadata into CLI namespaces. These helpers preserve Task/Execution guidance and authorization discovery; they do not assemble a system prompt or skill resources.

The manager starts only `swarmenv-core-v1` with an explicit empty resource array. The Worker rejects former resource-based contracts and requires the direct `pi` command, the rendered startup text and the fixed Core prompt path. Core constructs native-tool and ambient-discovery flags; the Worker checks string arguments and stages the supplied prompt. Model-catalog hash/ownership checks and filesystem isolation remain separate guards. [Backend](16-pi-opensandbox-backend.md) explains this current path. Pi/provider-owned rendering remains outside the repository templates.

The former registered Agent startup helper, fixed system addendum and four skills have been removed after their callers migrated. Their original text and version-bound evidence remain in Git history and research revisions. Current generated references document the executable TaskPool and Harness compositions below.

## Continuations, notifications and lifecycle feedback

The TaskPool controller composes durable handoff warnings and eligible Material or dependency notices using `buildBotNotification`. It fixes the exact text, input mode and request identity before asynchronous admission. The Execution, deadline and notification ID come from durable Task state. The retained Runtime no longer dispatches Task notification inputs. Ordinary notices use `followUp` by default. The PutnamBench driver selects `steer` for Material notices, which enter the next Pi tool continuation after a running tool batch finishes, or start an idle turn. Handoff warnings and dependency notices use `followUp`. All notices retain current Task owner and Execution fence checks. The controller keeps the same notification identity across attempts and stops automatic input when delivery remains unknown. Handoff warnings name the Execution and remaining deadline allowance. Material notifications identify producer, Material and notification IDs and require reading and explicit feedback. Dependency updates direct the Agent to inspect Task state. None grants ownership, establishes correctness or completes the current Task. Controller admission can reject a stopped Agent; durable public state remains the authority on later reads.

Bridge command responses include structured results/errors and lifecycle notices. Native Bash carries these back into the model conversation; the Bridge does not create a separate turn for a tool response. Workspace conflicts also write an ordinary README artifact: it becomes model input only when read. Judge results carry actual checker diagnostics; successful request transport is not proof acceptance. Fixed guidance fields are catalogued separately from dynamic Task, Material, provider and checker content.

The PutnamBench Profile has no Added System Prompt. Its first user input includes the host Mission, Agent and time bounds, and the original Lean text from the same locked source used to seed the Workspace. Each new Agent receives that source once. Its discovery guidance covers ready and running Tasks, starting an empty pool, and making several separate proposals before or after taking one responsibility.

The input gives the workflow for saving and checking work, publishing structured Material content, sending it by response link, applying an exact saved revision, and recording adoption before a save. A directed response identifies the recipient via `--task-id`; the authenticated Execution supplies the producer. [PutnamBench first input](prompts/08-taskpool-harness.md#putnambench-first-user-input) · [Response link command](prompts/08-taskpool-harness.md#offline-swarm-task-link-help)

## Complete text and reproducible source inventory

| Reference | Contents |
|---|---|
| [CLI directory and provider documents](prompts/02-task-loop-and-tools.md) | Actual startup directory fixtures and available optional bundle documents |
| [Runtime turns](prompts/03-runtime-turns.md) | Complete TaskPool continuation and soft-closeout bodies |
| [Runtime notifications](prompts/04-runtime-messages.md) | Exact notification builder output and current versus unsent variants |
| [Tool-result guidance](prompts/06-tool-return-guidance.md) | Fixed executable hint/remediation/guidance fields and delivery conditions |
| [Source manifest](prompts/source-manifest.json) | Source hashes, extraction anchors, send sites and generated-body hashes |

`dist/scripts/generate-architecture-prompts.js` runs offline with explicit synthetic identities and timestamps. It enumerates repository `.prompt` send sites and instruction fields and fails when an unlisted source introduces one. Run `npm run docs:generate`, inspect generated and explanatory changes, then `npm run docs:check`. Fingerprints establish source alignment, not actual delivery or compliance. Actual claims about what an Agent saw require private Session/RPC evidence. Public reports must not contain raw conversations, proof candidates, credentials or personal paths. Full model request replay also needs external Pi/provider context and compaction state, which this repository does not capture as a canonical request.

## Phase-sensitive bound follow-up

The public-Core TaskPool controller calls `buildBotContinuationMessage` using the Execution's durable handoff deadline and reminder state for an unfinished active Execution after a settled turn. Its identity, lease, fence, deadline and stop guards remain controller/domain responsibilities. The generated runtime-turn reference contains the complete fixed body. Closeout instructions direct save, publish and finish, and domain guards enforce which new contributions remain allowed.

## Lifecycle and result feedback

The registered Agent Bridge sends Chinese `notice` fields on the same CLI response that carries the result or typed error. These are results of commands already issued in the Session. The Bridge does not send an extra Pi turn. The phase’s [fixed wording](../phases/0002-task-material-workspace/06-prompts-and-skills.md#必须有定义的运行消息) is instantiated from these sources:

| Branch | Input evidence and delivery |
|---|---|
| Take race, unknown response, changed initial revision | The Task claim supplies the competing Execution/quota outcome. The CLI assigns and transmits a stable request ID before the HTTP call, and reports that ID when the outcome is unclear. A successful take compares the recorded preview with the revision that actually prepared the directory. |
| Contribution rejected, selection expired, hard stop | The Bridge combines its authorized operation profile with the durable Agent/E state and deadline. The Task Service rejects early exit in an open Mission with remaining time. The Bridge returns the `discovery_required` phase and guidance to inspect current public state and existing Tasks within the selection budget. Once the selection deadline elapses, an unbound Agent without a pending take can use the budget-exit path. A live request may receive the hard-stop response if the connection still exists. |
| Workspace save or apply | A definitive save failure prevents delivery claims for private files. A Core-backed apply reports the fixed source revision, parents and conflict paths. For conflicts, the combined project contains a README and alternatives. The Agent reads the guidance as a file, resolves the project and records the resolution with `workspace save --resolved`. Reconciliation of an unknown install outcome sends no new input. |
| Merge check failure or moved main | The merge error carries the pinned main/source revision and checked-tree diagnostic, or the observed and actual main revisions from the failed compare-and-swap. The message includes the corresponding bounded recovery steps. |
| Mission submission | The submit and submission-view responses include the fixed submitted revision and Material IDs, the durable verdict and, on failure, the observed current main and freeze owner. See [Mission submission](03-mission-task.md). |
| Soft closeout and finish | The soft-closeout body names the E and the milliseconds remaining against its persisted deadline at composition. It is available in an already scheduled continuation or handoff notification. A finish response identifies the durable request and E admitted to closing before physical release. |

The ordinary Putnam workflow asks the Agent to save a fixed revision and run the Judge. Command help explains `--check-mode lean-module --path P`, which checks a complete module and its dependencies. A revision-only call requests full-project diagnostics. A full-mode path can bind Task delivery evidence. The final Mission verifier independently checks the original theorem. The current Core entrypoint starts without automatic skill loading.

### TaskPool take preview notice

`src/harnesses/taskpool/prepare-inputs.ts` composes one additional tool-result notice only when a host-recorded Task view preview differs from the authoritative public revision selected during take:

```text
Execution ${execution.execution_id} starts from ${snapshot.revision}, different from preview ${preview.revision}; reread the affected project files.
```

The Execution ID comes from TaskService's accepted reservation; selected revision comes from MissionWorkspace.exportRevision; preview revision comes from the same trusted Agent's earlier Task view. TaskPool stores the notice with immutable Workspace input provenance. On successful take it travels through the Service-v2 response and original Bash tool result; it is not independently injected as a model message. Core prepare/grant consumes only canonical file bytes and never composes this notice. `taskPoolResearcherProfile` forwards the host-supplied prompt unchanged and supplies readonly resource defaults; it adds no repository prompt template.

### TaskPool controller messages

The [generated TaskPool reference](prompts/08-taskpool-harness.md) extracts the complete defaults from the Harness/controller sources and records their fingerprints and public send site.

`src/harnesses/taskpool/controller.ts` owns its default discovery input, sent only after coordinator domain readiness through public `Runtime.send` with explicit `followUp`:

```text
Read public Tasks and take suitable work. Continue in this Session after take.
```

When the TaskPool host enables autonomous Tasks, the controller composes the autonomous discovery input in the same generated reference. After the Runtime availability check, it confirms the Agent is still UNBOUND within its persisted selection and hard deadlines and checks that the Mission is open. It then supplies the Mission ID, goal and acceptance conditions from TaskService, that Agent's ID and deadlines, and the effective run deadline from the host clock. This happens for initial discovery and later discovery turns. The input points to public reads and executable Task help, and describes how to choose and claim a bounded deliverable. If the selection window or binding ended, the controller records the skipped input. The PutnamBench driver keeps the Profile text empty. It sets the first-input context from the original theorem at revision `0.1` and includes its collaboration workflow in both the first input and later discovery messages.

The researcher in `src/harnesses/taskpool/harness.ts` defaults to an empty Added System Prompt. Core supplies the authorized Service directory at spawn and the TaskPool controller sends discovery guidance in the first user input.

Hosts can replace the base Profile text, discovery input or ordinary continuation through the host and controller settings. Without a Core capture binding or a trusted `snapshotProject`, the host includes the [generated Profile guidance](prompts/08-taskpool-harness.md) after any supplied Profile text, omits private Workspace save and observation operations from the Profile, and selects the Material-oriented defaults for ordinary continuation, soft closeout and the handoff warning. The persisted Execution supplies the phase and the warning deadline. A host ordinary-continuation override still applies before soft closeout. The controller rechecks Task state and remaining budget before its public followUp send. Directed user text passes through the same controller with the chosen mode and request ID. For the complete default text in each case, see the generated TaskPool reference.

The built-in Core Agent Service adds no child startup prompt or business result template. Its manifest help describes child admission, initialInput and pending cleanup; the Bridge exposes only permitted capabilities and the CLI renders the discovered text and schemas. Parent-supplied `input` goes unchanged through the shared Core input ledger with default steer or explicit followUp, after child identity/parentId and backend events are installed. The target Profile supplies the child's existing system prompt composition. Core does not copy the parent conversation, bindings or secretEnv, and does not automatically send child output back to a parent. See [built-in Agent control](15-core-runtime.md#built-in-agent-control).

## Public-Core PeerMesh peer

`createPeerMeshHarness` installs the following complete Profile prompt before spawn. It is passed through the ordinary Core Worker/native Pi system-prompt path. It is not a turn input.

```text
You are one PeerMesh peer in a persistent private project directory. Work only on your unique WORK_BRANCH. Clone RUN_REPOSITORY into the current project root (git clone "$RUN_REPOSITORY" .), then preserve this checkout across turns. Use your native Git credential helper; never print or persist credentials. Read the run issue, publish useful facts and detailed evidence to the shared board, and notify the run channel. Board CLAIM is a soft coordination note, not an exclusive Task lease. Follow-ups and configured idle-work batches arrive only after your current turn settles. There are no mid-turn notices or native automatic continuation. Do not merge or change main. Follow the fixed acceptance input and report actual results.
```

The nonsecret dynamic environment fields come from the successfully prepared run: RUN_REPOSITORY is its credential-free Gitea repository URL; WORK_BRANCH is `peer-${runId}`; GITEA_USERNAME and all Git author/committer name/email fields derive from the provisioned peer username. RUN_OWNER/RUN_REPO/RUN_ISSUE identify the fixed run repository and issue; RUN_CHANNEL/RUN_BOARD identify its actual channel and board. Only the peer Git token is supplied as secretEnv; it is not composed into a prompt. Core supplies its regular v2 Bash discovery/tool guidance.

The opt-in controlled acceptance explicitly sends these two complete turn inputs, in order after each accepted/started/completed wait: `FIXED_AGENSH_PEER_FIRST` and `FIXED_AGENSH_PEER_SECOND`. The local fixture in `test/fixtures/agensh-peer-upstream.ts` supplies fixed Bash function calls and final outputs `PEER_1_OK` / `PEER_2_OK`; these are controlled verification responses, not evidence of hosted model reasoning. Ordinary hosts supply their own explicit runInput text, which is not reconstructed from this template. No extra startup, queue, nudge, rejection, continuation or mid-turn notice prompt is added by this Harness. Shared runInput errors remain host-side errors; Core lifecycle/CLI error responses retain their documented paths.

### Serial PeerMesh router batch composition

The routed entrypoint adds a separate host-owned input path; the direct T13 entrypoint still forwards only the host's explicit text. [Complete generated peer/router texts](prompts/08-peermesh-harness.md) preserve the Profile prompt, serial batch instruction and optional idle nudge. `createPeerMeshRouter` composes each actual turn as the complete `routerInstruction`, a newline, and JSON `{batchId,source,eventId,kind,text,origin?,context}`. `batchId` derives from the host-ingested source/event/target identity. Source text is the targeted host input, a newly observed Gitea comment or Mattermost post, or the fixed configured nudge. Context is the run board's current rendered view for the trusted worker, read immediately before that batch. All dynamic fields are data; no upstream identity or credential is interpolated into the instruction. The router calls the exclusive Harness input helper. Project teams use Core `start`; the direct and routed compatibility paths use explicit `followUp`. Each reaches the same native Session. Failed readiness or context loading sends no batch. Unknown/cancelled submission fences subsequent sends; its diagnostics stay host-side. The same router adds the project-only notice path. It sends the exact notice instruction and JSON event envelope from the generated reference through Core `steer` after an ordinary batch has started. The event's recipient and source metadata are bound on the host. Its payload is a direct message or an admitted Board gist, without the full Board context. Pi inserts the notice as user-role content at its execution boundary. The compatibility entrypoints retain their serial instruction and delivery.

The team entrypoint in `src/harnesses/peermesh/team.ts` installs the [complete project Profile prompt and kickoff template](prompts/08-peermesh-harness.md) when `project` is configured. After every peer and event source is ready, all peers receive the configured project body in their first user input. The same body and title are also stored in the run issue, which peers can revisit for current context. The compatibility team uses the fixed Profile prompt and waits for each host kickoff. Repository, channel and Board fields are shared; branch, worker identity, author fields, bindings and secret Git environment remain peer-specific. External events carry the upstream sender ID, location and time when present. User inputs and configured idle prompts travel through the same serial composition. The two-peer fixtures supply fixed stage markers and controlled Bash responses as documented in the Harness chapter.

The T14 opt-in controlled native test uses fixed texts `T14_FIXED_KICKOFF`, `T14_FIXED_EXTERNAL`, and `T14_FIXED_USER`. The middle text is posted to the actual run PR and discovered through the HTTP subscription. The third marker is prefixed by the provisioned peer username in an actual Mattermost mention, discovered by that same subscription. Its three scripted Bash calls and outputs `ROUTER_1_OK`/`ROUTER_2_OK`/`ROUTER_3_OK` are local fixture responses, not hosted reasoning. The gate disables nudges; bounded nudge behavior is checked deterministically.

## Subagents host and round-result inputs

The ordinary Harness stages the [complete Root and Child Profile instructions](prompts/08-subagents-harness.md). Root is prompted to identify independently executable work before starting substantial work, delegate it early when useful, keep complementary work and integrate concrete contributions. Root asks for an early usable result through the collaboration Service. Child is prompted to send its first verified finding, test or patch as soon as it is usable. Both Profiles receive the initial Bash command for spawning a member and the command for discovering the Service. User text comes from the host input or config. The Child's first task and follow-ups come from authorized Bash Service requests. A normal notice or automatic child result has the original message ID, kind, trusted sender path and text. A result adds the outcome and source event sequence. The recipient reads pending notices in a wait tool response, through the no-wake steer path, or in a frozen batch attached to an explicit activation. An activation envelope carries the kind, sender path, text and batch; plain host input without a batch is passed through. A wait woken by an already admitted Pi input returns its reason and the next model request can see the input from Pi. Exact Service help and actual request bodies are available in the Service manifest and private trace.

The optional Pastel example driver uses the repository-owned [initial task and HSL follow-up](prompts/08-subagents-harness.md). The task asks Root to choose and coordinate its own team, make an early buildable delivery with tests, incorporate early concrete contributions and verify the stated formats with representative reference probes. The HSL input asks Root to notify affected members and is sent after the first observed active Root model request. The ordinary runner uses the task supplied by its caller.

The following inputs belong to the separate communication fixture.

The [Subagents prompts](prompts/08-subagents-harness.md) contain the complete default parent/child Profile text and every four-to-eight-Bot parent prompt/default goal variant. The host-frozen `childCount` selects `parentPromptFor` and, if no goal is supplied, `initialGoalFor`; count 2 preserves the original texts verbatim. The host stages those role prompts without composing a shared conversation. It sends configured `goal` and up to four `supplements` through the controller with fresh `user-N` identities and explicit `followUp`. The parent creates child input and followup text through native Bash Agent Service calls, subject to Profile and direct-child authorization; those future model-authored strings are not repository templates.

The controller receives Core events synchronously and copies each event before enqueueing work. A child result body is `JSON.stringify({childId, eventSeq, outcome, output?, error?, failure?})`. IDs and sequence come from the event, the relationship from public `runtime.get`, and output/error from that round's event snapshot. Fatal/exit fallback uses outcome `failed` and `failure` equal to `error` or `exit`. Those messages are actually submitted through `runtime.send(parentId, body, {requestId: child-result:<botId>:<seq>, mode: followUp})`. The delivery record separates accepted/unknown admission from settled parent text; multi-source parent events never prove completion of one specific input. Closing or unknown admission retains undelivered results and sends no replacement message. The final checked text preserves references and quotes from `childCount + 1` delivered child snapshots covering all configured children and one original child followup. Each parent settled observation freezes which deliveries had already been dispatched; a late accepted receipt may confirm that eligible send, while future dispatches cannot qualify the old text. This ordering rule does not establish which parent input a turn completed. Provider/Pi prompt additions and private native transcripts remain outside the generated repository reference.

## Fixed Lead-Worker instructions

The lead and helper Profile prompts and four fixed round instructions are fully reproduced in [the generated Lead-Worker reference](prompts/08-lead-worker-harness.md). The Harness serializes each instruction with the host goal/supplement or actual helper IDs and invokes the shared exclusive followUp helper. Helpers must read the public direction and keep permanent owner identities; the lead converts actual read feedback and the trusted user input into a public adjustment. This path has no busy steer, dynamic expansion or implicit continuation. See [the complete Harness flow](20-lead-worker-harness.md).


The separate opt-in genuine Kimi cooperation fixture adds host-authored acceptance goals documented in the [complete generated Agensh prompts](prompts/08-peermesh-harness.md). A's initial input combines liveCommon, liveAInitial, B's trusted username and a fresh seed; B's combines liveCommon, liveBInitial and A's username, omitting that seed. The external Gitea comment names A and appends liveAUser. Subsequent negotiation/agreement messages are model-authored upstream data. The normal router wraps these texts with its existing serial instruction and JSON identity; its injected context is only a fixed reminder to use Board Services, preserving the explicit seed-read check. These test-owned instructions do not change the production Profile or router prompt, and the fixture supplies no Bash function calls or final model responses.

## Staged host workload composition

Substrate obtains an optional `questionForCycle({peerIndex,botId,round,signal})` from the trusted host, validates a nonblank string of at most 8192 UTF-8 bytes, and sends it as `cycleQuestion` between the actual peer/cycle header and the unchanged `cyclePrompt`. Its default remains the static host question. This changes no Service grants or automatic turns. The separately supplied programming module controls only its task text and host validation; its exact source/hash and actual delivery belong to the reviewed run's private evidence. The host never executes model-supplied program source.

The optional Lead-Worker `runStage` path uses the same four source round instructions with these complete suffixes: initial lead: ` Use exactly the supplied role-to-path map for this stage.`; later lead: ` Cite exactly the previous stage feedback_ids and use the supplied new role-to-path map.`; each helper: ` Deliver only your supplied path and publish one new feedback note.` The host serializes `stage` (0–3) and its copied role-to-path `paths` map in every payload, adds actual helper Agent IDs and the host goal only to initialization, and adds the host supplement, registered `lead-stage-N` user identity and the preceding three verified task-feedback note sequences only to later lead inputs. Helpers receive the initial or followup source instruction according to the group number. These payloads are sent through the same `runInput` explicit followUp route, under unique `stage-N-role` request IDs, only after the stage admission and prior-direction guards. The configured system prompts and native tool discovery remain the generated lead/helper texts; no instruction is injected during the host's idle wait. Stage receipts record actual input acceptance and settlement identities separately from these composed templates.

The optional Lead-Worker setup path sends each original role a `prepare-stage` JSON input with `ready_note` equal to `Ready for staged workload: RUNTIME_ID:ROLE:BOT_ID`, using actual host-bound values, and the complete instruction: `Read the public Board, verify your own trusted role and Agent identity, then publish exactly ready_note as a public unscoped Board note. Do not claim work or create an artifact. This is setup only.` Each unique `prepare-stage-role` request uses the same explicit followUp helper and finite stage signal. The host accepts only actual new Board reads/notes from that Agent; no setup text is counted as a business delivery.

The generated Lead-Worker reference reproduces the complete staged corrective input composition. Only an explicit STAGE_CANDIDATE_REJECTED checker response enables this path after a helper input has completed. The original helper receives the original task with the derived new delivery path substituted, plus trusted stage, attempt, subtask ID and path map. Its instruction preserves the rejected task/Git/source/stdout, supplies no reference answer, and uses existing create/claim/complete operations. The exclusive followUp request ID is `stage-S-helperR-correction-N`; it keeps the original absolute stage cutoff. Unknown, queued, failed, malformed and checker-unavailable paths do not create a correction. Actual rejected/accepted admissions are retained separately from these source templates.


## ProgramBench Pastel

The [development benchmark](../../benchmarks/programbench-pastel/README.md) supplies its own workload text to existing dispatch paths. [Case source](../../benchmarks/programbench-pastel/case.ts) defines the fixed instance `sharkdp__pastel.b60e899`. The task expands `${goal}` to the following text before adding the four task lines.

```text
Rebuild Pastel for ProgramBench (sharkdp__pastel.b60e899).
Use the reference program at /opt/programbench/executable and its documentation in /opt/programbench.
Observe its behavior by running it. Author original source without accessing project source, external resources or hidden tests. Do not use or redistribute the reference in the candidate.
Create a source tree with a root compile.sh that builds ./executable in the offline ProgramBench environment. Preserve partial work if the full program is unfinished.
```

```text
Select and implement an original approach. Create an early runnable source snapshot, then extend or correct it as time allows.
Your teammates solve part of the same program. Record whose work was used, the source or version, and the behavior it supports.
Keep the candidate source and offline build instructions in the shared deliverable channel described below. A runnable subset is acceptable.
```

### Parent and children

The parent Profile leaves the Added System Prompt empty. The host appends the following instruction to the common task as the initial user input, separated by a blank line.

```text
Spawn two child Agents with complementary Pastel work using swarm bot spawn.
Include the relevant task requirements in each child input. Ask each child for a useful source file and a reference observation. Child results are delivered as JSON with childId, eventSeq, outcome and output.
Use the actual child results to write a source tree, test it with compile.sh and publish checkpoints using swarm candidate publish --stdin.
The payload is {"files":{"relative-path":"UTF-8 source text"},"used_children":[{"child_id":"actual UUID","event_seq":1,"file":"relative-path"}]}.
For each included child, preserve at least one whole source file it supplied, or explain your changes in your output. Keep extending the candidate within the available window.
```

The child Profile stages the following fixed instruction. The parent passes the relevant task requirements in each assignment through `swarm bot spawn` or `swarm bot send`. The existing Subagents router delivers completed child outputs back to the parent. The child identity and event sequence in each delivery come from Core.

```text
Work on the assigned Pastel component. Follow the provided task and return plain JSON with this shape:
{"files":{"relative-path":"UTF-8 source text"},"observation":"reference command and result"}. Include a source file the parent can use directly.
```

### TaskPool discovery and handoff

The host places the common task, a blank line and the following instruction in the discovery Prompt. The controller admits it after the initial window callback. On take, the existing Task handoff provides the corresponding fixed contract.

```text
Use swarm task list --state ready to find ready work and swarm task take to claim it. Read the complete Task before writing.
Publish source as Material attachments with relative names and base64 content. Use swarm material publish --help and --stdin.
When integrating, read both earlier Materials and their attachments, use their components in the candidate, and record swarm material consume with action integration and the actual impact. Include the Material IDs in used_material_ids on your new Material.
Publish the complete candidate tree as attachments, including compile.sh, before closing your Task. Close with swarm task finish and the actual Material IDs and outcome.
```

```text
Implement Pastel color parsing
Probe reference color input and publish a reusable named-color or hex parser with source attachments, interface and observations. Publish an early useful increment. If no language has been agreed, use Python 3 standard library.
```

```text
Implement Pastel output formatting
Probe reference format output and publish an independent formatting or conversion component with source attachments, interface and observations. Publish an early useful increment. If no language has been agreed, use Python 3 standard library.
```

```text
Integrate and submit a Pastel candidate
Read and integrate the two source Materials, implement a CLI with offline compile.sh, and publish an early runnable full source tree as Material attachments before extending behavior.
```

```text
Material with source attachments
Attach the produced source and record checks against the Pastel reference.
```

### PeerMesh peer inputs

The host sets the Gitea issue title to `Rebuild Pastel` and its body to the common task. Each kickoff gives the selected peer that task, a blank line and the role text below. The two contributors receive their respective inputs at the start. The integrator receives its input after the driver merges both contributor PRs.

**Parser**

```text
Implement a reusable color-input parsing component. Publish a small initial contribution early. Use Python 3 standard library if no language is agreed. Post a Board FACT with its file path, interface and a reference observation. Commit only your component, push it and open a PR from your assigned branch.
```

**Formatter**

```text
Implement an independent color-output formatting or conversion component. Publish a small initial contribution early. Use Python 3 standard library if no language is agreed. Post a Board FACT with its file path, interface and a reference observation. Commit a separate component file, push it and open a PR from your assigned branch.
```

**Integrator**

```text
Read both earlier peers’ Board FACTs and use their components from the current main. Implement the CLI and offline build (compile.sh). Prioritize a runnable subset and verify it with the reference. Commit and push the full candidate and open a PR. Return plain JSON {"adopted_files":["relative file path"],"checks":["reference command and observed result"]}.
```
