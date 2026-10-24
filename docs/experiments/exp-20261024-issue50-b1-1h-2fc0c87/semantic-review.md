# Independent semantic review

Experiment: `issue-50-b1-1h-2fc0c87`
Review mode: full local evidence, 10-minute windows
Review status: semantically useful with evidence-limited Candidate-route and retry-causality conclusions

This review was written from the current analyzer's stable evidence references
and the local experiment records. It does not copy Candidate/proof source,
transcripts, credentials, stdout/stderr, or hidden Agent reasoning. A route is
called `unknown` when the visible objective, Workspace metadata, or Material
metadata does not identify it.

## Run and evidence boundary

**Fact.** The run has four durable Executions and four Tasks. The experiment
metadata records a completed one-hour, four-Core run at commit
`2fc0c8770327cd277dd88119fff1a986a72be137`; the report marks it
`protocol_valid=true`, `solved=false`, and `made_progress=true`. The evidence
classes metadata, Agent, Bridge, Runtime, Service, Judge, SQLite, Observation,
Workspace, and summary are present; no unknown Task/Execution references were
reported (`experiment-analysis.md`, Evidence boundary and Run overview).

**Fact.** Lean/Lake preflight passed before Agent work. All 13 checker records
are source-level `FAIL / unsolved_goals`; no checker launch `ENOENT` occurred in
this run (`metadata/experiment.json`, `logs/projects/putnam_2025_b1/judge/lean-checker.ndjson`,
`state/projects/putnam_2025_b1/project.sqlite#check_results`).

**Unknown.** The initial Agent prompt and full Candidate/proof source are not
available as shareable semantic text. The review can identify Task goals,
Workspace/Material/Judge transitions, and feedback reads, but cannot claim the
hidden mathematical reasoning.

## Execution attempts and semantic windows

### Root Execution `77b4c33f-507c-4b0b-9923-b8696005f6aa`

Task `1b522aa3-8509-436c-9c02-ca4425b8b97c`, Core 1, four Session segments,
Workspace lineage `workspace:77b4c33f-507c-4b0b-9923-b8696005f6aa`, terminal
state `FAILED`. Workspace revisions and checkpoint/release records show an
isolated durable lineage; no predecessor or successor Execution is recorded.
The initial visible goal was to prove `putnam_2025_b1`; the exact prompt is
unknown (`experiment-analysis.md`, root Execution inventory).

| Time (UTC) | Phase and bounded interpretation | Route/durable change | Next owner/state | Evidence/confidence |
|---|---|---|---|---|
| 04:29:58–04:33:14 | Candidate construction/submission. Root explored the proof Task and created the first child while submitting the first Candidate. | Root revision 1–3, child creation, Material `3ded…`, Candidate `3ded…`; no explicit route metadata. | Judge feedback and child execution. | Observation sequences 1033, 1114, 1156–1157; medium. |
| 04:33:14–04:43:13 | Candidate checking/feedback. Two source-level FAILs were applied; feedback and Workspace activity continued. | Materials `965…`, `500…`, revisions 4+, seven waits/wakes; a zero-Material read was recorded. | Continue root work; child handoff remained pending. | Observation sequences 2527, 2529–2532; high. |
| 04:43:13–04:43:18 | Evidence gap. No durable event was recorded; this is not proof of no work. | None visible. | Unknown; preserve the gap. | Generated window 3; unknown. |
| 04:43:18–04:45:57 | Candidate construction/submission. A new Workspace revision and Candidate followed the prior feedback. | Revisions 9–11, Materials `f5f…`, `4da…`, Candidate `4da…`; route change is visible only as changed artifacts, not strategy. | Judge. | Observation sequences 6445–6448; high. |
| 04:45:57–04:55:51 | Candidate checking/feedback. Four FAIL checks were applied; Root read 8 and 9 Materials across the phase. | Material `393…`, `2ce…`, revisions 12–13; feedback reads occurred. | Continue construction; no verified route improvement. | Observation sequences 6501, 6503–6506; high. |
| 04:55:51–04:56:01 | Evidence gap. | None visible. | Unknown. | Generated window 6; unknown. |
| 04:56:01–04:59:53 | Candidate construction/submission after Material reads. | Revisions 18–19, Material `532…`, Candidate `149…`; no explicit strategy text. | Judge. | Observation sequences 6796–6799; high. |
| 04:59:53–05:09:51 | Candidate checking/feedback. Two FAIL checks were applied; Root read 21 Materials and created the second child during this broad phase. | Materials `150…`, `61f…`, `fd4…`; revision 20–21; child2 creation/claim around 05:06–05:07. | Child2 independent research plus Root feedback processing. | Observation sequences 6883, 6885–6888; high. |
| 05:09:51–05:09:55 | Evidence gap. | None visible. | Unknown. | Generated window 9; unknown. |
| 05:09:55–05:11:30 | Research/handoff review. Root read child/check evidence and later accepted child2's research Task. | Material read, revision 29, child2 reached `SATISFIED`. | Root resumes proof work. | Observation sequences 9157–9160; high. |
| 05:11:30–05:18:35 | Candidate construction and coordination. Root accepted child2, published evidence, entered a timer wait, then woke. | Review/accept, Material `4d4…`, revisions 30–31, wait/wake. | Continue Root; child3 became available near the end. | Observation sequences 9202, 9204–9206; high. |
| 05:18:35–05:28:32 | Candidate checking/feedback. Four FAIL checks were applied while Root created child3 and continued Workspace work. | Materials `278…`, `005…`, revisions 33+, child3 creation/claim; no PASS. | Child3 handoff and final Candidate attempt. | Observation sequences 10377–10378, 10736–10737; high. |
| 05:28:32–05:28:42 | Evidence gap. | None visible. | Unknown. | Generated window 13; unknown. |
| 05:28:42–05:29:26 | Final candidate construction/submission. | Revision 38, Candidate `dba…`, Material `dba…`. | Judge. | Observation sequences 11270–11273; high. |
| 05:29:26–05:29:31 | Final checker feedback and cleanup. One final FAIL was applied, then the timebox cleanup stopped the Root Execution. | Material `126…`; Execution terminal `FAILED`; Root Task remained `OPEN`. | Cleanup; dependent child Tasks remained waiting/open. | Observation sequences 11294, 11296–11299; high. |

**Interpretation.** The Root did process feedback and increase Workspace/Material
activity, but no visible metadata proves a mathematical route change. The
repeated `unsolved_goals` class is non-convergence evidence, not evidence that
the byte-identical Candidate was submitted repeatedly.

### Child Execution `780ec7cc-77ec-48d9-8cb2-8808fe2c8c23`

Task `af5c5300-d490-4922-83cc-3a65f55a97c1`, Core 2, one Session, separate
Workspace lineage, terminal state `WAITING(parent_review)`, no predecessor or
successor.

| Time (UTC) | Phase | Durable result and next state | Evidence/confidence |
|---|---|---|---|
| 04:35:02–04:38:09 | Research/handoff on the concrete proof-route child goal. | Revisions 1–3; published Material `0de…`; then requested `parent_review`, saved revision 4, released the Core. | Observation sequences 3754, 3756–3758, 5973–5976; high. |
| 04:38:09 onward | Silent waiting interval. | No later resume/rework was recorded before cleanup. Responsibility remained with the parent review condition. | Task/Execution state and wait records; high for waiting, unknown for hidden work. |

The handoff was published and the parent had a readable Material path, but this
child did not reach a recorded parent acceptance or rework loop.

### Child Execution `b25cc5fe-f6c0-4ecc-b06a-7a56c182881a`

Task `3bf727b6-b000-423c-a136-61063b1527ca`, Core 2, one Session, separate
Workspace lineage, terminal state `SUCCEEDED`, no predecessor or successor.

| Time (UTC) | Phase | Durable result and next state | Evidence/confidence |
|---|---|---|---|
| 05:06:44–05:09:09 | Research/handoff on the explicit five-point construction goal. | Revisions 1–3; published Material `fac…`; child remained independently bound to Core 2. | Observation sequence 7219 and Material sequence 8789; high. |
| 05:09:09–05:11:30 | Coordination/waiting and completion. | Revision 4; child became `SATISFIED`; Root later read the result and accepted the Task. | Observation sequences 8449, 9049, 9157–9160; high. |

This is the only complete decompose → claim → deliver → consume → review path
in the run. It demonstrates that child work and parent consumption work, but it
does not demonstrate parallel sibling exploration.

### Child Execution `fdc41fb8-c941-45d9-a9f9-f118e02c2e74`

Task `1c712cbd-208d-47d0-a492-e8dfe096680b`, Core 2, one Session, separate
Workspace lineage, terminal state `WAITING(parent_review)`, no predecessor or
successor.

| Time (UTC) | Phase | Durable result and next state | Evidence/confidence |
|---|---|---|---|
| 05:18:58–05:19:53 | Research/handoff on the Mathlib API construction goal. | Revisions 1–3; published Material `e331…`; claim contention was observed around the same child. | Observation sequences 9563, 10363, 10726; high. |
| 05:19:53 onward | Silent waiting interval. | Revision 4 and `parent_review` wait; no resume or parent acceptance before cleanup. | Observation sequence 10925 and state inventory; high for waiting, unknown for hidden work. |

## Coordination and collaboration loop

**Fact.** The loop `decompose → claim → independent work → deliver → consume →
review/resume` exists in the durable records. Root created three direct children
at separated times; Core 2 claimed them sequentially. Child1 and Child3
published Materials and waited for parent review. Child2 published a Material,
became satisfied, and was consumed/accepted by Root. This is a closed loop for
one child and one-way/waiting delivery for two children (`project.sqlite` Tasks,
Executions, Materials; `experiment-analysis.md`, Collaboration review).

**Interpretation.** The issue is not missing Task/Execution/Material identity
or an inability to create children. The frontier was narrow and late: no
interval had four independent eligible work units, only Cores 1 and 2 ever
carried bound Executions, and child creation was sequential. Competing
explanations are Agent decomposition timing, the problem's actual separability,
and provider retry/turn occupancy; the current evidence cannot assign the
cause to the scheduler.

**Validation condition.** Use a control task whose contract permits two
independent children, record both child creation times before either finishes,
and compare time-to-first-sibling, eligible-window duration, maximum bound
Executions, and parent-consumption latency.

## Candidate and Judge review

All 13 Candidates were submitted through a started checker and returned
source-level `FAIL / unsolved_goals`: `3ded…`, `500…`, `4da…`, `b801…`,
`c71…`, `4375…`, `149…`, `fd4…`, `e52…`, `005…`, `ba2…`, `04c…`, and
`dba…` (full IDs and CheckResult references are in
`experiment-analysis.md`, Candidate/Judge review). The checker lifecycle was
therefore `request accepted → checker started → source-level FAIL`, not a
pre-checker infrastructure failure.

| Candidate range | Visible change and feedback response | Semantic conclusion |
|---|---|---|
| `3ded…` → `500…` | Workspace revisions and Materials changed; first FAIL feedback was read. | No strategy metadata identifies whether the proof route changed. |
| `4da…` → `149…` | Several revisions and Material reads followed FAIL feedback; diagnostic class remained `unsolved_goals`. | Activity and artifact changes are real; mathematical route improvement is unknown. |
| `fd4…`, `e52…`, `005…`, `ba2…`, `04c…` | Later candidates followed further checks, reads, child creation, and handoffs; each remained source-level FAIL. | No exact duplicate can be established from the permitted evidence; no verified convergence occurred. |
| `dba…` | Final Workspace revision and Candidate were submitted immediately before cleanup; final FAIL followed. | Timebox truncation prevented a later route/parent review conclusion. |

`get_check_result`/`apply_check_result` and Material reads are visible, but a
read does not prove that the next Candidate used the feedback. This is the
correct evidence boundary for the route question.

## Coordination, execution, and tool-layer findings

- **Coordination:** Bridge calls completed; Task Service and router recorded
  quota conflicts and one invalid `parent_review` wait contract. Five claim
  conflicts affected the Root/child claim races. They are contention and retry
  waste, not state corruption. Validation: correlate a claim conflict with the
  immediately preceding queue snapshot and require a claimability change before
  retry.
- **Execution:** Pi Agent logs show repeated `terminated`/`auto_retry_start`
  sequences across the four Cores. Runtime logs show normal bind, wait, wake,
  and session configuration but no `runtime.session_failure`,
  `recovery_started`, or `recovery_exhausted`. Retry activity is confirmed;
  permanent Runtime capacity loss is not. Validation: record retry interval,
  Core availability, and recovery outcome as first-class Runtime events.
- **Tool:** The checker launched and produced valid source-level diagnostics;
  the one invalid `request_wait` was a recoverable Service contract error.
  There is no evidence in this run of a checker health failure. Provider retry
  latency is not causally measured because Runtime occupancy during Pi retry is
  absent.

## System efficiency and health

**Derived facts.** Four Cores were configured; maximum active bound-Core count
was 2, mean active bound-Core count was about 0.98, effective Agent-time
utilization was 0.2443, and the four-way eligible window was 0. `ready_work_ms`
was 256,314 ms and `ready_unassigned_ms` was 217,776 ms. The latter is computed
as `ready_count > idle_core_count`; it is not a direct measurement of a ready
Task waiting while a truly available Core was ignored.

**Interpretation.** The run shows serial degradation and a narrow task frontier,
but not a proven scheduler defect. Core 3/4 had Agent sessions and discovery or
retry activity without bound Executions, while Root created children only at
04:31, 05:06, and 05:18. A ready/idle latency metric is required before
claiming missed wakeups. The terminal Root failure and open/waiting Tasks are
consistent with timebox cleanup; they are a terminal-state reporting concern,
not mathematical failure.

## High-impact findings and next validation

1. **Narrow exploration frontier — confidence: medium.** Observed pattern:
   three children were created sequentially, only two bound Cores ran, and no
   four-way eligible interval existed. Affected entities: Root and all three
   child Executions. Impact: the run cannot measure sustained sibling
   exploration. Competing explanations: task separability, Agent strategy, and
   retry occupancy. Validate with a task that makes two independent children
   eligible before the first child completes.
2. **Retry visibility gap — confidence: high for retries, low for Runtime
   failure.** Observed pattern: repeated Pi `terminated` retries with no Runtime
   recovery event. Affected entities: all four Agent sessions/Cores. Impact:
   retry time cannot be separated from available capacity or claim latency.
   Competing explanation: normal provider transient handling. Validate with
   retry interval and Core-availability telemetry.
3. **Claim contention — confidence: high.** Observed pattern: five active-quota
   conflicts. Impact: wasted claim turns and noisy ready metrics. Alternative:
   expected same-Task race under quota one. Validate with queue snapshots and
   quota-aware backoff measurement.
4. **Feedback-loop non-convergence — confidence: medium.** Observed pattern:
   13 valid `unsolved_goals` results despite revisions and reads. Impact: no
   verified mathematical progress. Alternative: the problem may simply be
   difficult within one hour. Validate by comparing an independent-route run;
   do not impose a fixed “change route after N FAILs” prompt rule.
5. **Material causal effect is unknown — confidence: high.** Source Task and
   Execution links and reads exist, but downstream route impact is not encoded
   for every Material. Validate by linking a consumed Material to the next
   Task/Workspace/Candidate change.

## Rubric score

| Dimension | Score | Reason |
|---|---:|---|
| Coordination | 2/2 | Task/Execution/Material identities, claim conflicts, and one closed handoff loop are evidenced. |
| Execution | 2/2 | All four durable Executions have bounded phases, waits, wake/reuse, and terminal states. |
| Tool | 1/2 | Checker lifecycle and Service errors are classified; retry occupancy and provider error causality are incomplete. |
| Efficiency | 2/2 | Runtime occupancy, eligible supply, ready metrics, contention, and competing scheduler explanations are separated. |
| Candidate semantics | 1/2 | Candidate-by-Candidate feedback/status is complete, but visible strategy metadata is insufficient for strong route claims. |
| Evidence discipline | 2/2 | Stable IDs, source paths, uncertainty, and alternatives are stated. |
| **Total** | **10/12** | **Semantically useful; Tool and Candidate dimensions remain evidence-limited.** |

The score is above the 9/12 diagnostic-only threshold. Conclusions about
semantic route changes, retry-caused capacity loss, and Material usefulness
remain explicitly `unknown` where the evidence cannot support them.
