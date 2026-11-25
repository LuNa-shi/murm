# Prompts and model-visible instructions

## Phase 0005 Core

The generic backend uses the host's complete `Profile.prompt` verbatim. The trusted Worker writes it to `/workspace/runtime/profile-prompt.txt` and starts native Pi with `--append-system-prompt` pointing to that file. Pi provides the original tool instructions for `read`, `write`, `edit`, and `bash`. This path disables ambient extensions, skills, prompt templates and context files. Bot creation performs startup and readiness calls. A subsequent host `send` passes the entire supplied input string as the Pi RPC `prompt` message with the selected `steer` or `followUp` behavior. Core adds no template text to the Profile prompt or input. [Core Runtime](15-core-runtime.md) explains host assembly and [Pi/OpenSandbox backend](16-pi-opensandbox-backend.md) explains the actual launch and send paths.

Custom Service instructions reach a generic Bot when it runs `swarm service view <id>` or `swarm <service> [<operation>] --help` through native Bash. The Bridge derives the visible capabilities from the frozen Profile.services and registered manifest. The CLI composes the usage line with the chosen Service ID, manifest purpose, each allowed operation's description/help.when, side_effect/idempotent, serialized input/output schemas and declared errors. This is command output returned through Pi's Bash result, not an extra system prompt or independent model turn. Unrequested metadata is not automatically inserted into Profile.prompt. The full composition is in `src/cli/swarm-cli.ts` and the actual dispatch/authorization path is described in [Core Runtime](15-core-runtime.md).

The installed Notes Environment gives the writer and reader their role prompts at spawn. It sends one publication input to the writer. After the host verifies the write, it sends a retrieval input to the reader, verifies the read and sends a follow-up on the same reader. Each input uses explicit `followUp` through the host helper. The fixed key is `core-service-boundary`. The configured source observation is `review-input.json`, provided at spawn and read through native tools. The writer additionally receives `note-request.json` containing the fixed key and the observation as a JSON string field; its publication input explicitly uses `--input note-request.json` to preserve that field type. Notes exposes put only to the writer and get only to the reader. The complete role and turn text is generated from the host example. [Notes prompts](prompts/07-notes-environment.md)

The fixed scaleMAS Environment stages the same peer prompt for all three Bots and sends a peer/cycle header, the host question and the cycle instruction through the exclusive `runInput` helper. Its complete text and dynamic field provenance are in [scaleMAS prompts](prompts/09-scalemas-environment.md); [the Environment chapter](19-scalemas-environment.md) describes ordering and failure gates.

## Flat messages and Core startup

[bot-contract.js](../../src/agent/bot-contract.ts) composes the current Flat continuation, soft-closeout and domain notification messages and projects Service metadata into CLI namespaces. These helpers preserve Task/Execution guidance and authorization discovery; they do not assemble a system prompt or skill resources.

The manager starts only `swarmenv-core-v1` with an explicit empty resource array. The Worker rejects former resource-based contracts and requires the direct `pi` command, Profile prompt text and the fixed Core prompt path. Core constructs native-tool and ambient-discovery flags; the Worker checks string arguments and stages the supplied prompt. Model-catalog hash/ownership checks and filesystem isolation remain separate guards. [Backend](16-pi-opensandbox-backend.md) explains this current path. Pi/provider-owned rendering remains outside the repository templates.

The former registered Bot startup helper, fixed system addendum and four skills have been removed after their callers migrated. Their original text and version-bound evidence remain in Git history and research revisions. Current generated references document the executable Flat and Environment compositions below.

## Continuations, notifications and lifecycle feedback

The Flat controller composes its durable handoff warning using `buildBotNotification` and admits it through its serialized `followUp` input path. It fixes the exact text and request identity before asynchronous admission; the Execution/deadline and notification ID come from durable Task state. The retained Runtime no longer dispatches Task notification inputs. The builder retains Material/dependency formatting, but the current Flat host has no automatic send path for those two variants. Handoff warnings name the Execution and remaining deadline allowance. Material notifications identify producer, Material and notification IDs and require reading and explicit feedback. Dependency updates direct the Bot to inspect Task state. None grants ownership, establishes correctness or completes the current Task. Controller admission can reject a stopped Bot; durable public state remains the authority on later reads.

Bridge command responses include structured results/errors and lifecycle notices. Native Bash carries these back into the model conversation; the Bridge does not create a separate turn for a tool response. Workspace conflicts also write an ordinary README artifact: it becomes model input only when read. Judge results carry actual checker diagnostics; successful request transport is not proof acceptance. Fixed guidance fields are catalogued separately from dynamic Task, Material, provider and checker content.

## Complete text and reproducible source inventory

| Reference | Contents |
|---|---|
| [CLI directory and provider documents](prompts/02-task-loop-and-tools.md) | Actual startup directory fixtures and available optional bundle documents |
| [Runtime turns](prompts/03-runtime-turns.md) | Complete flat continuation and soft-closeout bodies |
| [Runtime notifications](prompts/04-runtime-messages.md) | Exact notification builder output and current versus unsent variants |
| [Tool-result guidance](prompts/06-tool-return-guidance.md) | Fixed executable hint/remediation/guidance fields and delivery conditions |
| [Source manifest](prompts/source-manifest.json) | Source hashes, extraction anchors, send sites and generated-body hashes |

`dist/scripts/generate-architecture-prompts.js` runs offline with explicit synthetic identities and timestamps. It enumerates repository `.prompt` send sites and instruction fields and fails when an unlisted source introduces one. Run `npm run docs:generate`, inspect generated and explanatory changes, then `npm run docs:check`. Fingerprints establish source alignment, not actual delivery or compliance. Actual claims about what a Bot saw require private Session/RPC evidence. Public reports must not contain raw conversations, proof candidates, credentials or personal paths. Full model request replay also needs external Pi/provider context and compaction state, which this repository does not capture as a canonical request.

## Phase-sensitive bound follow-up

The public-Core flat controller calls `buildBotContinuationMessage` using the Execution's durable handoff deadline and reminder state for an unfinished active Execution after a settled turn. Its identity, lease, fence, deadline and stop guards remain controller/domain responsibilities. The generated runtime-turn reference contains the complete fixed body. Closeout instructions direct save, publish and finish, and domain guards enforce which new contributions remain allowed.

## Lifecycle and result feedback

The registered Bot Bridge sends Chinese `notice` fields on the same CLI response that carries the result or typed error. These are results of commands already issued in the Session. The Bridge does not send an extra Pi turn. The phase’s [fixed wording](../phases/0002-task-material-workspace/06-prompts-and-skills.md#必须有定义的运行消息) is instantiated from these sources:

| Branch | Input evidence and delivery |
|---|---|
| Take race, unknown response, changed initial revision | The Task claim supplies the competing Execution/quota outcome. The CLI assigns and transmits a stable request ID before the HTTP call, and reports that ID when the outcome is unclear. A successful take compares the recorded preview with the revision that actually prepared the directory. |
| Contribution rejected, selection expired, hard stop | The Bridge combines its authorized operation profile with the durable Bot/E state and deadline. The Task Service rejects early exit in an open Mission with remaining time. The Bridge returns the `discovery_required` phase and guidance to inspect current public state and existing Tasks within the selection budget. Once the selection deadline elapses, an unbound Bot without a pending take can use the budget-exit path. A live request may receive the hard-stop response if the connection still exists. |
| Save failure | The response names a definitive Workspace save failure and rejects claiming private files as delivered. Active-project apply guidance and conflict-alternative README production have been retired; legacy persisted install recovery sends no new model instruction. |
| Merge check failure or moved main | The merge error carries the pinned main/source revision and checked-tree diagnostic, or the observed and actual main revisions from the failed compare-and-swap. The message includes the corresponding bounded recovery steps. |
| Mission submission | The submit and submission-view responses include the fixed submitted revision and Material IDs, the durable verdict and, on failure, the observed current main and freeze owner. See [Mission submission](03-mission-task.md). |
| Soft closeout and finish | The soft-closeout body names the E and the milliseconds remaining against its persisted deadline at composition. It is available in an already scheduled continuation or handoff notification. A finish response identifies the durable request and E admitted to closing before physical release. |

The `use-workspace` skill directs ordinary local-proposition iteration to save a fixed revision and select `--check-mode lean-module --path P`. It explains that P selects a complete module and its dependencies, rather than an individual declaration within a multi-declaration file, and permits independently useful lemmas/definitions to be organized in imported modules. A revision-only call still requests full-project diagnostics; a full-mode path binds Task delivery evidence. Local receipts do not satisfy a full delivery requirement. It explains imports under the locked source directory, actual module coverage, warnings and the separate Mission proof check. The skill remains an image resource discovered through the existing manifest and sent through the existing skill-read path; it does not grant new authority or require a particular research decomposition. The command help distinguishes deployments with project checking from compatibility source-only deployments.

### Flat take preview notice

`src/environments/flat/prepare-inputs.ts` composes one additional tool-result notice only when a host-recorded Task view preview differs from the authoritative public revision selected during take:

```text
Execution ${execution.execution_id} starts from ${snapshot.revision}, different from preview ${preview.revision}; reread the affected project files.
```

The Execution ID comes from TaskService's accepted reservation; selected revision comes from MissionWorkspace.exportRevision; preview revision comes from the same trusted Bot's earlier Task view. Flat stores the notice with immutable Workspace input provenance. On successful take it travels through the Service-v2 response and original Bash tool result; it is not independently injected as a model message. Core prepare/grant consumes only canonical file bytes and never composes this notice. `flatResearcherProfile` forwards the host-supplied prompt unchanged and supplies readonly resource defaults; it adds no repository prompt template.

### Flat controller messages

The [generated flat reference](prompts/08-flat-environment.md) extracts the complete defaults from the Environment/controller sources and records their fingerprints and public send site.

`src/environments/flat/controller.ts` owns its default discovery input, sent only after coordinator domain readiness through public `Runtime.send` with explicit `followUp`:

```text
Read public Tasks and take suitable work. Continue in this Session after take.
```

The default researcher Profile prompt in `src/environments/flat/environment.ts` supplies the base text during Core assembly.

```text
Use the flat Services to discover, execute and truthfully finish Mission work.
```

Hosts can replace the base Profile text, discovery input or ordinary continuation through the host and controller settings. Without a trusted `snapshotProject`, the host appends the [generated Profile guidance](prompts/08-flat-environment.md) to either base prompt, omits private Workspace save and observation operations from the Profile, and selects the Material-oriented defaults for ordinary continuation, soft closeout and the handoff warning. The persisted Execution supplies the phase and the warning deadline. A host ordinary-continuation override still applies before soft closeout. The controller rechecks Task state and remaining budget before its public followUp send. Directed user text passes through the same controller with the chosen mode and request ID. For the complete default text in each case, see the generated Flat reference.

The built-in Core Bot Service adds no child startup prompt or business result template. Its manifest help describes child admission, initialInput and pending cleanup; the Bridge exposes only permitted capabilities and the CLI renders the discovered text and schemas. Parent-supplied `input` goes unchanged through the shared Core input ledger with default steer or explicit followUp, after child identity/parentId and backend events are installed. The target Profile supplies the child's existing system prompt composition. Core does not copy the parent conversation, bindings or secretEnv, and does not automatically send child output back to a parent. See [built-in Bot control](15-core-runtime.md#built-in-bot-control).

## Public-Core Agensh peer

`createAgenshEnvironment` installs the following complete Profile prompt before spawn. It is passed through the ordinary Core Worker/native Pi system-prompt path. It is not a turn input.

```text
You are one Agensh peer in a persistent private project directory. Work only on your unique WORK_BRANCH. Use Bash and swarm Service commands; discover each operation with swarm <service> <operation> --help. Clone RUN_REPOSITORY into the current project root (git clone "$RUN_REPOSITORY" .), then preserve this checkout across turns. Use your native Git credential helper; never print or persist credentials. Read the run issue, publish useful facts and detailed evidence to the shared board, and notify the run channel. Board CLAIM is a soft coordination note, not an exclusive Task lease. Follow-ups and configured idle-work batches arrive only after your current turn settles. There are no mid-turn notices or native automatic continuation. Do not merge or change main. Follow the fixed acceptance input and report actual results.
```

The nonsecret dynamic environment fields come from the successfully prepared run: RUN_REPOSITORY is its credential-free Gitea repository URL; WORK_BRANCH is `peer-${runId}`; GITEA_USERNAME and all Git author/committer name/email fields derive from the provisioned peer username. RUN_OWNER/RUN_REPO/RUN_ISSUE identify the fixed run repository and issue; RUN_CHANNEL/RUN_BOARD identify its actual channel and board. Only the peer Git token is supplied as secretEnv; it is not composed into a prompt. Core supplies its regular v2 Bash discovery/tool guidance.

The opt-in controlled acceptance explicitly sends these two complete turn inputs, in order after each accepted/started/completed wait: `FIXED_AGENSH_PEER_FIRST` and `FIXED_AGENSH_PEER_SECOND`. The local fixture in `test/fixtures/agensh-peer-upstream.ts` supplies fixed Bash function calls and final outputs `PEER_1_OK` / `PEER_2_OK`; these are controlled verification responses, not evidence of hosted model reasoning. Ordinary hosts supply their own explicit runInput text, which is not reconstructed from this template. No extra startup, queue, nudge, rejection, continuation or mid-turn notice prompt is added by this Environment. Shared runInput errors remain host-side errors; Core lifecycle/CLI error responses retain their documented paths.

### Serial Agensh router batch composition

The routed entrypoint adds a separate host-owned input path; the direct T13 entrypoint still forwards only the host's explicit text. [Complete generated peer/router texts](prompts/08-agensh-environment.md) preserve the Profile prompt, serial batch instruction and optional idle nudge. `createAgenshRouter` composes each actual turn as the complete `routerInstruction`, a newline, and JSON `{batchId,source,eventId,kind,text,context}`. `batchId` derives from the host-ingested source/event/target identity. Source text is the targeted host input, a newly observed Gitea comment or Mattermost post, or the fixed configured nudge. Context is the run board's current rendered view for the trusted worker, read immediately before that batch. All dynamic fields are data; no upstream identity or credential is interpolated into the instruction. The router calls the existing Environment runInput helper, which explicitly sends followUp to the same native Session. Failed readiness or context loading sends no batch. Unknown/cancelled submission fences subsequent sends; its diagnostics stay host-side. No independent notification or busy-steer channel is added.

The team entrypoint in `src/environments/agensh/team.ts` composes the same complete peer Profile prompt for every `peer-<key>` Profile and the same serial instruction for each peer's exclusive router. Dynamic `WORK_BRANCH` now comes from the selected provisioned peer's branch, with the original single-peer `peer-<runId>` fallback. Repository, channel and board fields are shared; worker identity, account author fields, bindings and secret Git environment remain peer-specific. All identities and subscriptions are installed before kickoff. Targeted upstream text and current board rendering enter only the selected router's JSON batch; its call through shared runInput sends explicit followUp to that Bot's original Session. The team adds no independent prompt, continuation or failure text. The opt-in two-peer fixture supplies fixed stage markers and controlled Bash responses, described in the Environment chapter; these are verification inputs rather than ordinary production prompts or hosted model evidence.

The T14 opt-in controlled native test uses fixed texts `T14_FIXED_KICKOFF`, `T14_FIXED_EXTERNAL`, and `T14_FIXED_USER`. The middle text is posted to the actual run PR and discovered through the HTTP subscription. The third marker is prefixed by the provisioned peer username in an actual Mattermost mention, discovered by that same subscription. Its three scripted Bash calls and outputs `ROUTER_1_OK`/`ROUTER_2_OK`/`ROUTER_3_OK` are local fixture responses, not hosted reasoning. The gate disables nudges; bounded nudge behavior is checked deterministically.

## Subagents host and round-result inputs

The ordinary Environment stages the [complete Root and Child Profile instructions](prompts/08-subagents-environment.md). User text comes from the host input or config. The Child's first task and follow-ups come from authorized Bash Service requests. A normal notice or automatic child result has the original message ID, kind, trusted sender path and text. A result adds the outcome and source event sequence. The recipient reads pending notices in a wait tool response, through the no-wake steer path, or in a frozen batch attached to an explicit activation. An activation envelope carries the kind, sender path, text and batch; plain host input without a batch is passed through. A wait woken by an already admitted Pi input returns its reason and the next model request can see the input from Pi. Exact Service help and actual request bodies are available in the Service manifest and private trace.

The optional Pastel example driver uses the repository-owned [initial task and HSL follow-up](prompts/08-subagents-environment.md). It sends the latter as host input after observing Root's first real model request. The ordinary runner uses the task supplied by its caller.

The following inputs belong to the separate communication fixture.

The [subagents prompts](prompts/08-subagents-environment.md) contain the complete default parent/child Profile text and every four-to-eight-Bot parent prompt/default goal variant. The host-frozen `childCount` selects `parentPromptFor` and, if no goal is supplied, `initialGoalFor`; count 2 preserves the original texts verbatim. The host stages those role prompts without composing a shared conversation. It sends configured `goal` and up to four `supplements` through the controller with fresh `user-N` identities and explicit `followUp`. The parent creates child input and followup text through native Bash Bot Service calls, subject to Profile and direct-child authorization; those future model-authored strings are not repository templates.

The controller receives Core events synchronously and copies each event before enqueueing work. A child result body is `JSON.stringify({childId, eventSeq, outcome, output?, error?, failure?})`. IDs and sequence come from the event, the relationship from public `runtime.get`, and output/error from that round's event snapshot. Fatal/exit fallback uses outcome `failed` and `failure` equal to `error` or `exit`. Those messages are actually submitted through `runtime.send(parentId, body, {requestId: child-result:<botId>:<seq>, mode: followUp})`. The delivery record separates accepted/unknown admission from settled parent text; multi-source parent events never prove completion of one specific input. Closing or unknown admission retains undelivered results and sends no replacement message. The final checked text preserves references and quotes from `childCount + 1` delivered child snapshots covering all configured children and one original child followup. Each parent settled observation freezes which deliveries had already been dispatched; a late accepted receipt may confirm that eligible send, while future dispatches cannot qualify the old text. This ordering rule does not establish which parent input a turn completed. Provider/Pi prompt additions and private native transcripts remain outside the generated repository reference.

## Fixed lead-helper instructions

The lead and helper Profile prompts and four fixed round instructions are fully reproduced in [the generated lead-helper reference](prompts/08-lead-helper-environment.md). The Environment serializes each instruction with the host goal/supplement or actual helper IDs and invokes the shared exclusive followUp helper. Helpers must read the public direction and keep permanent owner identities; the lead converts actual read feedback and the trusted user input into a public adjustment. This path has no busy steer, dynamic expansion or implicit continuation. See [the complete Environment flow](20-lead-helper-environment.md).


The separate opt-in genuine Kimi cooperation fixture adds host-authored acceptance goals documented in the [complete generated Agensh prompts](prompts/08-agensh-environment.md). A's initial input combines liveCommon, liveAInitial, B's trusted username and a fresh seed; B's combines liveCommon, liveBInitial and A's username, omitting that seed. The external Gitea comment names A and appends liveAUser. Subsequent negotiation/agreement messages are model-authored upstream data. The normal router wraps these texts with its existing serial instruction and JSON identity; its injected context is only a fixed reminder to use Board Services, preserving the explicit seed-read check. These test-owned instructions do not change the production Profile or router prompt, and the fixture supplies no Bash function calls or final model responses.

## Staged host workload composition

scaleMAS obtains an optional `questionForCycle({peerIndex,botId,round,signal})` from the trusted host, validates a nonblank string of at most 8192 UTF-8 bytes, and sends it as `cycleQuestion` between the actual peer/cycle header and the unchanged `cyclePrompt`. Its default remains the static host question. This changes no Service grants or automatic turns. The separately supplied programming module controls only its task text and host validation; its exact source/hash and actual delivery belong to the reviewed run's private evidence. The host never executes model-supplied program source.

The optional lead-helper `runStage` path uses the same four source round instructions with these complete suffixes: initial lead: ` Use exactly the supplied role-to-path map for this stage.`; later lead: ` Cite exactly the previous stage feedback_ids and use the supplied new role-to-path map.`; each helper: ` Deliver only your supplied path and publish one new feedback note.` The host serializes `stage` (0–3) and its copied role-to-path `paths` map in every payload, adds actual helper Bot IDs and the host goal only to initialization, and adds the host supplement, registered `lead-stage-N` user identity and the preceding three verified task-feedback note sequences only to later lead inputs. Helpers receive the initial or followup source instruction according to the group number. These payloads are sent through the same `runInput` explicit followUp route, under unique `stage-N-role` request IDs, only after the stage admission and prior-direction guards. The configured system prompts and native tool discovery remain the generated lead/helper texts; no instruction is injected during the host's idle wait. Stage receipts record actual input acceptance and settlement identities separately from these composed templates.

The optional lead-helper setup path sends each original role a `prepare-stage` JSON input with `ready_note` equal to `Ready for staged workload: RUNTIME_ID:ROLE:BOT_ID`, using actual host-bound values, and the complete instruction: `Read the public Board, verify your own trusted role and Bot identity, then publish exactly ready_note as a public unscoped Board note. Do not claim work or create an artifact. This is setup only.` Each unique `prepare-stage-role` request uses the same explicit followUp helper and finite stage signal. The host accepts only actual new Board reads/notes from that Bot; no setup text is counted as a business delivery.

The generated lead-helper reference reproduces the complete staged corrective input composition. Only an explicit STAGE_CANDIDATE_REJECTED checker response enables this path after a helper input has completed. The original helper receives the original task with the derived new delivery path substituted, plus trusted stage, attempt, subtask ID and path map. Its instruction preserves the rejected task/Git/source/stdout, supplies no reference answer, and uses existing create/claim/complete operations. The exclusive followUp request ID is `stage-S-helperR-correction-N`; it keeps the original absolute stage cutoff. Unknown, queued, failed, malformed and checker-unavailable paths do not create a correction. Actual rejected/accepted admissions are retained separately from these source templates.


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

The host places the following instruction in the parent Profile and appends it to the common task as the initial host input, separated by a blank line.

```text
Spawn two child Bots with complementary Pastel work using swarm bot spawn.
Ask each child for a useful source file and a reference observation. Child results are delivered as JSON with childId, eventSeq, outcome and output.
Use the actual child results to write a source tree, test it with compile.sh and publish checkpoints using swarm candidate publish --stdin.
The payload is {"files":{"relative-path":"UTF-8 source text"},"used_children":[{"child_id":"actual UUID","event_seq":1,"file":"relative-path"}]}.
For each included child, preserve at least one whole source file it supplied, or explain your changes in your output. Keep extending the candidate within the available window.
```

The child Profile combines the common task, a blank line and the following instruction. The parent authors its actual child assignments through `swarm bot spawn` or `swarm bot send`. The existing Subagents router delivers completed child outputs back to the parent. The child identity and event sequence in each delivery come from Core.

```text
Work on the assigned Pastel component. Follow the provided task and return plain JSON with this shape:
{"files":{"relative-path":"UTF-8 source text"},"observation":"reference command and result"}. Include a source file the parent can use directly.
```

### Flat discovery and handoff

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

### Agensh peer inputs

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
