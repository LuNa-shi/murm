## Problem Statement

The current SwarmEnv runtime mixes Task readiness, Execution ownership, Core
capacity, and Agent-session lifecycle. The existing Scheduler starts unbound
Agent sessions, the Agent claims work, Runtime binds the claim, and Task
Service still supports Execution `WAITING`, wake/resume, and parent review.
Those paths overlap enough that an operator cannot reliably answer:

- which component is allowed to choose work;
- whether a Core is actually occupied;
- whether a blocked Task still owns an Execution;
- whether a Session restart is the same attempt or a new attempt;
- whether child results were consumed by another Execution;
- why an apparently idle Core did not start useful work.

The system also allows Task creation to grow faster than execution. Admission
limits are necessary, but they are a protection at the Task Service boundary,
not the central architecture. The main problem is the orchestration model and
the missing behavioral contract between Runtime, Task Controller, Core Daemon,
Task Service, Execution, Session, and Core.

## Solution

Simplify the runtime around two orchestration roles and two supporting
boundaries.

1. **Task Controller** is one deterministic reconciliation loop. It evaluates
   dependency conditions, maintains Task claimability, observes Core Daemon
   health, and signals idle Daemons. It never ranks Tasks and never claims
   work.
2. **Core Daemon** is one long-lived supervisor per Core. When its Core is
   idle, it obtains a bounded claimable shortlist, starts a stateless
   selection turn, lets its Agent choose a Task by value and Context, calls
   `claim(task_id)`, and hands the resulting Execution to Runtime. After the
   Execution ends, the Daemon returns to discovery.

Task Service remains the durable authority for Task, Execution, dependency,
lease, fencing, Workspace lineage, and admission facts. Runtime is the
execution substrate invoked by a Daemon: it materializes Workspace, starts and
supervises a Task Session, handles heartbeat/fencing/recovery, and releases
the Core. Runtime does not choose Tasks.

An Execution is one attempt for one Task and remains bound to one Core for its
lifetime. A Session is a process incarnation inside that Execution. A Session
may be restarted on the same Core while retaining the Execution identity. If
the Task is released, the Core is lost, or the Task is claimed again later, a
new Execution identity is created.

A blocked Task has no active Execution and consumes no Core. The Execution
that declares a real dependency ends after saving its useful Workspace and
Materials. The Controller reopens the Task when its conditions are satisfied.
Child Tasks validate their own contracts and become `DONE`; parent review is
not a completion gate.

## User Stories

1. As an operator, I want one clear component to decide Task value, so that
   Controller and Runtime cannot make competing scheduling decisions.

2. As an operator, I want Task Controller to reconcile dependencies and health
   deterministically, so that state recovery does not depend on an LLM.

3. As an operator, I want each Core to have one long-lived Core Daemon, so
   that Core capacity remains reusable across many Executions.

4. As a Core Daemon, I want to receive a bounded claimable shortlist, so that
   the selection Agent can reason about current work without scanning an
   unbounded queue.

5. As an active selection Agent, I want to choose one Task from the returned
   shortlist, so that task value is decided with current Context rather than
   by a fixed central ranking policy.

6. As a Core Daemon, I want claim to be the concurrency boundary, so that
   multiple Daemons can inspect the same queue without creating two owners.

7. As a Core Daemon, I want a lost claim race to produce a structured
   conflict and a bounded rescan, so that contention does not become a
   protocol failure or an infinite retry loop.

8. As a Runtime, I want to receive an already claimed Execution, so that I
   can focus on process, Workspace, lease, and evidence management.

9. As an Execution, I want one Task and one Core binding for my lifetime, so
   that a later attempt cannot be mistaken for a relocation of the same
   attempt.

10. As a Runtime, I want a Session restart on the same Core to retain the
    Execution identity, so that provider or process recovery does not create
    duplicate Task attempts.

11. As an operator, I want a lost Core or released Task to create a new
    Execution on a later claim, so that ownership history remains truthful.

12. As a Core, I want to return to `IDLE` immediately after an Execution
    completes, blocks, fails, or is canceled, so that capacity can be reused.

13. As a Task owner, I want a `BLOCKED` Task to have no active Execution, so
    that dependency time is not reported as occupied Core time.

14. As a Task Controller, I want dependency completion to reopen a Task
    idempotently, so that a restart or duplicate event cannot create repeated
    state transitions.

15. As a Task Controller, I want to react to dependency events and perform a
    periodic repair sweep, so that both low latency and missed-event recovery
    are supported.

16. As an Agent, I want to create a child only for a genuinely separate
    responsibility, so that decomposition produces useful collaboration
    rather than queue noise.

17. As a child Task, I want to self-validate against my own acceptance
    condition, so that reaching `DONE` does not require a hidden parent
    approval protocol.

18. As a parent Task, I want to consume child Materials and evidence through
    explicit records, so that parent-child structure does not create implicit
    ownership of child execution.

19. As an operator, I want to see which Execution created each child and
    which later Execution consumed its result, so that collaboration is
    auditable.

20. As an Agent, I want Task creation to return typed backpressure when
    capacity is exhausted, so that I can continue existing work or declare a
    real dependency instead of blindly retrying.

21. As a Task Service, I want bounded Root and Execution admission, so that
    Task production cannot indefinitely outrun execution.

22. As an operator, I want older eligible Tasks to receive a protected
    fairness opportunity, so that newly created children cannot starve old
    work forever.

23. As an Agent, I want the initial prompt to teach the ordered
    `list_tasks -> select task_id -> claim(task_id)` protocol, so that the
    selection turn does not guess IDs or issue concurrent claims.

24. As a Task Session, I want to work only through the claimed Task and its
    registered Services, so that Workspace and Material provenance remains
    enforceable.

25. As an operator, I want Core occupancy, Execution attempts, Task states,
    Session restarts, and dependency events reported separately, so that
    utilization cannot hide lifecycle errors.

26. As a benchmark operator, I want a per-Execution narrative containing its
    goal, actions, outputs, dependencies, and terminal reason, so that I can
    inspect what the Agent actually did.

27. As a benchmark operator, I want the same semantic parallel experiment to
    run against one clean implementation commit, so that architectural
    improvements are compared on identical protocol and fixture conditions.

28. As a maintainer, I want deterministic lifecycle tests before real-Agent
    testing, so that a two-hour run exercises a validated orchestration
    contract.

## Implementation Decisions

- **Task Service remains the durable authority.** It owns Task and Execution
  state, leases, fencing, dependency relations, Workspace lineage references,
  admission counters, and idempotency. Runtime and Daemon state must not
  become a second source of Task truth.

- **Task Controller is the only reconciliation role.** It watches Task
  events, dependency facts, admission capacity, and Daemon health. It can
  reopen a blocked Task, signal an idle Daemon, and request health recovery.
  It never selects a Task, creates an Execution by itself, or reviews Agent
  output.

- **Core Daemon is the only value-selection role.** There is one Daemon per
  reusable Core. It runs a discovery/selection/claim loop, but it does not
  retain durable responsibility for any Task. The durable result of selection
  is the Task claim and the resulting Execution.

- **Runtime is a per-Core execution substrate.** The Daemon invokes Runtime
  after a successful claim. Runtime starts a fresh Task Session, materializes
  the Workspace, sends the Execution prompt, supervises the process, handles
  heartbeat/fencing/recovery, and releases the Core. Runtime does not call
  the Task list to choose work.

- **Selection Session and Task Session are separate.** The selection Session
  receives only the bounded shortlist and the context required to choose one
  Task. It has no durable Task memory and ends after the claim succeeds or the
  selection attempt is abandoned. Runtime starts a fresh Task Session for the
  claimed Execution. This prevents selection context from leaking into Task
  execution.

- **One Core has at most one active Execution.** A Core may have many
  Executions over an Experiment, but never two simultaneously. Discovery and
  selection occupancy are reported separately from active Task work.

- **Execution identity is attempt identity.** An Execution keeps its
  `execution_id`, `task_id`, Workspace lineage, and Core binding across a
  Session restart on that Core. A new claim after release, fencing, or Core
  loss creates a new Execution identity. A Session generation/fencing change
  records process recovery without pretending that an Execution moved between
  Cores.

- **Task lifecycle is explicit.** The normal states are `OPEN`,
  `RUNNING`, `BLOCKED`, `DONE`, `CLOSED`, and `CANCELED`. `OPEN`
  is claimable, `RUNNING` has one active Execution, `BLOCKED` has an
  explicit unmet condition and no active Execution, and `DONE` means the
  Task's own acceptance contract is satisfied. `CLOSED` is optional
  administrative cleanup.

- **Execution release is a real boundary.** When an Execution declares an
  actual dependency, it saves useful Workspace and Materials, persists the
  typed condition, transitions the Task to `BLOCKED`, ends the Execution,
  releases the Core, and returns control to the Daemon loop. It does not
  leave a waiting Execution occupying logical ownership.

- **Controller reopening is idempotent.** Dependency-changing writes trigger
  reconciliation, and a periodic sweep repairs missed events. A Task becomes
  `OPEN` only when its dependency expression and current admission
  condition allow a claim. Reconciliation records the evidence and performs
  no duplicate transition on retry.

- **Active selection is bounded.** Task Service returns a bounded set of
  currently claimable Tasks. The set may include priority and aging
  information and must include protected old work. The Agent chooses within
  that set. Task Service does not perform an LLM ranking, and Controller does
  not preselect a Task.

- **Admission is deliberately small in the first implementation.** It
  enforces a Root unfinished-Task limit, a Root `OPEN` limit, a cumulative
  per-Execution child budget, a per-turn structural mutation limit, required
  goal/output/acceptance fields, and a stable responsibility key. The checks
  are atomic and idempotent. A rejected child returns a typed result and does
  not implicitly block or pause its parent.

- **Duplicate responsibility is rejected first.** A repeated responsibility
  key in one Root scope returns the existing Task identity. Automatic semantic
  merging is deferred because it would rewrite identity, dependencies,
  Workspace lineage, and evidence. Explicit rework uses a new responsibility
  key and provenance.

- **Aging protects eligible old work.** An OPEN Task records when it became
  claimable. After the configured threshold it enters a protected fairness
  floor. A younger claim cannot indefinitely bypass a protected Task. The
  exact numerical threshold is configuration, while the no-starvation
  invariant is part of the behavior contract.

- **Core occupancy has no semantic WAITING state.** The Core projection uses
  `IDLE`, discovery/selection, active Task work, and stopping. Task
  `BLOCKED` time is reported on the Task timeline, not as Core occupancy.
  Runtime and observability must not write a Core WAITING interval for a
  released Execution.

- **Execution and Task evidence are separate from selection evidence.**
  Selection records the candidate view, selected Task, claim result, and
  conflict if any. Execution records Workspace, Service, Material, checker,
  heartbeat, recovery, and terminal evidence. The report can therefore tell
  whether a bad result came from selection, execution, dependency handling,
  or external checker health.

- **Agent prompt is part of the runtime interface.** The selection prompt
  teaches bounded candidate choice, claim ordering, fairness, and conflict
  handling. The Task prompt teaches claimed-only reads, Service use, child
  contracts, evidence publication, and the conditions for `DONE`. It does
  not tell the Agent to use Task creation to fill a quota.

- **No standalone Scheduler component is introduced.** The words scheduler
  and monitor describe Controller behaviors. Fixed local Cores are started by
  the Runtime launcher or service manager. Controller observes their health
  and signals them; Daemons perform active Task selection.

- **Migration preserves old evidence.** Existing Execution `WAITING`,
  wake/resume, and parent-review records remain readable for analysis. New
  normal-flow writes use Task `BLOCKED`, an ended Execution, and Controller
  reconciliation. A migration report identifies records that cannot be
  projected without manual review.

- **Acceptance is behavioral.** A good implementation must show correct
  ownership, prompt claim handoff, Core reuse, child result consumption,
  bounded queue growth, fair claim behavior, and useful per-Execution
  progress. Mathematical solve success is a separate outcome.

- **Primary testing seam.** The highest seam is the public Task Service and
  Runtime lifecycle boundary: tests use claim, Task transitions, dependency
  writes, Session/Execution start and release, and observations. Internal
  helper counters or private scheduling calls are not acceptance contracts.

## Testing Decisions

- Tests assert externally visible state, ownership, events, and evidence
  rather than private implementation details.

- Task Service tests will cover:
  - OPEN/RUNNING/BLOCKED/DONE/CLOSED/CANCELED transitions;
  - one active Execution per Task and one Core binding per Execution;
  - dependency declaration and idempotent Controller reopening;
  - claim races and lease/fencing conflicts;
  - required Task contract and bounded child admission;
  - duplicate responsibility rejection;
  - typed backpressure and no-partial-write behavior;
  - aging/fairness protection for old eligible Tasks.

- Runtime lifecycle tests will cover:
  - starting one claimed Execution on one Core;
  - Session restart on the same Core with stable Execution identity;
  - release after completion, block, failure, and cancellation;
  - Core reuse after release;
  - fencing and recovery without duplicate owners;
  - no active Execution after a Task becomes BLOCKED.

- Core Daemon tests will cover:
  - no selection turn when no Task is claimable;
  - bounded shortlist discovery;
  - valid selection followed by exactly one claim;
  - lost claim race followed by bounded rescan;
  - fresh Task Session after claim;
  - return to discovery after Execution terminal state;
  - no Task selection by Runtime or Controller.

- Controller tests will cover:
  - event-driven and periodic dependency reconciliation;
  - reopen only when dependency and capacity conditions are satisfied;
  - no duplicate reopening;
  - idle-Daemon notification;
  - health observation and restart signaling;
  - no LLM ranking and no Task claim from Controller.

- Prompt and Service-surface tests will cover:
  - `list_tasks -> select task_id -> claim(task_id)`;
  - claimed-only reads after claim;
  - no guessed IDs;
  - no concurrent claims;
  - handling of typed backpressure and claim conflicts;
  - child self-validation and evidence publication.

- Observability tests will verify four separate projections:
  Core occupancy, Execution attempts and Session generations, Task lifecycle,
  and dependency/admission events. The projections must join by identity
  without treating BLOCKED time as Core occupancy.

- A deterministic collaboration fixture will contain one Root Task, at
  least two separable child Tasks, a dependency block, child Materials, and a
  downstream integration step. The external result must show two child
  Executions running on separate Cores, child completion, result consumption,
  Root reopening, and final Root progress.

- The deterministic suite and whitespace validation run before any
  real-Agent experiment.

- The required real-Agent acceptance uses the same clean implementation
  commit and the semantic parallel mode for the full two-hour timebox. The
  sanitized report must include Core timelines, every Execution narrative,
  claim/release/block/reopen events, child-result consumption, Controller and
  Daemon events, typed admission outcomes, provider/session failures, and
  exact fixture/provider/model metadata.

- Hard acceptance invariants are zero:
  - Core semantic WAITING intervals;
  - active blocked Tasks;
  - one Execution owned by multiple Cores;
  - duplicate active owners;
  - orphaned Core capacity after terminal Execution;
  - duplicate Controller reopen transitions;
  - invalid Tool protocol events;
  - unbounded Task growth beyond policy.

- Operational acceptance requires that when independent OPEN work exists,
  available Cores become active within one Controller reconciliation plus one
  selection turn, and that a Core released from an Execution returns to a
  useful claim loop without manual intervention.

- Collaboration acceptance requires downstream consumption evidence, not
  merely child creation. Every required child result used by the Root must be
  traceable from child Execution output to a later Task Session action.

- Mathematical solve success is reported separately from Runtime correctness.
  An unsolved problem can still demonstrate a correct orchestration contract;
  a solved problem with invalid ownership or lifecycle evidence cannot.

## Out of Scope

- Automatic semantic merging of duplicate responsibilities.
- A third long-lived monitor or scheduler decision maker.
- A central LLM scheduler that chooses Tasks before Core Daemons.
- Multiple simultaneous active Executions for one Task in the simplified
  default model.
- Parent review as a prerequisite for child `DONE`.
- Execution-level or Core-level semantic `WAITING` in the normal flow.
- Replacing Task Service, Workspace, Material, Context, or Judge with new
  systems.
- Kubernetes deployment or heterogeneous fleet scheduling.
- Large-scale prompt rewriting unrelated to selection, claim, execution
  evidence, and completion behavior.
- Treating utilization, dispatch count, queue size, or Agent turn count as
  proof of useful mathematical progress.
- Publishing raw Agent transcripts, proof contents, credentials, or
  unredacted experiment state.

## Further Notes

This specification is the architecture contract for Issue #70. Admission is
intentionally one implementation detail inside Task Service. The main
acceptance question is whether the Runtime, Controller, and Core Daemon
cooperate through the boundaries above and produce a smoother, more
collaborative, and more truthful execution trace.

The expected successful trace is: a Daemon selects and claims a Task, Runtime
runs one Execution on one Core, the Execution creates genuinely independent
children, other Daemons execute those children, child results are persisted
and consumed, a blocked parent is released from its Core, Controller reopens
it after dependencies complete, and a new Execution integrates the results.

The implementation must preserve the exact commit and clean-worktree
evidence used by the two-hour experiment. The issue is ready for an
implementation PR only after deterministic tests pass and the sanitized
real-Agent acceptance run is attached to the PR.
