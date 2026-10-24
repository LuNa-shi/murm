# Issue #53 checker health acceptance evidence

This document records the evidence for the checker-health implementation. It
keeps the deterministic protocol evidence separate from the real Agent gate;
the latter cannot be called complete until a real NuRouter/Pi route is
available.

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

The real-path probe was run from the clean implementation worktree with:

```sh
node scripts/run-mvp-fixture.mjs --real-agent
```

The probe returned `status: BLOCKED` before creating a Task or Execution because
the shell did not provide `NUROUTER_PI_PROVIDER` and
`NUROUTER_PI_MODEL`. The local tool inventory was available (Node 24.21.0,
NuRouter 0.2.12, Pi 1.0.1, Lean 4.33.1, and Lake 5.0.0), and the probe recorded
`secret_values_recorded: false`. No real-Agent report path exists for this
attempt because launch was correctly refused before an experiment began.

The remaining acceptance action is to load the local, non-secret route
configuration and rerun the same command from a clean commit. The resulting
experiment and sanitized report must be recorded under the normal
`experiments/<id>/` and `reports/<id>/` paths. That run should show either a
verified checker preflight followed by source-level PASS/FAIL, or an explicit
preflight/process infrastructure result; it must never classify a checker that
did not start as mathematical proof failure.
