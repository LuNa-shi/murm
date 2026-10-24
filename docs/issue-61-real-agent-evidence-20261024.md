# Issue #61 candidate feedback acceptance evidence

This document records the deterministic gates and the final real-Agent run for
the candidate feedback lifecycle. The shareable JSON report contains only
bounded operational fields; the raw Agent output remains in the ignored
experiment directory named in that report.

## Deterministic gates

The final deterministic command was:

```sh
npm test
```

It passed **133 tests with 0 failures**. `git diff --check` also passed before
the acceptance run.

The tests cover the two separate boundaries introduced by Issue #61:

- Agent-facing `submit_candidate` and `judge_get_check_result` responses retain
  a bounded Lean diagnostic, source-failure classification, location, process
  status, and exit code while excluding candidate source and raw streams.
- A source-level failure stays `RUNNING` and keeps the same bridge binding, so
  a second candidate can be submitted in the same Execution. A retryable
  checker-health failure is deferred until the response has been flushed; a
  disconnected response is not treated as delivered feedback.
- The real-agent trace correlates the first CheckResult with the later
  submission and requires diagnostic delivery before the revision.

## Final real-Agent gate

The worktree was clean at implementation commit
`e8cd7ad9fe0f6d42ab2938c07686c4d68a6c8f23`. The probe returned
`READY_TO_LAUNCH` with the explicit `openai` / `gpt-6.1-sol` route. The run
used one Core, a 360000 ms process timebox, and a 180000 ms Agent-turn timeout.
The locked fixture used PutnamBench commit
`a635813f5edf297d928f9bd5ef8324a26bdde09c`, Lean 4.33.1, Mathlib revision
`0df444a360eaa60ab8c11dca51a86af692955474`, checker `lean` `mvp-1`, and
project root `/home/ubuntu/PutnamBench/lean4`.

The exact command was:

```sh
NUROUTER_PI_PROVIDER=openai \
NUROUTER_PI_MODEL=gpt-6.1-sol \
SWARMENV_PUTNAMBENCH_ROOT=/home/ubuntu/PutnamBench/lean4 \
SWARMENV_IMPLEMENTATION_COMMIT=e8cd7ad9fe0f6d42ab2938c07686c4d68a6c8f23 \
SWARMENV_WORKTREE_DIRTY=false \
SWARMENV_WORKTREE_STATUS=clean \
SWARMENV_TIMEBOX_MS=360000 \
timeout 360s node scripts/run-mvp-fixture.mjs --real-agent
```

The harness makes the first submission a controlled, genuinely invalid
near-valid candidate by changing one `ring` tactic to `rfl`. It does not inject
the repaired candidate or a second independent prompt. The Agent receives the
first synchronous CheckResult, publishes its revision, and submits it through
the same bridge.

The run completed with `status: SUCCEEDED`. The first CheckResult was
`APPLIED`, `verdict=FAIL`, `result_class=source_failure`,
`checker_process_status=completed`, and `exit_code=1`; its Agent-facing trace
recorded a diagnostic excerpt and a Lean location. The Execution remained
`RUNNING`. The second CheckResult was `APPLIED`, `verdict=PASS`,
`result_class=PASS`, `checker_process_status=completed`, and `exit_code=0`.
The Task ended `SATISFIED` and the Execution ended `SUCCEEDED`.

The feedback handoff proves `same_agent_session=true`,
`same_execution=true`, `first_result_delivered_before_revision=true`,
`first_diagnostic_delivered=true`, and `wait_between_candidates=false` with no
Runtime lifecycle event between the two candidate submissions. No secret values,
candidate source, proof text, raw transcript, stdout, or stderr are included in
the shareable report.

The sanitized run record is
[`docs/issue-61-real-agent-gpt61-20261024.json`](issue-61-real-agent-gpt61-20261024.json).
