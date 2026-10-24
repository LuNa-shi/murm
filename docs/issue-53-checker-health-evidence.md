# Issue #53 checker health acceptance evidence

This document records the evidence for the checker-health implementation. It
keeps the deterministic protocol evidence separate from the real Agent gate.
The real-Agent evidence below was rerun at the exact implementation commit
recorded in the sanitized report.

## Deterministic gates

The final deterministic command is:

```sh
npm test
```

Result on the Issue #53 worktree: **125 passed, 0 failed**. `git diff --check`
also passed before the acceptance commit.

The relevant executable evidence is in these tests:

| Concern | Evidence |
| --- | --- |
| Clean checker PASS and source-level FAIL retain process evidence | `test/judge.test.js`: `Lean checker returns PASS only for a clean zero exit and preserves failure evidence` |
| A checker that never starts is not a mathematical FAIL | `test/judge.test.js`: `Checker result contract distinguishes source failure from a checker that never started`; `test/task-flow.test.js`: `exhausted checker infrastructure failures block the Task without claiming a mathematical FAIL` |
| Preflight binds the locked input, project cwd, Lean version, checker ref, and checker version | `test/judge.test.js`: `Lean checker preflight binds the locked input, project cwd, and toolchain version` |
| Missing executable, unbound fixture, and unknown toolchain are explicit unavailable states | `test/judge.test.js`: `Lean checker preflight reports an unavailable executable before proof checking`; `Lean checker preflight refuses an unbound fixture or an unknown toolchain version` |
| Identical infrastructure health is bounded; a changed health fingerprint opens a new retry window | `test/judge.test.js`: `Judge persists checker preflight health and bounds identical infrastructure retries`; `A changed Checker health result allows a later source-level check`; `A changed unavailable diagnostic opens a fresh bounded retry window` |
| Agent tool calls receive typed, safe process diagnostics and release a waiting Core | `test/putnam-runner.test.js`: `checker infrastructure errors returned by submit_candidate retain actionable safe process details`; `test/services-bridge.test.js`: `ServicesBridge releases the physical binding when checker feedback moves an Execution to WAITING` |
| Task Service resumes only after Judge reports a changed health fingerprint | `test/task-flow.test.js`: `checker health waits require a changed health fingerprint before resuming` |
| Reports do not export proof-bearing fields | `test/putnam-runner.test.js`: `report validator rejects proof-bearing fields` |

The deterministic ScriptExecutor report is intentionally not committed as an
artifact: its raw form contains candidate/proof content. The tests above assert
the sanitized report boundary and retain only status, diagnostic, identity, and
bounded process evidence in the shareable report surface.

## Real Agent gate

The final real-path run used the local route and locked Lean project with:

```sh
NUROUTER_PI_PROVIDER=openai \
NUROUTER_PI_MODEL=gpt-6.1-sol \
SWARMENV_PUTNAMBENCH_ROOT=/home/ubuntu/PutnamBench/lean4 \
node scripts/run-mvp-fixture.mjs --real-agent
```

The run was executed at implementation commit
`41d8ce949e9f7864142fcf319823a32a78660870`.

The probe returned `READY_TO_LAUNCH`, and the experiment completed with
`status: SUCCEEDED`. It used one real Agent/Core session, Pi 1.4.0, NuRouter
0.2.12, Node 24.21.0, Lean 4.33.1, and Lake 5.0.0. The fixture was locked to
PutnamBench commit `a635813f5edf297d928f9bd5ef8324a26bdde09c`, checker `lean`
version `mvp-1`, and the pinned Mathlib revision.

The Agent submitted two Materials through the public `submit_candidate` tool.
The first CheckResult was `APPLIED`, `verdict=FAIL`,
`result_class=source_failure`, `checker_process_status=completed`, and
`exit_code=1`. The second was `APPLIED`, `verdict=PASS`,
`result_class=PASS`, `checker_process_status=completed`, and `exit_code=0`.
The Task ended `SATISFIED`, the Execution ended `SUCCEEDED`, and both checks
used the same Workspace lineage across the checkpoint and wake. No checker
infrastructure failure was mistaken for a mathematical result, and
`secret_values_recorded` remained false.

The sanitized run record is
[`docs/issue-53-real-agent-gpt61-20261024.json`](issue-53-real-agent-gpt61-20261024.json).
It contains route, fixture, lifecycle, CheckResult, and bounded process-status
metadata only; candidate source, proof text, raw transcript, stdout, stderr,
and credentials are excluded.

Earlier attempts exposed two harness issues before this final run: the target
worktree did not have the local route environment, and the one-off real-agent
driver sent a phase prompt while Runtime's initial prompt was still running.
The worktree SOP and driver now copy/check the route configuration, queue the
phase prompt as a follow-up, wait for the actual Agent turn or an expected
Runtime stop after candidate submission, and then record the Judge result.
