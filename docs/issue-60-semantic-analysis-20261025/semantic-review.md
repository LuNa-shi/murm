# Independent semantic review

This review is an independent operator reading of the sanitized evidence for
`exp-20261025-issue60-pr68-semantic-2h`. The deterministic extractor used the
nested `run/` evidence boundary and 10-minute windows. Source references below
use the stable IDs in `analysis/experiment-analysis.md`,
`analysis/aggregate-report.json`, `analysis/putnam_2025_b1/report.json`, and
`run/state/projects/putnam_2025_b1/project.sqlite`.

No raw Agent transcript, hidden reasoning, proof source, credentials,
stdout/stderr, or private Workspace content is used here. The report is
therefore diagnostic-only for claims that need candidate source or an explicit
Material-consumption event.

## Acceptance and evidence boundary

The implementation under test is `a0412fba65a8ab22bd1df2531f901a7c6dbe363a`,
with `repository_worktree_dirty=false`. The run used semantic parallel mode,
4 Cores, `openai-codex/gpt-6.1-sol`, the pinned PutnamBench commit
`a635813f5edf297d928f9bd5ef8324a26bdde09c`, and a 7,200,000 ms timebox.
The run reached the deadline with `protocol_valid=true`, `made_progress=true`,
`invalid=false`, and `solved=false`.

The evidence boundary contains metadata, Agent/Bridge/Runtime/Service/Judge
logs, the project SQLite database, observation events, Workspace manifests and
revisions, and the sanitized numerical summaries. The analyzer found 35
Executions, 33 Tasks, 93 Materials, and 8 Judge checks. A published Material
has no recorded consumer in the available evidence, but this may be a missing
consumer-correlation event rather than proof that the Material was not read.

## Execution identity and bounded work windows

The durable Execution ID remains the identity of an attempt. Core and Session
reuse is a segment of that Execution; it is not counted as a new mathematical
attempt. The 35 records group as follows:

- Nine research Executions reached `SUCCEEDED`: `4d68bcb9-a6cb-4ef9-a46a-69044e166304`, `54d30e48-b599-4530-be13-600a9fdeb3ef`, `e75f9649-b32b-4a02-96c4-48bde92fd03a`, `93161aee-1705-4487-b6a4-50a9fb16f428`, `e2fc341e-409d-42aa-b1f9-a718fbc6e4f0`, `c9bb95e2-9a55-451d-a10f-6f2121e6150d`, `32196b2d-1a21-4d20-b2c2-8846f937af96`, `f0aed2c8-6c8d-4d0f-9ec0-e82132c1a997`, and `8db887fb-e423-49a3-87ca-a0bd71f85fd5`. Their Task goals cover explicit simplex/algebraic constructions, coordinate and analytic circumcenter routes, circle-local exclusion, Bool/color reasoning, and Mathlib API discovery. This is real route exploration, but the sanitized boundary does not expose enough Workspace content to judge which lemma or route was mathematically decisive.
- Twenty-two Executions ended `WAITING` on `parent_review`: `b3380155-87de-4f3d-b6e4-bb15862af668`, `10d7e711-5df3-4f41-bd01-e2c714adc0b8`, `1b7271b6-d21f-46e3-b3c2-ce6e5476e798`, `1ef9834d-92bc-4c77-b9ee-9092cf80a6ae`, `f8e809a5-fd1c-4201-ae64-39bce6dfcbe8`, `b0b0d88f-31c6-4f4b-88b7-2a1947673522`, `ee3cd9c8-0091-4359-9232-a896cb1dcabc`, `f95eb5fe-6254-416d-ab1a-15d32d93ae7b`, `debda152-9b49-4fbc-b4b2-d13912322170`, `4ab44ac9-e612-4554-a92a-56cbb6e9280e`, `c6db275f-0cea-4716-8422-f69f72ef8b61`, `bea19492-8a2b-423a-a6e0-1df11ae0a1e1`, `cd0da823-fd08-453e-aadf-7460942319e5`, `86dd3f93-d1eb-4c22-a57f-264812fbf813`, `1ce30aaa-41e1-4c18-8fa0-144ff59b009a`, `a01f784d-efad-47b6-b87c-9ef76171e7fc`, `cf70d753-2425-481e-8114-0887e6b2be77`, `4e1530ae-363b-42d5-b940-f04932c26d56`, `c83c047c-5d34-4495-8ed5-f54e52169968`, `772c64c2-580c-4944-9241-2c31f5477329`, `827095fc-6095-42fd-8791-83f8401cd160`, and `678da0e4-abf9-4cbd-ad32-b00e2de70896`. The concrete handoff point is visible; the consumer's read and review decision are absent for most of these records.
- Two parent Executions waited on `child_task_terminal`: `a7aed351-6a54-48dd-b809-e45a754b0015` and `505a7630-efc5-4804-ae64-059b57bdfefd`. This shows the root/rework path did use typed child-completion waits.
- `4ca2017f-9001-4079-9119-7a303e18a882` is the fenced root attempt (attempt 11), and `f301399e-4fea-495b-bd11-183043344290` is the final failed root/rework attempt (attempt 4). The state table supports a timebox cleanup interpretation; it does not prove a scheduler crash.

The meaningful global windows are:

1. **17:08–17:20, decomposition and first research wave.** The root proof
   Task was claimed, branch/required-subtask structure was created, and Cores
   1–4 started bounded research. The goals identify algebraic, degenerate
   simplex, coordinate circumcenter, and Mathlib API routes. Two research
   Tasks became satisfied while multiple children entered `parent_review`.
   The expected next owner was the parent reviewer. Evidence: Task and
   Execution rows above; four branch groups, ten required-subtask groups, and
   the first structure events in the SQLite database.
2. **17:20–18:12, silent/recovery interval.** The available observation
   projection has no bounded semantic event that identifies a route change.
   This is an evidence gap, not a claim that no work occurred. The next
   expected owner was a resumed parent or an eligible research child.
3. **18:12–18:30, API and local-lemma exploration.** New research Executions
   investigated circle-local exclusion, analytic coordinates, and exact
   `Simplex`/circumcenter theorem names. Several tasks reached `SUCCEEDED`,
   while child outputs again ended in `parent_review`. This expanded the route
   set but did not close the parent-consumption loop.
4. **18:31–18:53, candidate construction and Judge feedback.** The root
   Execution produced repeated Candidates; the checker started and completed
   each time. Six checks belong to the root proof route and two to the later
   rework path. Every result is a completed source-level `FAIL`, with no
   checker infrastructure failure. The route metadata is too sparse to prove
   a changed proof strategy between candidates.
5. **18:45–19:01, rework and second research wave.** Rework tasks and more
   coordinate/API research were created. `accept_count=9` and
   `rework_count=8` show that the review protocol was exercised, but the
   22 final `parent_review` waits show that the loop did not close for many
   children.
6. **19:04–19:08, deadline cleanup.** The final root attempt ended in `FAILED`
   near the 7,200-second deadline while the root and many research Tasks
   remained `WAITING` or `OPEN`. The evidence supports explicit timebox
   truncation or cleanup races as competing explanations; it does not support
   calling the mathematical problem impossible.

Initial context and Workspace initialization are valid at the metadata level:
the implementation commit is clean, the input is pinned, and per-Execution
Workspace manifests/checkpoints exist. The sanitized report does not expose the
full initial prompt or candidate source, so prompt-level mathematical intent
is reported only through Task goals. There are 53 typed waits/checkpoints and
5 resumed Executions; the database records multiple attempts and fencing, so
recovery is durable. A typed terminal reason for the experiment deadline is
not visible, which limits cleanup conclusions.

## Coordination and handoff loop

The run demonstrates `decompose → claim → independent work → publish/check`
and uses 32 child Tasks, 44 child claims, 26 structure operations, 4 branch
groups, and 10 required-subtask groups. Nine Tasks reached `SATISFIED`; 23
Tasks remained `WAITING` and one remained `OPEN` at the final snapshot.

The handoff loop is only partially closed. Producers published 93 Materials,
and Judge results were applied, but the available evidence records no explicit
consumer for those Materials. For each such edge, the producer, intended
parent, and downstream operation are unknown or uncorrelated. The two possible
explanations are (a) the parent did not read and review the result, leaving the
child parked, or (b) the observation/report projection did not retain the
consumer link. The next run must record `publish → read_materials →
accept_task/request_rework → resume` with the same Material, Task, and
Execution IDs.

The root did perform review/rework operations, so this is not a total
scheduler or protocol failure. It is a weakly observed and frequently
one-way handoff loop that leaves capacity and mathematical route information
unused.

## Candidate and Judge semantics

The Judge path is healthy: one checker preflight was available, 8 checker
processes started and completed, all 8 were classified `source_failure`, and
there were zero infrastructure failures and zero unassessed results. The first
six Candidates on Task `62d5c5da-9040-4e00-aa03-878ef78d23f0` were checked at
17:11:20, 17:15:18, 17:19:18, 17:21:59, 17:23:39, and 18:43:07; the later two
were associated with rework Task `e7f042f9-9c65-46e8-a22d-23045722767a` at
18:50:59 and 18:55:56. Feedback was applied/read, but the bounded report has
no route hash or source-level diff that demonstrates a new strategy. The
visible Task goals do show a progression from explicit simplex construction to
coordinate/analytic circumcenter and Mathlib API routes, so the research tree
changed route even though the Candidate loop did not converge.

The observed pattern is `same source_failure → another Candidate`, especially
six times on the root Task and twice on the rework Task. Operationally this
spent Judge and Agent time without producing a PASS. Competing explanations
are repeated unchanged proof files, a genuinely difficult Lean API boundary,
or missing route metadata. Validation requires a route fingerprint or explicit
research/parent-review record between repeated diagnostics; the next Candidate
must name the changed route and reference the consumed failure.

## System efficiency and health

The configured capacity was four Cores and all four were claimed. The run's
effective utilization was `0.2658467`, mean active Core count `1.063`, and
eligible-work mean active Core count `3.551`. Ready work existed for
`1,329,129 ms`, of which `1,070,078 ms` was ready but unassigned. Scheduler
startup succeeded 107/107 times, with no startup failure or bounded startup
exhaustion, one duplicate suppression, and dispatch latency from 17 ms to
92.3 s (median about 1.8 s, p95 about 44.4 s). This is evidence of serial
underuse and handoff/claim delay; it is not enough to declare the scheduler
incorrect.

The main competing explanations are: (1) parent-review waits did not release
or wake the right eligible consumer, (2) many fine-grained nested Tasks caused
claim contention and short-lived sessions, or (3) Agent turn latency and
research-task granularity left no runnable work at intervals. The decisive next
instrumentation is a per-Core interval ledger joining ready queue age, claim
success/conflict, Runtime `RUNNING`, `WAITING` capacity release, wake-to-dispatch
latency, and the consuming Task ID. A scheduler defect should only be claimed
if ready work remains while a free Core has no successful dispatch and the
handoff event is present.

There were 93 Agent tool errors across `STALE_VERSION`, `INVALID_CONTRACT`,
`CONFLICT`, and `NOT_ALLOWED`; `tool_protocol_error_count=0`,
`invalid_wait_attempt_count=0`, and `protocol_valid=true`. These are
contract/contention signals, not provider or transport failures. Their impact
is claim/structure retry cost. The next report should attach each error to an
operation and determine whether the Agent retries with a fresh state version;
otherwise the aggregate count cannot distinguish healthy contention from
avoidable repeated discovery.

## System-level findings and validation conditions

1. **Handoff visibility / delivery without consumption (medium confidence).**
   Observed: 93 Materials and 22 `parent_review` waits with no consumer record.
   Affected entities: the research children listed above, their parents, and
   Cores 1–4. Impact: parent route selection and Core release cannot be proven.
   Alternatives: missing observation correlation or a parent that read through
   an unrecorded path. Validate with a required `read_materials` event and a
   downstream accept/rework/resume event for every published Material.
2. **Feedback loop lacks visible route change (medium confidence).**
   Observed: 8/8 source-level failures and repeated `source_failure` on the
   root/rework Tasks. Impact: repeated Candidate checking consumed the
   timebox without convergence. Alternatives: route metadata is incomplete or
   the failure requires a deeper API discovery step. Validate by requiring a
   changed Workspace/research route after two identical diagnostics.
3. **Capacity underuse and ready-but-unassigned time (medium confidence).**
   Observed: 26.6% effective utilization versus 3.551 eligible mean active
   Cores, with 1.07M ms ready-unassigned. Impact: the 4-Core configuration did
   not translate into four-Core mathematical progress. Alternatives: short
   tasks, Agent response latency, or unavailable consumer links. Validate with
   the interval ledger described above.
4. **Deadline cleanup is incomplete (medium confidence).** Observed: final
   failed Execution plus root/open/waiting Tasks at deadline. Impact: the run
   cannot distinguish deferred work from failed work and leaves no clean
   terminal domain outcome. Alternatives: final child failure could have
   triggered the root failure immediately before timeout. Validate typed
   experiment-timebox cancellation/recovery and a no-orphan lease assertion.

## Protocol versus domain outcome

Protocol/lifecycle outcome: **successful and valid**. Pi sessions started,
service calls and checker preflights completed, direct child structure and
WAITING/resume/rework paths were exercised, and no invalid wait or protocol
error invalidated the run.

Collaboration outcome: **partially successful**. Decomposition, claims,
branch/required-subtask creation, Judge application, accept/rework, and resume
were observed; Material consumption and the final parent-review closure were
not demonstrated for most deliveries.

Domain outcome: **not solved**. All eight checker invocations produced
source-level failures. No checker infrastructure failure explains the result,
but the evidence does not establish whether the dominant cause was repeated
proof route, missing Mathlib API lemma, or insufficient time after research.

## Rubric score

| Dimension | Score | Basis |
|---|---:|---|
| Coordination | 1/2 | Child creation, claims, waits, and rework are concrete; consumer/review edges are incomplete. |
| Execution | 2/2 | Durable IDs, Core/Session segments, typed waits, fencing, resume, rework, and deadline state are reconstructed. |
| Tool | 2/2 | Provider/startup, contract error classes, checker preflight, process status, and source/infrastructure classification are separated. |
| Efficiency | 2/2 | Ready supply, eligible capacity, dispatch latency, utilization, and competing causes are quantified. |
| Candidate semantics | 1/2 | Candidate sequence and feedback classes are compared; route/source diffs are unavailable in sanitized evidence. |
| Evidence discipline | 2/2 | Stable Task/Execution/Material/Check IDs and explicit unknowns/alternatives are retained. |
| **Total** | **10/12** | Diagnostic-only because handoff and candidate-route evidence remains incomplete despite the score. |

## Next experiment acceptance gates

The next semantic run should require all of the following before claiming
improvement: (1) at least one end-to-end Material consumer loop,
(2) explicit route change after repeated Judge feedback, (3) lower
ready-unassigned time and higher eligible-work utilization at the same Core
count, (4) typed timebox cleanup with no orphaned waits or leases, and
(5) separate protocol/lifecycle, collaboration, and mathematical outcome
fields. A mathematical PASS remains a separate gate from Runtime success.
