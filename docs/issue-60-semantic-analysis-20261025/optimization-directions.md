# Optimization directions after semantic 2-hour run

This note is derived from the sanitized experiment report, aggregate metrics, project SQLite state, and the independent semantic review. It contains no Agent transcript, proof source, credentials, or raw process output.

## Priority 0: close the handoff loop

The run produced 93 Materials and ended with 22 `parent_review` waits plus one `child_task_terminal` wait. The analyzer has no recorded consumer for the Materials. This is an evidence-backed handoff gap; it does not prove that every Material was useless. The next implementation should make the consumer path durable: publish → intended parent can read → parent records the read → parent accepts or requests rework → the child or parent resumes. The Agent prompt should require the parent to read the child Task, Material metadata, Workspace diff, and CheckResult before a review decision. Add counters for `published_to_read`, `read_to_decision`, `decision_to_resume`, and orphaned Material age.

Validation: run a short semantic fixture with one child that publishes a Material and one child that receives a failed Judge result. Require both a recorded consumer and a downstream accept/rework or resume event. A report should fail the handoff gate when a published result has no consumer after its review deadline.

## Priority 1: turn Judge feedback into route changes

All 8 candidates reached the checker and all 8 were source-level failures; checker infrastructure failures were zero. Six failures occurred on the root proof Task and two on its rework path. The report does not show a meaningful route change between repeated diagnostics. After two failures with the same diagnostic class, the Runtime should require one of: a changed Workspace route, an explicitly bounded research Task, or parent rework before another full Candidate submission. The prompt should make the failure class and the required next action visible, while leaving the mathematical strategy to the Agent.

Validation: use a deterministic Judge fixture that returns the same source failure twice, then a different diagnostic. Verify that the second repeat creates a research/rework transition and that no third unchanged Candidate is accepted as normal progress.

## Priority 1: improve effective Core utilization

The run configured 4 Cores and reached all 4, but effective utilization was only `0.2658`; mean active Core count was `1.063`, while the eligible-work mean was `3.551`. There were `1,329,129 ms` of ready work and `1,070,078 ms` of ready-but-unassigned time. Scheduler dispatches succeeded 107/107 with no startup failure, but dispatch latency ranged from 17 ms to 92.3 s (median about 1.8 s, p95 about 44.4 s). This points to serial gaps, claim contention, or handoff latency rather than a Pi startup failure.

Validation: instrument ready queue age, claim conflict, WAITING capacity release, wake-to-dispatch latency, and active RUNNING intervals per Core. Compare a baseline and optimized run with the same fixture. Require lower ready-unassigned time and higher eligible-work utilization without increasing duplicate claims or invalid waits.

## Priority 1: make timebox cleanup typed and terminal

The run reached the 7200-second deadline with the root proof Task still `WAITING`, 22 research Tasks still `WAITING`, one Task `OPEN`, and a recently failed Execution. The report treats this as likely timebox/cleanup truncation, not a scheduler defect. The Runtime should persist an explicit experiment-timebox terminal reason, wake or cancel dependent waits, release leases, and record whether unfinished work was cancelled, deferred, or resumable.

Validation: run a short timebox with a waiting root and open children. At deadline, assert that every Execution has a typed terminal/recovery state, no Core lease remains active, and the report distinguishes timebox truncation from mathematical failure.

## Priority 2: reduce nested research fanout

The run created 32 child Tasks, 44 child claims, 4 branch groups, 10 required-subtask groups, and 3 rework-task creation events. Only 9 Tasks were satisfied; 23 remained waiting at the deadline. The visible work split was useful for exploring algebraic, coordinate, analytic, and Mathlib API routes, but several chains ended in `parent_review` without a closed consumer loop. Prefer bounded route bundles with explicit expected output and a fixed review point. Limit grandchildren until the parent has consumed the first result.

Validation: compare the current semantic run with a fanout-capped run using the same 4 Cores and timebox. Measure satisfied-task ratio, parent-review closure, unique route count, and time spent in ready-but-unassigned state.

## Priority 2: make mathematical work compile incrementally

The checker was healthy, so the remaining failure is mathematical/source-level. The task goals show repeated exploration of explicit simplices, circumcenter coordinates, circle-local exclusion, and Mathlib API names. Require research Tasks to produce a small compilable lemma or API check before the root submits another full Candidate. Keep those checks as Materials with a typed status so the parent can select a route based on evidence instead of repeatedly submitting similar full files.

Validation: add a fixture where a helper lemma compiles while the final theorem fails. Verify that the Agent publishes the helper result, the parent reads it, and the next Candidate changes its route or is blocked with a clear reason.

## Priority 3: repair the analysis tool's large observation import

The deterministic analyzer hit Node's call-stack limit on this run because it spread 126,367 observation facts into one `push(...facts)` call. The report was generated after a temporary local batching change; the repository source was restored and `main` remains clean. Make this one-line batching fix in a dedicated analysis-tool issue before the next report so that the prescribed skill command works without a private workaround.

Validation: run `npm run analyze:experiment` against this experiment and a larger observation fixture in both sanitized and full modes, and assert that the report completes with stable counts and no stack overflow.
