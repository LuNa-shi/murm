# Issue #34: Runtime Reliability Fixes and Swarm Execution Model v2

Status: proposed implementation spec
Issue: [#34](https://github.com/LuNa-shi/SwarmEnv/issues/34)
Evidence: [8-hour execution analysis](https://github.com/LuNa-shi/SwarmEnv/blob/codex/issue-33-long-run-putnam-8h-20261022/docs/issue-33-long-run-execution-analysis.md), [sanitized B1 evidence](https://github.com/LuNa-shi/SwarmEnv/tree/codex/issue-33-long-run-putnam-8h-20261022/docs/evidence/putnam_2025_b1)

## Problem Statement

The current MVP can persist Tasks, lease Executions, release Core capacity while
waiting, publish Materials, run Judge checks, and resume a waiting Execution.
The completed 8-hour experiments show that these protocol paths are not yet a
reliable long-running research system.

Three failures are already evidenced by Issue #34:

1. In the final B1 interval, the resumed Agent Session hit termination, 502,
   length termination, and context-window overflow. No further Service call was
   made, but the Execution remained RUNNING until cleanup. Heartbeat proved that
   the lease was alive, not that an Agent could still make progress.
2. B1 generated an initial pair of parallel children and then reverted to a
   serial pattern of child completion, parent review, and the next child
   creation. The shared queue became empty even though four Core slots existed.
3. B4 and 2024 B4 produced repeated Judge failures and accepted child work
   without evidence that the route changed or that the result improved the
   global proof trajectory.

These are two different classes of work:

- **Fixes** restore correctness and observability for behavior the existing MVP
  already promises. They must be completed before another long run.
- **Features** change the collaboration model from a Root-centered parent-child
  workflow into a shared Dynamic Task Flow around one Global Goal. They must be
  introduced behind an explicit Swarm mode and evaluated with a short canary
  before any 1-hour or 8-hour run.

The target outcome is a system in which a physical Core is reusable capacity,
an Agent Session is replaceable, an Execution is a durable attempt, a Task is a
responsibility, a research route is an evolving plan, and a Global Goal is the
shared objective. No one of these identities should be required to remain
permanently bound to another.

## Solution

Deliver the work in three gated stages.

### Stage 1: Runtime and evidence fixes

Make a RUNNING Execution mean that a live Agent process is capable of
progressing. Record lease health, process health, completed turns, successful
Service calls, and goal-relevant progress separately. Detect context overflow,
process termination, repeated model failures, and no-response turns. Stop and
fence the failed session, release the Core, and recover from the last durable
checkpoint in a fresh session when the retry policy permits it.

Add bounded stagnation and repeated-route diagnostics. A legitimate WAITING
Execution must retain a concrete wait condition and wake normally. An empty
queue must remain IDLE or bounded backoff; it must not be treated as semantic
WAITING.

Complete ready-unassigned reason classification and progress-chain evidence so
the next report can distinguish missing work supply from dispatch, claim,
wake, long-turn, and failed-session delays.

### Stage 2: Four-exploration Swarm MVP

Add one Global Goal for the experiment and create four initial Exploration
Tasks with configurable route hints. They share one Dynamic Task Flow and one
Context Service. Any available Core may claim any claimable Task. An
Exploration Task may continue, wait, publish, create more work, or finish
without reserving a Core or requiring its creator to review every result.

Keep parent_id as creation provenance. Scheduling, claiming, Material
consumption, and integration must use the Global Goal and explicit dependency
relations rather than treating the parent-child tree as the complete
collaboration graph.

### Stage 3: Context-driven collaboration

Give Materials a structured, reusable contract and record which Tasks consume
which Materials. Publish events for new and superseded Materials. Explicit
Task or Material dependencies can wake a waiting Task or make an OPEN Task
claimable. The infrastructure delivers the update and records whether it was
consumed; the Agent decides whether the update changes its route.

Only after these paths pass deterministic and short real-agent fixtures should
the project compare single-agent, independent-parallel, current Root-child,
and four-exploration Swarm runs under equal model and total-token budgets.

## Domain Model

The following vocabulary is normative for this Issue.

| Concept | Meaning | Ownership and lifecycle |
| --- | --- | --- |
| Global Goal | The shared experiment objective and completion contract, such as proving one PutnamBench problem. | Owned by the experiment. It has no required long-lived Agent owner. |
| Research Route | A current hypothesis about how a Task contributes to the Global Goal, including subgoals, assumptions, known failures, and the next planned change. | Durable route metadata or Material. It can be replaced or retired without replacing the Global Goal. |
| Task | A durable responsibility with a goal, expected output, acceptance conditions, and completion contract. | Owned by Task Service. A Task can be claimed by different Executions over time. |
| Exploration Task | A Task intended to maintain one initial or discovered research direction. | Uses the same Task Service and queue as all other Tasks. It is not a permanent Root Agent. |
| Execution | One leased attempt to perform a Task. | Owns fencing, checkpoint, Workspace lineage, and recovery disposition. It is replaceable. |
| Agent Session | One model process/session that performs turns for an Execution. | Owned by Runtime and replaceable after failure or context overflow. |
| Core slot | Reusable physical or logical capacity for one active Agent process. | Owned by Runtime. It has no permanent Task or Agent identity. |
| Material | Immutable shared evidence, feedback, artifact, route description, or claim. | Owned by Context Service with source Task and Execution provenance. |
| CheckResult | A Judge result for a candidate under a Workspace snapshot and checker environment. | Owned by Judge Service and linked to the candidate and route evidence. |
| Dynamic Task Flow | The claimable work projection for a Global Goal, including Tasks, explicit dependencies, notifications, and recovery opportunities. | Owned by Task Service and Runtime projections. |

Existing vocabulary remains valid with two clarifications:

- The repository's persisted Task states remain the authoritative lifecycle
  states. READY is a derived claimability projection: an OPEN Task whose
  dependencies, quota, and recovery policy permit a claim. This preserves the
  existing distinction between WAITING and BLOCKED.
- The first reliability implementation does not add a persisted RECOVERABLE
  Execution state. It records failure class and recovery disposition, fences or
  fails the unusable Execution, releases its Core, and creates a fresh
  resumable attempt from the checkpoint when eligible. A report may project
  this as recoverable.

## Work Classification

### Fixes: correctness and evidence defects

| ID | Fix | Current defect | Required behavior | Primary acceptance evidence |
| --- | --- | --- | --- | --- |
| FIX-01 | Session health and stale RUNNING recovery | A dead or unusable Agent Session can leave its Execution RUNNING while heartbeat continues. | Runtime records process/session health separately from lease heartbeat. A terminated, context-overflowed, repeatedly failing, or watchdog-stalled session is stopped and fenced or failed; the old session cannot make later Service calls. | A fake Agent that emits overflow and then remains heartbeat-alive leaves no stale RUNNING Execution and no occupied Core after the recovery decision. |
| FIX-02 | Durable fresh-session recovery | Retrying the same overflowed Session can repeat the same failure and lose the long-run budget. | The latest durable checkpoint, Workspace revision, input Material snapshot, route summary, and failure class are sufficient to start a new Session. Recovery is bounded by policy and uses a new session/runtime generation. | A fixture resumes from the checkpoint in a fresh Session, preserves Workspace and fencing lineage, and records the old Session as terminated. |
| FIX-03 | Productive health telemetry | Heartbeat is currently easy to misread as Agent progress. | Record last heartbeat, last process signal, last completed turn, last successful Service call, last Workspace/Material/Judge/Task fact, last goal-progress fact, consecutive model failures, and last failure class. | A report shows healthy lease plus failed Session as a distinct condition, and each timestamp can be traced to an append-only event. |
| FIX-04 | Runtime watchdog and Core release | A no-response Agent can hold a Core until the experiment deadline. | A watchdog uses configurable thresholds and only acts on an active RUNNING process with no qualifying turn or Service progress. It stops the process, records a typed diagnosis, releases capacity, and follows recovery or bounded-stop policy. | A no-response fixture releases capacity within the configured watchdog bound; a normal long turn and a concrete WAITING condition are not falsely stopped. |
| FIX-05 | Stagnation and bounded tail | A run can remain valid but make no root-relevant progress for hours. | Record typed stagnation windows and the last Root/Goal progress time. After a configured window, emit a next action: route review, fresh exploration opportunity, recovery, or bounded stop. Do not turn an empty queue into WAITING. | The analysis report contains 15-minute, 1-hour, 4-hour, and 8-hour checkpoints and a recomputable no-progress tail duration. |
| FIX-06 | Repeated-failure diagnosis | Rework can repeat the same candidate snapshot and route after Judge FAIL. | Record candidate fingerprint, Workspace snapshot, route fingerprint, diagnostic class, and the intended route change for each attempt. A repeated fingerprint requires a route change or bounded stop; a similar error with a different route remains eligible. | The B4-shaped fixture cannot execute the same route indefinitely and reports why it changed route or stopped. |
| FIX-07 | Ready-unassigned cause accounting | Existing ready-unassigned time cannot distinguish missing decomposition from scheduler delay. | Every interval with claimable work and no assignment has one mutually exclusive cause: discovery latency, Agent turn occupancy, dispatch capacity, wake delay, claim conflict, or insufficient decomposition. Coverage must be complete and recomputable. | Category durations sum to the measured ready-unassigned interval; coverage is 1 for deterministic fixtures. |
| FIX-08 | Delivery-to-goal progress evidence | Child SATISFIED and parent ACCEPTED do not show whether the Global Goal improved. | Record delivery, Material publication, explicit consumption, downstream action, Judge effect, and Goal progress as separate facts. Do not count acceptance alone as goal progress. | A fixture can show accepted but unused work, consumed work that changes a candidate, and a Material that enters a verified dependency chain. |

FIX-01 through FIX-05 are P0/P1 runtime reliability work and must gate long
experiments. FIX-06 through FIX-08 are evidence and control-flow correctness
work and must gate claims about collaboration quality.

### Features: new Swarm execution behavior

| ID | Feature | New behavior | Required acceptance evidence |
| --- | --- | --- | --- |
| FEAT-01 | Global Goal and Exploration initialization | An experiment creates one Global Goal and four configurable Exploration Tasks. Route hints are Direct Proof, Equivalent Reformulation, Lemma/Literature Search, and Alternative Strategy/Counterexample Analysis by default, but are data, not hard-coded roles. | A deterministic initialization fixture creates four claimable Tasks with one goal, distinct route hints, bounded contracts, and no permanent Core ownership. |
| FEAT-02 | Shared Dynamic Task Flow | All claimable Tasks for a Global Goal are visible through one goal-scoped queue. Any Core can explicitly claim any eligible Task. A Task creator does not receive a scheduling or review privilege. | Four fake Agents claim four explorations concurrently; a later Task created by one exploration is claimable by a different Core while the creator is waiting or finished. |
| FEAT-03 | Separate provenance from collaboration edges | parent_id remains the origin/provenance edge. Add explicit dependency and relation records for depends_on and related_to. Task claims do not require a parent review unless the Task contract explicitly requests legacy parent review. | A Task created by A can be claimed and consumed by B, and a dependency edge can block or wake work without requiring A's Session to remain alive. |
| FEAT-04 | Structured reusable Materials | Key Materials can declare claim, assumptions, evidence references, dependency references, applicability, and evidence state. Proposed claims are visible to Agents but cannot satisfy a checked completion contract without the required evidence. | Context tests preserve immutability, provenance, and evidence state; a proposed lemma can be read and cited but cannot be treated as a checked fact by the completion contract. |
| FEAT-05 | Explicit Material consumption | An Agent records which Material it used and in which Task/Execution action. Candidate submission and route updates can reference consumed Materials. | Reports distinguish read, explicit consume, candidate use, and verified dependency-chain use. Cross-task reuse is counted only from durable records. |
| FEAT-06 | Context-driven notification and wake | Material publication or supersession emits a durable update. Tasks with explicit matching dependencies receive an update and can re-enter the claimable projection or wake from a matching wait. Unrelated Tasks are not woken. | A waiting dependent Task receives one idempotent update and becomes claimable after the dependency event; the same event does not wake an unrelated Task. |
| FEAT-07 | Limited reorganization controls | Agents can create bounded Tasks, retire an obsolete route, reprioritize an OPEN Task, and propose a replacement relation. Mutations are versioned, fenced, idempotent, and auditable. Arbitrary concurrent graph rewriting is out of scope. | Conflict and stale-version fixtures reject unsafe updates; a route retirement releases or cancels only the intended responsibility and preserves provenance. |
| FEAT-08 | Swarm observability and comparison harness | Reports expose task supply, claims, cross-task reuse, route changes, wake causes, Goal progress, Core utilization, and total token/wall-clock cost. | A 20–30 minute canary produces a sanitized report for the Swarm variant and the same report shape for the three baselines. |

## Implementation Plan

### Phase 0: freeze the evidence contract

1. Add deterministic fixtures for the three observed failure shapes: dead
   Session with live heartbeat, context overflow after a checkpoint, and
   repeated Judge FAIL with no route change.
2. Define the event vocabulary and report fields before changing scheduler
   behavior. Events must be append-only, correlated with Experiment, Core,
   Agent Session, Task, and Execution where known, and safe for sanitized
   output.
3. Document the thresholds and retry policy as configuration. A default must
   exist for tests, while real runs must record the actual values.

Exit gate: the existing lifecycle, wait, wake, fence, workspace, Judge, and
report tests remain green, and each new failure fixture fails for the reason
that the corresponding Fix is intended to address.

### Phase 1: implement FIX-01 through FIX-08

1. Extend Runtime and the Agent adapter boundary with Session lifecycle,
   completed-turn, Service-call, model-failure, and process-exit signals.
2. Persist health and recovery facts without putting raw transcripts,
   credentials, candidate source, or proof contents into sanitized reports.
3. Add the watchdog as a Runtime-owned policy. It must fence the old
   Execution before a replacement can use the Workspace, and all late writes
   from the old fencing version must be rejected.
4. Reuse the existing checkpoint and Workspace lineage for fresh-session
   recovery. Build a compact recovery prompt from structured state and
   redacted failure metadata; do not replay an unbounded conversation.
5. Add repeated-route and stagnation decisions as typed facts. A diagnostic
   observation alone does not force a route change; the decision must use the
   recorded route and input fingerprints.
6. Complete ready-unassigned and delivery-to-goal accounting in the report
   projection. Make every duration and counter derivable from state intervals
   or Service events.

Exit gate: all FIX acceptance evidence passes, no healthy WAITING/wake path is
regressed, and a short fake-agent run reaches cleanup with zero stale RUNNING
Executions.

### Phase 2: implement FEAT-01 through FEAT-03

1. Introduce a Global Goal record or equivalent durable goal projection for a
   Swarm experiment. Preserve the legacy root Task and root_id query shape as
   a compatibility projection during migration.
2. Associate Tasks with the Global Goal. Keep parent_id as provenance only for
   Swarm scheduling. Existing parent-review contracts continue to work for
   legacy Tasks.
3. Add four initial Exploration Tasks through one initialization operation.
   Their route hints, priorities, contracts, and parallel quotas are
   configurable and recorded in the experiment report.
4. Add goal-scoped Task listing and claim filtering. Preserve explicit claim
   and idempotency semantics. A Core is released at wait, terminal outcome,
   fence, or recovery and can claim another Task.
5. Add versioned dependency and relation records. Dependency satisfaction is
   evaluated by Task Service; mathematical relevance remains an Agent
   decision unless an explicit Material reference says otherwise.

Exit gate: the four-exploration fake-agent fixture shows simultaneous
claiming, waiting, release, cross-route claiming, and no mandatory
creator-to-child review chain.

### Phase 3: implement FEAT-04 through FEAT-07

1. Extend Context Service's immutable Material record with structured
   collaboration metadata and strict validation for Swarm mode.
2. Add explicit consume and action references. A read alone is not a consume;
   the Agent must record that a Material informed a route, Task, candidate, or
   integration action.
3. Emit idempotent Context update events and connect them to explicit Task
   dependency subscriptions. The first implementation must not infer
   mathematical relevance from arbitrary text.
4. Add bounded Task/route reorganization operations with state version,
   fencing, authorization, and audit records.
5. Add an integration Task contract for weaving verified Materials into a
   Goal-level candidate. It may be claimed by any Core and does not belong to
   one fixed Root Session.

Exit gate: a two-route fixture publishes a proposed lemma, a second route
consumes it, a dependent Task wakes, the resulting candidate records the
dependency, and the report shows the chain from publication to Goal progress.

### Phase 4: short controlled experiments

Run the same problem, model, provider, tool contract, total Agent token
budget, and Judge configuration in four variants:

| Variant | Description |
| --- | --- |
| A | One Agent with the full time/token budget. |
| B | Four independent Agents with no shared Task Flow or Context. |
| C | Existing Root-child MVP, with its current shared Material behavior. |
| D | Four-exploration Swarm MVP with shared Dynamic Task Flow and explicit Material consumption. |

Start with a 20–30 minute canary. Run a 1-hour comparison only if every
variant is protocol-valid and the Swarm canary demonstrates actual
cross-task activity. Defer another 8-hour run until the canary and 1-hour
reports show no stale RUNNING Execution and no unexplained long tail.

## User Stories

1. As an experiment operator, I want a failed Agent Session to stop occupying
   a Core, so that a dead process cannot consume the experiment deadline.
2. As an experiment operator, I want lease heartbeat and productive Agent
   activity reported separately, so that I can tell infrastructure liveness
   from research progress.
3. As a Runtime, I want to recognize context-window overflow as a typed
   failure, so that retry policy can create a fresh Session instead of
   replaying an unusable one.
4. As an Agent, I want my latest durable checkpoint and Workspace revision
   restored into a fresh Session, so that a recoverable failure does not erase
   the research responsibility.
5. As a Runtime, I want old fencing versions rejected after recovery, so that
   late calls from a terminated Session cannot corrupt the new attempt.
6. As an experiment operator, I want a watchdog diagnosis for a no-response
   Agent, so that a heartbeat-only stall becomes an actionable recovery or
   stop decision.
7. As an Agent, I want a concrete WAITING condition to preserve ownership
   without holding a process, so that valid dependency waits are not confused
   with a failed Session.
8. As an experiment operator, I want stagnation checkpoints at fixed elapsed
   times, so that a long run exposes when meaningful progress stopped.
9. As an Agent, I want repeated Judge failures tied to route and snapshot
   fingerprints, so that I can change a research route rather than repeat the
   same attempt.
10. As an experiment operator, I want ready-unassigned time classified by
    cause, so that low utilization can be attributed to work supply,
    scheduling, conflict, or Agent behavior.
11. As a Goal owner, I want delivery, consumption, downstream action, and
    Goal progress recorded separately, so that accepted local work is not
    mistaken for global proof progress.
12. As an experiment operator, I want one Global Goal for a problem, so that
    multiple research directions can contribute to one completion contract.
13. As an Agent, I want an initial Exploration Task with a route hint, so that
    four Cores can begin different lines of inquiry without permanent Agent
    roles.
14. As a Core scheduler, I want all claimable Tasks for a Goal in one queue,
    so that any reusable Core can continue work discovered by any other Core.
15. As an Exploration Agent, I want to create a bounded Task without reserving
    a child Core, so that discovered work becomes a shared opportunity.
16. As a waiting Agent, I want my Core released while my Task remains
    resumable, so that other Tasks can use the capacity.
17. As an Agent, I want parent_id to tell me who proposed a Task without
    forcing parent review, so that provenance and collaboration remain
    separate.
18. As an Agent, I want to declare a Task dependency, so that the Runtime can
    wake or expose work when the dependency becomes available.
19. As an Agent, I want to publish a Material with claim, assumptions,
    evidence, and applicability, so that another route can reuse it safely.
20. As an Agent, I want to read a proposed Material without treating it as
    checked fact, so that exploration can proceed without weakening Judge
    acceptance.
21. As an Agent, I want to record explicit Material consumption, so that the
    system can measure real cross-task reuse rather than mere publication.
22. As a Context Service, I want Material publication to emit an idempotent
    update, so that dependent Tasks can reevaluate without polling every
    Material blindly.
23. As an Agent, I want a new Material update delivered to my waiting Task,
    so that I can decide whether to continue, change route, or stop.
24. As a Task Service, I want stale or conflicting reorganization requests
    rejected, so that several Agents cannot silently overwrite one another's
    route decisions.
25. As an experiment operator, I want to compare single-agent, independent
    parallel, Root-child, and Swarm variants under equal budgets, so that
    higher activity is not confused with better collaboration.
26. As a researcher, I want sanitized reports to expose reuse, route changes,
    Goal progress, and Core utilization without raw transcripts or proof
    contents, so that results remain auditable and safe to publish.

## Implementation Decisions

- Preserve the existing Service boundaries: Task Service owns Task and
  Execution transitions, Context Service owns immutable Materials, Runtime
  owns process capacity and fencing, Workspace Manager owns revisions and
  checkpoints, and Judge Service owns independent checks.
- Preserve explicit claim, operation idempotency, state versions, fencing
  versions, and durable checkpoint requirements.
- Keep parent-child behavior as a compatibility mode. A legacy child with a
  parent_review completion contract still waits for and is reviewed by its
  parent. Swarm Tasks use contracts that permit shared claiming and
  integration.
- Do not add a second independent persisted Task state axis just to represent
  READY. Claimability is a projection of OPEN state, dependency facts,
  execution quota, and recovery policy.
- Do not make a physical Core, Agent Session, or Execution the owner of a
  Global Goal. A Core can host many Executions over time, and an Execution can
  be resumed by another Core and Session.
- Do not use automatic text similarity as the first Material dependency
  mechanism. Initial notifications require explicit Task or Material
  references; semantic relevance is recorded by the Agent.
- Do not let a Material's proposed evidence state satisfy a checked Task
  contract. Judge evidence and completion contracts remain authoritative.
- Recovery must be bounded. Each failure records its class, retry number,
  checkpoint reference, Session identity, and final disposition. Exhausted
  recovery produces a clear stop/failed fact and releases the Core.
- Route change is an auditable decision. The route fingerprint, failure
  diagnosis, next change, and resulting input snapshot are recorded. Similar
  diagnostics alone are insufficient to declare duplicate research.
- Reports are derived from Runtime state intervals and Service events. LLM
  summaries can be explanatory Material but cannot define utilization,
  protocol validity, or Goal progress metrics.
- A Global Goal migration must retain legacy root_id and root Task query
  compatibility until all existing fixtures and reports use goal-scoped
  queries.

## Testing Decisions

Tests will assert externally visible lifecycle, scheduling, collaboration, and
report behavior. They will not assert private helper calls or a particular
database query shape.

1. **Runtime recovery seam.** Use the existing Runtime plus fake Agent adapter
   boundary to simulate normal turns, process exit, context overflow, repeated
   provider failure, and heartbeat-only stalls. Assert Core release, fencing,
   checkpoint reuse, fresh-session start, and bounded terminal disposition.
2. **Task lifecycle seam.** Use Task Service through Services SDK operations to
   assert claim, wait, wake, recovery, stale-version rejection, dependency
   readiness, and legacy parent review. This extends the existing task-flow and
   concurrency fixtures.
3. **Context seam.** Use Context Service through the SDK to assert immutable
   structured Materials, evidence states, provenance, explicit consumption, and
   idempotent update events. This extends the existing Context Service tests.
4. **End-to-end benchmark seam.** Use the existing benchmark fixture and
   report validator to assert that failure fixtures and Swarm fixtures produce
   sanitized, recomputable evidence. This is the highest seam for lifecycle
   interaction and should be preferred over duplicating lower-level tests.
5. **Real-agent seam.** After deterministic tests pass, run a short real Agent
   canary with recorded provider/model route, commit, timebox, fixture, and
   report path. Do not use an 8-hour run as the first validation of a new
   lifecycle.

Required checks for each implementation PR are the focused lifecycle tests,
the full npm test suite, and git diff --check. A benchmark PR also requires a
clean worktree and a sanitized report. Raw Agent transcripts, proof contents,
credentials, and unredacted experiment state remain local.

## Acceptance Criteria

Issue #34 is ready for implementation only when the following are explicit:

### Fix acceptance

- A context-overflow or terminated Session cannot leave a Core occupied with a
  RUNNING Execution past the watchdog decision.
- A replacement Session starts from a durable checkpoint and the old fencing
  version cannot write.
- Heartbeat-only liveness is reported separately from completed turns,
  successful Service calls, and Goal-relevant progress.
- Normal WAITING with a typed condition still releases capacity and wakes
  correctly; an empty queue is not reported as semantic WAITING.
- Stagnation and repeated-route fixtures produce a typed next action and
  bounded behavior.
- Ready-unassigned classification has complete coverage and category totals
  are recomputable from the event/state interval evidence.
- Reports distinguish accepted delivery from explicit cross-task consumption
  and Goal progress.

### Feature acceptance

- A Swarm experiment creates one Global Goal and four configurable
  Exploration Tasks, and four reusable Cores can claim them without
  permanent Task/Core binding.
- A Task created by one Exploration can be claimed by another Core while the
  creator is waiting or terminated.
- parent_id remains provenance; shared claiming and dependency wake do not
  require the originating parent Session.
- A structured proposed Material can be read and cited but cannot satisfy a
  checked completion contract without valid Judge evidence.
- A dependent Task receives one durable Context update, can become claimable or
  resume, and the report records whether the Material was explicitly consumed.
- Versioned route/task reorganization rejects stale concurrent writes and
  preserves all provenance.
- A short Swarm canary demonstrates at least one cross-task Material
  consumption and one non-parent-created claim before the 1-hour comparison is
  allowed.

### Experiment acceptance

- Variants A–D use the same problem, model/provider route, tool contract,
  Judge, total Agent token budget, and report schema.
- The first run is a 20–30 minute canary. A 1-hour run requires all canaries
  to be protocol-valid and the Swarm path to show actual cross-task activity.
- Results report both wall-clock time and total compute/token cost, plus
  useful Core utilization, ready-unassigned causes, route changes, Material
  reuse, Goal progress, and valid-run rate.
- A new 8-hour run is deferred unless the short runs show no stale RUNNING
  tail and no unresolved recovery or accounting gaps.

## Out of Scope

- Automatic theorem proving, automatic semantic matching of arbitrary Material
  text, or a general knowledge graph.
- Unrestricted concurrent rewriting of an arbitrary Task graph.
- Removing the existing parent-child tree or breaking legacy parent review.
- Changing Judge soundness, Lean checker semantics, or the mathematical
  quality of the selected model.
- Claiming that four active Cores alone prove Swarm behavior.
- Tuning model/provider selection, prompt quality, or token pricing as part of
  the lifecycle fixes.
- Publishing raw transcripts, proof contents, candidate source, credentials,
  or unredacted experiment state.
- Repeating another 8-hour experiment before the fix and canary gates pass.

## Further Notes

This plan deliberately separates the safety loop from the research-model loop.
The first loop answers whether Runtime can tell when an Agent can no longer
work and recover without wasting the lease. The second answers whether
multiple Agents can create, find, consume, and reorganize work around one
objective.

The existing strict-tree ADR is a valid MVP decision and should not be
silently rewritten by implementation. The Swarm mode is a new scheduling
contract. Its implementation should add an ADR describing why Global Goal,
provenance edges, dependency edges, and reusable Core capacity are separate,
and should update CONTEXT.md only when the new terms are implemented rather
than merely proposed.

The first useful proof that this is a Swarm is behavioral: a Material produced
by one Exploration must change another Task's available work or next action,
and that downstream action must be visible in the Goal-level evidence chain.
Parallel process count is a capacity metric; it is not the collaboration
acceptance criterion.
